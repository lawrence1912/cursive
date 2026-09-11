# cursive 开发上下文（AI 助手必读）

## 一句话

Typora 风格的 macOS Markdown 编辑器。**Swift 壳（AppKit + WKWebView）+ `src/renderer`（CodeMirror 6）**；Electron 版已彻底删除（P0-4），构建链只剩 Vite → `out/renderer`。

## 功能要点（renderer）

- **文件树**：`sidebar.ts` 懒加载树。打开单个 .md 且未开过文件夹时，`setActive` 自动把文档目录挂为树根（sbRows E2E 断言把关）
- **大纲视图**：`ui/outline.ts`，右侧 220px 面板。标题来自 syntaxTree 的 ATX/SetextHeading 节点（250ms 防抖重建）；点击 `scrollIntoView(y:'start')` 跳转；滚动时按「视口顶部行之前最近的标题」跟随高亮。显隐 = 菜单 `view:toggle-outline`（⌘⇧T，新增 MenuAction——契约已同步 types.ts），状态存 localStorage `cursive.outlineVisible`。**两个面板开关在标题栏两端**（`.tb-btn`，main.ts 插进 `#drag-strip`：左内边距 78 躲开红绿灯、右留 10，26×26；**顶部 3px 不是 align-items:center** —— 红绿灯是 14×14、圆心离窗口顶 16pt，按 38px 条高居中会落到 19，低 3px；两个数都由探针 `trafficEnd`/`trafficMidFromTop` 实测把关），面板藏了开关还在，亮=面板开着（`.is-on` + aria-pressed）。面板头部原来的隐藏按钮、以及更早的「唤回浮标」（#sb-show/#ol-show，absolute 钉在 #main 左右上角，正好压住第一个标签）**都已删**，开关只剩标题栏 + 菜单 ⌘\ / ⌘⇧T 两条路，且都走 main.ts 的 `toggleSidebar()`/`toggleOutline()`（localStorage 持久化和按钮状态各只有一份）。E2E 防回归：`tabHit`（藏起文件树后 `elementFromPoint` 打第一个标签中心）、`tbHoleLeft/tbHoleRight`（原生放行）、`tbHitPage`（页面命中）、`tbToggle`（点击真切面板）、`trafficEnd ≤ 72`（左按钮躲开红绿灯）、`|tbMidY - trafficMidFromTop| ≤ 1`（与红绿灯同线）。**布局总览**：drag-strip(38) → **main(左 sidebar 通栏 | center=tabbar+editor | 右 outline 通栏)** → status-bar。标签栏只属于中间编辑器列（在文件树/大纲的右侧），不横贯全宽；DOM：index.html 静态 #main/#center 骨架，sidebar/tabbar/outline 由 main.ts 插入对应槽位
- **标签页**：`main.ts` + `ui/tabbar.ts`。每标签持有完整 EditorState（切走冻结/切回 setState，装饰+撤销历史+光标随 tab 走）；`setDocState` 的 dirty 聚合为「任意标签脏」，`file:save-and-close` = 所有脏标签落盘（任一取消即中止关窗）；关闭最后标签自动开新空白标签；开新标签**不**触发 dirty 守卫（不会丢内容）。布局：#tabbar 在 drag-strip 之下 32px，打印时隐藏
- **chrome 视觉网格**（真相 = `base.css` 顶部那几个 token，别在组件里写死尺寸）：`--chrome-size:13px`（树行/大纲行/标签，macOS 的界面字号）、`--chrome-label:12px`（面板小标题 + 状态栏）、`--chrome-row:30px`、`--tabbar-h:40px`、`--status-h:30px`、图标 16px（`ui/icons.ts` 一处改全局）。拖拽条与侧栏/标签栏/大纲/状态栏同属 chrome 层 `--surface`，**只有正文那张纸是 `--bg`**。**标签栏**：活动标签 = 编辑区那张纸的顶边（`--bg` + 1px 描边 + 8px 上圆角，与正文连成一片），分隔线画成 `#tabbar` 的 `box-shadow: inset 0 -1px 0`（border-bottom 在盒子外沿，子元素盖不住它；inset 在背景层，活动标签的底色正好压住那一段）；所有标签等高（条高 40 − 顶部 6 = 34，用 `height:100%` 拿），**活动态不能比别人高**，否则文字基线会跳；非活动标签不画边框（一排描边盒子 = 格栅），关闭 × 平时 `opacity:0`、hover/活动/键盘聚焦才现身（用 opacity 不用 display，位置留着才不抖）。原先那条「顶部 2px 蓝条」已删 —— 连成一片本身就是当前位置的信号。
- **表格真渲染**：`index.ts tableField`（StateField）+ `widgets.ts TableWidget/parseTable`。块级（跨行）装饰**只能走 StateField**，ViewPlugin 的会直接报错；光标碰到由 decorate.ts 回显源码（同一套 reveal 判定，两个集合不重叠）。样式 `.cm-lp-tableview`。**表格必须点得进去**：`WidgetType.ignoreEvent()` 默认返回 true = widget 里的事件编辑器一概不管（CM 的 `eventBelongsToEditor` 直接判定事件不属于编辑器，连 `domEventHandlers` 都收不到）→ 点表格毫无反应、改不了字。现在 TableWidget 只放行 `mousedown`（其余继续忽略，否则 widget 内容会被 DOM observer 当成编辑输入写回文档），index.ts 的 `editTableOnClick` 接住它：`posAtDOM(单元格)` 拿到表格块起点 → 行号 = 起点行 + （表头 0 / 正文 n+1，**源码第 1 行是分隔行，DOM 里没有它**）→ `cellSpan()`（widgets.ts）算出那一格文字在行内的偏移 → 点左半格进格首、右半格进格尾。选区一动 reveal 就把整块换回源码，于是可以直接打字。E2E `tableEdit` + 6 个 `cellSpan` 单测把关

## 决策记录（2026-09-11）

- 只做 macOS，不做跨平台
- 不引入 Rust/Tauri
- 壳 = Swift + AppKit + WKWebView；原型在 `shell-swift/main.swift`，已探针验证渲染进程完整启动
- **P0-4 已完成**：删除 `src/main` / `src/preload` / electron 系依赖与配置，构建只走根目录 `vite.config.ts`（root=`src/renderer`，base=`./`，output=`out/renderer`）；`electron-vite.config.ts`、`electron-builder.config.cjs`、electron/electron-store/electron-vite/electron-builder 均已移除。`package.json` 无 `main` 字段，`npm run build` = `vite build`

## 架构与契约

- 渲染进程：`src/renderer`，产物 `out/renderer`，纯 CodeMirror 6 —— **构建链里没有 Electron/Node 依赖**，原生能力一律经 `window.api`
- IPC 契约 = `window.api`（签名见 `src/shared/types.ts` 的 `CursiveApi`），壳侧 1:1 实现：
  - invoke：`openDialog` / `read` / `save` / `saveAs` / `confirmDiscard` / `openExternal` / `pickFolder` / `readDir` / `lastFolder` / `setAppearance`
  - send：`setDocState` / `confirmClose`
  - 壳→渲染推送：`menu` / `file:opened` / `folder:opened`
- 菜单动作字符串（真相在 `src/shared/types.ts` 的 `MenuAction`）：`file:new` `file:open` `file:save` `file:save-as` `file:save-and-close` `file:open-folder` `edit:find` `view:toggle-source` `view:toggle-sidebar` `view:toggle-outline` `view:theme-system` `view:theme-light` `view:theme-dark` `app:preferences`
- **主题与排版偏好**：真相在渲染层 localStorage `cursive.prefs`（`ui/prefs.ts`）。CSS 只认 `data-theme="light|dark"` 两个确定值，`system` 由 matchMedia 解析后钉上去；`base.css` 里那份媒体查询只兜首帧（CSP 禁内联脚本，抢不到更早时机），**暗色 token 两份必须同步改**。切主题会调 `setAppearance` 让壳设 `NSApp.appearance` —— 不设的话标题栏/红绿灯/NSAlert/NSOpenPanel 还是系统色，切一半很违和。字号/行距改完必须 `view.requestMeasure()`，否则 CodeMirror 缓存的字符尺寸是过期的
- 文件读写必须走 `src/shared/textfile.ts` 的 BOM/EOL 指纹逻辑（Swift 侧已移植为 `decodeDoc`/`encodeDoc`），保证「保存零损耗」

## 自定义协议（两个，缺一不可）—— ✅ 已实现

1. **`app://r/<相对路径>`** → 服务 `out/renderer` 静态资源。原因：`<script type="module" crossorigin>` 在 WKWebView 的 `file://` 下因 opaque origin **静默失败**。壳已实现 `FileSchemeHandler`（含路径穿越防护）。
2. **`safe-file://local/<绝对路径>`** → Markdown 图片加载。渲染层由 `src/renderer/editor/live-preview/decorate.ts` 生成这种 URL。壳侧已实现，**E2E 验证中文/空格文件名图片可加载**。

## 契约 v2（P0 自动保存 / 崩溃恢复 / 外部变更）

- `CursiveApi` 新增：`scratchSave(id,content,fp)`（无路径文档静默写
  `~/Library/Application Support/cursive/scratch/<id>.json`）、`scratchList()`、
  `scratchClear(id)`、`confirmReload(name) → 'reload'|'keep'`、`openTabs(paths)`
  （壳据此注册外部变更监听）；推送通道新增 `file:changed-externally(path)`
- **崩溃恢复不许抢焦点**：`scratchList()` 是异步的，而 argv/Finder 那份文件是壳轮询 `__cursive` 就绪后推过来的 —— 谁先到都有可能。恢复前先记下「活动标签是否已有路径」，spawnTab 完再 `activate` 回去；另外过滤启动空白页之后必须校正 `activeId`，否则它悬空 → 后续 `activate()` 既不冻结旧 state 也不更新 `docPath`，状态栏会一直挂着一个已经不存在的文件名（真出现过：三个标签 + 状态栏显示另一个文件）
- 自动保存：停止输入 2s / 切标签 / 失焦时静默落盘，**必须走 encodeDoc 指纹路径**
  （E2E 验证字节级一致）；无路径文档进 scratch；真正保存/关闭时清 scratch
- 外部变更：壳侧 DispatchSource 监听 openTabs 的所有路径；
  **rename/delete 后必须重开重注册**（rename-replace 保存会让 fd 失效，事件只来一次）；
  0.8s 节流。渲染层收到后：与磁盘一致（自己的自动保存触发）→ 忽略；
  干净 → 静默重载保留滚动/光标；脏 → confirmReload 弹窗；非活动标签脏 → 标记 ⚠ 失效
- 已知坑：Swift 三引号字符串里的 `\n` 是真实换行 —— 拼进 JS 字符串字面量会变成
  跨行语法错误（callAsyncJavaScript 报 "A JavaScript exception occurred" 且
  try/catch 接不住，因为是 parse 错误）。要写 `\\n`

## 已踩坑（勿再踩）

- ⌘C/⌘V 在 WKWebView 不生效，除非应用菜单里有接线的「编辑」菜单（`Selector("cut:")` 等）
- `evaluateJavaScript` 与 `WKUserScript` **不受页面 CSP 限制**（页面 `script-src 'self'` 拦不住注入）
- **didFinish 可能早于渲染层模块执行完**：监听器没注册时 emit `file:opened` 会静默丢失。壳侧轮询 `window.__cursive`（main.js 末尾暴露的就绪标记）就绪后再发射，见 `flushPendingOpen()`
- **WebKit 会对自定义 scheme 的 URL 再做一次百分号编码（`%` → `%25`）**，而渲染层拼 safe-file URL 时已经 encodeURI 过了 → handler 逐级解码：解一次文件不存在就再解一次（对字面 `%` 文件名依然成立）
- 探测图片要用 `.cm-lp-image img`，`.cm-editor img` 会先匹配到 CodeMirror 自己的隐藏占位 `cm-widgetBuffer`（src=null）
- **live-preview 装饰只铺可视视口（设计如此）**：视口外的图片 widget 不存在，滚动到位才建，不是 bug
- **CM6 的 parse 是异步分块的**，且 `update()` 的 docChanged/selectionSet/viewportChanged 都不响应 parse 推进 → 首开长文档时深处节点拿不到树、装饰缺失。修复：`buildDecorations` 里用 `ensureSyntaxTree(state, visEnd + 1000)` 把可视范围强制同步解析到位（有限界，不伤大文档）。（当时 Electron 版也有同款潜在 bug，顺带修了）
- **同款坑的块级版更隐蔽**：`blockField`（表格/公式/mermaid 共用的 StateField）的重建只挂在 docChanged/selection/主题效应上，「打开文件 / 外部重载 / 切标签」这类**纯换 state 的路径**之后没人再推它一把 —— 字段初值是在空树上算的，装饰就永远缺失（tableField 时代就潜伏着，E2E 能过纯靠时序侥幸）。块级装饰本来就是全文范围的，只能 `ensureSyntaxTree(state, doc.length)` 全文强制同步解析。test/block.test.ts 不依赖 DOM 就能断言这些
- **WKWebView 会持久缓存自定义 scheme 的响应**：`FileSchemeHandler` 裸 `URLResponse` 不带缓存指令 → `app://r/index.html`（固定文件名 = 永远同一个缓存键）被磁盘缓存，重新构建后浏览器还在跑旧 bundle，症状是「改了代码却永远不生效」。修复：响应用 `HTTPURLResponse` 显式带 `Cache-Control: no-store` + `Content-Type`（.js 不是 text/javascript 的话 ES module 被拒载），启动时再清一次 WebKit 数据库自愈老缓存。调试「改了没生效」先怀疑这个，别急着怀疑自己的代码
- 编译固定 `swiftc -O -swift-version 5`（避开 Swift 6 严格并发检查）；CLT 即可，无需 Xcode.app
- 编译输出里 8 个 `use '#selector' instead of Selector(...)` 警告是**刻意的**（undo:/cut:/paste: 等响应链派发必须用字符串选择器），忽略，不要"修"
- `NSWindow` 脏标记是 `isDocumentEdited` 属性（没有 `setDocumentEdited()`）
- `NSAlert.runModal()` 返回 `ModalResponse`，做数组下标要 `.rawValue` 运算
- 大字符串回传：`evaluateJavaScript("window.api._resolve(\(id), <json>)")`，JSON 用 `JSONSerialization` 生成，别手拼；异步通道用 `callAsyncJavaScript(body, arguments:, in: nil, in: .page)`（body 是第一个无标签参数）
- `#drag-strip` 拖拽（两代实现，现在是确定性方案）：WKWebView 不认 `-webkit-app-region`，且把 `mouseDownCanMoveWindow` 重写为 false。第一代「叠 NSView + isMovableByWindowBackground」**失败**——当时 contentView 就是 webView，`addSubview(_, positioned:, relativeTo: webView)` 相对自身属未定义用法。现在的做法：① 容器视图做 contentView，webView 与 `DragStripView` 平级兄弟；② 条的 `mouseDown` 直接 `window.performDrag(with: event)`（与系统标题栏同源，不依赖任何机制位）。**38px 高度与 base.css `--drag-strip` 强耦合，改 CSS 记得同步壳**；③ `clickCount == 2` 走 `performDoubleClickAction()` —— titleVisibility 藏了系统标题栏，双击缩放 AppKit 不会替你接，得自己读 NSGlobalDomain 的 `AppleActionOnDoubleClick`（Maximize 默认 / Minimize / None）再分派 `performZoom`/`performMiniaturize`。单击那条先进 performDrag 的拖拽循环，跑完才返回，第二击照常带 clickCount=2，两者不打架；④ 条子两端要给标题栏按钮**挖洞**：`hitTest` 在左 72–110、右末尾 42 这两段返回 nil，点击才落得到网页上的 `.tb-btn`（区间按 `webView.pageZoom` 缩放 —— 页面一缩放 CSS px 就不等于点了），**这几个数与 base.css `#drag-strip` 的内边距/按钮尺寸强耦合**；smoke 探针有 `dragStripHit`（原生 hitTest）与 `dblClickZoomed` 自动把关（后者**必须先把窗口设成确定的小 frame**：窗口若已在 standard state，zoom 只会试着回 user state，而新窗口没有 user state，frame 纹丝不动 → 假阴性）
- renderer 行为用壳内探针 + vitest 验证（无头环境点不了界面，靠 `/tmp/cursive-shell-*.json` 断言）
- `WKPDFConfiguration.rect` 输出**单页** PDF（页尺寸 = rect），不是分页文档；要 A4 分页需走 `WKWebView.printOperation`（NSPrintOperation）或 print CSS @page，当前长条页方案对自用足够

## 自检探针 / E2E（每次改壳必跑）

```sh
CURSIVE_SMOKE=1 ./shell-swift/cursive-shell <file.md>
# +3s 写 /tmp/cursive-shell-check.json   （DOM：hasApi/cm/sidebar/status）
# +4s 写 /tmp/cursive-shell-e2e.json    （read→save 逐字节往返 + 装饰计数 + 图片加载），然后自动退出
```

另加 `CURSIVE_SMOKE_SHOT=<png>`（截 webView）、`CURSIVE_SMOKE_THEME=dark|light|system`（截图前切主题，走查两套配色；**会写进 localStorage，走查完用 system 复位**）、`CURSIVE_SMOKE_SCRATCH_DELAY=<ms>`（拖慢 scratchList 应答，逼出「文件先到、崩溃恢复后到」的竞态）。⚠️ `~/Library/Application Support/cursive/scratch/` 里的残留快照会被下一轮当成待恢复草稿开出来，把用例打开的文件挤成非活动标签 —— release.sh 每轮开头会清空它，手跑探针时也记得清。

另加 `CURSIVE_SMOKE_PDF=<路径>`：E2E 后顺带导出 PDF（绕过保存面板），结果写 `/tmp/cursive-shell-pdf.json`（bytes/error）。

验证 PDF 不要用 PDFKit 提取文本（CJK 提取严重失真），改用结构信号：页尺寸（`PDFDocument.page.bounds` 应为 595×内容高）、`strings out.pdf | grep -c "Subtype */Image"`（图片对象数）、`sips -s format png` 转 PNG 目检。

⚠️ 探针/E2E **只在 `CURSIVE_SMOKE` 环境变量下运行**；不带该变量启动是正常交互应用，绝不自动退出。
（历史教训：曾把 `NSApp.terminate()` 编进默认路径，导致「启动几秒后闪退」。）
从 Finder/非项目根目录启动时，cwd 不是项目根 —— renderer 资源路径按可执行文件位置向上回退（shell-swift/ 的上级）。

PASS 标准：`status`=打开的文件名；`bytesEqual=true`（BOM/CRLF 指纹还原）；`counts.cm-lp-*` 视口内非零；图片用例 `img.loaded=true`；`tabHit=true`（无浮层压标签）；`tbHoleLeft/tbHoleRight/tbHitPage=true`、`trafficEnd≤72`、`|tbMidY - trafficMidFromTop| ≤ 1`（标题栏开关点得到、不撞红绿灯、与红绿灯同一条水平线）；`dblClickZoomed=true`（系统偏好非 Maximize 时该项跳过，只记 `dblClickAction`）。
测试夹具生成：见 `/tmp/cursive-e2e/`（kitchen-sink.md / crlf.md / img.md + assets），图片 URL 里的空格/中文要百分号编码（渲染层 parseImage 不接受裸空格）。

## 构建与运行

```sh
./shell-swift/release.sh              # 标准工作流：测试 + E2E 全绿才打包 dist/cursive.app
CURSIVE_DMG=1 ./shell-swift/release.sh  # 同上，额外出 DMG
./shell-swift/cursive-shell [file.md]   # 开发运行（项目根执行；资源查找 Bundle → cwd → exe 相对）
```

**约定：每轮改动收尾必须跑 `release.sh`，让用户随时拿到全绿的新包。**

## 路线图

**完整清单见 `ROADMAP.md`** —— 现状盘点 + 对标 Typora/MarkText + P0–P4 共 26 项，带验收标准与坑。
本节只留「已完成（含踩坑记录）」和「当前这一轮」。

### 已完成（勿重做）

1. ~~safe-file://local SchemeHandler（图片）~~ ✅ 含双重解码坑
2. ~~argv 打开文档 + E2E 验证（read→save 往返/装饰/图片）~~ ✅；**待手动验证**：打开/另存为面板、脏标记关闭拦截、Finder 双击 .md（`application(_:openFile:)` 已有雏形）
3. ~~PDF 导出~~ ✅ 文件 →「导出为 PDF…」（⌘P）：离屏 595pt(A4) WKWebView 加载同一 renderer，`__shellEmit` 注入实时内容（含未保存修改），注入打印 CSS（隐 sidebar/状态栏/drag-strip、白底、高度自适应），等 `document.fonts.ready` + 图片 `decode()` 后 `createPDF`。输出为**单页长条 PDF**（页高=内容高），打印样式在 `PDFExporter.printCSS`
4. ~~打包~~ ✅ `./shell-swift/make-app.sh`（加 `CURSIVE_DMG=1` 连 DMG 一起出）：组装 dist/cursive.app（Info.plist 含 .md 关联 rank=Alternate/NSHighResolutionCapable，icon 用 build/icon.icns）→ ad-hoc 签名 → hdiutil 打 DMG。产物 ~3.5MB / DMG ~1.7MB。已验证：bundle 内 smoke、`open` 启动、`open -a` 带文档启动。注意：壳的 `findRendererRoot()` 三级查找顺序 Bundle Resources → cwd/out/renderer → exe 相对路径
5. ~~P0-1 最近文件 + Finder 集成~~ ✅ `NSDocumentController` 系统最近列表（打开/保存时 note）、文件菜单「打开最近」10 项 + 清除、Dock 右键；E2E 断言 `recents≥1`
6. ~~P0-2 自动保存 + 崩溃恢复~~ ✅ 停输入 2s / 切标签 / 失焦静默落盘（走 `encodeDoc` 指纹路径，E2E 断言字节一致）；无路径文档进 scratch，启动恢复为未命名标签；状态栏「已保存 HH:MM」。**坑**：恢复是异步的，不能抢走 argv/Finder 打开的那份焦点，且过滤启动空白页后必须校正 `activeId`（否则状态栏挂一个不存在的文件名）。release.sh 有专门的竞态用例（`CURSIVE_SMOKE_SCRATCH_DELAY`）
7. ~~P0-3 外部变更监听~~ ✅ 壳侧 `DispatchSource` 监听 openTabs 全部路径，0.8s 节流；**rename/delete 后必须重开重注册**（rename-replace 保存会让 fd 失效）；渲染层干净则静默重载保留滚动光标，脏则 `confirmReload`，非活动脏标签标 ⚠
8. ~~P0-4 删除 Electron~~ ✅ 只留 `src/renderer` + `src/shared`；构建链 = 根 `vite.config.ts`；`scripts/make-icon.mjs` 改为纯 `sips`+`iconutil`（不再依赖 Electron）；README / 本节同步。验收：不装 electron 也能 `npm run build` + `release.sh` 全绿

### 已完成（非 P0 清单，可插队项）

- ~~P3-4 主题系统（部分）~~ ✅ 浅/深/跟随系统三态、视图菜单、`NSApp.appearance` 同步、localStorage 持久化；**缺**护眼皮肤与扫描 `themes/*.css`
- ~~P3-5 排版偏好面板~~ ✅ `ui/prefs.ts`（⌘,）：主题/衬线/字号/行距/栏宽 + 恢复默认；改完 `view.requestMeasure()`
- ~~P2-6 表格点击定位（半）~~ ✅ `TableWidget.ignoreEvent` 放行 mousedown + `editTableOnClick` + `cellSpan`；**缺**增删行列工具栏 / Tab 跨格 / 对齐美化
- ~~P1-1 KaTeX 数学公式~~ ✅ 方言层 `InlineMath`/`DisplayMath`（pandoc 收紧定界规则：开后非空白、闭前非空白且后非数字，货币符号不吃）；行内走 decorate（ViewPlugin）、块级走 `blockField`（StateField）；`MathWidget` 用 `katex.renderToString`（同步，`throwOnError:false` 错误红色源码不崩）；CSS/字体已进产物；E2E `math.md` 断言行内/块级计数 + **KaTeX 字体真加载**（CSP 拦掉时肉眼看不出）
- ~~P1-2 mermaid~~ ✅ `blockField` 里 FencedCode(mermaid) → `MermaidWidget`：动态 import 独立 chunk、`eq()` 按源码+主题、`destroy()` 取消未完渲染；**render 对语法错误不抛异常而是内嵌错误 SVG —— 必须先 `parse()` 预校验**才能走「保留源码+错误提示」分支；主题切换经 `themeEffect` 派发到所有标签（冻结标签也要 `state.update` 重建，否则 widget DOM 缓存导致切回还是旧配色）；E2E `mermaid.md` 断言 svg≥1 + error≥1

- ~~P1-3 方言补齐~~ ✅ 高亮 `==…==`、上下标 `^…^`/`~…~`（GFM 删除线只认 `~~`，单 `~` 归下标，互不打架；math 元素内容原子，`$e^{-x^2}$` 不受影响）、emoji `:smile:`（EMOJI 表外的短代码保持字面量，`10:30:45` 安全）、脚注 `[^1]`（引用=上标角标，悬停显示定义、点击跳转；定义区折叠成一行，光标进入回落）、`[TOC]` 目录组件（点击跳标题）。dialect.md E2E 断言六类组件计数
  - **坑 1**：`[^1]: 文字` 同时是合法的链接引用定义形状，LinkReference 会抢 —— 必须用 eager `parse` + `before: 'LinkReference'` 抢先
  - **坑 2**：eager parse 落完元素后必须 `cx.nextLine()` 把当前行推过块，否则 parsedPos 不前进，解析器原地重试直到超时（ensureSyntaxTree 拿不到全树）
  - **坑 3**：行内定界符长度必须与开定界符匹配（数学踩过，P1-3 的 == 复用同一扫描器）

- ~~P1-4 代码块增强~~ ✅ `CodeBarWidget`（语言标签 + 复制按钮，`Decoration.widget` 挂块首行，`float:right` 到右上）。复制走 `navigator.clipboard`，WKWebView 非安全上下文会失败 → 兜底 textarea + `execCommand('copy')`。副本按钮点击即刻 e.preventDefault/stopPropagation，别让 widget 默认吞事件
- ~~P1-5 图片显示增强~~ ✅ `parseImage` 支持 Typora `=宽x高` 尺寸语法；点击图片开灯箱（body 级遮罩 + Escape 关闭，复刻 Prefs 面板叠层模式）；加载失败显示**解析后的完整路径**（decodeURI + 剥掉 safe-file://local 前缀），而不是只给 alt —— 只给 alt 排查不了是路径错还是文件缺

### 当前这一轮：P2 手感

- ~~P2-1 格式化命令 +「格式」菜单~~ ✅ 菜单「格式」15 项（粗/斜/下划线/删除线/行内码/链接/标题1-6/正文/代码块/引用/无序·有序列表/任务项）→ `menu` 通道 → `MenuAction` 的 `fmt:*` → `editor/fmt.ts` 的 `applyFormat`。⌘ 组合一律走原生菜单（判断 1）
  - **一次 dispatch 落一笔**：所有 changes + 新选区放进同一个事务 → ⌘Z 一步撤回；多选区每个 range 独立判开/关
  - **幂等**：已有同种格式 → 本次切换摘掉；`isWrapped` **只看选区内部首尾定界符**（不能向前 range 外取，doc 开头 from=0 会越界判失败）
  - **选区映射用 `ChangeSet.mapPos`**：手写位移图在「删除+插入」混合时混用原始/位移后坐标，会把选区映射到文档尾之外（Selection outside）；from 取 assoc -1、to 取 +1，才能把插入的定界符包进选区供下次幂等判定
  - **无选区**：光标落在词内才作用于该词（`Intl.Segmenter` 分词，中文按词切）；词外（空格/标点）→ 插空对，不偷偷包旁边的词
  - **测试坑**：纯 `EditorState.create` 默认**关多选区**，多光标用例必须显式 `EditorState.allowMultipleSelections.of(true)`，否则 `selection.ranges` 被折成单个
  - 代码块围栏摘除要连**闭围栏前的换行**一起吃掉，否则留下 `code\n`
- ~~P2-2 输入规则~~ ✅ `editor/input-rules.ts`：Enter 时表格骨架（`| a | b |` → 补分隔行+空行）与围栏骨架（` ```ts ` → 补空行+闭合围栏）；标题/引用/列表/分隔线的即时渲染由 live-preview 负责、续行由 markdownKeymap 负责，不重复造。一次事务 → ⌘Z 一步撤销
  - 围栏「是否已闭合」判定要 `gm` 正则逐行数围栏（无 `m` 时 `^` 只匹配串首，永远数不到第二个）
- ~~P2-3 列表智能~~ ✅ `editor/list-ops.ts`：Tab/⇧Tab 升降级（列表上下文优先于 indentWithTab），有序列表**向前向后扩到段边界**后整段重编号（只向后找会漏前半段），保留 `)` 分隔符风格；每行一条前缀替换 change → 缩进与重编号同一事务、不重叠。回车续行/空项退出/任务项续 `[ ]` 仍归 markdownKeymap
- **P2-4** 智能粘贴（HTML→MD / URL 包链接 / ⇧⌘V 纯文本）· **P2-5** 图片粘贴落盘
- **P2-6** 表格工具栏 · **P2-7** 查找替换本地化

### 动手前必读的三个判断（`ROADMAP.md` 第二节展开）

1. **⌘ 快捷键走原生菜单，不要走 CM keymap** —— `MainWebView.performKeyEquivalent` 对所有 ⌘ 事件返回 false。菜单里没有的 ⌘ 组合能否落回 CodeMirror 未实测；⌘B/⌘1-6 一律做成「格式」菜单项 + 扩 `MenuAction`
2. **块级组件一律照抄 `tableField`** —— StateField 提供块级装饰，ViewPlugin 会直接报错
3. **大数据不过 IPC 桥** —— 图片落盘由壳读 `NSPasteboard` 返回相对路径，别把 base64 塞进 `evaluateJavaScript`

原第 6/7 条（Sparkle 自动更新、显示质量打磨）已并入 `ROADMAP.md` 的 P4-5 / P3-4。

## 约定

- 壳代码放 `shell-swift/`，单文件渐进；**优先 AppKit，不用 SwiftUI**
- 不改 `src/renderer` / `src/shared` 的接口；壳侧发现契约缺口，先补本文件再动代码
- 改完壳必跑探针自检；涉及保存路径的改动要同时验证 BOM/CRLF 指纹还原
