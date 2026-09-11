# cursive 路线图

> 基准 `73da752`（2026-09-11，**P0 全部完成；P1-1～P1-3 已完成**）。现状盘点 + 对标 Typora / MarkText + 按依赖顺序排的 P0–P4 清单。
> 在线版（同一份内容，带样式）：<https://claude.ai/code/artifact/462ed29a-cc2f-4026-8e01-e4fa47e104a0>
>
> 开发上下文、契约、已踩的坑见 `CONTEXT.md`；这份只管「接下来做什么」。

## 一、现状

最难的一段已经过去：装饰器引擎、输入法安全、块级装饰的 StateField 模式、两个自定义协议、
E2E 一条龙 —— 这些都是「做错一次要返工一周」的部分，现在全部落地且有断言守着。
**内核已经完成，外围还是毛坯。**

### 已经做到的

- **实时预览引擎**：标题 / 强调 / 行内码 / 链接 / 图片 / 引用 / 分隔线 / 列表 / 任务框 /
  代码块嵌套高亮 / YAML front matter / GFM 表格真渲染
- **回显粒度三档** `node · line · block`，默认按行
- **保存零损耗**：BOM/EOL 指纹 + 字节级往返断言（`test/pipeline.test.ts`）
- **输入法铁律**：`composing` 期间不重算装饰
- **多标签**：每标签独立 EditorState，光标、撤销栈、装饰随标签走
- 文件树（懒加载、自动挂根）、大纲（滚动跟随）、源码模式、CJK 字数统计、查找
- PDF 导出、DMG 打包、探针 + 4 个 E2E 用例的 `release.sh`
- 产物 3.4 MB `.app` / 1.7 MB DMG

### 还缺的（两类）

| 类别 | 内容 | 后果 |
|---|---|---|
| **手感缺口** | 格式化快捷键、输入规则、智能粘贴、图片落盘、表格只读 | 写作时手要离开键盘 |
| **工作区缺口** | 跨文件搜索、文件树可写、专注/打字机、多窗口、大纲增强 | 当主力工具还差一口气（最近文件 / 自动保存 / 外部变更 / 主题切换 / 排版偏好已补齐） |

内容缺口已清（P1-1～P1-3）：数学、mermaid、脚注、高亮、上下标、emoji、TOC 全部渲染，不再看到裸源码。

历史包袱已清：**Electron 版已删除（P0-4）**，此后新功能只实现一遍。

## 二、三个结构性判断

不是功能，是会影响一整批功能实现形态的约束。开工前定下来，比事后返工便宜。

### 判断 1 —— 格式化命令走原生菜单，不要走 CodeMirror keymap

`MainWebView.performKeyEquivalent` 对所有带 ⌘ 的事件一律返回 `false`，把命令键整个交还给
菜单系统（这是修「文件树隐藏不了」时的解法）。菜单里没有的 ⌘ 组合能否落回 CodeMirror，
取决于事件是否继续下沉到 `keyDown:` —— **没实测过**。

无论实测结果如何，⌘B / ⌘1 这类命令都应该做成「格式」菜单项 + 扩 `MenuAction` 契约：
Typora 和 MarkText 都有格式菜单，可发现性本身就是需求。

> **先验证**：在 `setup.ts` 临时绑一个 `Mod-b` 打日志，用 `CURSIVE_SMOKE` 探针发一次 ⌘B，
> 看 console 通道有没有收到。顺带确认 ⌘← ⌘→ ⌘↑ ⌘↓ 这些 macOS 行首行尾/文档首尾导航键
> 在编辑器里还活着 —— 它们走同一条命令键路径。

### 判断 2 —— 块级组件一律照抄 `tableField`

ViewPlugin 不能提供跨行装饰（抛 `Block decorations may not be specified via plugins`，
还会连带崩掉行渲染）。表格渲染时已经踩过并解决：块级走 StateField，光标碰到时由
`decorate.ts` 用同一套 Reveal 判定回显源码，两个装饰集合天然不重叠。

数学块、mermaid、front matter 折叠全是这个模式的复制粘贴，**不要再各自发明**。

### 判断 3 —— 大数据不过 IPC 桥

图片落盘的常规做法（渲染层读 Blob → base64 → `evaluateJavaScript` 回传）在一张手机截图上
就会明显卡顿，而且 WKWebView 里 `DataTransfer` 的 File 拿不到真实路径。

正确形态：渲染层只发一个 `pasteImage(docDir)` 请求，壳从 `NSPasteboard` 取图、落盘到
`./assets/`、把相对路径返回来；拖拽同理，由壳侧 `registerForDraggedTypes([.fileURL])` 接管。
渲染层全程只处理一个字符串。

## 三、对标矩阵

`●` 有 · `◐` 部分 / 有限 · `○` 无

| 能力 | cursive | Typora | MarkText | 取舍 |
|---|:--:|:--:|:--:|---|
| 单窗格实时预览 | ● | ● | ● | 核心已追平 |
| 源码模式 / 多标签 / 文件树 / 大纲 | ● | ● | ● | 已追平 |
| 数学公式（KaTeX） | ● | ● | ● | 已追平，含货币符号收紧规则 |
| mermaid 等图表 | ● | ● | ● | 已追平，随主题配色 + 错误保留源码 |
| 脚注 / 高亮 / 上下标 / TOC | ● | ● | ◐ | 已补齐（emoji 取常用表） |
| 格式化快捷键（⌘B/⌘1-6…） | ● | ● | ● | 已补齐，含格式菜单 |
| Markdown 输入规则 | ● | ● | ● | 表格/围栏骨架已补（续行归 markdownKeymap） |
| 表格可编辑（工具栏 / 点单元格） | ◐ 只读渲染 | ● | ● | P2，本清单最难一项 |
| 智能粘贴 HTML → Markdown | ● | ● | ● | 已补齐，含 URL 包链接 / ⇧⌥⌘V 纯文本 |
| 图片粘贴 / 拖拽落盘 | ● | ● | ● | 粘贴落盘 + 拖图片/拖 .md 开标签 |
| 图床上传 | ○ | ● | ● | P4，自用可跳过 |
| 自动保存 + 崩溃恢复 | ○ | ● | ● | P0，丢内容是致命体验 |
| 外部变更监听 | ○ | ● | ◐ | P0，配合 git 用必需 |
| 跨文件全局搜索 | ○ | ● | ● | P3 |
| 文件树增删改 / 拖拽 | ○ 只读 | ● | ● | P3 |
| 专注模式 / 打字机模式 | ○ | ● | ● | P3，半天的事 |
| 主题切换 / 自定义 CSS | ◐ 跟随系统 | ● | ● | P3，变量都在，缺开关 |
| 排版偏好（字号/行距/栏宽） | ○ 硬编码 | ● | ◐ | P3，改 CSS 变量即可 |
| 导出 HTML | ○ | ● | ● | P4，其它导出的地基 |
| 导出 PDF（真分页） | ◐ 单页长条 | ● | ● | P4 |
| 导出 docx / epub | ○ | ● | ○ | P4，pandoc 桥接，本机未装 |
| 拼写检查 | ○ | ● | ● | 中文写作价值低，可缓 |
| 多窗口 | ○ 单窗口 | ● | ● | P3，已有多标签，不急 |
| 最近文件 / Finder 双击 | ◐ 壳里丢了 | ● | ● | P0，迁移回归 |
| **保存零损耗（字节不变）** | **● 有断言** | ○ | ○ | 两者都从 AST 重新序列化，会重写源码格式 |
| **体积 / 启动** | **● 3.4 MB** | ◐ | ○ ~200 MB | 原生壳换来的，别为任何功能牺牲 |

## 四、功能清单

分层不是按「重要性」排的，是按**依赖**排的：P0 不做完，后面每个功能都要写两遍；
P2 的手感项如果放在 P1 前面，会在数学/图表落地时和格式化命令抢同一批快捷键。

### P0 迁移收尾 —— ✅ 全部完成

目标（已达成）：仓库里只剩一套壳，文档不会因为崩溃或外部修改而丢内容。

#### ✅ P0-1 最近文件 + Finder 集成

- **需求**：「打开最近」菜单（10 项 + 清除）、Dock 图标右键最近列表、Finder 双击 .md、
  拖 .md 到 Dock 图标或窗口打开。Electron 版的 `store.ts` 有这套，壳里只剩 `lastFolder`
- **实现**：`NSDocumentController.noteNewRecentDocumentURL` 白拿系统最近列表；
  `application(_:openFile:)` 已有雏形，接上 `flushPendingOpen` 即可。契约不用改，
  壳侧直接 emit `file:opened`
- **验收**：冷启动后菜单有历史项；Finder 双击打开到**新标签**而不是覆盖当前标签

#### ✅ P0-2 自动保存 + 崩溃恢复

- **需求**：有路径的文档在停止输入 2 秒 / 窗口失焦 / 切标签时静默落盘；未命名文档写进
  `~/Library/Application Support/cursive/scratch/`，下次启动恢复成未命名标签。
  状态栏显示「已保存 14:32」。偏好可关
- **实现**：必须复用 `encodeDoc` 的指纹路径 —— 自动保存是最容易悄悄破坏「保存零损耗」的地方。
  渲染层已有 `savedDoc` 对比，加一个防抖即可
- **验收**：`pipeline.test.ts` 加一条「自动保存 10 次后字节仍不变」；`kill -9` 后重开能恢复未命名内容

#### ✅ P0-3 外部变更监听

- **需求**：文件在外部被改（git checkout、另一个编辑器、脚本）时：当前标签干净就静默重载并
  保留滚动位置与光标；脏就弹「重新载入 / 保留我的版本」。文件被删则标记为「已失效」
- **实现**：壳侧 `DispatchSource.makeFileSystemObjectSource`，新增推送通道
  `file:changed-externally`（先补 `types.ts` 和 `CONTEXT.md` 的契约）
- **坑**：**大多数编辑器保存是 rename-replace**，原 fd 会失效、事件只来一次 —— 收到
  `.rename`/`.delete` 后必须重新打开并重注册监听，否则第二次外部修改就静默丢失
- **验收**：外部 `echo >> a.md` 后 1 秒内视图更新，且光标行不跳

#### ✅ P0-4 删掉 Electron 版

**已完成**：删 `src/main`、`src/preload`、`electron-vite.config.ts`、
`electron-builder.config.cjs`、`tsconfig.node/web.json`，移除 electron / electron-store /
electron-vite / electron-builder 依赖；构建改为根目录 `vite.config.ts`
（root=`src/renderer`，base=`./`，output=`out/renderer`）。`scripts/make-icon.mjs` 改为
纯 `sips`+`iconutil`。README / CONTEXT.md 已同步。验收：干净 clone 不装 electron，
`npm run build` + `release.sh` 全绿。

### P1 内容能力 —— ✅ 全部完成（P1-1～P1-5）

目标：任何一份正常的技术 Markdown 打开都不会看到裸源码。
数学与图表已落地，「看起来像 Typora」视觉部分到此完成。

#### ✅ P1-1 KaTeX 数学公式

- **需求**：行内 `$x^2$` 与块级 `$$…$$` 渲染为公式，光标进入回落源码（Reveal 已有）；
  解析失败显示红色源码而不是崩掉
- **实现**：GFM 不含 math，要给 `@lezer/markdown` 写一个 `MarkdownConfig`：`defineNodes` +
  InlineParser（行内）+ BlockParser（块级）。行内走 ViewPlugin，块级走 StateField（判断 2）。
  KaTeX 的 CSS 和字体打进 `out/renderer`，壳的 mime 表已经有 `woff2`
- **坑**：中文文档里 `$` 常是货币符号。用 CommonMark-math 的收紧规则：**开定界符后不接空格、
  闭定界符前不是空格**，并且两侧不紧邻数字，否则「￥5 到 $10」会被吃成公式。
  另：`markdown-lang.ts` 当初刻意不用 `markdownLanguage` 就是为了避开 Superscript 吃掉
  `$e^{-x^2}$` —— 这块地基是为这项留的
- **验收**：`dialect.test.ts` 加 InlineMath/BlockMath 节点断言；`release.sh` 加 `math.md`
  用例断言 `.katex` 计数非零；CSP 下字体确实加载（否则公式会用系统字体凑合，肉眼不一定看得出）

#### ✅ P1-2 mermaid 图表

- **需求**：` ```mermaid ` 代码块渲染成图；渲染失败保留源码并显示错误行；跟随深浅色主题
- **实现**：块级 StateField + 懒加载 `import('mermaid')`（约 1 MB，Vite 自动分 chunk，壳的
  `app://r` 能服务动态 import）。Widget 里异步渲染：先占位、拿到 SVG 再填充；`eq()` 按源码
  字符串比较，`destroy()` 取消未完成的渲染
- **坑**：页面 CSP 是 `script-src 'self'`。mermaid 的部分图类型（mindmap/cytoscape 系）依赖
  `new Function`，会被拦。**先只启用 flowchart / sequence / gantt / class / state**，
  确有需要再评估放宽 CSP —— 放宽是安全决策，不是顺手改的配置
- **验收**：10 张图的文档滚动不掉帧（证明 `eq()` 缓存生效）；改一个字符只重绘那一张图

#### ✅ P1-3 方言补齐：脚注 / 高亮 / 上下标 / emoji / TOC

- **需求**：`[^1]` 脚注（引用处 hover 预览、点击跳转，定义区折叠）、`==高亮==`、
  `H~2~O` / `x^2^`、`:smile:`、`[TOC]` 渲染成目录组件
- **实现**：全部是 `@lezer/markdown` 扩展 + 一个 widget，一次性做完比分批便宜
- **坑**：上下标与数学公式抢 `^`。必须让 math 的 parser 优先级高于 Superscript，或者把上下标
  做成可关的偏好项 —— 这正是当初弃用 `markdownLanguage` 的原因，别把它又装回来
- **验收**：`dialect.test.ts` 每种语法一条断言，并且带 `$e^{-x^2}$` 的回归用例仍然解析成
  Math 而不是 Superscript

#### P1-4 代码块增强（0.5 天）

右上角语言标签 + 复制按钮；光标进入时可切换语言；长行横向滚动而不是撑破栏宽。
行级装饰已经有 `.cm-lp-code`，加一个挂在首行的 widget 即可，不碰文本。

#### P1-5 图片显示增强（0.5 天）

点击放大预览；支持 Typora 的尺寸语法 `![alt](src =600x)`；加载失败时显示解析后的完整路径
（现在只显示 alt，排查不了是路径错还是文件缺）。

### P2 编辑手感 —— P2-1～P2-5/P2-7 ✅，剩 P2-6（表格工具栏）

目标：写作时手不离键盘。这一层每一项都直接改文本、走 `dispatch({changes})`，因此撤销栈全部
免费兼容 —— 这是 CM6 路线相对 contenteditable 路线最大的红利，要用足。

#### ✅ P2-1 格式化命令 +「格式」菜单

- **需求**：⌘B 粗体 · ⌘I 斜体 · ⌘U 下划线 · ⌘K 链接 · ⌃⌘C 行内码 · ⇧⌘X 删除线 ·
  ⌘1–⌘6 标题 · ⌘0 正文 · ⇧⌘K 代码块 · ⇧⌘Q 引用 · ⇧⌘[ / ⇧⌘] 有序/无序列表 · ⇧⌘C 任务项
- **实现**：NSMenu「格式」菜单 → 现有 `menu` 通道 → 渲染层命令表，`MenuAction` 增加约 12 个
  `format:*`（见判断 1）。三处契约同步：`types.ts` / `main.swift` / `CONTEXT.md`
- **语义**：无选区时作用于光标所在词（中文按 `Intl.Segmenter` 分词，不要按空格）；
  已是该格式则取消，必须幂等；多光标要全部生效
- **验收**：加粗再加粗 = 原文；⌘Z 一次撤回整个格式化动作而不是逐字符

#### ✅ P2-2 Markdown 输入规则

- **需求**：行首 `## ` → 标题、`- ` / `1. ` / `> ` → 列表与引用、```` ```lang ```` + 回车 →
  代码块骨架、`---` + 回车 → 分隔线、`|a|b|` + 回车 → 表格骨架
- **实现**：一个 `EditorState.transactionFilter` 或输入处理扩展；只在行首触发，避免正文里的
  `-` 被误伤
- **坑**：输入规则必须能**一次撤销回触发前**。用事务 annotation 把「输入字符 + 规则改写」
  合并成一次历史条目，否则 ⌘Z 会撤出一个半成品状态

#### ✅ P2-3 列表智能行为

- **需求**：Tab / ⇧Tab 在列表项内升降级、有序列表自动重编号、空列表项回车退出列表、
  任务项回车自动带 `[ ]`
- **现状**：`markdownKeymap` 已经给了回车续行和退格删标记，**缺的是升降级和重编号**。
  Tab 现在绑的是 `indentWithTab`，要在列表上下文里优先接管

#### ✅ P2-4 智能粘贴

- **需求**：粘贴 HTML（网页、飞书、Notion）自动转 Markdown；选中文字时粘贴 URL 自动包成链接；
  ⇧⌥⌘V 粘贴为纯文本
- **实现**：turndown（约 30 KB）+ `EditorView.domEventHandlers.paste`。转换结果要过一遍自己的
  方言：转出来的 `*` 强调符要统一成文档里在用的风格

#### ✅ P2-5 图片粘贴 / 拖拽落盘

- **需求**：截图后 ⌘V 直接落盘到 `./assets/` 并插入相对链接；从 Finder 拖图片进窗口同理；
  拖 .md 进来则打开为新标签。偏好：资源目录规则、是否复制外部图片
- **实现**：见判断 3。新契约 `pasteImage(docDir) -> {relPath} | null`，壳从 `NSPasteboard`
  取图落盘；拖拽由壳侧 `registerForDraggedTypes` 接管。命名用 `<文档名>-<时间戳>.png`，
  避免多文档共用目录时撞名
- **验收**：粘贴一张 4 MB 截图，从按键到图片显示 < 300 ms；文件名含中文和空格时链接仍能加载
  （复用现有 `safe-file` 的双重解码用例）

#### P2-6 表格编辑器（2 天）

- **需求**：点渲染态表格的某个单元格，光标落到源码里对应的位置；浮动工具栏增删行列、设对齐；
  Tab / ⇧Tab 跨单元格，行末 Tab 新建行；保存时管道符对齐美化（可关）
- **实现**：`parseTable` 目前只产出文本，要让它同时记录**每个单元格的源码偏移**，widget 才能
  把点击映射回位置。工具栏用 `view.coordsAtPos` 定位。所有操作走 `dispatch({changes})`，撤销免费
- **取舍**：清单里最难的一项，也是体验差距最明显的一项。时间紧就先只做「点单元格定位光标」，
  工具栏后补 —— 前者才是真正解决「表格改不动」的那一半

#### ✅ P2-7 查找替换本地化与增强

- **需求**：现在是 `@codemirror/search` 的默认英文面板。重配皮肤：中文标签、正则/大小写/整词
  开关、「第 3 个 / 共 12 个」计数、⌘G / ⇧⌘G 查找下一个/上一个
- **坑**：⌘G 必须同时加进「编辑」菜单 —— 命令键分发路径被壳改写过（判断 1），
  只在 keymap 里绑不一定生效

### P3 工作区（约 9 天）—— 当主力工具用的门槛

目标：管理一个几百篇文档的目录而不用切回 Finder 和 VS Code。按需挑，不必全做。

| 编号 | 功能 | 要点 | 估时 |
|---|---|---|:--:|
| P3-1 | 文件树可写 | 右键新建/重命名/删除/在 Finder 显示、拖拽移动。删除一律 `NSFileManager.trashItem`，不要 `removeItem`；每个新通道都要校验路径在树根内（沿用 `FileSchemeHandler` 的防穿越写法） | 1.5 天 |
| P3-2 | 跨文件全局搜索 | **必须在壳侧实现**，渲染层递归 `readDir` 会让 IPC 往返爆炸。`searchFiles(root, query, opts)` 流式回推，用可取消的 Operation | 1.5 天 |
| P3-3 | 专注 + 打字机模式 | 专注的行级装饰放进 `live-preview` 同一个 plugin，省一次语法树遍历；打字机的地基已有 —— `theme.ts` 里 `.cm-scroller` 的 `paddingBottom: 40vh` 就是为它留的 | 0.5 天 |
| P3-4 | 主题系统 | 内置浅/深/跟随系统/护眼 + 扫描 `~/Library/Application Support/cursive/themes/*.css`。CSS 变量已就位，缺的只是开关和持久化；壳侧要同步 `NSAppearance`，否则标题栏还是系统色 | 1 天 |
| P3-5 | 排版偏好面板 | 字号/行距/栏宽（`--column` 现硬编码 46rem）/衬线切换。**投入产出比最高**：全是现成变量，做的其实是一个面板，而这恰是 Typora 用户改得最勤的东西 | 1 天 |
| P3-6 | 大纲增强 | 折叠、层级过滤、拖拽重排章节（= 整段文本移动，撤销兼容）、每节字数 | 1 天 |
| P3-7 | 多窗口 | 要把 `AppDelegate` 里的单 window/webView 抽成 `DocumentWindowController`。越早做越便宜，但有了多标签后紧迫性不高 | 1.5 天 |
| P3-8 | 状态栏与统计 | 光标行列、选区字数、阅读时间、点击弹详细统计。`wordcount.ts` 的 CJK 分词已经写对了，只是没展示 | 0.5 天 |

### P4 导出与分发（约 6 天）

目标：文档能离开 cursive。只有在需要把东西交给别人时才值得做 —— 自用场景下优先级最低。

| 编号 | 功能 | 要点 | 估时 |
|---|---|---|:--:|
| P4-1 | 导出 HTML | 单文件：内联主题 CSS + KaTeX CSS，图片可选 base64，mermaid 导静态 SVG。**先做这项**，PDF / 复制为 HTML / pandoc 全以它为地基。**坑**：导出走全文渲染而编辑器只渲染视口，两条路径对同一段 md 的理解必须一致（原计划点名的**方言漂移**风险），配 golden 测试对比两边输出 | 1 天 |
| P4-2 | PDF 真分页 | 现在 `WKPDFConfiguration.rect` 出的是**单页长条**。改走 `webView.printOperation(with:)` + `@page` CSS，支持 A4/Letter、页边距、页码，标题不被切断（`break-after: avoid`）。验收沿用现有约定：不用 PDFKit 提文本（CJK 失真），看页尺寸 595×842、页数、`strings \| grep Subtype.*Image` | 1 天 |
| P4-3 | 复制为 HTML / 纯 Markdown | 选中内容复制为富文本（贴进飞书/邮件带格式）或纯源码。`NSPasteboard` 同时写两种类型 | 0.5 天 |
| P4-4 | pandoc 桥接 | docx / epub / latex / rtf。检测不到 pandoc 就灰掉菜单并提示安装（本机未装，原计划已写明降级策略） | 1 天 |
| P4-5 | 签名公证 + 自动更新 | 现在是 ad-hoc 签名，拷到别的机器会被 Gatekeeper 拦。要分发就需要 Developer ID 签名 + 公证 + Sparkle 通道。**纯自用则永远不做；一旦想给第二个人用，这项就变成 P0** | 2 天 |

### P5 差异化（可选，未排期）

- 双链 `[[wiki]]` + 反链面板 + 标签索引
- AI 辅助：选中改写 / 续写 / 翻译 / 生成大纲。走壳侧 `URLSession` 调 API，**渲染层不碰密钥**
- 版本历史：每次保存打 git snapshot，侧栏时间线 + diff
- 代码块执行

## 五、非功能红线

不是某个里程碑的任务，是所有改动的准入条件。前两条已经有自动化断言守着，别让它们退化。

1. **保存零损耗** —— 任何功能都不得在用户没主动要求时改写源码。`test/pipeline.test.ts` 是红线；
   自动保存、智能粘贴、表格美化是最容易破坏它的三处
2. **输入法安全** —— 新 widget、新 keymap 都要过「中文连打 200 字不掉字」。
   铁律不变：`view.composing` 为真时绝不重算装饰器，新增的 StateField 同样适用
3. **性能预算** —— 1 万行 + 50 个公式 + 10 张图，滚动不掉帧，打字无延迟。每个 widget 必须
   实现 `eq()`；块级 StateField 的全文遍历要有提前返回，别在长文档上白跑
4. **契约三处同步** —— `types.ts` ↔ `main.swift` ↔ `CONTEXT.md`。壳侧发现契约缺口，
   先补文档再动代码
5. **E2E 跟进** —— 每个新功能在 `release.sh` 里加一个 `run_case`。现有 4 个用例
   （img / table / kitchen-sink / crlf）就是模板
6. **壳与引擎的边界** —— `src/renderer` 只认 `window.api`，不碰任何原生能力。这是当初能把
   Electron 换成 Swift 而 renderer 零改动的原因

## 六、节奏

按业余时间估，总计约 26 天。每一段结束都应该是一个能日常用的版本，而不是半成品。

| 阶段 | 内容 | 做完的标志 |
|---|---|---|
| 第 1 段 | P0 全部 | ✅ 完成：仓库里没有 Electron，崩溃能恢复，外部改文件会同步 |
| 第 2 段 | P1-1 ~ P1-5 内容五件套 | ✅ 完成：数学/mermaid/脚注/高亮/上下标/emoji/TOC/代码块标签/图片放大全部渲染，不再看到裸源码。视觉上「像 Typora」到此为止 |
| 第 3 段 | P2-1 → P2-5 手感五件套 | 从网页抄一段带图的资料，全程不用碰鼠标。体验从「能用」跳到「顺手」 |
| 第 4 段 | P2-6 表格编辑 + P1-3 方言补齐 | 两个「难但影响面窄」的项目放一起收 |
| 随后 | P3 按需挑，P4 等要交付给别人再说 | P3-5 排版偏好、P3-3 专注/打字机各半天到一天，性价比最高，可随时插队 |
