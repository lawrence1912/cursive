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

echo "==> [2/4] 编译原生壳 + 原生专项（键盘焦点 / 第八节 5–7 核心流程）"
./shell-swift/build.sh 2>&1 | grep -E "^built|error"
python3 shell-swift/check-focus.py
# 第八节 5–7：只读阅读模式、后退 / 前进、重新打开关闭的标签。真窗口里走菜单那条路，
# 每条「挡住了」都钉着一个「可编辑时真的会改」的证人（test/native-flow.js）
python3 shell-swift/check-flow.py

echo "==> [3/4] E2E 十一用例 + 崩溃恢复竞态（含拖拽条 hitTest 自检）"
ARTIFACTS=$(mktemp -d /tmp/cursive-e2e-results.XXXXXX)
echo "E2E 逐用例记录：$ARTIFACTS"
FIX=/tmp/cursive-e2e
# 自检的应用支持目录**整个搬进临时目录**（0.4.1 修）。从前这儿写的是
# `$HOME/Library/Application Support/cursive/…`，于是跑一轮发布自检要在开发机上
# `rm -rf` 真实的版本历史、逐用例清空真实的崩溃恢复草稿、往真实的 themes/ 里
# 丢一张探针皮肤 —— 那都是这台机器上用户自己的东西，而自检要的只是一个**确定的**
# 起点，跟它在哪儿无关。壳侧认 `CURSIVE_SMOKE_SUPPORT`（只在 CURSIVE_SMOKE 下生效，
# 见 main.swift 的 supportBaseURL），`test/smoke-harness.test.ts` 扫源码守着这条。
SUPPORT=/tmp/cursive-e2e-support
export CURSIVE_SMOKE_SUPPORT="$SUPPORT"
rm -rf "$SUPPORT"
# 整轮结束就收走，**成功失败两条路都走这儿** —— 从前那句收皮肤的 rm 挂在末尾，
# `set -e` 下任何一条断言红了都走不到，于是失败一次就在真实目录里留下一张 e2e-skin.css
trap 'rm -rf "$SUPPORT"' EXIT
SCRATCH="$SUPPORT/cursive/scratch"
mkdir -p "$SCRATCH"
# 0.2.0 版本历史：整轮开始前清一次。每份夹具各有自己的目录，不清也不会串，
# 但清了之后「这一轮留下了几份快照」才是确定的数（同上面清 scratch 的道理）
rm -rf "$SUPPORT/cursive/history"
# 0.3.0 T4：给「停用自定义皮肤」放一张认得出来的皮肤（.cm-content 染成 rgb(1,2,3)）。
# 皮肤是从应用支持目录的 themes/ 扫的（没有第二条路），那个目录此刻已经是临时的那份；
# 名字仍带 e2e- 前缀 —— 万一哪天这套隔离又被绕过去，一眼认得出是谁留下的
THEMES="$SUPPORT/cursive/themes"
mkdir -p "$THEMES"
printf '.cm-content { background: rgb(1, 2, 3); }\n' > "$THEMES/e2e-skin.css"
rm -rf "$FIX"; mkdir -p "$FIX/assets" "$FIX/out"
cp test/fixtures/kitchen-sink.md test/fixtures/crlf.md test/fixtures/math.md test/fixtures/mermaid.md \
   test/fixtures/dialect.md test/fixtures/callout.md test/fixtures/bom.md "$FIX/"
cp test/fixtures/assets/placeholder.png "$FIX/assets/中文 图.png"
# 第八节 3 走查②要一个**落在文末**的块级公式：「展开会让文档变矮、滚动被夹回去」
# 只在文末才发生（文档中间有的是内容把高度撑着）。追加在副本上，仓库里的夹具不动
printf '\n$$\n\\begin{aligned}\na &= b + c \\\\\nd &= e + f \\\\\ng &= h + i\n\\end{aligned}\n$$\n' >> "$FIX/math.md"
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
# 0.4.0 F2 跨文件替换的四份夹具。三种指纹各一份 —— 替换走的是与保存同一条
# decode/encode 路，CRLF 的改完还得是 CRLF、带 BOM 的还得带 BOM；
# 每份都留一行**不含命中**的正文，用来证明「没命中的行一个字节不动」
python3 - <<'REPFIX'
import io, os
d = '/tmp/cursive-e2e'
io.open(os.path.join(d, 'rep-lf.md'), 'w', encoding='utf-8', newline='').write(
    '# 替换 LF\n\n第一处 术语 在这儿。\n没有命中的一行 —— 一个字节都不许动。\n又一处 术语 收尾。\n')
io.open(os.path.join(d, 'rep-crlf.md'), 'w', encoding='utf-8', newline='').write(
    '# 替换 CRLF\r\n\r\n这一行有 术语 在。\r\n这一行没有。\r\n')
io.open(os.path.join(d, 'rep-bom.md'), 'w', encoding='utf-8-sig', newline='').write(
    '# 替换 BOM\n\n带 BOM 的 术语 一处。\n尾行不动。\n')
io.open(os.path.join(d, 'rep-undo.md'), 'w', encoding='utf-8', newline='').write(
    '# 撤销\n\n这里有一个 待撤销 的词。\n')
REPFIX

# 第八节 4：读盘失败的三种夹具。壳要把它们分成三类（契约 v35），从前四种失败
# 在渲染层长得一模一样。**GBK 那份不能用 printf 写** —— 得真是一段非 UTF-8 字节；
# 000 那份靠权限位，整轮末尾随 $FIX 一起 rm -rf（目录可写，删得掉）
python3 -c "open('/tmp/cursive-e2e/gbk.md','wb').write('# 中文标题\n正文两行。\n'.encode('gbk'))"
printf '# 读不动
' > "$FIX/denied.md"
chmod 000 "$FIX/denied.md"

# 手工对齐过的表：E2E 要靠它证明「改一格不会顺手把别的列重排」
printf '# 表格测试\n\n| 左对齐   | 居中 | 右对齐 |\n| :------- | :--: | -----: |\n| a        | b    | c      |\n| **粗体** | `code` | d      |\n' > "$FIX/table.md"
# 第八节 3 走查③（连着进两张表）**自己一份夹具**：往 table.md 里加第二张表会把
# 那条用例原有的断言搅了（实测底部工具栏那条当场翻红）。同 tabs.md / link-target.md
# 的道理 —— 拿别的用例的夹具当小白鼠，红起来分不清是谁的错
printf '# 两张表\n\n| 一表左 | 一表右 |\n| ------ | ------ |\n| a      | b      |\n\n正文一行，把两张表隔开。\n\n| 二表左 | 二表右 |\n| ------ | ------ |\n| x      | y      |\n' > "$FIX/tables.md"

# A1 排序的三个证人（目录在前 + Finder 的比法）。`out/` 本来就在（字母序落在中间，
# 必须被提到所有文件前面），这里再补两类裸 `sorted()` 一定会排错的名字：
# 数字要按**数值**比（第2 < 第10），大小写**不能分家**（裸码位会把 Zebra 抬到最前）
printf '# 第2章\n' > "$FIX/第2章.md"
printf '# 第10章\n' > "$FIX/第10章.md"
printf '# Zebra\n' > "$FIX/Zebra.md"

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
    # 0.3.0 T2 检查更新：替身**一个字节都不联网**，两个版本依次作答 ——
    # 依次是「有新版本」（9.9.9）、「已是最新」（0.0.0 = 裸二进制读不到 Info.plist
    # 时壳回的那个值，正好等于此刻的 current）、「那边还没发过 release」（none，真实
    # 世界里的 404）、「没问着」（fail，断网那一种）。只装在这一条用例上：别的用例连
    # `CURSIVE_SMOKE_UPDATE` 都没有，那时替身回 null，等于这条路彻底不开
    UPDATE_ENV=""
    [ "$1" = "crlf.md" ] && UPDATE_ENV="9.9.9,0.0.0,none,fail"
    # 0.3.0 T3 导出为长图：只在 img.md 上跑 —— 那份夹具有三张图，
    # 顺带把「图片一律嵌成 data: URI」（长图指不着本地文件）也走一遍
    PNG_ENV=""
    [ "$1" = "img.md" ] && PNG_ENV="/tmp/cursive-e2e/out/img.png"
    CURSIVE_SMOKE=1 CURSIVE_SMOKE_NAME='e2e-新建.md' CURSIVE_SMOKE_RENAME='e2e-改名.md' \
        CURSIVE_SMOKE_HTML="/tmp/cursive-e2e/out/$1.html" CURSIVE_SMOKE_PDF="$PDF_ENV" \
        CURSIVE_SMOKE_DISCARD="$DISCARD_ENV" CURSIVE_SMOKE_UPDATE="$UPDATE_ENV" \
        CURSIVE_SMOKE_PNG="$PNG_ENV" \
        ./shell-swift/cursive-shell "/tmp/cursive-e2e/$1" 2>"$ARTIFACTS/$1.log"
    for kind in check e2e pdf; do
        record="/tmp/cursive-shell-$kind.json"
        [ ! -f "$record" ] || cp "$record" "$ARTIFACTS/$1.$kind.json"
    done
    python3 - "$1" <<'PY'
import json, sys, os, re, struct, hashlib, unicodedata
px = lambda v: float(str(v or '0').replace('px', '') or 0)
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
      # 0.3.0 T5：窗口位置按**工作区**记，键里那串摘要就是工作区根的 SHA-256 前 16 位。
      # 这里独立算一遍与壳对账 —— 从前所有窗口共用一个 `Main`，只有第一个窗口的位置算数
      and c.get('frameAutosaveKey') == 'Main-' + hashlib.sha256(b'/tmp/cursive-e2e').hexdigest()[:16]
      # 而自检下这个名字**不许真的挂上去**：挂了就会把开发机记住的窗口位置改掉，
      # 更要紧的是自检的窗口大小会变成「上次跑完留下的那个」，视口敏感的断言跟着飘
      and not c.get('frameAutosaveLive')
      and r.get('autosaved') is True and r.get('reloaded') is True
      and r.get('tabHit') is True    # 文件树藏起来后没有浮层压住第一个标签
      # 文件树藏起来后，红绿灯右边那一截空当还在 = 窗口还拖得动（两侧都藏 + 标签排满时
      # 它是唯一的抓手；挖洞按真实 rect 报，没有元素的地方才留得住拖拽）
      and r.get('tbGutter') is True
      # 标题栏开关：原生条子给两端挖了洞（否则点击到不了网页）+ 渲染层点击真的切了面板
      and c.get('tbHoleLeft') is True and c.get('tbHoleRight') is True
      # 0.2.x 顶栏合并：正文的标签坐在原生拖拽条底下，挖洞区（契约 v26，渲染层量了报上来）
      # 必须把它放行 —— 报漏了标签就一个点击都收不到，而页面那一侧的 tabHit 照样是绿的
      and c.get('tabUnderStrip') is True and c.get('tabNativeHole') is True
      and c.get('trafficEnd', 999) <= 72   # 左按钮（x=78 起）躲开红绿灯
      and r.get('tbHitPage') is True
      # 标题栏按钮与红绿灯同一条水平线（页面 px vs 原生点，zoom=1 时 1:1）
      and abs(r.get('tbMidY', -99) - c.get('trafficMidFromTop', 0)) <= 1
      and r.get('tbToggle', {}).get('hidden') == 'none'
      and r.get('tbToggle', {}).get('restored') == 'flex')
# 第八节 4：读盘失败分四类（契约 v35）。三种真失败各造了一份夹具，
# 壳回的必须是「类别 | 路径」而不是同一句「读不到文件」
op = r.get('openFailProbe') or {}
ok = ok and op.get('gbk') == 'notUtf8' and op.get('missing') == 'notFound'
ok = ok and op.get('denied') == 'denied'
# 能读的那一份照样读得到（证明这条用例不是在报一片红）
ok = ok and op.get('fine') is True

# 第八节 1：保存状态归**标签**自己。每个用例都走一遍 —— 它量的是一条人人都在的路
sp = r.get('saveProbe') or {}
# 刚自动保存完 → 那一格有话说，而且不是黄的（黄色只留给「保存失败」）
ok = ok and bool(sp.get('savedText')) and sp.get('savedWarn') is False
# 改一个字就换了一句话：没落盘的内容不许显示成「已保存」
ok = ok and bool(sp.get('dirtyText')) and sp.get('dirtyText') != sp.get('savedText')
# **靶子**：换到一个从来没落过盘的空白标签，那一格必须一个字都没有。
# tabsOpen 证明这条断言还证明得了东西（真的换到了第二个标签上）
# **数的是「多出来一个」**：所有用例共用一个工作区根，上一条用例留在会话里的标签
# 会在这一条启动时被恢复出来，写死 2 会随用例顺序随机变红（真踩过）
ok = ok and sp.get('blankText') == '' and sp.get('tabsOpen') == sp.get('tabsBefore', -9) + 1
# 切回来还是原来那句（去掉时刻里的数字再比，跨分钟不飘）
ok = ok and sp.get('back') is True
# 壳侧写盘失败回的那句话非空 —— 状态栏「保存失败」那一格的 title 读的就是它
ok = ok and bool((sp.get('writeFail') or '').strip())
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
    # ---- 第八节 3 走查①：跨图片拖选 ----
    # 拖过一张渲染出来的图时回显布局必须冻住（holdPointerLayout）。量法是**同一个屏幕
    # 坐标问两次**：拖到一半问一次、拖到终点再问一次 —— 不冻的话那张图会在半路翻成
    # 源码、下面的东西整体上跳，两次答案就不一样了（也就是「人手底下的落点被换掉了」）
    dp = r.get('dragProbe') or {}
    ok = ok and dp.get('steady') is True
    # 选区真的跨过了那张图（这条用例才证明得了东西）
    ok = ok and dp.get('covers') is True
    # 拖选期间视口一动不动
    ok = ok and dp.get('scrolled') == 0
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
    # 0.3.0 T3 导出为长图：菜单 → 同一份导出 HTML → 壳侧离屏渲染 + 快门 → 写盘
    pg = r.get('pngProbe') or {}
    ok = ok and not pg.get('err')
    ok = ok and '长图已导出' in (pg.get('note') or '')
    png = '/tmp/cursive-e2e/out/img.png'
    ok = ok and os.path.exists(png)
    if ok:
        raw = open(png, 'rb').read()
        # 直接读 PNG 头（IHDR 的宽高），别信回执里那句话 —— 那句是渲染层说的，
        # 而这一条要证的是**盘上那张图**真是这么大
        pw, ph = struct.unpack('>II', raw[16:24])
        # 宽度 = 正文栏宽 × 2（2 倍图）。这条同时钉死两处耦合：
        # 导出 CSS 的 `--column` 是 rem × 根字号 16px，以及壳侧那个 PNG_SCALE
        ok = ok and pw == pg.get('wantWidth', 0) * 2
        # 高度：一张长图（比宽的多），而且没撞上上限（撞了就是另一条分支，回执会变）
        ok = ok and ph > pw and ph < 32768
        # 图片嵌进去了：几张 icon 的 base64 摊开，一张空白页绝到不了这个量
        ok = ok and len(raw) > 100_000
if sys.argv[1] == 'tables.md':
    # ---- 第八节 3 走查③：连着进两张表 ----
    # 第一张进就地编辑态之后再点第二张：第二张要接上，**而且两张都得留在渲染态** ——
    # 「进/出」的条件是 0.4.x 修过两轮的地方（docs/table-editing.md 判断 3 / 5），
    # 从前栽过的样子正是「点完第二张，第一张塌回管道符源码」
    th = r.get('tableHopProbe') or {}
    ok = ok and th.get('views0') == 2          # 夹具真有两张表
    ok = ok and th.get('firstOn') is True and th.get('secondOn') is True
    ok = ok and th.get('stillRendered') == 2
    ok = ok and th.get('bar') is True          # 工具栏跟着走到第二张
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
    # 0.4.0 修：⌘Z 的去路。在格子里打过字（WebKit 撤销栈里压着一条真记录）之后
    # 回车加一行 —— 整张表的格子重建，那条记录当场作废。撤销必须照样把那一行撤掉，
    # **而且只撤那一行**（打的字还在），重做拿得回来，表格还留在渲染态。
    # 从前这里什么都不会发生：菜单项照亮、⌘Z 被它吃掉，落进 WebKit 的死路
    ur = te.get('undoRound') or {}
    ok = ok and ur.get('typedIn') is True and ur.get('addedRow') is True
    ok = ok and ur.get('undone') is True
    ok = ok and ur.get('redone') is True and ur.get('stillRendered') is True
    hd = r.get('handles') or {}   # 悬停 +/− 手柄：行/列各一颗药丸
    ok = ok and hd.get('on') is True and hd.get('pills') == 2
# ---- 0.2.0：自动补全 / 命令面板 / 快速打开 / 复制为富文本 ----
# 每个用例都跑一遍：这四样都挂在编辑器与 chrome 的公共路径上，
# 哪份文档上坏了都算坏（同 P4-1 导出那条的道理）
v = r.get('v020') or {}
ok = ok and not v.get('err')
sp = r.get('searchProbe') or {}
ok = ok and sp.get('activeTabFocus') is True and sp.get('activeTabStable') is True
# 自动补全：真的敲了 `:sm` 让面板自己弹出来（走 activateOnTyping，不是直接调 API），
# 第一条必须是 :smile: —— 面板在、但排序坏了的话这一条就抓得到
ok = ok and v.get('rows', 0) >= 2 and v.get('first', '').startswith(':smile:')
# 敲完删回去，文档与取样时逐字节相同（红线一：补全不许在别处留下痕迹）
ok = ok and v.get('restored') is True
# 命令面板：列的是 MenuAction 全表（40 条以上），筛「高亮」后第一条就是它，Esc 关得掉
ok = ok and v.get('cmdAll', 0) >= 40 and v.get('cmdHit') == '高亮' and v.get('cmdClosed') is True
ok = ok and v.get('cmdFocusInside') is True and v.get('cmdFocusRestored') is True
ok = ok and v.get('tabDOMStable') is True
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
ok = ok and v.get('hiFocusInside') is True and v.get('hiTabInside') is True and v.get('hiFocusRestored') is True
# 0.4.0 F3 的两个新源。**公式那条的要害是「正文里不许弹」**：那儿的反斜杠是转义，
# 弹一张希腊字母表纯属打扰 —— 一正一反两条一起断言，只测「弹得出来」是测不到分寸的
ok = ok and any('alpha' in it for it in (v.get('mathItems') or []))
ok = ok and (v.get('plainItems') or []) == []
# 链接目的地：列的是**相对当前文档**的写法（绝对路径 = 那条 /private 软链没抹平）
li = v.get('linkItems') or []
ok = ok and len(li) >= 2 and not any(it.startswith('/') for it in li)
ok = ok and v.get('completeRestored') is True
# 0.4.0 还的第四条账：⌘P 归「打印…」，导出 PDF 让到 ⇧⌘P（菜单是原生的，网页那侧看不见）
fm = c.get('fileMenu') or []
ok = ok and any(i['title'].startswith('打印') and i['key'] == 'p' and not i['shift'] for i in fm)
ok = ok and any('PDF' in i['title'] and i['key'] == 'p' and i['shift'] for i in fm)

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

if sys.argv[1] == 'table.md':
    # 0.3.0 T4 停用自定义皮肤（安全出口）：面板里选上 → 生效 → 菜单停用 → 摘掉 → 再启用
    sk = r.get('skinProbe') or {}
    ok = ok and not sk.get('err')
    ok = ok and 'e2e-skin' in (sk.get('listed') or [])
    # 真的叠上去了（看计算样式，不看那个 <style> 元素在不在 ——
    # 「挂上了但一条没生效」正是这一轮顺带补的那种静默失败）
    ok = ok and sk.get('onBg') == 'rgb(1, 2, 3)'
    # 停用之后必须真的不见了，而且状态栏说清楚是哪一头
    ok = ok and sk.get('offBg') != 'rgb(1, 2, 3)'
    ok = ok and '已停用' in (sk.get('offNote') or '')
    # 再按一次回得去 —— 皮肤改好之后，人手边只有这条菜单
    ok = ok and sk.get('backBg') == 'rgb(1, 2, 3)'
    ok = ok and '已启用' in (sk.get('backNote') or '')
    # 探针自己收干净了（皮肤退选），否则它会跟着 localStorage 留给后面的用例
    ok = ok and sk.get('cleaned') != 'rgb(1, 2, 3)'
if sys.argv[1] == 'kitchen-sink.md':
    # ---- 第八节 3 走查④：切源码模式，阅读位置要稳 ----
    # 切换是一次 reconfigure：文档没变，整篇的高度全变了（图/公式/表换成源码）。
    # 量的是「视口顶上那一行的行号」—— 位置按像素留在原地的话，看的那一行早跑没了
    mp = r.get('modeProbe') or {}
    ok = ok and mp.get('inSource') is True and mp.get('restored') is True
    ok = ok and mp.get('drift') == 0 and mp.get('driftBack') == 0
    # ---- 第八节 3 走查⑤：中文输入候选期间点一下别处 ----
    # 红线二：合成期间绝不重算装饰器（候选窗开着时结构一变，WebKit 把候选整个撤掉 =
    # 中文连打掉字）。量的是看得见的东西：那一行会不会翻回源码
    ip = r.get('imeProbe') or {}
    ok = ok and ip.get('started') is True and ip.get('renderedBefore') is True
    ok = ok and ip.get('heldRendered') is True and ip.get('kept') is True
    # moved：那一下点击真的落下去了；revealedAfter：合成收工之后它**翻得动** ——
    # 两条都是「这条用例还证明得了东西」的证人
    ok = ok and ip.get('moved') is True and ip.get('revealedAfter') is True
    # ---- 第八节 2：外部修改冲突 ----
    # 这条路从前一次都没被自检跑过（原生弹窗的 runModal 会把无人值守的自检卡死）。
    # 只挂在这一条用例上：它要等过整个自动保存窗口，每条都跑就是白花小一分钟
    cp = r.get('conflictProbe') or {}
    ok = ok and cp.get('shown') is True
    # 面板里两份都看得见：− 是磁盘那份、+ 是我这份（从前那个弹窗上人什么都看不见，
    # 两个按钮却各丢掉一份内容）
    ok = ok and cp.get('sawDisk') is True and cp.get('sawMine') is True
    # 状态栏那一格换成了黄色的「外部已修改 · 查看差异」，而且它带着出口
    ok = ok and cp.get('statusWarn') is True and cp.get('statusAct') is True
    # **最要紧的一条**：冲突挂着的时候自动保存真的停住了 —— 等过 2 秒防抖窗口，
    # 磁盘上还是外面那份。这是整条改动里唯一会真丢东西的地方（从前非活动标签
    # 只挂一个 ⚠，两秒后照样一声不响地盖掉）
    ok = ok and cp.get('notOverwritten') is True
    # 点「保留我的」之后盘上才轮到我这份，而磁盘那份已经先进了版本历史
    ok = ok and cp.get('resolved') is True and cp.get('diskKept') is True
    # ---- 契约 v36：写盘那一刻自己比一次 ----
    # 上面那一幕靠文件监听，而监听有 300ms 合并窗、自动保存是停手 2 秒 —— 外面在那
    # 300ms 里写一笔的话，我们会先盖上去，事件随后才到、读到的已经是自己那份，
    # 冲突永远不会出现。这一条逼的就是那条竞态：外部写完**立刻**按 ⌘S
    ok = ok and cp.get('racePanel') is True
    # **一个字节都没写下去**：盘上还是外面那份
    ok = ok and cp.get('raceHeld') is True
    # ---- 第三幕：外面只改了换行符，正文一个字没动 ----
    # 写前比对最容易漏的一种：光比正文完全看不见它 —— 于是我们按旧指纹写回去，
    # 人家刚做的 LF→CRLF 转换被悄悄撤销（红线一：保存零损耗）
    ok = ok and cp.get('fpPanel') is True and cp.get('fpHeld') is True
    # （面板里那句 `cf.fpOnly` 只在**正文一模一样**时才露面，而这一幕里手上这份多了
    #   一行，画的是真差异 —— 所以这儿不验那句话，它归 i18n 与那块面板自己管）
    # 收尾把指纹换回去了（后面的用例还要用这份文档）
    ok = ok and cp.get('fpRestored') is True
    # 收干净了：面板关掉（它是 inset:0 的浮层，留着会挡住后面每一条 elementFromPoint）
    ok = ok and cp.get('closed') is True and cp.get('raceClosed') is True
    # ---- 0.4.1 front matter 属性表 ----
    # 夹具头上是 `title: 语料文档` + `tags: [markdown, 测试]`。三条各守一段：
    # 键名两个（title / tags）、标签两颗（数组拆开了才有）、两条 `---` 收成了边
    #（收不成的话它们各占一整行，卡片顶上凭空多两行等宽的 `---`）
    ok = ok and r['counts'].get('cm-lp-fm-key', 0) == 2
    ok = ok and r['counts'].get('cm-lp-fm-tag', 0) == 2
    # `>= 1` 而不是 2：取数那一刻光标还在文档开头，也就是**停在上面那条 `---` 上** ——
    # 回显是按行判的，它于是原样露着。下面那条没人碰，收成了边
    ok = ok and r['counts'].get('cm-lp-fm-edge', 0) >= 1
    # ---- 0.4.1 ⌘+点击标签 = 拿它搜工作区 ----
    tp = r.get('tagProbe') or {}
    ok = ok and not tp.get('err')
    ok = ok and '⌘' in (tp.get('title') or '')
    # 送进搜索框的那条式子要一字不差：中文标签靠的就是它，中间那三支是**同一个值的
    # 三种 YAML 写法**（裸 / 单引号 / 双引号）—— 别的文件里写成 `["测试"]` 的同一颗
    # 也得搜得到，而带转义的写法只有「再编码回去」才配得上（0.4.1 修）
    ok = ok and tp.get('query') == '(?<=[\\[,\\s])(?:测试|\'测试\'|"测试")(?=[\\],\\s]|$)'
    # 开关得亮着（所见即所搜），而且**至少搜到夹具自己**
    ok = ok and tp.get('regexOn') is True and tp.get('self') is True
    # 0.4.1 修：侧栏藏着的时候点标签，侧栏自己回来、搜索框拿到焦点
    #（hiddenBefore 证明这条用例还证明得了东西）
    ok = ok and tp.get('hiddenBefore') is True and tp.get('revealed') is True
    ok = ok and tp.get('focused') is True
    # 0.4.1 修：面板一关，那颗 `.*` 回到人自己那套 —— 临时开的开关不许留下。
    # 基线由探针自己钉成「关」（否则开发机上那位偏好本来是开的，这条恒真等于没测），
    # prefKept 则守着「探针跑完，他那位偏好原样还在」
    ok = ok and tp.get('restored') is True and tp.get('prefKept') is True
    # 收干净了：面板关掉、文件树回来（后面还有两条探针要用这块地方）
    ok = ok and tp.get('cleaned') is True
    # ---- 0.4.1 折叠一条列表 ----
    lf = r.get('listFoldProbe') or {}
    ok = ok and not lf.get('err')
    # 「  - 嵌套项」那一行真的从屏幕上消失了，药丸接上
    ok = ok and lf.get('before') is True and lf.get('folded') is False
    ok = ok and (lf.get('pillText') or '').endswith('行')
    # **折的是父项那一条**：光标落在「- 无序项二」上。落在「- 嵌套项」= 折错了一层，
    # 落在别处 = 退到整节去了 —— 两种错法只有这一条断言抓得到
    ok = ok and (lf.get('caretLine') or '').strip() == '- 无序项二'
    ok = ok and lf.get('back') is True
    # 红线一：折叠一个字节都不许改文档
    ok = ok and lf.get('byteSafe') is True
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
    # B4 拖拽两件：贴住下边缘它自己滚；停在收起的目录上 0.7s 它自己弹开，
    # 而且**弹开之后落点高亮要自己回来**（展开是一次整棵 replaceChildren）
    ok = ok and tp.get('autoScrolled') is True
    ok = ok and tp.get('sprung') is True and tp.get('dropAfterSpring') is True
    # A1 排序：目录在前，名字按 Finder 那条比法（`nameOrder`）。裸 `sorted()` 三条全错，
    # 所以三条各钉一个证人 —— 目录混在文件中间 / 第10章跑到第2章前面 / Zebra 被抬到最前
    order = tp.get('rootOrder') or []
    at = {x['name']: i for i, x in enumerate(order)}
    dirs = [i for i, x in enumerate(order) if x['dir']]
    files = [i for i, x in enumerate(order) if not x['dir']]
    ok = ok and bool(dirs) and bool(files) and max(dirs) < min(files)
    ok = ok and at.get('第10章', -1) > at.get('第2章', -1) >= 0
    ok = ok and at.get('Zebra', -1) > at.get('tabs', -1) >= 0
    # A2 切标签只换一个 class，不重建整棵树（抓着的那行 DOM 还在 = 没走过 replaceChildren）
    ok = ok and tp.get('tabQuiet') is True
    # B2 缩进参考线：背景宽度按 --depth 裁 —— 根这一层一条都不画，第 N 层正好 N 条
    # （周期就是 --tree-indent）。缩进本身也是这个数算的，所以这条同时守着「行还缩不缩进」
    gd = tp.get('guides') or {}
    ok = ok and gd.get('depth', 0) >= 1 and gd.get('root') == '0px 100%'
    ok = ok and gd.get('size') == '%dpx 100%%' % (16 * gd.get('depth', 0))
    # B3 滚起来才有那条发丝线。scrollable 是这条断言的前提 —— 夹具哪天缩到一屏放得下，
    # on/off 就都成了空转，这里要它自己喊出来
    sp = tp.get('scrollProbe') or {}
    ok = ok and sp.get('scrollable') is True and sp.get('idle') is True
    ok = ok and sp.get('on') is True and sp.get('off') is True
    # 三样都别在磁盘上留下痕迹：新建的、改名的、搬进 assets/ 的
    ok = ok and not os.path.exists('/tmp/cursive-e2e/e2e-新建.md')
    ok = ok and not os.path.exists('/tmp/cursive-e2e/e2e-改名.md')
    ok = ok and not os.path.exists('/tmp/cursive-e2e/assets/e2e-改名.md')
    # 契约 v32 自动刷新：外面往树根里丢了个文件、又把它拿走，树自己跟上；
    # 而我们自己的原子写（条目清单没变）不该让它重画一次 —— autoQuiet 守的就是那条闸，
    # 它一旦变 False，就是「边打字边自动保存 = 每两秒重建一次整棵树」回来了
    ok = ok and tp.get('autoAdded') is True and tp.get('autoGone') is True
    ok = ok and tp.get('autoQuiet') is True
    ok = ok and not os.path.exists('/tmp/cursive-e2e/e2e-外来.md')
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
    # ---- 第八节 3 走查②：文末展开一个块级公式 ----
    # 翻面让文档变矮，浏览器把超出新上限的 scrollTop **夹回去** —— 0.2.x 实测文末
    # 400px 的图点一下跳 377px。`pointer-selection.ts` 末尾那笔底部留白治的就是它
    mt = r.get('mathTailProbe') or {}
    ok = ok and mt.get('revealed') is True          # 真翻成源码了
    ok = ok and mt.get('inBlock') is True           # 落点落在点中的那个块里
    # **回归预算**：2026-09-22 实测 29px（正文一行 ≈ 29px），给到一行出头。
    # 这个数是量出来的，不是拍的 —— 它一旦涨到几百，就是那笔留白又没了
    ok = ok and mt.get('jumped', 999) <= 40
    # P4-1：导出的公式走 MathML（不依赖 KaTeX 的 CSS 与字体）
    ok = ok and '<math' in page and 'class="math-block"' in page
    # P1-1：行内 + 块级公式都渲染了，且 KaTeX 字体真的加载（CSP 下被拦肉眼不一定看得出）
    m = r.get('math') or {}
    ok = ok and (m.get('inline', 0) >= 2 and m.get('block', 0) >= 2 and m.get('font') is True)
    # ---- 0.4.1 正文缩放：⌘+ 两下 = 125%，而且**只有正文变大** ----
    zp = r.get('zoomProbe') or {}
    ok = ok and not zp.get('err')
    b, z, rs = zp.get('before') or {}, zp.get('zoomed') or {}, zp.get('reset') or {}
    # 起点是 100%，状态栏那一格不露面（没话说就别占地方）
    ok = ok and b.get('zoom') == '1' and b.get('badge') == ''
    # 正文字号与栏宽都乘了 1.25（栏宽不乘的话，一行能放的字数会随缩放缩水）
    ok = ok and z.get('zoom') == '1.25' and z.get('badge') == '125%'
    ok = ok and abs(px(z.get('body')) - px(b.get('body')) * 1.25) < 0.5
    ok = ok and abs(px(z.get('column')) - px(b.get('column')) * 1.25) < 0.5
    # **这两条才是这次改动的全部意义**：chrome 一个像素都不许跟着变
    ok = ok and z.get('status') == b.get('status') and z.get('tree') == b.get('tree')
    # 点状态栏那一格回到 100%，一切复原（后面按坐标来的断言都指着这一步）
    ok = ok and rs == b
    # 壳那边一路没碰 pageZoom（页面看不见它，只有原生报得出来）
    ok = ok and abs(c.get('pageZoom', 0) - 1) < 1e-6
if sys.argv[1] == 'dialect.md':
    # P4-1：目录与脚注在导出里是真的锚点
    ok = ok and '<nav class="toc">' in page and '<sup class="footnote-ref"' in page
    ok = ok and 'href="#fn-1"' in page and 'id="fn-1"' in page
    # 0.4.0 还的第一条账：**脚注定义里的行内语法要渲染**（从前 `**粗体**` 就是四个星号
    # 杵在那儿）。数的是定义区里真的出现了加粗/代码那两个 span
    ok = ok and r['counts'].get('cm-lp-seg-strong', 0) >= 1
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
    # ---- 0.4.0 F1 折叠一节 ----
    fp = r.get('foldProbe') or {}
    ok = ok and not fp.get('err')
    ok = ok and fp.get('handles', 0) >= 1
    # 折起来之后屏幕上**只剩标题那一行** —— 这才叫折叠，不是「变淡」
    ok = ok and fp.get('before', 0) > 5 and fp.get('folded') == 1
    ok = ok and (fp.get('pillText') or '').endswith('行')
    ok = ok and fp.get('back') == fp.get('before')
    # 菜单那条路也要真的折得动，而且**光标要落回标题行** ——
    # 不落回去的话它就留在刚藏起来的正文里，「落点掉进折叠区就展开」会当场把它弹开
    ok = ok and fp.get('menuFolded') == 1 and (fp.get('caretLine') or '').startswith('#')
    # 落点掉进折叠区 = 当场展开（查找 / 大纲 / 跨文件搜索都走这条）
    ok = ok and fp.get('reopened') == fp.get('before')
    # 红线一：折叠一个字节都不许改文档
    ok = ok and fp.get('byteSafe') is True
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
    # ⑤⑥⑦ 三种打不开都要在状态栏说一句话：点了没反应是最糟的失败方式。
    # **第八节 4 之后这句话换了**：从前不论什么原因一律报「找不到文件」，
    # 现在按壳回的类别分四种说法，还各带一个下一步 —— 链接指着的这一份是真没了，
    # 所以是「找不到 + 刷新文件树」（不是 UTF-8 / 没权限那两种另有各自的话）
    mn = lp.get('missingNote') or ''
    ok = ok and mn.startswith('找不到「缺失.md」') and '刷新文件树' in mn
    ok = ok and lp.get('anchorNote') == '本文里没有这个锚点：#没有这一节'
    # 本地文件那条要走到「系统没接手」才说得出话 —— 自检下的 openExternal 替身
    # 对 file:// 按「在不在」回话，就是为了让这条路测得到
    ok = ok and lp.get('fileNote') == '打不开：/tmp/cursive-e2e/缺失.png'
    # ⑧ 地址带空格**又看不出是哪个文件**（没后缀）：这种解析器仍然不认 ——
    # 误认比不认更糟（正文里平白多出一条蓝线），但也不能就这么没反应
    ok = ok and (lp.get('spacedNote') or '').startswith('地址里有空格')
    ok = ok and '我的 笔记 没有后缀' in (lp.get('spacedNote') or '')
if sys.argv[1] == 'crlf.md':
    # 0.3.0 T2 检查更新：菜单 → 壳（替身不联网）→ 状态栏 → 那颗按钮把 release 页交给系统
    up = r.get('updateProbe') or {}
    ok = ok and not up.get('err')
    # ① 点完**当场**有声：那一下要过网络，中间静默就是「点了没反应」
    ok = ok and '正在检查更新' in (up.get('pendingText') or '')
    # ② 有新版本：新旧两个号都在那句话里。`0.0.0` 同时守着「裸二进制读不到 Info.plist
    # 就回 0.0.0」这条兜底 —— 哪天它变了，这里会第一个响
    ok = ok and '9.9.9' in (up.get('foundText') or '') and '0.0.0' in (up.get('foundText') or '')
    # 是一颗按钮，不是直接把浏览器唤起来：点菜单的人想知道的是「有没有」
    ok = ok and up.get('foundBtn') == '去看看'
    # 按下之后才交给系统（自检下只记账）。**去处是壳拼的常量**，响应里的 html_url
    # 一个字节都不进来 —— 这条断言守的就是那件事
    ok = ok and (e.get('external') or []) == ['https://github.com/lawrence1912/cursive/releases/latest']
    # ③ 同一进程里再问一次 → 已是最新，而且没有按钮（没什么可去看的）
    ok = ok and '已是最新' in (up.get('latestText') or '')
    ok = ok and up.get('latestBtn') is False
    # ④ 那边还没发过 release：说清楚是「还没有版本」而不是「连不上」，而且**不是黄的**
    # —— 这一下什么都没出错。这个仓库在第一次发版之前走的就是这条路
    ok = ok and 'GitHub 上还没有发布版本' in (up.get('noneText') or '')
    ok = ok and up.get('noneWarn') is False
    # ⑤ 真·没问着：这一句才是黄的（「没能如愿」用黄色是 note() 的分工）
    ok = ok and '连不上 GitHub' in (up.get('failText') or '')
    ok = ok and up.get('failWarn') is True
    # ---- 0.4.0 F2 跨文件替换（契约 v30）----
    rp = r.get('replaceProbe') or {}
    ok = ok and not rp.get('err')
    # 三份夹具四处命中（rep-lf 两处、crlf 一处、bom 一处）
    ok = ok and rp.get('found') == 4
    # 按钮上写着「还剩几处」—— 勾掉一处之后它得跟着变
    ok = ok and '替换' in (rp.get('btnLabel') or '')
    # 回执要说清楚改了几个文件几处（勾掉的那一处不算）
    ok = ok and '已替换 3 个文件里的 3 处' in (rp.get('replacedNote') or '')
    ok = ok and '已还原 1 个文件' in (rp.get('undoneNote') or '')
    # **盘上的字节**（回执说了什么不算数，这一段才算）
    def rd(name):
        return open('/tmp/cursive-e2e/' + name, 'rb').read()
    lf = rd('rep-lf.md')
    # 勾掉的是最后一处 —— 「又一处 术语 收尾」那一行必须原样留着
    ok = ok and lf == ('# 替换 LF\n\n第一处 名词 在这儿。\n没有命中的一行 —— 一个字节都不许动。\n'
                       '又一处 术语 收尾。\n').encode()
    # CRLF 一条：改完还得是 CRLF，而且**一个 \n 都不许裸着**
    crlf = rd('rep-crlf.md')
    ok = ok and crlf == '# 替换 CRLF\r\n\r\n这一行有 名词 在。\r\n这一行没有。\r\n'.encode()
    # BOM 一条：头三个字节还在
    bom = rd('rep-bom.md')
    ok = ok and bom.startswith(b'\xef\xbb\xbf')
    ok = ok and bom == '\ufeff# 替换 BOM\n\n带 BOM 的 名词 一处。\n尾行不动。\n'.encode('utf-8')
    # 撤销那一份：**逐字节回到改之前**
    ok = ok and rd('rep-undo.md') == '# 撤销\n\n这里有一个 待撤销 的词。\n'.encode()
    # 每个被改的文件改前都留了一份历史版本（8 秒那颗撤销过期之后唯一的退路）
    # 历史落在**自检专用的那份支持目录**里（脚本头上 export、壳侧 supportBaseURL 认）。
    # 这条顺带守着隔离本身：哪天壳又把它写回真实目录，这里当场就空了
    hist = os.path.join(os.environ['CURSIVE_SMOKE_SUPPORT'], 'cursive', 'history')
    for name in ('rep-lf.md', 'rep-crlf.md', 'rep-bom.md'):
        key = hashlib.sha256(('/tmp/cursive-e2e/' + name).encode()).hexdigest()[:16]
        snaps = [f for f in os.listdir(os.path.join(hist, key))
                 if f.endswith('.md')] if os.path.isdir(os.path.join(hist, key)) else []
        ok = ok and len(snaps) >= 1
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
# CM 会捕获插件异常并写 console.error；不能让断言通过掩盖运行时错误。
errors = [entry.get('error') for entry in r.get('trace', []) if entry.get('stage') == 'console.error']
if errors:
    print('renderer errors:', errors)
ok = ok and not errors
print(('PASS ' if ok else 'FAIL ') + sys.argv[1])
sys.exit(0 if ok else 1)
PY
}
run_case img.md
run_case table.md
run_case tables.md
run_case kitchen-sink.md
run_case crlf.md
# 0.4.0 F2 顺带补的一条：**带 BOM 的文件读进来再存回去，那三个字节还得在**。
# 这条一直没人守着（bom.md 从来不在用例表里，而那份夹具自己都没有 BOM），
# 于是壳侧「Foundation 读文件会吃掉 BOM」的洞活了很久 —— 通用断言里的 bytesEqual 就够
run_case bom.md
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
rm -f /tmp/cursive-shell-pdf.json /tmp/cursive-shell-e2e.json
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

# 0.4.1 修：**⌘A 的去路**。全选原先挂 AppKit 的 `selectAll:`，沿响应链落进 WebKit
# 自己那条 SelectAll —— 它只认「编辑宿主里**渲染出来**的那部分」，而 CodeMirror 只把
# 视口那一段放进 DOM。于是长文档按一次全选只选到一屏，⌘A 之后复制 / 删除只拿得到
# 当前屏幕上的那一段（实测 19340 字符的文档选到 0…340）。
# **挂在这份夹具上是有理由的**：八个用例的文档都一屏装得下，视口就是全文，
# 在那儿怎么选都对 —— 这条只有长文档看得见，而长文档只有这一份
python3 - <<'SELALL'
import json, sys
e = json.load(open('/tmp/cursive-shell-e2e.json'))
# 探针的返回值整个装在 `result` 里（壳侧 `out["result"] = v`），顶层只有
# source / windows / scratch* 那几个壳自己补的键 —— 读错一层不会报错，
# 只会永远拿到空字典，于是这条断言恒红。`test/smoke-harness.test.ts` 对着账
r = e['result']
s = r.get('selectAllProbe') or {}
ok = s.get('coversAll') is True
# 视口确实比全文小，这条用例才证明得了东西（理由见 main.swift 里那段注释）
ok = ok and s.get('viewportSmaller') is True
# 0.4.1：焦点先挪到状态栏那颗字数上（awayOK 证明这条用例还证明得了东西），
# 全选之后必须收回编辑器 —— 否则 ⌘C 走原生 copy: 拿到的是空的
ok = ok and s.get('awayOK') is True and s.get('refocused') is True
print(('PASS ' if ok else 'FAIL ') + '全选选的是全文 '
      + str({k: s.get(k) for k in ('from', 'to', 'docLen', 'viewport', 'awayOK', 'refocused')}))
sys.exit(0 if ok else 1)
SELALL

# 崩溃恢复不许抢焦点：种一份 scratch 草稿，再把 scratchList 的应答拖慢到 1.2s，
# 逼出「文件先到、恢复后到」那条顺序 —— 正常顺序下 scratchList 几毫秒就回来，测不到。
# 原 bug：恢复出来的草稿会把 argv/Finder 打开的那份挤成非活动标签；更糟的是过滤掉
# 启动空白页之后 activeId 悬空，状态栏会一直挂着一个已经不存在的文件名
printf '{"content":"# 崩溃前的草稿","fingerprint":{"eol":"\\n","bom":false},"savedAt":"2026-01-01T00:00:00Z"}' \
    > "$SCRATCH/tab-e2e-recovery.json"
rm -f /tmp/cursive-shell-check.json /tmp/cursive-shell-e2e.json
CURSIVE_SMOKE=1 CURSIVE_SMOKE_SCRATCH_DELAY=1200 ./shell-swift/cursive-shell "$FIX/img.md" 2>"$ARTIFACTS/recovery.log"
cp /tmp/cursive-shell-check.json "$ARTIFACTS/recovery.check.json"
cp /tmp/cursive-shell-e2e.json "$ARTIFACTS/recovery.e2e.json"
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
r = e.get('result') or {}
done = next((entry for entry in r.get('trace', []) if entry.get('stage') == 'done'), {})
drafts = [tab.get('draft') for tab in done.get('tabs', []) if tab.get('path') is None]
# 探针结束时，恢复草稿必须原文不动；不能把「启动时没抢焦点」当成全程正确。
ok = ok and once and e.get('bytesEqual') is True and not r.get('jsError')
ok = ok and drafts == ['# 崩溃前的草稿']
print(('PASS ' if ok else 'FAIL ') + '崩溃恢复不抢焦点 ' + str(tabs)
      + ' 草稿交出 %s/问 %s 次，剩 %s' % (e.get('scratchHandouts'), e.get('scratchQueries'), e.get('scratchPending')))
sys.exit(0 if ok else 1)
RECOVERY
rm -f "$SCRATCH"/*.json

# 探针皮肤不必单独收：整个 $SUPPORT 是临时的，退出时那条 trap 一起端走

echo "==> [4/4] 打包"
./shell-swift/make-app.sh

# ---- 0.3.0 T1：出包之后再验一次「另一片真的能跑」----
#
# compile.sh 合完已经断言过两片都在，但「lipo 里有这一片」和「这一片跑得起来」是两回事。
# 这儿跑的是**包里那个二进制**（资源走 Bundle，和用户双击打开的是同一条路），
# 只是把架构钉死在非本机那一片上。
#
# **这条用例代替不了真机**：Rosetta 用的是本机 macOS 27 的 Swift 运行时，
# 而 x86_64 的真实用户跑的是 macOS 12–15 上的老运行时。它能证明「这片代码是对的」，
# 证明不了「回退兼容库不链也没事」—— 后者的依据是 compile.sh 里那道 guard。
BIN="dist/Cursive.app/Contents/MacOS/Cursive"
HOST_ARCH=$(uname -m)
OTHER=$([ "$HOST_ARCH" = "arm64" ] && echo x86_64 || echo arm64)
# `${OTHER}` 的花括号不能省：`/bin/sh` 里变量名后面紧跟一个**全角**右括号时，
# `$OTHER）` 会被连着吃掉（实测输出是「另一片（▒▒冒烟」）—— 半角 `)` 没这毛病
echo "==> [4+] 另一片（${OTHER}）冒烟"
if ! lipo -archs "$BIN" | grep -q "$OTHER"; then
    echo "FAIL 包里没有 $OTHER 片（只有 $(lipo -archs "$BIN")）"; exit 1
fi
if [ "$HOST_ARCH" = "arm64" ] && ! arch -x86_64 /usr/bin/true 2>/dev/null; then
    # 没装 Rosetta 就跑不了 x86_64 那一片。**不算失败，但要说出来** ——
    # 装一句 `softwareupdate --install-rosetta` 就能把这条用例打开
    echo "SKIP 未装 Rosetta（softwareupdate --install-rosetta 之后这条才跑）"
else
    rm -f /tmp/cursive-shell-check.json /tmp/cursive-shell-e2e.json
    rm -f "$SCRATCH"/*.json
    cp test/fixtures/kitchen-sink.md "$FIX/arch-probe.md"
    CURSIVE_SMOKE=1 arch -"$OTHER" "$BIN" "$FIX/arch-probe.md" 2>/dev/null
    python3 - "$OTHER" <<'ARCHPY'
import json, sys
arch = sys.argv[1]
c = json.load(open('/tmp/cursive-shell-check.json'))
e = json.load(open('/tmp/cursive-shell-e2e.json'))
r = e['result']
# 只断言「这一片确实是同一个应用」：桥通了、CodeMirror 活着、往返零损耗。
# 细项（表格/查找/树…）本机那一片已经逐条验过九遍，这儿再验一遍只是拖时间
ok = (c['cm'] and c.get('cmState') and c.get('apiKeys', 0) >= 50
      and e['bytesEqual'] and r.get('jsOK') is True and r.get('cmLines', 0) > 0)
print(('PASS ' if ok else 'FAIL ') + arch + ' 片：api %s 键 · 行 %s · 往返 %s'
      % (c.get('apiKeys'), r.get('cmLines'), e['bytesEqual']))
sys.exit(0 if ok else 1)
ARCHPY
    rm -f "$FIX/arch-probe.md"
fi

echo "全部通过，包在 dist/Cursive.app（$(lipo -archs "$BIN")）"
