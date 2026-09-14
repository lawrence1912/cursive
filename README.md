<img src="brand/logo-mark.svg" alt="cursive" width="132" align="right">

# Cursive

macOS 上的 Markdown 编辑器：单窗格、无分屏、打字即渲染。
标记默认隐藏，光标移进哪一行，哪一行才回显源码。

![Cursive 浅色界面](docs/shots/light.png)

深色是 [这个样子](docs/shots/dark.png)，另外还有跟随系统、护眼两套，以及用户自定义皮肤。

> 图里这份文档就是仓库根目录的 [`demo.md`](demo.md) —— 装好之后直接打开它，
> 上面这些构件（表格 / 公式 / 告示块 / mermaid / 代码块语言条）都能当场点着玩。

## 当前进度

**已经是所见即所得了。** 打字即渲染，markdown 标记默认隐藏，光标移进某一行才回显源码。
渲染层是纯 CodeMirror 6，原生能力由 `shell-swift/` 的 Swift + WKWebView 壳提供 ——
**仓库里没有 Electron**。

| 能力 | 状态 |
|---|:--|
| 实时预览装饰器引擎（标记按光标显隐） | ✅ |
| 打开/保存/另存、脏标记、关闭拦截、原生菜单、查找 | ✅ |
| 多标签（每标签独立 EditorState） | ✅ |
| 文件树 · 大纲（滚动跟随） | ✅ |
| 文件树工具栏：新建文件/文件夹 · 搜索 · 打开文件夹 | ✅ |
| 文件树读写：新建 · 重命名 · 拖拽移动 · 删除（进废纸篓）· 在 Finder 中显示 | ✅ |
| GFM 表格真渲染 + **就地编辑**（点进格子直接改，不回落源码）<br>底部浮动工具栏（增删行列/整列对齐/整理对齐）· 悬停 +/− 手柄 · 格内行内语法 | ✅ |
| 自动保存 + 崩溃恢复 · 外部变更监听 | ✅ |
| 最近文件 · Finder 双击 · Dock 菜单 | ✅ |
| 导出 PDF（真分页 · A4/Letter · 页边距 · 页码） | ✅ |
| 主题切换（浅/深/系统/护眼）+ 自定义皮肤 CSS · 排版偏好（字号/行距/栏宽/衬线） | ✅ |
| 界面语言切换（中文 ⇄ English）· 原生菜单与对话框全量跟随 | ✅ |
| KaTeX 数学公式（行内/块级）· mermaid 图表 | ✅ |
| 脚注 · `==高亮==` · 上下标 · emoji · `[TOC]` | ✅ |
| 告示块 `> [!note]` / `> [!danger]`（Obsidian 别名 + GitHub 大写写法，可折叠） | ✅ |
| 代码块：藏 ``` + 顶部语言条（语言选择器 / 复制）· 图片放大预览/尺寸语法 | ✅ |
| 格式化命令 +「格式」菜单（⌘B/⌘I/⌘1-6…） | ✅ |
| 格式化命令：底部悬浮格式栏 + 原生「格式」菜单 + 快捷键（⌘B/⌘1-6…） | ✅ |
| Markdown 输入规则（表格/代码块骨架）· 列表智能（Tab 升降级/重编号） | ✅ |
| 智能粘贴（HTML→MD · URL 包链接 · ⇧⌥⌘V 纯文本） | ✅ |
| 查找替换：右上角浮层面板 · 面板内计数 · ⌘G/⇧⌘G · ⌥⌘R 摊开替换 | ✅ |
| 截图粘贴 + 拖拽图片自动落盘 `assets/` · 拖 .md 开新标签 | ✅ |
| 专注模式（压暗非当前段落）· 打字机模式（光标行定高） | ✅ |
| 大纲：折叠 · 层级档位 · 过滤框 · 每节字数 · 拖拽重排 · 右键菜单 | ✅ |
| 状态栏：光标行列 · 选区字数 · 阅读时间 · 点字数条弹详细统计 | ✅ |
| 跨文件全局搜索（壳侧流式、可取消；结果按文件分组，点击跳转并选中那一处） | ✅ |
| 多窗口（⌘⇧N，每个窗口独立文档、标签与文件树） | ✅ |
| 导出 HTML（单文件：样式内联 · 图片可嵌 base64 · mermaid 烘成静态 SVG · 公式走 MathML） | ✅ |
| 导出 docx / epub（pandoc 桥接） | ⬜ |

**当前已渲染**：标题、粗体/斜体/删除线、行内代码、链接、图片、引用、分隔线、
无序/有序列表、任务复选框（可点击）、代码块（嵌套语言高亮）、YAML front matter、
GFM 表格、KaTeX 数学公式（`$…$` / `$$…$$`，货币符号不吃，错误红色源码）、
mermaid 图表（随主题配色，语法错误保留源码+报错）、
告示块（13 种类型 6 档配色，图标 + 中文类型名，`[!note]-` 可折叠）。

## 安装

需要 macOS 12 或更新。两条路，选一条。

### 一、下载现成的包

到 [Releases](../../releases) 拿 `Cursive-<版本>.dmg`，打开后把 Cursive 拖进「应用程序」。

**第一次打开会被 macOS 拦住**，提示「无法验证开发者」或「已损坏，无法打开」。
包没有坏 —— 它只做了 ad-hoc 签名，**没有 Apple Developer ID 证书**（那是 $99/年的付费项目，
这个项目没买），而凡是从浏览器下载的文件都会被系统打上隔离属性，两者一撞 Gatekeeper 就拦。

任选一种放行，做一次就够：

```bash
xattr -dr com.apple.quarantine /Applications/Cursive.app
```

或者不用终端：双击被拦之后打开「系统设置 → 隐私与安全性」，往下翻会多出一行
「仍要打开」，点它。（新版 macOS 已经取消了「右键 → 打开」那个老办法，只剩这一处。）

### 二、自己编译（不会被拦）

本机编译出来的包**不带隔离属性**，Gatekeeper 不管它，省掉上面那一步：

```bash
npm install
./shell-swift/release.sh          # 测试 + E2E 全绿才出包 → dist/Cursive.app
CURSIVE_DMG=1 ./shell-swift/release.sh   # 顺带出 dist/Cursive-<版本>.dmg
```

只需要 Node 和 Xcode Command Line Tools（`xcode-select --install`），**不需要装 Xcode.app**。

## 快捷键

| | |
|---|---|
| ⌘O / ⌘⇧O | 打开文件 / 打开文件夹（**开新窗口**：一个窗口 = 一个工作区） |
| ⌘S / ⌘⇧S | 保存 / 另存为 |
| ⇧⌘E / ⌘P | 导出 HTML / 导出 PDF |
| ⌘, | 设置（主题 / 排版） |
| ⌘\ / ⌘⇧T | 显示/隐藏文件树 / 大纲 |
| ⌘⇧F | 在文件夹中查找（跨文件搜索） |
| ⌘⇧N | 新建窗口 |
| ⌃⌘D | 切换深色 |
| ⌘/ | 源代码模式 |
| ⌥⌘F / ⌥⌘T | 专注模式 / 打字机模式 |
| ⌃⌘F | 全屏 |
| ⌘F / ⌥⌘R | 查找 / 查找并替换 |
| ⌘B / ⌘I / ⌘U | 粗体 / 斜体 / 下划线 |
| ⇧⌘X / ⌃⌘C / ⌘K | 删除线 / 行内代码 / 链接 |
| ⌘1 – ⌘6 / ⌘0 | 标题 1–6 / 正文 |
| ⇧⌘K / ⇧⌘Q | 代码块 / 引用 |
| ⇧⌘[ / ⇧⌘] / ⇧⌘C | 无序列表 / 有序列表 / 任务项 |
| ⇧⌥⌘V | 粘贴为纯文本 |
| ⌘ + 点击链接 | 用浏览器打开 |

标题栏两端还有三处入口：左边一颗开关文件树，右边一块是「深色 / 栏宽 / 大纲」。

命令行：`cursive 文件.md` 打开文件，`cursive 目录/` 在侧边栏打开文件夹。

**接下来做什么见 [`ROADMAP.md`](ROADMAP.md)**（现状盘点 + 对标 Typora/MarkText + P0–P4 清单）；
开发上下文与踩坑记录见 [`CONTEXT.md`](CONTEXT.md)。

## 运行

```bash
npm install
npm run build                     # 构建 renderer 到 out/renderer
./shell-swift/build.sh            # 编译原生壳 → shell-swift/cursive-shell
./shell-swift/cursive-shell a.md    # 开发运行（资源查找 Bundle → cwd → exe 相对）
CURSIVE_TIMING=1 ./shell-swift/cursive-shell a.md   # 打印启动各阶段耗时（壳侧 + 页面内三格）
```

其他脚本：

```bash
npm run dev        # 浏览器里开发 renderer（HMR，但拿不到 window.api，原生功能不可用）
npm test           # 往返保真 + 方言 + 表格单测
npm run typecheck  # 渲染层 + 共享层类型检查
npm run icon       # 从 brand/app-icon.svg 重出 build/icon.png + icon.icns（换图标时跑）
```

## 架构

```
src/
├─ renderer/      CodeMirror 6 编辑器 + 应用界面（纯 Web，产物 out/renderer）
└─ shared/        两端共用：类型、换行/BOM 指纹、分词计数
shell-swift/      Swift + AppKit + WKWebView 原生壳（单文件渐进，优先 AppKit）
```

渲染层只认 `window.api`（签名见 `src/shared/types.ts` 的 `CursiveApi`），不碰任何原生能力 ——
这正是把 Electron 换成 Swift 壳时 renderer 零改动的原因。壳侧 1:1 实现该契约，
新增通道要三处同步：`types.ts` ↔ `main.swift` ↔ `CONTEXT.md`。

两个自定义协议缺一不可：`app://r/<路径>` 服务渲染资源（WKWebView 下 `file://` 的 ES module
因 opaque origin 会静默失败），`safe-file://local/<绝对路径>` 加载文档里的本地图片。

### 核心约定：源码即真相

编辑器缓冲区里始终是**未经修改的 markdown 文本**。渲染效果全部由 CodeMirror 装饰器
（Decoration）叠加上去，不改动文本本身。因此：

- **保存零损耗** —— 没编辑过的地方，字节完全不变（自动保存也必须走这条指纹路径）
- 源代码模式 = 把装饰器关掉，一次 `Compartment.reconfigure`
- 撤销、搜索、输入法、大文档性能都由 CM6 兜底

`src/shared/textfile.ts` 守住这条承诺的边界：CodeMirror 建 state 时会把 CRLF/CR 归一成
LF，BOM 若不剥掉会被当成正文第一个字符。读文件时把这两样摘成「指纹」，写回时原样还原。
`test/textfile.test.ts` 对着 `test/fixtures/` 里的语料断言字节级往返一致。

### 实时预览是怎么做的

`src/renderer/editor/live-preview/` 是全项目的核心。一个 `ViewPlugin` 遍历**可视区域内**
的语法树，产出装饰器改变显示方式，不碰文本本身：

| 目的 | 手段 |
|---|---|
| 藏掉 `**` `#` `>` 这些标记 | `Decoration.replace({})` |
| 圆点、复选框、分隔线、图片 | `Decoration.replace({ widget })` |
| 标题字号、引用边框、代码块底色 | `Decoration.line({ class })` |

`reveal.ts` 决定「光标碰到多大范围就露出源码」，三档可选，默认按行：

- `node` 只露出光标所在的行内元素。最贴近 Typora，但每动一次光标就重排一次。
- `line` **默认**。整行露出，抖动降到「每换一行一次」，稳得多。
- `block` 整段露出。最稳但离 Typora 最远。

写这部分时踩到的三个坑，都记在代码注释里：

1. **ViewPlugin 不能提供块级装饰** —— `Decoration.replace({ block: true })` 会抛
   `Block decorations may not be specified via plugins`，并且连带把行渲染搞崩（报
   一个看起来毫不相干的 `Cannot destructure property 'tile'`）。块级（表格、以后的
   数学块/mermaid）一律走 `StateField`，见 `tableField`。
2. **输入法** —— `view.composing` 为真时绝不重算装饰器，否则中文连打会吞字。
   合成结束后靠 `wasComposing` 标志补一次。
3. **widget 必须实现 `eq()`** —— 否则每次按键都会把所有图片、图表重建一遍。

方言在 `markdown-lang.ts`：CommonMark + GFM + YAML front matter。刻意**不用**
`markdownLanguage`，因为它自带上下标扩展，会把 `$e^{-x^2}$ ` 里的 `^` 解析成
Superscript。`scripts/dump-tree.mjs` 可以打印任意文档的节点名，改装饰器前先跑一次。

### 导出 HTML / PDF 是怎么做的

`src/renderer/export/` 把整份文档渲染成语义 HTML（`<h2>` / `<table>` / `<figure>`），
**和实时预览共用同一棵语法树和同一批解析函数** —— 图片走 `parseImage`、告示块走
`calloutAt`、表格走 `tableDataAt`、围栏走 `fenceParts`、行内标记走 `INLINE_MARKS`、
标题锚点走 `headings.ts` 的 `slugs`。编辑器只渲染视口而导出渲染全文，两条路径对同一段
markdown 必须是同一种理解，所以这里一处小解析器都不另写；`test/export.test.ts` 拿
`buildBlocks()` 的块级装饰和导出产出逐块对账，外加一份 golden 快照。

产物是**单文件**：样式内联、mermaid 烘成静态 SVG、图片可选嵌成 data: URI
（勾在保存面板上，读盘在壳侧 —— 图片字节不过 IPC 桥）。三处与编辑器**有意不同**：
公式走 MathML（KaTeX 的 HTML 输出要额外背 1 MB 字体）、裸 HTML 一律转义（所见即所得，
顺带没有「导出的文件被文档里的脚本接管」这回事）、告示块的折叠态一律摊开。

**导出 PDF 就是把这份 HTML 打印出来**（`PDFPrinter`，`printOperation(with:)` 真分页）：
纸张 / 页边距 / 分页归壳侧 `NSPrintInfo` 一处管，CSS 只管排版与断页规则，页码由 PDFKit
盖在下页边距里。这条路上有四个坑能让结果「时好时坏」——「`op.run()` 会把主线程堵死，
于是分页永远算不完、PDF 一路涨到 1.8 GB」和「开印前调一次 `knowsPageRange` 就随机印空白页」
是其中两个，全部记在 `PDFPrinter` 的注释里。

## 打包成 .app

```bash
./shell-swift/release.sh              # 标准工作流：测试 + E2E 全绿才打包 dist/Cursive.app
CURSIVE_DMG=1 ./shell-swift/release.sh  # 同上，额外出 dist/Cursive-<version>.dmg
```

`release.sh` 依次跑：类型检查 + 单测 → 构建 renderer → 编译壳 → 8 个 E2E 用例
（图片/表格/全家桶/CRLF/数学/mermaid/方言/告示块）+ 崩溃恢复竞态 → `make-app.sh` 组装 bundle。
产物约 9.8 MB（app，含 KaTeX 与 mermaid，**两者都按需加载** —— 没有公式/图表的文档一个字节都不背；
首屏 JS 759 KB，katex 与 turndown 各自躺在自己的 chunk 里）。

`make-app.sh` 把 `out/renderer` 塞进 `Contents/Resources/renderer`，写入 `Info.plist`
（`.md` 关联 rank=Alternate，不抢默认打开方式），再做 ad-hoc 签名
（`codesign --force --deep --sign -`）。本机构建的包没有 quarantine 属性，Gatekeeper 不拦；
**从 Releases 下载的包会被拦**，放行办法见上面「安装」。

**签名公证是有意不做的**：Developer ID 证书 + 公证要 Apple Developer Program（$99/年），
换来的只是「下载版少点一次『仍要打开』」。这个项目选择把这笔钱省掉，代价写在安装说明里
明说 —— 想要零提示的体验就自己编译，那条路本来就不经过 Gatekeeper。

图标的矢量源只有 `brand/app-icon.svg` 一份，`npm run icon` 用系统 `sips` + `iconutil`
打出 `build/icon.png`（1024 母版）和 `build/icon.icns`，**每一档尺寸都从矢量重新栅格**，
不依赖浏览器或任何图形库。整套品牌资产与用法见 `brand/README.md`。

## 冒烟 / E2E

没法手动点界面时（沙箱、自动化），壳内置探针：

```bash
CURSIVE_SMOKE=1 ./shell-swift/cursive-shell test/fixtures/kitchen-sink.md
# +3s 写 /tmp/cursive-shell-check.json  （DOM：api/cm/侧栏/状态栏/标题栏/拖拽条）
# +4s 写 /tmp/cursive-shell-e2e.json    （read→save 逐字节往返 + 装饰计数 + 图片加载），然后退出
```

`CURSIVE_SMOKE` 之外启动就是正常交互应用，绝不自动退出。

> **探针是会改东西的**：改标题层级、往表格里打字、追加 marker（自动保存还会落盘），
> `treeProbe` 还会在**树根目录里真的建文件、改名、移动、删除**。所以永远只在
> **夹具的副本**上跑（`release.sh` 就是先把 fixtures 拷进 `/tmp/cursive-e2e/` 才跑的），
> 别拿自己在乎的文件和目录去试。只想拍张图就加 `CURSIVE_SMOKE_SHOT_CLEAN=1`，
> 那条路跳过全部探针：文档一个字不动，树根一个文件不碰。

可选：
`CURSIVE_SMOKE_SHOT=<png>` 截图、`CURSIVE_SMOKE_SHOT_CLEAN=1` 只截图不跑探针、
`CURSIVE_SMOKE_SHOT_JS=<js>` 快门前跑一段 JS 给截图「摆姿势」（挪光标、收格式栏、滚位置）、
`CURSIVE_SMOKE_THEME=dark|light|sepia|system` 切主题后截图（**走查完记得用 system 复位** ——
主题是写进 localStorage 的）、
`CURSIVE_SMOKE_MENU=<菜单动作>` 截图前派一个菜单动作（目检设置面板这类）、
`CURSIVE_SMOKE_SHOT_SEARCH=1` 截图前把跨文件搜索面板留在开着的状态、
`CURSIVE_SMOKE_PDF=<路径>` 顺带导出 PDF（结果含页数与页尺寸；纸张与页边距用
`CURSIVE_SMOKE_PDF_PAPER` / `CURSIVE_SMOKE_PDF_MARGIN` 走查）、`CURSIVE_SMOKE_HTML=<路径>` 顺带导出 HTML
（绕过保存面板，图片按嵌入处理）、`CURSIVE_SMOKE_SCRATCH_DELAY=<ms>` 逼出崩溃恢复竞态。

> 切主题的截图**别接着上一次不同主题的运行跑**：WKWebView 的 `takeSnapshot` 会把切换前的
> 合成层原样拍进去（表现为活动标签、大纲当前行还留着上一套配色）。那是截图假象，不是配色
> bug —— 同一主题连跑第二次就正常了。

细节见 `CONTEXT.md` 的「自检探针 / E2E」一节。

## 已知限制

- 表格的「整理对齐」是显式命令（工具栏那颗「整理」），不会自动跑 —— 平时改一格只动那一格，源码里的列宽会变参差，这是保存零损耗的代价
- 表格单元格里粘贴多行文本会被压成一行（格内粘贴退化成原生纯文本，多行由 `escapeCell` 压平）
- 代码块的语言条只在「光标不在围栏行上」时出现：把光标挪到围栏行会回显 ```` ```ts ```` 源码（要改语言也可以直接在那行改）
- 导出的 PDF / HTML 只有浅色一套（导出物会进别人的浏览器、会被打印，跟着阅读者的系统外观走
  等于同一份文档两个样子）；脚注定义里的行内语法不渲染（解析器把定义整块当叶子节点，
  编辑器里也一样）
- 告示块的类型表是封闭的：`> [!xyz]` 这种表里没有的类型不成卡片，仍旧是普通引用
  （只是 `[!xyz]` 以字面量示人，不会再被当成链接）
- 嵌套的 `> > [!note]` 只有里层那块算告示块，不递归
- 跨文件搜索只扫 `.md/.markdown/.mdown/.mkd/.txt`，跳过 `node_modules`/`dist`/`out` 这类目录；
  上限 800 处命中 / 6000 个文件，触顶会在结果区注明「已截断」
- 自定义皮肤是叠在内置主题之后的一张 CSS，写坏了只能删文件重开（没有出错回滚）
- 多窗口之间只共享 localStorage 里的偏好；窗口位置只记第一个窗口的
- 尚无 pandoc 导出（docx / epub）
- 没有签名公证，也没有自动更新：下载版第一次打开要手动放行一次（见「安装」），
  新版本要自己回 Releases 拿

## 许可

[MIT](LICENSE) © 2026 Lawrence。

依赖也都是宽松许可，不冲突：CodeMirror 6、@lezer/\*、KaTeX、mermaid、turndown 均为 MIT。
