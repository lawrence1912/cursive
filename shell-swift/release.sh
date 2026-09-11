#!/bin/sh
# 一条龙：构建 → 测试 → E2E → 打包。全绿才出包，任何一步失败立即中止。
#
# 用法：
#   ./shell-swift/release.sh              # 测试 + 打包 dist/cursive.app
#   CURSIVE_DMG=1 ./shell-swift/release.sh  # 额外出 dist/cursive-<version>.dmg
set -e -o pipefail
cd "$(dirname "$0")/.."

echo "==> [1/4] 类型检查 + 单元测试 + 构建 renderer"
npm run typecheck --silent && npx vitest run 2>&1 | grep -E "Tests |FAIL" && npm run build --silent

echo "==> [2/4] 编译原生壳"
./shell-swift/build.sh 2>&1 | grep -E "^built|error"

echo "==> [3/4] E2E 七用例 + 崩溃恢复竞态（含拖拽条 hitTest 自检）"
FIX=/tmp/cursive-e2e
SCRATCH="$HOME/Library/Application Support/cursive/scratch"
# 上一轮留下的崩溃恢复快照，会被下一轮当成「待恢复的草稿」开出来，把用例打开的文件
# 挤成非活动标签 —— E2E 于是随机 FAIL。每轮从干净的恢复状态起跑
mkdir -p "$SCRATCH"; rm -f "$SCRATCH"/*.json
rm -rf "$FIX"; mkdir -p "$FIX/assets"
cp test/fixtures/kitchen-sink.md test/fixtures/crlf.md test/fixtures/math.md test/fixtures/mermaid.md test/fixtures/dialect.md "$FIX/"
cp test/fixtures/assets/placeholder.png "$FIX/assets/中文 图.png"
printf '# 图片测试\n\n![中文图](assets/%%E4%%B8%%AD%%E6%%96%%87%%20%%E5%%9B%%BE.png)\n' > "$FIX/img.md"
printf '# 表格测试\n\n| 左对齐 | 居中 | 右对齐 |\n| :--- | :---: | ---: |\n| a | b | c |\n| **粗体** | `code` | d |\n' > "$FIX/table.md"

run_case() {
    rm -f /tmp/cursive-shell-check.json /tmp/cursive-shell-e2e.json
    CURSIVE_SMOKE=1 ./shell-swift/cursive-shell "/tmp/cursive-e2e/$1" 2>/dev/null
    python3 - "$1" <<'PY'
import json, sys
c = json.load(open('/tmp/cursive-shell-check.json'))
e = json.load(open('/tmp/cursive-shell-e2e.json'))
r = e['result']; img = r.get('img')
ok = (c['status'] != '未命名' and c['cm'] and c.get('dragStripHit') is True
      and e['bytesEqual'] and (img is None or img['loaded'])
      and c.get('sbRows', 0) >= 1 and c.get('tabs', 0) >= 1
      and r.get('autosaved') is True and r.get('reloaded') is True
      and r.get('tabHit') is True    # 文件树藏起来后没有浮层压住第一个标签
      # 标题栏开关：原生条子给两端挖了洞（否则点击到不了网页）+ 渲染层点击真的切了面板
      and c.get('tbHoleLeft') is True and c.get('tbHoleRight') is True
      and c.get('trafficEnd', 999) <= 72   # 左按钮（x=78 起）躲开红绿灯
      and r.get('tbHitPage') is True
      # 标题栏按钮与红绿灯同一条水平线（页面 px vs 原生点，zoom=1 时 1:1）
      and abs(r.get('tbMidY', -99) - c.get('trafficMidFromTop', 0)) <= 1
      and r.get('tbToggle', {}).get('hidden') == 'none'
      and r.get('tbToggle', {}).get('restored') == 'flex')
# 双击拖拽条 = 缩放（系统偏好非 Maximize 时该项不产出，跳过）
if c.get('dblClickAction') == 'Maximize':
    ok = ok and c.get('dblClickZoomed') is True
if sys.argv[1] == 'table.md':
    ok = ok and (r['counts'].get('cm-lp-tableview', 0) >= 1)
    # 点单元格 → 真表格让位给源码，光标正好落在那一格（历史 bug：widget 吞事件，表格改不了）
    te = r.get('tableEdit') or {}
    ok = ok and te.get('revealed') is True and te.get('cell') == 'a' and '|' in (te.get('line') or '')
if sys.argv[1] == 'kitchen-sink.md':
    ok = ok and c.get('outlineRows', 0) >= 3
    ok = ok and e.get('recents', 0) >= 1
    ok = ok and r['counts'].get('cm-lp-codebar', 0) >= 1   # P1-4：代码块右上角语言标签+复制
    fp = r.get('formatProbe') or {}   # P2-1：格式化命令幂等（加粗再加粗=原文）
    ok = ok and fp.get('bolded') is True and fp.get('toggledBack') is True
    sp = r.get('searchProbe') or {}   # P2-7：查找面板中文 + 匹配计数
    ok = ok and sp.get('open') is True and sp.get('nextLabel') == '下一个' and '处' in (sp.get('matchText') or '')   # P0-1：打开过的文件进了系统最近列表
if sys.argv[1] == 'math.md':
    # P1-1：行内 + 块级公式都渲染了，且 KaTeX 字体真的加载（CSP 下被拦肉眼不一定看得出）
    m = r.get('math') or {}
    ok = ok and (m.get('inline', 0) >= 2 and m.get('block', 0) >= 2 and m.get('font') is True)
if sys.argv[1] == 'dialect.md':
    # P1-3：TOC/脚注/emoji/高亮/上下标各自渲染成组件或样式
    c2 = r['counts']
    ok = ok and (c2.get('cm-lp-toc', 0) >= 1 and c2.get('cm-lp-footnote-ref', 0) >= 2
                 and c2.get('cm-lp-emoji', 0) >= 1 and c2.get('cm-lp-highlight', 0) >= 1
                 and c2.get('cm-lp-sup', 0) >= 1 and c2.get('cm-lp-sub', 0) >= 1)
if sys.argv[1] == 'mermaid.md':
    # P1-2：正常块渲染出 SVG；非法块保留源码报错而不是白屏
    mm = r.get('mermaid') or {}
    ok = ok and mm.get('count', 0) >= 2 and mm.get('svg', 0) >= 1 and mm.get('error', 0) >= 1
print(('PASS ' if ok else 'FAIL ') + sys.argv[1])
sys.exit(0 if ok else 1)
PY
}
run_case img.md
run_case table.md
run_case kitchen-sink.md
run_case crlf.md
run_case math.md
run_case mermaid.md
run_case dialect.md

# 崩溃恢复不许抢焦点：种一份 scratch 草稿，再把 scratchList 的应答拖慢到 1.2s，
# 逼出「文件先到、恢复后到」那条顺序 —— 正常顺序下 scratchList 几毫秒就回来，测不到。
# 原 bug：恢复出来的草稿会把 argv/Finder 打开的那份挤成非活动标签；更糟的是过滤掉
# 启动空白页之后 activeId 悬空，状态栏会一直挂着一个已经不存在的文件名
printf '{"content":"# 崩溃前的草稿","fingerprint":{"eol":"\\n","bom":false},"savedAt":"2026-01-01T00:00:00Z"}' \
    > "$SCRATCH/tab-e2e-recovery.json"
rm -f /tmp/cursive-shell-check.json
CURSIVE_SMOKE=1 CURSIVE_SMOKE_SCRATCH_DELAY=1200 ./shell-swift/cursive-shell "$FIX/img.md" 2>/dev/null
python3 - <<'RECOVERY'
import json, sys
c = json.load(open('/tmp/cursive-shell-check.json'))
tabs = c.get('tabList') or []
ok = c.get('status') == 'img.md' and '未命名' in tabs
print(('PASS ' if ok else 'FAIL ') + '崩溃恢复不抢焦点 ' + str(tabs))
sys.exit(0 if ok else 1)
RECOVERY
rm -f "$SCRATCH"/*.json

echo "==> [4/4] 打包"
./shell-swift/make-app.sh
echo "全部通过，包在 dist/cursive.app"
