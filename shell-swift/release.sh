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

echo "==> [3/4] E2E 九用例 + 崩溃恢复竞态（含拖拽条 hitTest 自检）"
FIX=/tmp/cursive-e2e
SCRATCH="$HOME/Library/Application Support/cursive/scratch"
mkdir -p "$SCRATCH"
# 0.2.0 版本历史：整轮开始前清一次。每份夹具各有自己的目录，不清也不会串，
# 但清了之后「这一轮留下了几份快照」才是确定的数（同上面清 scratch 的道理）
rm -rf "$HOME/Library/Application Support/cursive/history"
rm -rf "$FIX"; mkdir -p "$FIX/assets" "$FIX/out"
cp test/fixtures/kitchen-sink.md test/fixtures/crlf.md test/fixtures/math.md test/fixtures/mermaid.md \
   test/fixtures/dialect.md test/fixtures/callout.md "$FIX/"
cp test/fixtures/assets/placeholder.png "$FIX/assets/中文 图.png"
# 三张图各守一条链：① 百分号编码的中文文件名；② 尺寸语法 `=宽x高`；
# ③ 尖括号目的地（文件名带空格时**唯一**的写法）+ 尺寸。②③ 以前在编辑器里从来没生效过
printf '# 图片测试\n\n![中文图](assets/%%E4%%B8%%AD%%E6%%96%%87%%20%%E5%%9B%%BE.png)\n\n![尺寸图](assets/%%E4%%B8%%AD%%E6%%96%%87%%20%%E5%%9B%%BE.png =120x80)\n\n![尖括号图](<assets/中文 图.png> =60x40)\n' > "$FIX/img.md"
# 标签右键菜单（0.2.0）的一次性夹具：那条用例要把它改脏再撤回，
# 拿别的用例的夹具当小白鼠的话，自动保存会在它们身上留下一个字
printf '# 标签右键测试\n\n正文一行。\n' > "$FIX/tabs.md"
# 0.2.0 链接跳转的一对夹具：links.md 里四条去处各一条 + 两条打不开的；
# link-target.md 只当落点 —— 拿别的用例的夹具当目标的话，那边的探针一改内容，
# 「落在哪一节」这条断言就跟着飘
cat > "$FIX/link-target.md" <<'TARGET'
# 目标文档

## 目标小节

顺着链接跳进来的落点。
TARGET
cat > "$FIX/我的 目标 文档.md" <<'SPACED'
# 带空格的文件名

## 空格小节

文件名里有空格的落点：这是中文笔记最常见的样子，链接必须写成 `<…>` 或 %20。
SPACED
cat > "$FIX/links.md" <<'LINKS'
# 链接测试

## 靶子

这一节是给格式栏探针当靶子的：它会把文档里**第一个**二级标题升成三级。
没有这一节的话，被升级的就是下面那个锚点落点，「跳到了哪一行」那条断言得跟着别人的
副作用走 —— 夹具宁可多一节，也不要一条会莫名其妙变红的断言。

## 小节

正文一行。

内部：[跳到小节](#小节)

外链：[外部地址](https://example.com/a)

本地：[别的文档](link-target.md#目标小节)

文件：[一张图](<assets/中文 图.png>)

带空格的文件名：[尖括号写法](<./我的 目标 文档.md#空格小节>) 与 [百分号写法](./%E6%88%91%E7%9A%84%20%E7%9B%AE%E6%A0%87%20%E6%96%87%E6%A1%A3.md) 与 [裸空格写法](./我的 目标 文档.md#空格小节)

坏的：[缺失文件](缺失.md) 与 [缺失锚点](#没有这一节) 与 [缺失图片](缺失.png)

写不对的：[看不出是文件](我的 笔记 没有后缀) —— 地址带空格又没有后缀，认不出来
LINKS
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
    # 标签右键那条用例要验「批量关闭时点取消要中止整批」，所以它的「是否保存」
    # 替身答案设成 cancel（其余用例用默认的 discard —— 万一哪里误关脏标签，
    # 当场过去而不是把整轮挂起）
    DISCARD_ENV=""
    [ "$1" = "dialect.md" ] && DISCARD_ENV="cancel"
    CURSIVE_SMOKE=1 CURSIVE_SMOKE_NAME='e2e-新建.md' CURSIVE_SMOKE_RENAME='e2e-改名.md' \
        CURSIVE_SMOKE_HTML="/tmp/cursive-e2e/out/$1.html" CURSIVE_SMOKE_PDF="$PDF_ENV" \
        CURSIVE_SMOKE_DISCARD="$DISCARD_ENV" \
        ./shell-swift/cursive-shell "/tmp/cursive-e2e/$1" 2>/dev/null
    python3 - "$1" <<'PY'
import json, sys, os, re, unicodedata
c = json.load(open('/tmp/cursive-shell-check.json'))
e = json.load(open('/tmp/cursive-shell-e2e.json'))
r = e['result']; img = r.get('img')
ok = (c['status'] != '未命名' and c['cm'] and c.get('dragStripHit') is True
      and e['bytesEqual'] and (img is None or img['loaded'])
      and c.get('sbRows', 0) >= 1 and c.get('tabs', 0) >= 1
      # 契约 v19：带文件开出来的窗口，工作区 = 那个文件所在的目录。壳侧（树根 = 防穿越
      # 守卫之界）与渲染层（侧栏真挂在那儿）各守一条 —— 从前壳侧是空的、侧栏靠渲染层
      # 兜底才挂上，于是真机上会带出「上次那个文件夹」
      and (e.get('windowRoots') or [''])[0] == '/tmp/cursive-e2e'
      and c.get('sbRoot') == '/tmp/cursive-e2e'
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
    # P1-5 的尾巴：尺寸语法端到端。解析器不给节点的那一版，这两条都会落空 ——
    # `renderImage` 拿不到 parseImage 的结果就退回 escapeHtml(raw)，导出物里是一行裸源码
    ok = ok and 'width="120" height="80"' in page
    # 尖括号目的地：解析器认领了、parseImage 却读不出 src 的话，这张图整个不出现
    ok = ok and 'width="60" height="40"' in page and '![尖括号图]' not in page
    # 编辑器那一侧：三张都渲染成了真图片（有一张没认出来就是 2，屏幕上是裸源码）
    ok = ok and r['counts'].get('cm-lp-image', 0) >= 3
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
# ---- 0.2.0：自动补全 / 命令面板 / 快速打开 / 复制为富文本 ----
# 每个用例都跑一遍：这四样都挂在编辑器与 chrome 的公共路径上，
# 哪份文档上坏了都算坏（同 P4-1 导出那条的道理）
v = r.get('v020') or {}
ok = ok and not v.get('err')
# 自动补全：真的敲了 `:sm` 让面板自己弹出来（走 activateOnTyping，不是直接调 API），
# 第一条必须是 :smile: —— 面板在、但排序坏了的话这一条就抓得到
ok = ok and v.get('rows', 0) >= 2 and v.get('first', '').startswith(':smile:')
# 敲完删回去，文档与取样时逐字节相同（红线一：补全不许在别处留下痕迹）
ok = ok and v.get('restored') is True
# 命令面板：列的是 MenuAction 全表（40 条以上），筛「高亮」后第一条就是它，Esc 关得掉
ok = ok and v.get('cmdAll', 0) >= 40 and v.get('cmdHit') == '高亮' and v.get('cmdClosed') is True
# 快速打开：索引走壳侧 listFiles（契约 v21），树根下那几份夹具都得在，Esc 同样关得掉
ok = ok and v.get('files', 0) >= 5 and v.get('fileFirst', '').endswith('.md')
ok = ok and v.get('fileClosed') is True
# 复制为富文本（契约 v20）：两种风味都得非空，且 HTML 明显比 Markdown 源码长
ch = e.get('copyHtml') or []
ok = ok and len(ch) == 2 and ch[1] > 0 and ch[0] > ch[1]
# 版本历史（契约 v22）：前面「收干净」保存过一次，所以至少落下一份快照；
# 点开它要能读回正文并算出差异（hiLines 为 0 = 要么没读回、要么 diff 空转）
ok = ok and v.get('hiRows', 0) >= 1 and v.get('hiLines', 0) >= 1
ok = ok and v.get('hiStat', '').startswith('+') and v.get('hiClosed') is True

# ---- 0.2.0 标签右键菜单（只在 dialect.md 这条用例上跑）----
if sys.argv[1] == 'dialect.md':
    tp = r.get('tabProbe') or {}
    ok = ok and not tp.get('err')
    ok = ok and tp.get('added') == 3           # 从侧栏点开三个文件，就该多三个标签
    ok = ok and tp.get('labels') == ['关闭', '关闭左边的标签', '关闭其他标签',
                                     '关闭右边的标签', '关闭所有标签']
    # 灰掉的位置要跟着右键的是哪一个走：第一个没有「左边」，最后一个没有「右边」
    ok = ok and tp.get('offAtFirst') == [False, True, False, False, False]
    ok = ok and tp.get('offAtLast') == [False, False, False, True, False]
    # 命令作用在哪个标签，那个就亮着；菜单收起要跟着灭
    ok = ok and tp.get('marked') is True and tp.get('stillContext') is False
    # 关闭右边 / 关闭左边：被右键的那个是唯一的幸存者
    ok = ok and tp.get('afterRight') == 1 and tp.get('afterLeft') == 1
    # **最要紧的一条**：批量关闭撞上脏标签、用户点了取消 → 整批停下，一个都不许少
    ok = ok and tp.get('beforeCancel') == 2 and tp.get('afterCancel') == 2

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
if sys.argv[1] == 'links.md':
    # 0.2.0 链接跳转：⌘+点击的四条去处 + 两种打不开
    lp = r.get('linkProbe') or {}
    ok = ok and not lp.get('err')
    # 预览里地址是藏着的 —— 悬停的 title 是「这条链接通向哪儿」的唯一线索
    ok = ok and lp.get('title') == '#小节'
    # ① 本文锚点：光标真的落在那一节的标题上（锚点串与 [TOC]、大纲、导出 id 同一份算法）
    ok = ok and lp.get('anchorLine') == '## 小节'
    # ② 本地文档 + 锚点：多出一个标签、活动文档换成目标文件、落点是目标那一节
    ok = ok and lp.get('tabsAfter') == lp.get('tabsBefore', -9) + 1
    ok = ok and (lp.get('openedPath') or '').endswith('link-target.md')
    ok = ok and lp.get('openedLine') == '## 目标小节'
    ok = ok and lp.get('backOnLinks') is True
    # ②b 文件名带空格：尖括号写法与百分号写法都要落到同一份文件（锚点也照跳）。
    # 这一段守的是整条链 —— 渲染层拼路径、过桥、壳侧按原样读盘，中间任何一步把空格
    # 弄丢或多编码一次都会变成「找不到文件」
    ok = ok and (lp.get('angPath') or '').endswith('/我的 目标 文档.md')
    ok = ok and lp.get('angLine') == '## 空格小节'
    ok = ok and not lp.get('angNote')
    ok = ok and lp.get('pctPath') == lp.get('angPath')
    ok = ok and not lp.get('pctNote')
    # 裸空格写法（方言放宽）：和另外两种写法同一个落点、同一节，一句话都不用说
    ok = ok and lp.get('barePath') == lp.get('angPath')
    ok = ok and lp.get('bareLine') == '## 空格小节'
    ok = ok and not lp.get('bareNote')
    # 「一个窗口 = 一个工作区」：顺着链接读下去是同一个工作区里的事，不许弹新窗口
    ok = ok and e.get('windows', 0) == 1
    # ③④ 外部地址与本地文件都交给系统（自检下只记账）。file:// 那条守的是百分号编码 ——
    # 文件名里那个空格和中文，壳侧的 scheme handler 要能原样解回来
    ext = e.get('external') or []
    ok = ok and 'https://example.com/a' in ext
    ok = ok and any(u.startswith('file:///tmp/cursive-e2e/assets/') and u.endswith('.png') for u in ext)
    # 三次交给系统：外部地址、存在的图、不存在的图（最后一条走的就是下面 fileNote 那条路）
    ok = ok and len(ext) == 3
    # ⑤⑥⑦ 三种打不开都要在状态栏说一句话：点了没反应是最糟的失败方式
    ok = ok and lp.get('missingNote') == '找不到文件：缺失.md'
    ok = ok and lp.get('anchorNote') == '本文里没有这个锚点：#没有这一节'
    # 本地文件那条要走到「系统没接手」才说得出话 —— 自检下的 openExternal 替身
    # 对 file:// 按「在不在」回话，就是为了让这条路测得到
    ok = ok and lp.get('fileNote') == '打不开：/tmp/cursive-e2e/缺失.png'
    # ⑧ 地址带空格**又看不出是哪个文件**（没后缀）：这种解析器仍然不认 ——
    # 误认比不认更糟（正文里平白多出一条蓝线），但也不能就这么没反应
    ok = ok and (lp.get('spacedNote') or '').startswith('地址里有空格')
    ok = ok and '我的 笔记 没有后缀' in (lp.get('spacedNote') or '')
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
run_case links.md

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
# 0.2.0 PDF 书签：① 渲染层报了几个标题，就得有几条落进文件（每一条都定位成功）；
# ② 写完之后 PDFKit 还认得出来 —— 这一条守的是「自己往 PDF 尾部追加的那次增量更新
# 结构合法」，而不只是「函数跑过了」（PDFKit 自己的 outlineRoot 根本写不出去，
# 见 main.swift 的 PDFOutlineWriter）
ok = ok and d.get('headings', 0) >= 1
ok = ok and d.get('bookmarks', 0) == d.get('headings', 0)
ok = ok and d.get('bookmarksReadBack', 0) >= 1
# `headings` 一起印出来：它是 0 就说明**夹具在跑的过程中被改坏了**（标题没了），
# 而不是书签逻辑坏了 —— 两者的排查方向完全不同
print(('PASS ' if ok else 'FAIL ') + 'PDF 真分页 + 书签 '
      + str({k: d.get(k) for k in ('pages', 'width', 'height',
                                   'headings', 'bookmarks', 'bookmarksReadBack')}))
sys.exit(0 if ok else 1)
PAGED

# 崩溃恢复不许抢焦点：种一份 scratch 草稿，再把 scratchList 的应答拖慢到 1.2s，
# 逼出「文件先到、恢复后到」那条顺序 —— 正常顺序下 scratchList 几毫秒就回来，测不到。
# 原 bug：恢复出来的草稿会把 argv/Finder 打开的那份挤成非活动标签；更糟的是过滤掉
# 启动空白页之后 activeId 悬空，状态栏会一直挂着一个已经不存在的文件名
printf '{"content":"# 崩溃前的草稿","fingerprint":{"eol":"\\n","bom":false},"savedAt":"2026-01-01T00:00:00Z"}' \
    > "$SCRATCH/tab-e2e-recovery.json"
rm -f /tmp/cursive-shell-check.json /tmp/cursive-shell-e2e.json
CURSIVE_SMOKE=1 CURSIVE_SMOKE_SCRATCH_DELAY=1200 ./shell-swift/cursive-shell "$FIX/img.md" 2>/dev/null
python3 - <<'RECOVERY'
import json, sys, os
c = json.load(open('/tmp/cursive-shell-check.json'))
e = json.load(open('/tmp/cursive-shell-e2e.json'))
tabs = c.get('tabList') or []
ok = c.get('status') == 'img.md' and '未命名' in tabs
# 恢复是**一次性**的：探针末尾开了第二个窗口，它照样会问一次 scratchList，
# 但那份草稿已经交出去了 —— 交出 1 份、候选集清空。
# 原 bug：`scratchList` 把目录里的东西全发一遍，于是 A 窗口正在编辑的未命名文档
# 会跟着每一个新开的窗口跑一份（两份各自再落盘，越滚越多）
once = (e.get('scratchQueries', 0) >= 2 and e.get('scratchHandouts') == 1
        and e.get('scratchPending') == 0)
ok = ok and once
print(('PASS ' if ok else 'FAIL ') + '崩溃恢复不抢焦点 ' + str(tabs)
      + ' 草稿交出 %s/问 %s 次，剩 %s' % (e.get('scratchHandouts'), e.get('scratchQueries'), e.get('scratchPending')))
sys.exit(0 if ok else 1)
RECOVERY
rm -f "$SCRATCH"/*.json

echo "==> [4/4] 打包"
./shell-swift/make-app.sh
echo "全部通过，包在 dist/Cursive.app"
