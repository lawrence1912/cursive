#!/usr/bin/env python3
"""第八节 17：真实中文输入法组合走查（人工发起，不进 release.sh）。

用系统**当前**的中文输入法（本机是微信输入法）在真窗口里组字：按键由 ime-driver 用 CGEvent
投给测试窗口那一个进程，输入法真的接手、真的弹候选。判据不依赖候选词是什么 ——
页面探针记下输入法自己提交的每一段（compositionend 的 data），这里核对文档里落下的
正好是那几段：不多、不少、不重复、不落进别的标签或输入框。

为什么不进 release.sh：它依赖这台机器装了哪个输入法、是不是中文模式，换一台机器就是
另一回事；而且整段要占着前台一两分钟。跑法：

    python3 shell-swift/check-ime.py [记录输出路径.json]

安全：每一个事件投递之前确认测试窗口在最前面，不在就立刻停（见 ime-driver.swift）；
不切换输入法、不改系统设置。跑的时候别碰键盘鼠标 —— 按键走的是与真键盘同一个入口。
输入法可能会从这次输入里学到几个词的频率。
"""
import json
import os
from pathlib import Path
import platform
import plistlib
import subprocess
import sys
import tempfile
import time

from native_probe import Window, compile_driver

root = Path(__file__).resolve().parent.parent
record_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/tmp/cursive-ime-record.json')

# 一百组常用双音节词，空格取首选。首选是什么由输入法决定，判据只认它自己提交了什么
WORDS = ('women zhongguo shijian wenti gongzuo xuexi shenghuo pengyou jintian mingtian '
         'difang dongxi shiqing yinwei suoyi danshi ruguo keyi xianzai yijing '
         'women xihuan kaishi jieshu wenzhang bianji wendang biaoge gongshi tupian '
         'shurufa zhongwen ceshi yanshi tiyan xingneng wenti xiufu wancheng tijiao '
         'baocun dakai guanbi chakan sousuo tihuan fuzhi niantie chexiao chongzuo '
         'biaoti duanluo liebiao yinyong daima lianjie jiaozhu mulu dagang zishu '
         'chuangkou biaoqian wenjian wenjianjia gongzuoqu zhuti zihao hangju lankuan '
         'yulan yuanma zhuanzhu dazi zidong shoudong jilu lishi banben duibi '
         'huifu shanchu chongmingming yidong fuzhi daochu dayin changtu zhuangtai '
         'tishi jinggao cuowu chenggong shibai chongshi quxiao queding bangzhu shezhi').split()

failures = []
record = {'steps': []}


def check(name, ok, **detail):
    print(('PASS ' if ok else 'FAIL ') + name)
    record['steps'].append({'check': name, 'pass': bool(ok), **detail})
    if not ok:
        failures.append(name)


def commits(log):
    """输入法提交了什么。内嵌组字的输入法派 compositionend（data 就是提交的那段）；
    不把拼音嵌进输入框的（候选全在它自己的窗里）只派一次 insertText 的 beforeinput"""
    if any(e['type'] == 'compositionend' for e in log):
        return ''.join(e['data'] for e in log if e['type'] == 'compositionend')
    return ''.join(e['data'] for e in log if e['type'] == 'beforeinput' and e.get('inputType') == 'insertText')


with tempfile.TemporaryDirectory(prefix='cursive-ime-') as directory:
    fixture = Path(directory)
    driver = compile_driver(fixture / 'ime-driver')
    (fixture / 'a.md').write_text(
        '# 输入法走查\n\n在这里输入：\n\n第二段：点到这里。\n\n'
        '| 名称 | 说明 |\n| --- | --- |\n| 表格 | 在格子里输入 |\n\n结尾一段。\n')
    (fixture / 'b.md').write_text('# 另一个标签\n\n这里不该出现别的标签里的字。\n')
    win = Window(fixture, (root / 'test/native-ime.js').read_text(), [fixture / 'a.md'], driver)
    cmd, typ, key = win.cmd, win.type, win.key

    def drv(*args):
        win.drv(*args)

    try:
        win.activate()
        wetype = Path('/Library/Input Methods/WeType.app/Contents/Info.plist')
        record['env'] = {
            'macOS': platform.mac_ver()[0],
            'build': subprocess.run(['sw_vers', '-buildVersion'], capture_output=True, text=True).stdout.strip(),
            'model': subprocess.run(['sysctl', '-n', 'hw.model'], capture_output=True, text=True).stdout.strip(),
            'ime': '微信输入法 ' + plistlib.loads(wetype.read_bytes()).get('CFBundleShortVersionString', '?')
                   if wetype.exists() else '?'
        }

        # ---- 前提：当前输入法在中文模式，敲字母会开始组字 ----
        cmd('prepare', where='paragraph')
        typ('ni')
        time.sleep(0.4)
        probe = cmd('state')
        key('escape')
        time.sleep(0.3)
        cmd('state')
        record['precheck'] = {'text': probe['text'][:80], 'active': probe['active'],
                              'hasFocus': probe['hasFocus'], 'log': probe['log']}
        if not any(e['type'] == 'compositionstart' for e in probe['log']):
            print('预检现场：', json.dumps(record['precheck'], ensure_ascii=False))
            raise SystemExit('敲字母没有开始组字：当前输入法不是中文输入法，或者处在英文模式。走查没有开始')

        # ---- S1 普通段落连续输入 200 字以上 ----
        s0 = cmd('prepare', where='paragraph')
        at, before = s0['sel'][1], s0['text']
        log = []
        for w in WORDS:
            typ(w)
            key('space')
            time.sleep(0.09)
        time.sleep(0.8)
        s1 = cmd('state')
        log += s1['log']
        c = commits(log)
        check('S1 段落里连续输入 200 字以上：不丢字、不重复', len(c) >= 200 and s1['text'] == before[:at] + c + before[at:]
              and not s1['composing'] and s1['active'] == 'editor',
              typed=' '.join(WORDS), committed=c, chars=len(c), focus=s1['active'])

        # ---- S2 方向键在候选里挪、空格确认；随后 ⌘Z 只撤这一次 ----
        time.sleep(0.8)  # 与上一段隔开撤销组（CodeMirror 的 newGroupDelay 是 500ms）
        s = cmd('state')
        at, before = s['sel'][1], s['text']
        typ('shi')
        time.sleep(0.3)
        key('right')
        key('right')
        time.sleep(0.3)
        mid = cmd('state')
        key('space')
        time.sleep(0.4)
        s2 = cmd('state')
        c = commits(mid['log'] + s2['log'])
        check('S2 组字时方向键交给输入法（不挪编辑器光标），空格确认落下的正是提交的那段',
              mid['composing'] and len(c) >= 1 and s2['text'] == before[:at] + c + before[at:]
              and s2['sel'][1] == at + len(c), typed='shi → → 空格', committed=c)
        time.sleep(0.6)
        key('z', 'cmd')
        time.sleep(0.4)
        s3 = cmd('state')
        check('S3 ⌘Z 撤掉的正是刚提交的那一段', s3['text'] == before, committed=c)

        # ---- S2b 翻页（=）后数字选择 ----
        time.sleep(0.6)
        s = cmd('state')
        at, before = s['sel'][1], s['text']
        typ('shi')
        time.sleep(0.3)
        key('=')
        time.sleep(0.35)
        paged = cmd('state')
        still = paged['composing'] and not any(e['type'] == 'compositionend' for e in paged['log'])
        if still:
            typ('2')
        time.sleep(0.4)
        s2b = cmd('state')
        c = commits(paged['log'] + s2b['log'])
        inserted = s2b['text'][at:len(s2b['text']) - (len(before) - at)]
        check('S2b 翻页后数字选择：落下的正是提交的那段' + ('' if still else '（= 不是这个输入法的翻页键，已按它的行为核对）'),
              inserted in (c, c + '=') and s2b['text'].endswith(before[at:]) and not s2b['composing'],
              typed='shi = 2' if still else 'shi =', committed=c, pagedKey=still)

        # ---- S4 Esc 取消合成，之后照常输入 ----
        s = cmd('state')
        at, before = s['sel'][1], s['text']
        typ('ceshi')
        time.sleep(0.3)
        key('escape')
        time.sleep(0.4)
        s4 = cmd('state')
        check('S4 Esc 取消合成：一个字都不落', s4['text'] == before and not s4['composing'],
              committed=commits(s4['log']))
        typ('hao')
        key('space')
        time.sleep(0.4)
        s4b = cmd('state')
        c = commits(s4b['log'])
        check('S4b 取消之后接着输入照常', len(c) >= 1 and s4b['text'] == before[:at] + c + before[at:], committed=c)

        # ---- S5 表格单元格：输入、组字时方向键 / 回车都交给输入法 ----
        s = cmd('prepare', where='cell')
        lines, row, col, before = s['lines'], s['cell']['row'], s['cell']['col'], s['text']
        typ('biaoge')
        key('space')
        time.sleep(0.5)
        s5 = cmd('state')
        c = commits(s5['log'])
        check('S5 格子里输入：提交的那段进了这一格、没进别处', len(c) >= 1 and s5['active'] == 'cell'
              and s5['cell'] and c in s5['cell']['text'] and s5['lines'] == lines
              and len(s5['text']) - len(before) == len(c), committed=c, cell=s5['cell'])
        before = s5['text']
        typ('hang')
        time.sleep(0.3)
        key('down')
        time.sleep(0.3)
        key('space')
        time.sleep(0.5)
        s5b = cmd('state')
        c = commits(s5b['log'])
        check('S5b 格子里组字时按 ↓：候选归输入法，焦点不跳到下一行', s5b['active'] == 'cell'
              and s5b['cell'] and (s5b['cell']['row'], s5b['cell']['col']) == (row, col)
              and s5b['lines'] == lines and len(s5b['text']) - len(before) == len(c), committed=c)
        before = s5b['text']
        typ('ce')
        time.sleep(0.3)
        key('return')
        time.sleep(0.5)
        s5c = cmd('state')
        c = commits(s5c['log'])
        check('S5c 格子里组字时按回车：输入法提交，表格不加行', s5c['lines'] == lines and s5c['active'] == 'cell'
              and len(s5c['text']) - len(before) == len(c), committed=c)

        # ---- S6 查找框：输入、组字时 ↓ 不触发「下一处」 ----
        s = cmd('prepare', where='find')
        before, sel = s['text'], s['sel']
        typ('chazhao')
        key('space')
        time.sleep(0.4)
        s6 = cmd('state')
        c = commits(s6['log'])
        check('S6 查找框里输入：提交的那段进了查找框、文档一个字不动', len(c) >= 1 and s6['find'] == c
              and s6['text'] == before and s6['active'] == 'find', committed=c)
        typ('zhao')
        time.sleep(0.3)
        key('down')
        time.sleep(0.3)
        key('space')
        time.sleep(0.4)
        s6b = cmd('state')
        c2 = commits(s6b['log'])
        check('S6b 查找框里组字时按 ↓：候选归输入法，不跳到下一处', s6b['find'] == c + c2 and s6b['sel'] == sel
              and s6b['active'] == 'find', committed=c2)
        cmd('escape-find')

        # ---- S7 候选期间打开命令面板、在面板里输入、关掉面板 ----
        s = cmd('prepare', where='paragraph')
        at, before = s['sel'][1], s['text']
        typ('zhong')
        time.sleep(0.3)
        s7 = cmd('menu', action='view:command-palette', wait=400)
        c = commits(s7['log'])
        check('S7 候选期间打开浮层：合成收尾，提交的那段至多落一次、落在原处，不进面板',
              s7['paletteOpen'] and s7['active'] == 'palette' and not s7['composing']
              and s7['text'] == before[:at] + c + before[at:] and (not c or c not in (s7['palette'] or '')),
              committed=c, landed='正文原处' if c else '取消（没有落字）')
        typ('mingling')
        key('space')
        time.sleep(0.4)
        s7b = cmd('state')
        c2 = commits(s7b['log'])
        check('S7b 浮层里用输入法：提交的那段进了面板的输入框，正文不动', len(c2) >= 1
              and s7b['palette'] == c2 and s7b['text'] == s7['text'], committed=c2)
        key('escape')
        time.sleep(0.4)
        s7c = cmd('state')
        check('S7c Esc 关掉面板：焦点回到正文', not s7c['paletteOpen'] and s7c['active'] == 'editor')
        before7 = s7c['text']
        at7 = s7c['sel'][1]
        typ('hao')
        key('space')
        time.sleep(0.4)
        s7d = cmd('state')
        c3 = commits(s7d['log'])
        check('S7d 关掉面板之后接着输入照常', len(c3) >= 1 and s7d['text'] == before7[:at7] + c3 + before7[at7:],
              committed=c3)

        # ---- S8 候选期间点到别处 ----
        s = cmd('prepare', where='paragraph')
        at, before = s['sel'][1], s['text']
        typ('dianji')
        time.sleep(0.3)
        p = cmd('point')
        drv('click', str(p['x']), str(p['y']))
        time.sleep(0.5)
        s8 = cmd('state')
        c = commits(s8['log'])
        target = p['pos'] + (len(c) if p['pos'] > at else 0)
        check('S8 候选期间点到别处：提交的那段至多落一次、落在原处，光标到了点的地方',
              not s8['composing'] and s8['text'] == before[:at] + c + before[at:] and abs(s8['sel'][1] - target) <= 3,
              committed=c, clickedAt=p['pos'], cursor=s8['sel'][1])
        before8, at8 = s8['text'], s8['sel'][1]
        typ('hao')
        key('space')
        time.sleep(0.4)
        s8b = cmd('state')
        c2 = commits(s8b['log'])
        check('S8b 点过去之后接着输入，落在点的地方', len(c2) >= 1 and s8b['text'] == before8[:at8] + c2 + before8[at8:],
              committed=c2)

        # ---- S9 候选期间切标签 ----
        opened = cmd('open-b')  # 第二个标签从文件树开，开完切回原标签
        s = cmd('prepare', where='paragraph')
        tab_a, at, before = s['tab'], s['sel'][1], s['text']
        typ('qiehuan')
        time.sleep(0.3)
        key('tab', 'ctrl')
        time.sleep(0.6)
        s9 = cmd('state')
        c = commits(s9['log'])
        check('S9 候选期间切标签：另一个标签里一个字都没有多', s9['tab'] != tab_a
              and s9['text'] == opened['bText'] and not s9['composing'], committed=c, landedIn=s9['tab'])
        typ('hao')
        key('space')
        time.sleep(0.4)
        s9b = cmd('state')
        c2 = commits(s9b['log'])
        bat = s9['sel'][1]
        check('S9b 切过去之后在新标签里输入照常', len(c2) >= 1
              and s9b['text'] == s9['text'][:bat] + c2 + s9['text'][bat:], committed=c2)
        s9c = cmd('menu', action='file:prev-tab', wait=400)
        check('S9c 切回原标签：组字时提交的那段至多落一次、落在原处', s9c['tab'] == tab_a
              and s9c['text'] == before[:at] + c + before[at:], committed=c)
    finally:
        win.close()

record['failures'] = failures
record_path.write_text(json.dumps(record, ensure_ascii=False, indent=1))
print(f'记录：{record_path}')
assert not failures, failures
