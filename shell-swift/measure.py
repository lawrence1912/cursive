#!/usr/bin/env python3
"""第八节 15：整机轻量体验指标（人工发起，不进 release.sh）。

在**可见且拥有焦点**的真窗口里量（窗口不是 key 时 WebKit 一帧都不派，量出来的帧时间是假的）：
  · 输入延迟：真按键（ime-driver，与真键盘同一个入口）→ 下一帧交出去；另记同步事务耗时。
    场景：普通段落（冷 / 预热）、中文输入法连打、开着查找、表格单元格、切标签；
  · 滚动：逐帧推进 scrollTop，记帧间隔；
  · 冷启动到可输入（CURSIVE_TIMING 的「文档已上屏」）、大文档导出 HTML、多标签内存、
    闲置 CPU、阅读时的能耗（top 的 POWER）。
文档规模照第四节红线三：1 万行 + 50 个公式 + 10 张图（另带表格、代码块、front matter）。

为什么不进 release.sh：计时类断言在别人正用着的机器上随机红，而红一次分不清是代码慢了
还是机器忙（ROADMAP 第三节「E2E 上 CI」同一条理由）。预算写在 BUDGETS 里，这个脚本拿它比，
超了就退出码 1 —— 是「跑一下看有没有退化」的工具，不是流水线的闸。

    python3 shell-swift/measure.py [结果.json]

跑的时候别碰键盘鼠标：按键走的是与真键盘同一个入口（每一个事件之前确认测试窗口在最前面，
不在就立刻停，不会打进别的应用）。整段约四五分钟。
"""
import json
import os
from pathlib import Path
import platform
import statistics
import subprocess
import sys
import tempfile
from threading import Thread
import time

from native_probe import ROOT, Window, compile_driver

out_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/tmp/cursive-perf.json')

# 回归预算（ms，除标注外）。由 2026-10-08 在 MacBookPro18,3（M1 Pro）上的基线定：
# 取基线 p95 的约 1.5 倍、向上取整到好记的数 —— 宽到不被一次系统抖动误伤，
# 窄到一次真的退化（比如每键全文 ensure 又回来了）一定越线
BUDGETS = {
    'typing.plain.frame.p95': 33,
    'typing.plain.sync.p95': 12,
    'typing.ime.frame.p95': 33,
    'typing.find.frame.p95': 40,
    'typing.table.frame.p95': 40,
    'tabs.frame.p95': 120,
    'scroll.slowFrames.ratio': 0.10,   # 超过 1.5 个刷新周期的帧占比
    'coldStart.painted.p50': 1200,
    'export.html.p50': 1500,
    'idle.cpu.percent': 1.0,           # 应用 + WebContent，%
}


def summary(values):
    v = sorted(values)
    if not v:
        return {'n': 0}

    def pct(q):
        return v[min(len(v) - 1, int(round(q * (len(v) - 1))))]
    return {'n': len(v), 'p50': round(pct(0.5), 1), 'p95': round(pct(0.95), 1),
            'max': round(v[-1], 1), 'mean': round(statistics.mean(v), 1)}


def build_fixture(d: Path) -> None:
    lines = ['---', 'title: 性能基线', 'tags: [基线, 测量]', '---', '', '# 性能基线文档', '']
    sec = formula = img = 0
    while len(lines) < 10000:
        sec += 1
        lines += [f'## 第 {sec} 节', '']
        for p in range(6):
            lines += [f'第 {sec} 节第 {p + 1} 段：撑出长度的中文正文，带一点 **粗体**、`行内代码`、'
                      f'$x_{p}$ 与 [一个链接](#第-{sec}-节)。', '']
        if sec % 13 == 0 and formula < 50:
            formula += 1
            lines += ['$$', f'\\sum_{{i=1}}^{{{sec}}} i^2 = \\frac{{n(n+1)(2n+1)}}{{6}}', '$$', '']
        if sec % 66 == 0 and img < 10:
            img += 1
            lines += [f'![图 {img}](img-{img}.svg)', '']
        if sec % 15 == 0:
            cell = '【格测量】' if sec == 330 else '数据'
            lines += ['| 列一 | 列二 | 列三 |', '| --- | --- | --- |']
            lines += [f'| {sec}-{r} | {cell if r == 1 else "数据"} | 备注 |' for r in range(4)] + ['']
        if sec % 10 == 0:
            lines += ['```ts', f'const n{sec}: number = {sec} // 代码块', '```', '']
        if sec == 333:
            lines += ['【测量点】在这里打字。', '']
    text = '\n'.join(lines) + '\n'
    (d / 'perf.md').write_text(text)
    for i in range(2, 7):
        (d / f'perf-{i}.md').write_text(text)
    (d / 'small.md').write_text('# 小文档\n\n' + '\n\n'.join(f'第 {i} 段。' for i in range(1, 40)) + '\n')
    for i in range(1, 11):
        (d / f'img-{i}.svg').write_text(
            f'<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240"><rect width="480" height="240" '
            f'fill="hsl({i * 36},60%,70%)"/><text x="20" y="120" font-size="40">图 {i}</text></svg>')


def webkit_pids(before: set) -> list:
    out = subprocess.run(['ps', '-axo', 'pid=,comm='], capture_output=True, text=True).stdout
    pids = []
    for line in out.splitlines():
        pid, _, comm = line.strip().partition(' ')
        if int(pid) not in before and 'WebKit' in comm:
            pids.append(pid)
    return pids


def footprint_mb(pid: str) -> float:
    out = subprocess.run(['footprint', '-p', pid], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if 'Footprint:' in line:
            num, unit = line.split('Footprint:')[1].split()[:2]
            scale = {'KB': 1 / 1024, 'MB': 1, 'GB': 1024}.get(unit, 1)
            return round(float(num) * scale, 1)
    return -1.0


def cputime(pid: str) -> float:
    raw = subprocess.run(['ps', '-o', 'cputime=', '-p', pid], capture_output=True, text=True).stdout.strip()
    if not raw:
        return 0.0
    parts = [float(x) for x in raw.replace('-', ':').split(':')]
    secs = 0.0
    for x in parts:
        secs = secs * 60 + x
    return secs


def power(pids: list, seconds: int) -> float:
    """top 的 POWER（能耗影响，无量纲）。第一个采样没有意义（没有区间），丢掉"""
    n = max(2, seconds // 5 + 1)
    args = ['top', '-l', str(n), '-s', '5', '-stats', 'pid,power']
    for p in pids:
        args += ['-pid', p]
    out = subprocess.run(args, capture_output=True, text=True).stdout
    samples, block = [], {}
    for line in out.splitlines():
        cells = line.split()
        if line.startswith('Processes:') and block:
            samples.append(sum(block.values()))
            block = {}
        if len(cells) == 2 and cells[0] in pids:
            block[cells[0]] = float(cells[1])
    if block:
        samples.append(sum(block.values()))
    return round(statistics.mean(samples[1:]), 2) if len(samples) > 1 else -1.0


results = {'budgets': BUDGETS}
with tempfile.TemporaryDirectory(prefix='cursive-perf-') as directory:
    d = Path(directory)
    build_fixture(d)
    driver = compile_driver(d / 'ime-driver')
    results['env'] = {
        'macOS': platform.mac_ver()[0],
        'build': subprocess.run(['sw_vers', '-buildVersion'], capture_output=True, text=True).stdout.strip(),
        'model': subprocess.run(['sysctl', '-n', 'hw.model'], capture_output=True, text=True).stdout.strip(),
        'cpu': subprocess.run(['sysctl', '-n', 'machdep.cpu.brand_string'], capture_output=True, text=True).stdout.strip(),
        'memGB': int(subprocess.run(['sysctl', '-n', 'hw.memsize'], capture_output=True, text=True).stdout) // 2**30,
    }
    doc = (d / 'perf.md').read_text()
    results['doc'] = {'lines': doc.count('\n'), 'chars': len(doc), 'formulas': doc.count('$$\n') // 2,
                      'images': doc.count('![图'), 'tables': doc.count('| 列一 |'), 'codeBlocks': doc.count('```ts')}

    # ---- 冷启动到「文档已上屏」：三次，各起一个只截图的自检窗口 ----
    painted, entered = [], []
    for i in range(3):
        sup = d / f'support-cold-{i}'
        env = dict(os.environ, CURSIVE_SMOKE='1', CURSIVE_SMOKE_SHOT_CLEAN='1', CURSIVE_TIMING='1',
                   CURSIVE_SMOKE_SUPPORT=str(sup), CURSIVE_SMOKE_SHOT=str(d / f'cold-{i}.png'),
                   CURSIVE_SMOKE_SHOT_WAIT='1500')
        r = subprocess.run([str(ROOT / 'shell-swift/cursive-shell'), str(d / 'perf.md')], cwd=ROOT, env=env,
                           capture_output=True, text=True, timeout=60)
        for line in r.stderr.splitlines():
            if line.startswith('[timing]') and '文档已上屏' in line:
                painted.append(float(line.split()[1].rstrip('ms')))
            if line.startswith('[timing]') and '文档进编辑器' in line:
                entered.append(float(line.split()[1].rstrip('ms')))
        time.sleep(1.0)
    results['coldStart'] = {'entered': summary(entered), 'painted': summary(painted)}

    # ---- 主会话 ----
    before = {int(x.split()[0]) for x in subprocess.run(['ps', '-axo', 'pid='], capture_output=True, text=True).stdout.split('\n') if x.strip()}
    win = Window(d, (ROOT / 'test/native-perf.js').read_text(), [d / 'perf.md'], driver)
    try:
        win.activate()
        time.sleep(1.0)
        results['window'] = win.cmd('info')

        def typing(label, keys, gap=0.1, before_keys=None):
            win.cmd('arm')
            for k in keys:
                if k == ' ':
                    win.key('space')
                else:
                    win.type(k, 5)
                time.sleep(gap)
            got = win.cmd('collect', settle=500)['samples']
            results.setdefault('typing', {})[label] = {
                'frame': summary([s['frame'] for s in got]),
                'sync': summary([s['sync'] for s in got]),
                'syncOver16': round(sum(s['sync'] > 16 for s in got) / max(1, len(got)), 3),
                'frameOver16': round(sum(s['frame'] > 16.7 for s in got) / max(1, len(got)), 3),
            }

        win.cmd('place', where='mid')
        typing('cold', list('12345'), gap=0.25)          # 打开之后的头几下
        typing('plain', list('1234567890' * 6))           # 预热之后的普通段落
        ime = []
        for w in ('zhongwen', 'shurufa', 'xingneng', 'ceshi', 'wendang', 'bianji', 'yulan', 'dagang'):
            ime += list(w) + [' ']
        typing('ime', ime, gap=0.08)                      # 中文输入法连打：每个字母都是一次组字更新
        win.cmd('place', where='find')
        typing('find', list('1234567890' * 4))
        win.cmd('unfind')  # 收掉查找面板：几千处命中的高亮会算进后面的滚动
        win.cmd('place', where='table')
        typing('table', list('1234567890' * 4))

        # 切标签：三个标签之间 ⌃⇥ 二十次（菜单那条路，起点是菜单动作进页面）
        win.cmd('open', name='small.md')
        win.cmd('open', name='perf-2.md')
        win.cmd('arm')
        for _ in range(20):
            win.key('tab', 'ctrl')
            time.sleep(0.45)
        got = win.cmd('collect', settle=600)['samples']
        results['tabs'] = {'frame': summary([s['frame'] for s in got]), 'sync': summary([s['sync'] for s in got])}

        # 滚动：逐帧推进 40px，两遍（第二遍 widget 高度都量过了）
        win.cmd('open', name='perf.md')
        scrolls = []
        for _ in range(2):
            r = win.cmd('scroll', frames=360, step=40, timeout=60)
            scrolls.append(r['intervals'])
        refresh = results['window']['rafMedian']
        flat = scrolls[1]
        results['scroll'] = {
            'first': summary(scrolls[0]), 'warm': summary(flat),
            'slowFrames.ratio': round(sum(x > refresh * 1.5 for x in flat) / max(1, len(flat)), 3),
            'longFrames50': sum(x > 50 for x in scrolls[0] + flat),
        }

        # 大文档导出 HTML（只到渲染层交出 HTML 那一刻；写盘在壳侧，另算）
        r = win.cmd('export', runs=3, timeout=120)
        results['export'] = {'html': summary(r['times']), 'bytes': r['bytes']}

        # 多标签内存：此刻三个标签（perf / small / perf-2）→ 再开三个 1 万行的
        pids = [win.pid] + webkit_pids(before)
        results['processes'] = pids
        mem = {'tabs3': {p: footprint_mb(p) for p in pids}}
        for name in ('perf-3.md', 'perf-4.md', 'perf-5.md'):
            win.cmd('open', name=name)
        time.sleep(2.0)
        pids = [win.pid] + webkit_pids(before)
        mem['tabs6'] = {p: footprint_mb(p) for p in pids}
        results['memoryMB'] = {k: {'total': round(sum(v.values()), 1), 'byPid': v} for k, v in mem.items()}

        # 闲置 CPU（30 秒不动）与阅读时的能耗（同一段闲置 + 一段逐帧滚动）
        win.cmd('open', name='perf.md')
        time.sleep(3.0)
        c0 = {p: cputime(p) for p in pids}
        time.sleep(30)
        c1 = {p: cputime(p) for p in pids}
        results['idle'] = {'cpu.percent': round(sum(c1[p] - c0[p] for p in pids) / 30 * 100, 2)}
        results['idle']['power'] = power(pids, 30)
        holder = {}
        t = Thread(target=lambda: holder.update(p=power(pids, 25)))
        t.start()
        for _ in range(3):
            win.cmd('scroll', frames=400, step=12, timeout=60)
        t.join()
        results['reading'] = {'power.scrolling': holder.get('p', -1.0)}
    finally:
        win.close()

flat = {
    'typing.plain.frame.p95': results['typing']['plain']['frame'].get('p95'),
    'typing.plain.sync.p95': results['typing']['plain']['sync'].get('p95'),
    'typing.ime.frame.p95': results['typing']['ime']['frame'].get('p95'),
    'typing.find.frame.p95': results['typing']['find']['frame'].get('p95'),
    'typing.table.frame.p95': results['typing']['table']['frame'].get('p95'),
    'tabs.frame.p95': results['tabs']['frame'].get('p95'),
    'scroll.slowFrames.ratio': results['scroll']['slowFrames.ratio'],
    'coldStart.painted.p50': results['coldStart']['painted'].get('p50'),
    'export.html.p50': results['export']['html'].get('p50'),
    'idle.cpu.percent': results['idle']['cpu.percent'],
}
over = {k: v for k, v in flat.items() if v is None or v > BUDGETS[k]}
results['flat'] = flat
results['overBudget'] = over
out_path.write_text(json.dumps(results, ensure_ascii=False, indent=1))
for k, v in flat.items():
    print(f"{'OVER' if k in over else 'ok  '} {k} = {v}  (预算 {BUDGETS[k]})")
print(f'结果：{out_path}')
sys.exit(1 if over else 0)
