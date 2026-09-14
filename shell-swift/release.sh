#!/bin/sh
# 一条龙：构建 → 测试 → E2E → 打包。全绿才出包，任何一步失败立即中止。
#
# 用法：
#   ./shell-swift/release.sh              # 测试 + 打包 dist/Cursive.app
#   CURSIVE_DMG=1 ./shell-swift/release.sh  # 额外出 dist/Cursive-<version>.dmg
set -e -o pipefail
cd "$(dirname "$0")/.."

echo "==> [1/4] 类型检查 + 单元测试 + 构建 renderer"
npm run typecheck --silent && npx vitest run 2>&1 | grep -E "Tests |FAIL" && npm run build --silent

echo "==> [2/4] 编译原生壳"
./shell-swift/build.sh 2>&1 | grep -E "^built|error"

echo "==> [3/4] E2E 八用例 + 崩溃恢复竞态（含拖拽条 hitTest 自检）"
FIX=/tmp/cursive-e2e
SCRATCH="$HOME/Library/Application Support/cursive/scratch"
mkdir -p "$SCRATCH"
rm -rf "$FIX"; mkdir -p "$FIX/assets" "$FIX/out"
cp test/fixtures/kitchen-sink.md test/fixtures/crlf.md test/fixtures/math.md test/fixtures/mermaid.md \
   test/fixtures/dialect.md test/fixtures/callout.md "$FIX/"
cp test/fixtures/assets/placeholder.png "$FIX/assets/中文 图.png"
printf '# 图片测试\n\n![中文图](assets/%%E4%%B8%%AD%%E6%%96%%87%%20%%E5%%9B%%BE.png)\n' > "$FIX/img.md"
# 手工对齐过的表：E2E 要靠它证明「改一格不会顺手把别的列重排」
printf '# 表格测试\n\n| 左对齐   | 居中 | 右对齐 |\n| :------- | :--: | -----: |\n| a        | b    | c      |\n| **粗体** | `code` | d      |\n' > "$FIX/table.md"

run_case() {
    rm -f /tmp/cursive-shell-check.json /tmp/cursive-shell-e2e.json /tmp/cursive-shell-pdf.json
    # 上一个用例的自动保存快照会被这一个当成「待恢复的草稿」开出来，把用例打开的文件
    # 挤成非活动标签 —— 于是随机 FAIL（原先只在整轮开始前清一次，挡不住用例之间互相污染）。
    # 每个用例都从干净的恢复状态起跑；末尾那条崩溃恢复用例自己种快照，不受影响
    rm -f "$SCRATCH"/*.json
    # P4-1：顺带把导出 HTML 走一遍（壳在自检下绕过保存面板，直接落到这个路径）。
    # P4-2：PDF 只在 mermaid.md 上导 —— 它没有 findProbe，探针跑完活动标签还是它自己
    # （kitchen-sink 那条最后会跳到 table.md，导出的就不是打开的那份了），
    # 而且它有图有代码，天然跨两页，正好证明「真分页」
    PDF_ENV=""
    [ "$1" = "mermaid.md" ] && PDF_ENV="/tmp/cursive-e2e/out/$1.pdf"
    CURSIVE_SMOKE=1 CURSIVE_SMOKE_NAME='e2e-新建.md' CURSIVE_SMOKE_RENAME='e2e-改名.md' \
        CURSIVE_SMOKE_HTML="/tmp/cursive-e2e/out/$1.html" CURSIVE_SMOKE_PDF="$PDF_ENV" \
        ./shell-swift/cursive-shell "/tmp/cursive-e2e/$1" 2>/dev/null
    python3 - "$1" <<'PY'
import json, sys, os, re, unicodedata
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
# P4-1 导出 HTML：每个用例都导一次 —— 渲染路径上任何一处抛异常都会在这里现形
hp = r.get('htmlProbe') or {}
html_out = '/tmp/cursive-e2e/out/%s.html' % sys.argv[1]
ok = ok and not hp.get('error') and hp.get('path') == html_out and os.path.exists(html_out)
page = open(html_out, encoding='utf-8').read() if os.path.exists(html_out) else ''
# 单文件：外壳齐全、样式内联、没有任何外部引用与脚本
ok = ok and page.startswith('<!doctype html>') and '<style>' in page and '</html>' in page
ok = ok and 'safe-file://' not in page and 'app://' not in page and '<script' not in page

# 双击拖拽条 = 缩放（系统偏好非 Maximize 时该项不产出，跳过）
if c.get('dblClickAction') == 'Maximize':
    ok = ok and c.get('dblClickZoomed') is True
if sys.argv[1] == 'img.md':
    # P4-1：图片嵌成 data: URI —— 文档里写的是百分号编码的中文文件名，
    # 这一条同时守着「渲染层给绝对路径 → 壳逐级解码找到文件 → base64 嵌进去」整条链
    ok = ok and 'data:image/png;base64,' in page
    # P2-5：截图粘贴 + 拖拽落盘都写到 <docDir>/assets/
    pp = r.get('pasteProbe') or ''
    ok = ok and pp.startswith('assets/') and os.path.exists(os.path.join('/tmp/cursive-e2e', pp))
    ok = ok and r.get('dropProbe') is True
if sys.argv[1] == 'table.md':
    ok = ok and (r['counts'].get('cm-lp-tableview', 0) >= 1)
    # P2-6：点单元格 → 表格**留在渲染态**、焦点落进 contenteditable 的格子里
    te = r.get('tableEdit') or {}
    line = te.get('line') or ''
    ok = ok and te.get('rendered') is True and te.get('focused') is True
    # 改一格只动那一格：后面两列手工对齐的 padding 一个字节都不能变
    ok = ok and line.startswith('| a2 ') and line.endswith('| b    | c      |')
    # P2-6 下半场：底部浮动工具栏 —— 露面、加行、整列居中、整理对齐
    ok = ok and te.get('barOn') is True and te.get('addedRow') == 1
    ok = ok and te.get('delim', '').startswith('| :------: ')
    tidy = te.get('tidyLines') or []
    def dw(s):
        return sum(2 if unicodedata.east_asian_width(c) in 'WF' else 1 for c in s)
    ok = ok and len(tidy) >= 4 and len({dw(t) for t in tidy}) == 1
    # 格内行内语法：**粗体** 渲染成 <strong>
    ok = ok and te.get('strong', 0) >= 1
    hd = r.get('handles') or {}   # 悬停 +/− 手柄：行/列各一颗药丸
    ok = ok and hd.get('on') is True and hd.get('pills') == 2
if sys.argv[1] == 'kitchen-sink.md':
    # P4-1：一份「什么都有」的文档导出后该有的东西（标题锚点 / 表格 / 代码上色 / 公式）
    ok = ok and '<h1 id=' in page and '<table>' in page
    ok = ok and 'class="tok-keyword"' in page and '<math' in page
    ok = ok and c.get('outlineRows', 0) >= 3
    ok = ok and e.get('recents', 0) >= 1
    ok = ok and r['counts'].get('cm-lp-codebar', 0) >= 1   # P1-4：代码块右上角语言标签+复制
    # P1-4：```ts 块真的上了色。破了的话 span 只剩两个围栏标记、颜色只有一种
    hl = r.get('codeHl') or {}
    ok = ok and hl.get('spans', 0) >= 8 and hl.get('colors', 0) >= 4
    # 围栏藏起来 + 顶部语言条：开围栏行里一个反引号都不该剩，语言名是给人看的那个，
    # 闭围栏行没有文字且塌成边距（没塌 = 卡片底下白白多一条空行，正是当初不敢藏的原因）
    cf = r.get('codeFence') or {}
    ok = ok and cf.get('off') is True and cf.get('lang') == 'TypeScript' and cf.get('copy') is True
    ok = ok and cf.get('ticks') == -1
    ok = ok and cf.get('closeOff') is True and cf.get('closeText') == ''
    ok = ok and 0 < cf.get('closeH', -1) <= 20
    # 语言选择器：筛出 Rust → 选中 → 围栏行只换语言那个词、条子跟着改名；
    # 再选回 TypeScript，文档一个字节不差（这份文档末尾还有字节级往返断言）
    ok = ok and cf.get('picker') is True and cf.get('pickName') == 'Rust'
    ok = ok and cf.get('before') == '```ts' and cf.get('afterLabel') == 'Rust'
    ok = ok and (cf.get('after') or '').startswith('```') and (cf.get('after') or '').endswith('rust')
    ok = ok and cf.get('restored') == cf.get('before')
    fp = r.get('formatProbe') or {}   # P2-1：格式化命令幂等（加粗再加粗=原文）
    ok = ok and fp.get('bolded') is True and fp.get('toggledBack') is True
    bp = r.get('barProbe') or {}      # P2-8：底部悬浮格式栏
    ok = ok and bp.get('visible') is True
    ok = ok and bp.get('bolded') is True and bp.get('onAfterBold') is True and bp.get('restored') is True
    ok = ok and bp.get('pickName') == '标题 2' and bp.get('menuOpened') is True
    ok = ok and (bp.get('promoted') or '').startswith('### ')
    tp = r.get('treeProbe') or {}     # P3-1：文件树工具栏 + 右键新建 / 重命名 / 拖走 / 删除
    ok = ok and tp.get('tools') == ['new-file', 'new-folder', 'collapse', 'search', 'open-folder']
    ok = ok and tp.get('rootMenu') == ['新建文件', '新建文件夹', '在 Finder 中显示']
    ok = ok and tp.get('rowMenu') == ['新建文件', '新建文件夹', '重命名…', '删除文件', '在 Finder 中显示']
    ok = ok and tp.get('created') is True and tp.get('renamed') is True
    ok = ok and tp.get('moved') is True and tp.get('deleted') is True and tp.get('nested') is True
    # 三样都别在磁盘上留下痕迹：新建的、改名的、搬进 assets/ 的
    ok = ok and not os.path.exists('/tmp/cursive-e2e/e2e-新建.md')
    ok = ok and not os.path.exists('/tmp/cursive-e2e/e2e-改名.md')
    ok = ok and not os.path.exists('/tmp/cursive-e2e/assets/e2e-改名.md')
    # P3-2 跨文件搜索：壳侧流式回推 → 结果分组 → 点命中跳到别的文件并选中那一处
    fi = r.get('findProbe') or {}
    ok = ok and fi.get('groups', 0) >= 2 and fi.get('hits', 0) >= 2
    ok = ok and fi.get('marks') == fi.get('hits') and fi.get('markText') == '表格'
    ok = ok and '个文件' in (fi.get('status') or '')
    ok = ok and fi.get('treeHidden') is True and fi.get('treeBack') is True
    ok = ok and fi.get('jumped') == '表格'
    ok = ok and (fi.get('openedPath') or '').endswith('table.md')
    # P3-7 多窗口：探针末尾请壳再开一个窗口，窗口表里应该**正好**两个 ——
    # 写死 2 是为了守「打开一个 md 弹出两个窗口」那个 bug：openFile: 排在
    # didFinishLaunching 之前，两边都开窗口的话这里会变成 3
    ok = ok and e.get('windows', 0) == 2
    # 契约 v14：新窗口是带着文件夹开的，树根当场就位（渲染层还没就绪就得挡住越界写）
    ok = ok and (e.get('windowRoots') or ['', ''])[-1] == '/tmp/cursive-e2e'
    sp = r.get('searchProbe') or {}   # 查找面板：右上角浮层 + 面板内计数 + ⌥⌘F 摊开替换
    ok = ok and sp.get('open') is True and sp.get('nextLabel') == '下一个'
    ok = ok and '处' in (sp.get('matchText') or '') and '/' in (sp.get('panelCount') or '')
    ok = ok and sp.get('replaceShown') is True and sp.get('closed') is True
    ok = ok and sp.get('replaceFolded') is True   # 三角收得起来（[hidden] 真的生效）
    # 贴着编辑区的上沿与右沿浮着（margin 10/14，留点余量）
    ok = ok and 0 <= sp.get('floatTop', -1) <= 26 and 0 <= sp.get('floatRight', -1) <= 30
    # 面板不再贴底通栏，格式栏也就不用再抬高让位（老版本这里是个非空 px 值）
    ok = ok and (sp.get('barBottom') or '') == ''
    ok = ok and e.get('recents', 0) >= 1   # P0-1：打开过的文件进了系统最近列表
    # P3-6：大纲取数与 [TOC] 合并成一份，标题文本是给人看的 ——
    # setext 不拖下划线、行内语法不再是裸源码
    rows = r.get('outlineRows') or []
    ok = ok and '带 粗体 和 码 的 setext 标题' in rows
    ok = ok and not any(('=' in t or '**' in t or '`' in t) for t in rows)
    # P3-3：专注模式压暗非当前段落；打字机把光标行停在视口 42% 高度上
    wp = r.get('writingProbe') or {}
    ok = ok and wp.get('focusOn') is True and wp.get('focusOff') is True
    ok = ok and wp.get('lit', 0) >= 1
    # 切模式时焦点还在查找框里 → main.ts 的 focusEditor() 不许 WebKit 顺手滚动
    # （不挡的话画面会跳到旧 DOM 选区上，上面那条 lit 也会跟着挂）
    ok = ok and wp.get('scrollKept') is True
    # 压暗只改文字颜色：暗区的 opacity 必须还是 1（盖遮罩那版会把图和代码块一起褪灰）
    ok = ok and wp.get('litOpacity') == 1 and wp.get('dimOpacity') == 1
    ok = ok and wp.get('imgOpacity') == 1
    ok = ok and wp.get('litColor') and wp.get('litColor') != wp.get('dimColor')
    ok = ok and wp.get('padTop', 0) > 100          # 打字机给顶部留的 42vh
    ok = ok and abs(wp.get('ratio', -9) - 0.42) <= 0.02   # 光标行顶边落在 42% 那条线上
    ok = ok and wp.get('typewriterOff') is True
    # P3-6 下半场：字数 / 折叠 / 层级档位 / 过滤框 / 右键菜单 / 拖拽重排
    op = r.get('outlineProbe') or {}
    ok = ok and op.get('all', 0) >= 6
    ok = ok and any(w > 0 for w in (op.get('words') or []))          # 每节字数
    ok = ok and 0 < op.get('foldedCount', 0) < op.get('all', 0)      # 折起来行数变少
    ok = ok and op.get('unfoldedCount') == op.get('all')             # 展开复原
    ok = ok and op.get('onlyH1') is True and op.get('h1Count', 99) < op.get('all', 0)
    ok = ok and op.get('backToAll') is True
    ok = ok and op.get('filtered') == ['表格'] and op.get('marks', 0) == 1
    ok = ok and op.get('clearHiddenAtRest') is True and op.get('clearShownWhenTyped') is True
    ok = ok and op.get('menu') == ['复制本节锚点', '在此后新建同级标题', '升一级', '降一级']
    ok = ok and op.get('demoted') is True                            # 右键降级真的加了个 #
    ok = ok and op.get('posFresh') is True                           # 改完立刻重建，行上的 pos 不是旧的
    ok = ok and op.get('dropShown') is True                          # 拖拽时有落点指示线
    ok = ok and op.get('movedBytesEqual') is True                    # 搬完字节只换了顺序
    # P3-8 状态栏与统计：光标行列 / 选区字数 / 详细统计面板
    st = r.get('statsProbe') or {}
    ok = ok and st.get('pos') == '行 %d · 列 2' % st.get('line', -1)
    ok = ok and bool(re.match(r'^[\d,]+ 词 · [\d,]+ 字符 · (约 \d+|不到 1) 分钟$', st.get('docText') or ''))
    ok = ok and bool(re.match(r'^已选 [\d,]+ 词 · [\d,]+ 字符$', st.get('selText') or ''))
    ok = ok and st.get('selClass') is True
    # 面板不抢焦点（条子上 mousedown 被挡）—— 否则选区没了，「选中」那一列是空的
    ok = ok and st.get('selDone') is True and st.get('hasSel') is True
    ok = ok and st.get('labels') == ['词', '字符', '不含空格', '中日韩字', '拉丁词', '段落', '行', '阅读时间']
    ok = ok and st.get('cols') == 3 and st.get('nums') == 16   # 三列表头 + 8 行 × 2 个数
    ok = ok and st.get('closed') is True                        # Escape 关得掉
    ok = ok and st.get('backText') == st.get('docText')         # 取消选区读数复原
if sys.argv[1] == 'math.md':
    # P4-1：导出的公式走 MathML（不依赖 KaTeX 的 CSS 与字体）
    ok = ok and '<math' in page and 'class="math-block"' in page
    # P1-1：行内 + 块级公式都渲染了，且 KaTeX 字体真的加载（CSP 下被拦肉眼不一定看得出）
    m = r.get('math') or {}
    ok = ok and (m.get('inline', 0) >= 2 and m.get('block', 0) >= 2 and m.get('font') is True)
if sys.argv[1] == 'dialect.md':
    # P4-1：目录与脚注在导出里是真的锚点
    ok = ok and '<nav class="toc">' in page and '<sup class="footnote-ref"' in page
    ok = ok and 'href="#fn-1"' in page and 'id="fn-1"' in page
    # P1-3：TOC/脚注/emoji/高亮/上下标各自渲染成组件或样式
    c2 = r['counts']
    ok = ok and (c2.get('cm-lp-toc', 0) >= 1 and c2.get('cm-lp-footnote-ref', 0) >= 2
                 and c2.get('cm-lp-emoji', 0) >= 1 and c2.get('cm-lp-highlight', 0) >= 1
                 and c2.get('cm-lp-sup', 0) >= 1 and c2.get('cm-lp-sub', 0) >= 1)
if sys.argv[1] == 'callout.md':
    # P4-1：告示块导出成卡片，图标是内联 SVG（不依赖字体）
    ok = ok and 'class="callout callout-danger"' in page and '<svg class="ic"' in page
    # P1-6：告示块渲染成卡片（危险那档有自己的色）、图标 widget 在、
    # 没写标题的补了中文名、折叠三角真的折而且一个字节都不碰文档
    c2 = r['counts']
    ok = ok and c2.get('cm-lp-callout-danger', 0) >= 1 and c2.get('cm-lp-callout', 0) >= 8
    cp = r.get('calloutProbe') or {}
    names = cp.get('names') or []
    ok = ok and cp.get('icons', 0) >= 5
    ok = ok and '笔记' in names and '注意' in names   # 大写 [!WARNING] 也落在别名表里
    # --cal-* 没解析到的话所有档位会是同一个继承色
    ok = ok and cp.get('danger') and cp.get('danger') != cp.get('note')
    # `[!summary]-` 默认折起 → 点三角展开 → 再点折回；折叠状态不写回文档
    ok = ok and (cp.get('more0'), cp.get('more1'), cp.get('more2')) == (1, 0, 1)
    ok = ok and cp.get('docLen') == cp.get('docLenAfter')
if sys.argv[1] == 'mermaid.md':
    # P4-1：图烘成静态 SVG 写进文件（导出物里不留运行时依赖）；非法那块保留源码
    ok = ok and '<figure class="mermaid"' in page and '<svg' in page
    ok = ok and 'class="mermaid-src"' in page
    # P4-2：**页面是 A4（595×842），不是一张几米长的长条**（老实现出的就是长条）。
    # 「真的在分页」由后面那条独立用例证（页数取决于文档长度，而探针会改文档，
    # 拿这份夹具去断言页数就是在赌它这一轮有多长）
    pdf = json.load(open('/tmp/cursive-shell-pdf.json')) if os.path.exists('/tmp/cursive-shell-pdf.json') else {}
    ok = ok and not pdf.get('error')
    ok = ok and pdf.get('width') == 595 and pdf.get('height') == 842
    ok = ok and pdf.get('pages', 0) >= 1 and pdf.get('bytes', 0) > 5000
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
run_case callout.md

# P4-2 真分页：拿一份足够长的文档单独导一次 PDF。八个夹具都只有一两页，而页数又随
# 探针改文档而变 —— 只有专门造一份长文档，「分页」这件事才断言得住（老实现无论多长都是一页）
python3 - > "$FIX/long.md" <<'LONG'
print('# 长文档（真分页用）\n')
for i in range(200):
    print('第 %d 段。' % (i + 1) + '中文正文内容，用来把文档撑到好几页。' * 2 + '\n')
LONG
rm -f /tmp/cursive-shell-pdf.json
CURSIVE_SMOKE=1 CURSIVE_SMOKE_PDF="$FIX/out/long.pdf" ./shell-swift/cursive-shell "$FIX/long.md" 2>/dev/null
python3 - <<'PAGED'
import json, os, sys
path = '/tmp/cursive-shell-pdf.json'
d = json.load(open(path)) if os.path.exists(path) else {}
ok = (not d.get('error') and d.get('width') == 595 and d.get('height') == 842
      and d.get('pages', 0) >= 3 and d.get('bytes', 0) > 5000)
print(('PASS ' if ok else 'FAIL ') + 'PDF 真分页 '
      + str({k: d.get(k) for k in ('pages', 'width', 'height')}))
sys.exit(0 if ok else 1)
PAGED

# 崩溃恢复不许抢焦点：种一份 scratch 草稿，再把 scratchList 的应答拖慢到 1.2s，
# 逼出「文件先到、恢复后到」那条顺序 —— 正常顺序下 scratchList 几毫秒就回来，测不到。
# 原 bug：恢复出来的草稿会把 argv/Finder 打开的那份挤成非活动标签；更糟的是过滤掉
# 启动空白页之后 activeId 悬空，状态栏会一直挂着一个已经不存在的文件名
printf '{"content":"# 崩溃前的草稿","fingerprint":{"eol":"\\n","bom":false},"savedAt":"2026-01-01T00:00:00Z"}' \
    > "$SCRATCH/tab-e2e-recovery.json"
rm -f /tmp/cursive-shell-check.json
CURSIVE_SMOKE=1 CURSIVE_SMOKE_SCRATCH_DELAY=1200 ./shell-swift/cursive-shell "$FIX/img.md" 2>/dev/null
python3 - <<'RECOVERY'
import json, sys, os
c = json.load(open('/tmp/cursive-shell-check.json'))
tabs = c.get('tabList') or []
ok = c.get('status') == 'img.md' and '未命名' in tabs
print(('PASS ' if ok else 'FAIL ') + '崩溃恢复不抢焦点 ' + str(tabs))
sys.exit(0 if ok else 1)
RECOVERY
rm -f "$SCRATCH"/*.json

echo "==> [4/4] 打包"
./shell-swift/make-app.sh
echo "全部通过，包在 dist/Cursive.app"
