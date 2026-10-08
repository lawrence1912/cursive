"""真窗口走查的公共部分（check-ime.py / measure.py 共用）。

起一个自检窗口、注入一段页面探针，然后靠**文件**跟它说话：指令写进一个 JSON 文件
（探针用 `window.api.read` 轮询），回执由探针用 `scratchSave` 写进隔离的支持目录 ——
不走 `save`，所以不会把临时路径记进「最近文件」。真按键交给 `ime-driver`（CGEvent，
与真键盘同一个入口），每一个事件投递之前都确认测试窗口在最前面。
"""
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parent.parent


class NotFront(SystemExit):
    pass


def compile_driver(out: Path) -> Path:
    subprocess.run(['swiftc', '-O', str(ROOT / 'shell-swift/ime-driver.swift'), '-o', str(out)],
                   check=True, capture_output=True)
    return out


class Window:
    def __init__(self, workdir: Path, probe_js: str, args, driver: Path, keys=True, extra_env=None):
        self.dir = workdir
        self.driver = driver
        self.cmd_file = workdir / 'cmd.json'
        self.support = workdir / 'support'
        self.out_file = self.support / 'cursive' / 'scratch' / 'probe.json'
        self.seq = 0
        script = ('window.__probeCmd = ' + json.dumps(str(self.cmd_file)) + ';\n'
                  "window.__probeOut = 'probe';\n" + probe_js)
        env = dict(os.environ, CURSIVE_SMOKE='1', CURSIVE_SMOKE_SHOT_CLEAN='1',
                   CURSIVE_SMOKE_SUPPORT=str(self.support), CURSIVE_SMOKE_SHOT=str(workdir / 'view.png'),
                   CURSIVE_SMOKE_SHOT_WAIT='900000', CURSIVE_SMOKE_SHOT_JS=script, **(extra_env or {}))
        # 自检默认吞掉一切真实按键（防旁边的人打字把夹具改花）；这里要的恰恰是真按键
        if keys:
            env['CURSIVE_SMOKE_KEYS'] = '1'
        self.app = subprocess.Popen([str(ROOT / 'shell-swift/cursive-shell'), *map(str, args)], cwd=ROOT, env=env,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.pid = str(self.app.pid)
        end = time.time() + 40
        while time.time() < end and (self.read() or {}).get('id') != 'ready':
            time.sleep(0.1)
        if (self.read() or {}).get('id') != 'ready':
            raise RuntimeError('探针没有起来')

    def read(self):
        try:
            return json.loads(json.loads(self.out_file.read_text())['content'])
        except Exception:
            return None

    def cmd(self, op, timeout=30, **kw):
        self.seq += 1
        cid = f'c{self.seq}'
        tmp = self.dir / 'cmd.tmp'
        tmp.write_text(json.dumps({'id': cid, 'op': op, **kw}))
        os.replace(tmp, self.cmd_file)
        end = time.time() + timeout
        while time.time() < end:
            got = self.read()
            if got and got.get('id') == cid:
                if 'error' in got:
                    raise RuntimeError(got['error'])
                return got
            time.sleep(0.04)
        raise TimeoutError(op)

    def front(self) -> bool:
        return subprocess.run([str(self.driver), 'front', self.pid], capture_output=True).returncode == 0

    def activate(self):
        """把测试窗口请到最前面。人正在用别的应用时可能要试几次；始终不成就停下"""
        for _ in range(10):
            subprocess.run(['osascript', '-e', 'tell application "System Events" to set frontmost of '
                            f'first process whose unix id is {self.pid} to true'], capture_output=True)
            time.sleep(0.6)
            if self.front():
                return
        raise NotFront('测试窗口请不到最前面 —— 为了不把按键打进别的应用，到此为止')

    def drv(self, *args):
        r = subprocess.run([str(self.driver), args[0], self.pid, *args[1:]], capture_output=True, text=True)
        if r.returncode == 3:
            raise NotFront('测试窗口不在最前面（' + r.stderr.strip() + '）—— 为了不把按键打进别的应用，到此为止')
        if r.returncode:
            raise RuntimeError(r.stderr.strip())

    def type(self, text, gap=35):
        self.drv('type', text, str(gap))

    def key(self, name, *mods):
        self.drv('key', name, *mods)

    def close(self):
        try:
            self.cmd('quit', timeout=3)
        except Exception:
            pass
        self.app.terminate()
        try:
            self.app.wait(timeout=5)
        except Exception:
            self.app.kill()

