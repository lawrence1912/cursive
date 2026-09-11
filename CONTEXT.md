# typmd 开发上下文（AI 助手必读）

## 一句话

Typora 风格的 macOS Markdown 编辑器。Electron 版完整可用；**已决策迁移到「Swift 壳 + WKWebView」**，`src/renderer`（CodeMirror 6）零改动复用。

## 决策记录（2026-09-11）

- 只做 macOS，不做跨平台
- 不引入 Rust/Tauri
- 壳 = Swift + AppKit + WKWebView；原型在 `shell-swift/main.swift`，已探针验证渲染进程完整启动
- Electron 版保留为对照/退路，迁移收尾后再删相关依赖

## 架构与契约

- 渲染进程：`src/renderer`，产物 `out/renderer`，纯 CodeMirror 6 —— **禁止让它依赖 Electron**
- IPC 契约 = `window.api`（签名见 `src/shared/types.ts` 的 `TypmdApi`），壳侧 1:1 实现：
  - invoke：`openDialog` / `read` / `save` / `saveAs` / `confirmDiscard` / `openExternal` / `pickFolder` / `readDir` / `lastFolder`
  - send：`setDocState` / `confirmClose`
  - 壳→渲染推送：`menu` / `file:opened` / `folder:opened`
- 菜单动作字符串必须与 `src/main/menu.ts` 一致：`file:new` `file:open` `file:save` `file:save-as` `file:save-and-close` `file:open-folder` `edit:find` `view:toggle-source` `view:toggle-sidebar`
- 文件读写必须走 `src/shared/textfile.ts` 的 BOM/EOL 指纹逻辑（Swift 侧已移植为 `decodeDoc`/`encodeDoc`），保证「保存零损耗」

## 自定义协议（两个，缺一不可）—— ✅ 已实现

1. **`app://r/<相对路径>`** → 服务 `out/renderer` 静态资源。原因：`<script type="module" crossorigin>` 在 WKWebView 的 `file://` 下因 opaque origin **静默失败**。壳已实现 `FileSchemeHandler`（含路径穿越防护）。
2. **`safe-file://local/<绝对路径>`** → Markdown 图片加载。渲染层由 `src/renderer/editor/live-preview/decorate.ts` 生成这种 URL。壳侧已实现，**E2E 验证中文/空格文件名图片可加载**。

## 已踩坑（勿再踩）

- ⌘C/⌘V 在 WKWebView 不生效，除非应用菜单里有接线的「编辑」菜单（`Selector("cut:")` 等）
- `evaluateJavaScript` 与 `WKUserScript` **不受页面 CSP 限制**（页面 `script-src 'self'` 拦不住注入）
- **didFinish 可能早于渲染层模块执行完**：监听器没注册时 emit `file:opened` 会静默丢失。壳侧轮询 `window.__typmd`（main.js 末尾暴露的就绪标记）就绪后再发射，见 `flushPendingOpen()`
- **WebKit 会对自定义 scheme 的 URL 再做一次百分号编码（`%` → `%25`）**，而渲染层拼 safe-file URL 时已经 encodeURI 过了 → handler 逐级解码：解一次文件不存在就再解一次（对字面 `%` 文件名依然成立）
- 探测图片要用 `.cm-lp-image img`，`.cm-editor img` 会先匹配到 CodeMirror 自己的隐藏占位 `cm-widgetBuffer`（src=null）
- **live-preview 装饰只铺可视视口（设计如此）**：视口外的图片 widget 不存在，滚动到位才建，不是 bug
- **CM6 的 parse 是异步分块的**，且 `update()` 的 docChanged/selectionSet/viewportChanged 都不响应 parse 推进 → 首开长文档时深处节点拿不到树、装饰缺失。修复：`buildDecorations` 里用 `ensureSyntaxTree(state, visEnd + 1000)` 把可视范围强制同步解析到位（有限界，不伤大文档）。**这个修复同时修了 Electron 版的同款潜在 bug**
- 编译固定 `swiftc -O -swift-version 5`（避开 Swift 6 严格并发检查）；CLT 即可，无需 Xcode.app
- 编译输出里 8 个 `use '#selector' instead of Selector(...)` 警告是**刻意的**（undo:/cut:/paste: 等响应链派发必须用字符串选择器），忽略，不要"修"
- `NSWindow` 脏标记是 `isDocumentEdited` 属性（没有 `setDocumentEdited()`）
- `NSAlert.runModal()` 返回 `ModalResponse`，做数组下标要 `.rawValue` 运算
- 大字符串回传：`evaluateJavaScript("window.api._resolve(\(id), <json>)")`，JSON 用 `JSONSerialization` 生成，别手拼；异步通道用 `callAsyncJavaScript(body, arguments:, in: nil, in: .page)`（body 是第一个无标签参数）
- `#drag-strip` 拖拽（两代实现，现在是确定性方案）：WKWebView 不认 `-webkit-app-region`，且把 `mouseDownCanMoveWindow` 重写为 false。第一代「叠 NSView + isMovableByWindowBackground」**失败**——当时 contentView 就是 webView，`addSubview(_, positioned:, relativeTo: webView)` 相对自身属未定义用法。现在的做法：① 容器视图做 contentView，webView 与 `DragStripView` 平级兄弟；② 条的 `mouseDown` 直接 `window.performDrag(with: event)`（与系统标题栏同源，不依赖任何机制位）。**38px 高度与 base.css `--drag-strip` 强耦合，改 CSS 记得同步壳**；smoke 探针有 `dragStripHit`（原生 hitTest）自动把关
- 本机 agent 环境里 Electron 起不来（GPU/network service 崩溃循环），renderer 行为用壳内探针 + vitest 验证，不要浪费时间去修 Electron 的环境问题
- `WKPDFConfiguration.rect` 输出**单页** PDF（页尺寸 = rect），不是分页文档；要 A4 分页需走 `WKWebView.printOperation`（NSPrintOperation）或 print CSS @page，当前长条页方案对自用足够

## 自检探针 / E2E（每次改壳必跑）

```sh
TYPMD_SMOKE=1 ./shell-swift/typmd-shell <file.md>
# +3s 写 /tmp/typmd-shell-check.json   （DOM：hasApi/cm/sidebar/status）
# +4s 写 /tmp/typmd-shell-e2e.json    （read→save 逐字节往返 + 装饰计数 + 图片加载），然后自动退出
```

另加 `TYPMD_SMOKE_PDF=<路径>`：E2E 后顺带导出 PDF（绕过保存面板），结果写 `/tmp/typmd-shell-pdf.json`（bytes/error）。

验证 PDF 不要用 PDFKit 提取文本（CJK 提取严重失真），改用结构信号：页尺寸（`PDFDocument.page.bounds` 应为 595×内容高）、`strings out.pdf | grep -c "Subtype */Image"`（图片对象数）、`sips -s format png` 转 PNG 目检。

⚠️ 探针/E2E **只在 `TYPMD_SMOKE` 环境变量下运行**；不带该变量启动是正常交互应用，绝不自动退出。
（历史教训：曾把 `NSApp.terminate()` 编进默认路径，导致「启动几秒后闪退」。）
从 Finder/非项目根目录启动时，cwd 不是项目根 —— renderer 资源路径按可执行文件位置向上回退（shell-swift/ 的上级）。

PASS 标准：`status`=打开的文件名；`bytesEqual=true`（BOM/CRLF 指纹还原）；`counts.cm-lp-*` 视口内非零；图片用例 `img.loaded=true`。
测试夹具生成：见 `/tmp/typmd-e2e/`（kitchen-sink.md / crlf.md / img.md + assets），图片 URL 里的空格/中文要百分号编码（渲染层 parseImage 不接受裸空格）。

## 构建与运行

```sh
./shell-swift/build.sh          # 或: swiftc -O -swift-version 5 shell-swift/main.swift -o shell-swift/typmd-shell
./shell-swift/typmd-shell [file.md]   # 必须在项目根运行（app:// 指向 ./out/renderer）
```

## 路线图

1. ~~safe-file://local SchemeHandler（图片）~~ ✅ 含双重解码坑
2. ~~argv 打开文档 + E2E 验证（read→save 往返/装饰/图片）~~ ✅；**待手动验证**：打开/另存为面板、脏标记关闭拦截、Finder 双击 .md（`application(_:openFile:)` 已有雏形）
3. ~~PDF 导出~~ ✅ 文件 →「导出为 PDF…」（⌘P）：离屏 595pt(A4) WKWebView 加载同一 renderer，`__shellEmit` 注入实时内容（含未保存修改），注入打印 CSS（隐 sidebar/状态栏/drag-strip、白底、高度自适应），等 `document.fonts.ready` + 图片 `decode()` 后 `createPDF`。输出为**单页长条 PDF**（页高=内容高），打印样式在 `PDFExporter.printCSS`
4. 最近文件（`NSDocumentController`）/ 拖拽 .md / Dock 菜单
5. ~~打包~~ ✅ `./shell-swift/make-app.sh`（加 `TYPMD_DMG=1` 连 DMG 一起出）：组装 dist/typmd.app（Info.plist 含 .md 关联 rank=Alternate/NSHighResolutionCapable，icon 用 build/icon.icns）→ ad-hoc 签名 → hdiutil 打 DMG。产物 ~3.4MB / DMG ~1.7MB。已验证：bundle 内 smoke、`open` 启动、`open -a` 带文档启动。注意：壳的 `findRendererRoot()` 三级查找顺序 Bundle Resources → cwd/out/renderer → exe 相对路径
6. （可选）Sparkle 自动更新（Typora macOS 同款）
7. 显示质量打磨（引擎无关、全部随迁）：Shiki 高亮、`text-wrap: pretty`、`hyphens: auto`、暗色主题、`-webkit-font-smoothing`
8. 收尾：删除 Electron 依赖（保留 `src/renderer`、`src/shared`），更新 README

## 约定

- 壳代码放 `shell-swift/`，单文件渐进；**优先 AppKit，不用 SwiftUI**
- 不改 `src/renderer` / `src/shared` 的接口；壳侧发现契约缺口，先补本文件再动代码
- 改完壳必跑探针自检；涉及保存路径的改动要同时验证 BOM/CRLF 指纹还原
