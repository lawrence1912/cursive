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

## 自定义协议（两个，缺一不可）

1. **`app://r/<相对路径>`** → 服务 `out/renderer` 静态资源。原因：`<script type="module" crossorigin>` 在 WKWebView 的 `file://` 下因 opaque origin **静默失败**。壳已实现 `AppSchemeHandler`（含路径穿越防护）。
2. **`safe-file://local/<绝对路径>`** → Markdown 图片加载。渲染层由 `src/renderer/editor/live-preview/decorate.ts` 生成这种 URL，Electron 版实现见 `src/main/protocol.ts`。**【壳侧待办：WKURLSchemeHandler】**

## 已踩坑（勿再踩）

- ⌘C/⌘V 在 WKWebView 不生效，除非应用菜单里有接线的「编辑」菜单（`Selector("cut:")` 等）
- `evaluateJavaScript` 与 `WKUserScript` **不受页面 CSP 限制**（页面 `script-src 'self'` 拦不住注入）
- 编译固定 `swiftc -O -swift-version 5`（避开 Swift 6 严格并发检查）；CLT 即可，无需 Xcode.app
- 编译输出里 8 个 `use '#selector' instead of Selector(...)` 警告是**刻意的**（undo:/cut:/paste: 等响应链派发必须用字符串选择器），忽略，不要"修"
- `NSWindow` 脏标记是 `isDocumentEdited` 属性（没有 `setDocumentEdited()`）
- `NSAlert.runModal()` 返回 `ModalResponse`，做数组下标要 `.rawValue` 运算
- 大字符串回传：`evaluateJavaScript("window.api._resolve(\(id), <json>)")`，JSON 用 `JSONSerialization` 生成，别手拼
- `#drag-strip` 是 Electron 的 `-webkit-app-region` 拖拽区，原生壳用 `window.isMovableByWindowBackground = true` 替代；该 CSS 在 WKWebView 无效（无害）
- `app://` 的 handler 里 URL path 要 `removingPercentEncoding` + 拒绝 `..` + 校验 `standardizedFileURL` 前缀

## 自检探针（每次改壳必跑）

- `didFinish` 后 3s 执行 probe JS → 写 `/tmp/typmd-shell-check.json` → `NSApp.terminate(nil)` 便于脚本化
- 通过标准：`hasApi=true, cm=true, cmState=true, sidebar=true`
- 控制台转发：`BRIDGE_JS` 劫持 `console.error/warn` + `window.error` / `unhandledrejection` → `shell` 通道 → stderr

## 构建与运行

```sh
./shell-swift/build.sh          # 或: swiftc -O -swift-version 5 shell-swift/main.swift -o shell-swift/typmd-shell
./shell-swift/typmd-shell [file.md]   # 必须在项目根运行（app:// 指向 ./out/renderer）
```

## 路线图（按序动工）

1. `safe-file://local` SchemeHandler（图片）—— 照 `AppSchemeHandler` 抄，注意绝对路径 + percent-decoding + 防穿越
2. 全功能验证：打开/保存/另存为/脏标记/关闭拦截/Finder 双击 .md（`application(_:openFile:)` 已有雏形）
3. PDF 导出：`WKWebView.createPDF(configuration:)`（macOS 11.3+ 公开 API）
4. 最近文件（`NSDocumentController`）/ 拖拽 .md / Dock 菜单
5. 打包脚本：`.app` bundle（Info.plist：CFBundleDocumentTypes `.md` 关联 rank=Alternate、NSHighResolutionCapable）+ `codesign --force --deep --sign -` + `create-dmg`
6. （可选）Sparkle 自动更新（Typora macOS 同款）
7. 显示质量打磨（引擎无关、全部随迁）：Shiki 高亮、`text-wrap: pretty`、`hyphens: auto`、暗色主题、`-webkit-font-smoothing`
8. 收尾：删除 Electron 依赖（保留 `src/renderer`、`src/shared`），更新 README

## 约定

- 壳代码放 `shell-swift/`，单文件渐进；**优先 AppKit，不用 SwiftUI**
- 不改 `src/renderer` / `src/shared` 的接口；壳侧发现契约缺口，先补本文件再动代码
- 改完壳必跑探针自检；涉及保存路径的改动要同时验证 BOM/CRLF 指纹还原
