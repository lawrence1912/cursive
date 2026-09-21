// Cursive 的原生 macOS 壳（spike → 可用的路线图起点）
//
// 目标：WKWebView 承载现有 out/renderer，window.api 的 15 个通道在 Swift 侧 1:1 实现，
// 渲染进程（CodeMirror 6 编辑器）零改动。
//
// 编译（无需 Xcode.app，CLT 即可）：
//   swiftc -O -swift-version 5 shell-swift/main.swift -o shell-swift/cursive-shell
// 运行（项目根目录）：
//   ./shell-swift/cursive-shell [file.md]

import AppKit
import CryptoKit
import PDFKit
import WebKit
import UniformTypeIdentifiers

// MARK: - textfile.ts 的 Swift 版：BOM / EOL 指纹

struct Fingerprint {
    var eol: String  // "\n" | "\r\n" | "\r"
    var bom: Bool
}

func decodeDoc(_ raw: String) -> (text: String, fp: Fingerprint) {
    let bom = raw.hasPrefix("\u{feff}")
    let body = bom ? String(raw.dropFirst()) : raw
    let crlf = body.components(separatedBy: "\r\n").count - 1
    let lf = body.components(separatedBy: "\n").count - 1 - crlf
    let cr = body.components(separatedBy: "\r").count - 1 - crlf
    var eol = "\n"
    if crlf >= lf && crlf >= cr && (crlf > 0 || lf > 0 || cr > 0) { eol = "\r\n" }
    else if cr > lf { eol = "\r" }
    let text = eol == "\n" ? body : body.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    return (text, Fingerprint(eol: eol, bom: bom))
}

func encodeDoc(_ text: String, _ fp: Fingerprint) -> String {
    var body = text
    if fp.eol == "\r\n" { body = text.replacingOccurrences(of: "\n", with: "\r\n") }
    else if fp.eol == "\r" { body = text.replacingOccurrences(of: "\n", with: "\r") }
    return fp.bom ? "\u{feff}" + body : body
}

// MARK: - 界面语言（契约 v16）

/// 0 = 中文，1 = English。**真相源在渲染层**（localStorage `cursive.prefs.lang`），
/// 启动与切换时经 `setLanguage` 推过来，壳不持久化 —— 与主题 / 视图开关同一条规矩。
/// 收到后重建菜单栏（buildMenu 可重入），对话框文案每次弹出现查，天然跟随。
var uiLangIdx = 0

/// 菜单 + 原生对话框的双语文案表。key 只在本文件内使用，渲染层不引用 ——
/// 原生菜单的措辞与界面文案本来就是两套，各自维护即可
let SHELL_TEXT: [String: [String]] = [
    // ---- 应用菜单 ----
    "menu.app.about":      ["关于 Cursive", "About Cursive"],
    // 没有省略号：这个应用里省略号的意思是「点完还有一层界面要你填」（设置…、另存为…），
    // 而这一条点完只在状态栏回一句话。真要去看新版本，是那句话上那颗按钮的事
    "menu.app.checkUpdate": ["检查更新", "Check for Updates"],
    "menu.app.settings":   ["设置…", "Settings…"],
    "menu.app.hide":       ["隐藏 Cursive", "Hide Cursive"],
    "menu.app.hideOthers": ["隐藏其他", "Hide Others"],
    "menu.app.quit":       ["退出 Cursive", "Quit Cursive"],
    // ---- 文件 ----
    "menu.file":            ["文件", "File"],
    "menu.file.new":        ["新建", "New"],
    "menu.file.newWindow":  ["新建窗口", "New Window"],
    "menu.file.open":       ["打开…", "Open…"],
    "menu.file.openFolder": ["打开文件夹…", "Open Folder…"],
    "menu.file.recent":     ["打开最近", "Open Recent"],
    "menu.file.save":       ["保存", "Save"],
    "menu.file.saveAs":     ["另存为…", "Save As…"],
    "menu.file.exportHtml": ["导出为 HTML…", "Export as HTML…"],
    "menu.file.exportPdf":  ["导出为 PDF…", "Export as PDF…"],
    "menu.file.exportPng":  ["导出为长图…", "Export as Image…"],
    "menu.file.print":      ["打印…", "Print…"],
    "menu.file.closeTab":   ["关闭标签", "Close Tab"],
    "menu.file.close":      ["关闭窗口", "Close Window"],
    // ---- 编辑 ----
    "menu.edit":            ["编辑", "Edit"],
    "menu.edit.undo":       ["撤销", "Undo"],
    "menu.edit.redo":       ["重做", "Redo"],
    "menu.edit.cut":        ["剪切", "Cut"],
    "menu.edit.copy":       ["拷贝", "Copy"],
    "menu.edit.paste":      ["粘贴", "Paste"],
    "menu.edit.selectAll":  ["全选", "Select All"],
    "menu.edit.pastePlain": ["粘贴为纯文本", "Paste as Plain Text"],
    "menu.edit.find":       ["查找…", "Find…"],
    "menu.edit.replace":    ["查找并替换…", "Find and Replace…"],
    "menu.edit.findInFiles":["在文件夹中查找…", "Find in Folder…"],
    "menu.edit.findNext":   ["查找下一个", "Find Next"],
    "menu.edit.findPrev":   ["查找上一个", "Find Previous"],
    // ---- 0.2.0 ----
    "menu.edit.selectNext": ["选择下一个匹配", "Select Next Occurrence"],
    "menu.edit.copyHtml":   ["复制为富文本", "Copy as Rich Text"],
    "menu.file.quickOpen":  ["快速打开…", "Quick Open…"],
    "menu.file.history":    ["版本历史…", "Version History…"],
    "menu.view.palette":    ["命令面板…", "Command Palette…"],
    // ---- 格式 ----
    "menu.format":          ["格式", "Format"],
    "fmt.bold":             ["粗体", "Bold"],
    "fmt.italic":           ["斜体", "Italic"],
    "fmt.underline":        ["下划线", "Underline"],
    "fmt.strike":           ["删除线", "Strikethrough"],
    "fmt.codeInline":       ["行内代码", "Inline Code"],
    "fmt.highlight":        ["高亮", "Highlight"],
    "fmt.superscript":      ["上标", "Superscript"],
    "fmt.subscript":        ["下标", "Subscript"],
    "fmt.mathInline":       ["行内公式", "Inline Math"],
    "fmt.link":             ["链接", "Link"],
    "fmt.h1":               ["标题 1", "Heading 1"],
    "fmt.h2":               ["标题 2", "Heading 2"],
    "fmt.h3":               ["标题 3", "Heading 3"],
    "fmt.h4":               ["标题 4", "Heading 4"],
    "fmt.h5":               ["标题 5", "Heading 5"],
    "fmt.h6":               ["标题 6", "Heading 6"],
    "fmt.p":                ["正文", "Body Text"],
    "fmt.codeBlock":        ["代码块", "Code Block"],
    "fmt.quote":            ["引用", "Quote"],
    "fmt.ulist":            ["无序列表", "Bullet List"],
    "fmt.olist":            ["有序列表", "Numbered List"],
    "fmt.task":             ["任务项", "Task Item"],
    "menu.insert":          ["插入", "Insert"],
    "fmt.table":            ["表格", "Table"],
    "fmt.image":            ["图片", "Image"],
    "fmt.hr":               ["分隔线", "Divider"],
    "fmt.mathBlock":        ["公式块", "Math Block"],
    "fmt.callout":          ["告示块", "Callout"],
    "fmt.mermaid":          ["流程图", "Diagram"],
    "fmt.footnote":         ["脚注", "Footnote"],
    "fmt.toc":              ["目录", "Table of Contents"],
    // ---- 视图 ----
    "menu.view":        ["视图", "View"],
    "view.sidebar":     ["文件树", "File Tree"],
    "view.outline":     ["大纲", "Outline"],
    "view.formatBar":   ["格式栏", "Format Bar"],
    "view.source":      ["源代码模式", "Source Mode"],
    "view.focus":       ["专注模式", "Focus Mode"],
    "view.typewriter":  ["打字机模式", "Typewriter Mode"],
    "view.toggleFold": ["折叠 / 展开", "Fold / Unfold"],
    "view.customOff":  ["停用自定义皮肤", "Disable Custom Theme"],
    "view.theme":       ["主题", "Theme"],
    "theme.system":     ["跟随系统", "System"],
    "theme.light":      ["浅色", "Light"],
    "theme.dark":       ["深色", "Dark"],
    "theme.sepia":      ["护眼", "Sepia"],
    "theme.toggleDark": ["切换深色", "Toggle Dark"],
    // 0.4.1 起这三条缩的是**正文**（字号 + 栏宽），不再是整张网页 —— 名字里点明它，
    // 免得与「窗口 › 缩放」（那条是真的动窗口）混作一谈
    "view.actualSize":  ["正文实际大小", "Actual Text Size"],
    "view.zoomIn":      ["放大正文", "Zoom In Text"],
    "view.zoomOut":     ["缩小正文", "Zoom Out Text"],
    "view.fullScreen":  ["全屏", "Full Screen"],
    // ---- 窗口 ----
    "menu.window":      ["窗口", "Window"],
    "win.minimize":     ["最小化", "Minimize"],
    "win.zoom":         ["缩放", "Zoom"],
    "win.nextTab":      ["下一个标签", "Next Tab"],
    "win.prevTab":      ["上一个标签", "Previous Tab"],
    // ---- 最近文件 ----
    "recent.none":  ["（暂无）", "(None)"],
    "recent.clear": ["清除最近", "Clear Recent"],
    // ---- PDF 导出面板 ----
    "pdf.margin.narrow": ["窄（12 mm）", "Narrow (12 mm)"],
    "pdf.margin.normal": ["标准（18 mm）", "Normal (18 mm)"],
    "pdf.margin.wide":   ["宽（25 mm）", "Wide (25 mm)"],
    "pdf.pageNumbers":   ["加页码（3 / 12）", "Page numbers (3 / 12)"],
    "pdf.paper":         ["纸张", "Paper"],
    "pdf.margins":       ["页边距", "Margins"],
    "pdf.done":          ["PDF 已导出", "PDF Exported"],
    "pdf.done.body":     ["{path}\n共 {pages} 页", "{path}\n{pages} pages"],
    // ---- 对话框 ----
    "dlg.ok":            ["好", "OK"],
    "dlg.cancel":        ["取消", "Cancel"],
    "dlg.reveal":        ["在 Finder 中显示", "Show in Finder"],
    "doc.untitled":      ["未命名", "Untitled"],
    "doc.untitledMd":    ["未命名.md", "Untitled.md"],
    "doc.untitledDoc":   ["未命名文档", "Untitled Document"],
    "dlg.save":          ["保存", "Save"],
    "dlg.dontSave":      ["不保存", "Don't Save"],
    "dlg.saveChanges":   ["是否保存更改？", "Save Changes?"],
    "dlg.saveChanges.body": ["{name} 有未保存的修改。", "{name} has unsaved changes."],
    "dlg.newFolder":     ["新建文件夹", "New Folder"],
    "dlg.newFile":       ["新建文件", "New File"],
    "dlg.newFolder.init":["未命名文件夹", "untitled folder"],
    "dlg.trash":         ["把「{name}」移到废纸篓？", "Move “{name}” to Trash?"],
    "dlg.trash.folder":  ["文件夹里的内容会一并移走，之后可以在废纸篓里找回。",
                          "The folder and everything in it will be moved; you can restore it from the Trash."],
    "dlg.trash.body":    ["之后可以在废纸篓里找回。", "You can restore it from the Trash."],
    "dlg.trash.ok":      ["移到废纸篓", "Move to Trash"],
    "dlg.rename":        ["重命名", "Rename"],
    "dlg.create":        ["创建", "Create"],
    "dlg.reload":        ["文件已在外部被修改", "File Modified Externally"],
    "dlg.reload.body":   ["{name} 在外部被修改，是否重新载入？保留我的版本将放弃磁盘上的改动。",
                          "“{name}” was modified externally. Reload it? Keeping your version discards the copy on disk."],
    "dlg.reload.ok":     ["重新载入", "Reload"],
    "dlg.reload.keep":   ["保留我的版本", "Keep My Version"],
    "export.embedImages":     ["嵌入图片（单文件）", "Embed images (single file)"],
    "export.embedImages.tip": ["把本地图片转成 data: URI 写进同一个文件；不勾则保留相对路径",
                               "Convert local images to data: URIs inside the same file; uncheck to keep relative paths"],
    "export.defaultName":     ["未命名.html", "Untitled.html"],
    "export.defaultPng":      ["未命名.png", "Untitled.png"],
    // ---- 错误提示 ----
    "err.export":       ["导出失败", "Export Failed"],
    "err.print":        ["打印失败", "Print Failed"],
    "err.export.empty": ["渲染层没有交出可打印的内容", "The renderer did not provide printable content"],
    // PDF 那条路上的两处失败：走的是 NSError.localizedDescription → showError 的 detail，
    // 写成字面量的话英文界面会弹出「标题 English / 正文中文」的半拉子对话框
    "err.pdf.noView":   ["离屏视图没了", "The offscreen print view is gone"],
    "err.png.shot":     ["截图没成", "The snapshot could not be taken"],
    "err.pdf.noFile":   ["打印任务没有产出文件", "The print job produced no file"],
    "err.open":         ["打不开文件", "Can’t Open File"],
    "err.create":       ["无法创建「{name}」", "Can’t Create “{name}”"],
    "err.trash":        ["无法移到废纸篓", "Can’t Move to Trash"],
    "err.rename":       ["无法重命名「{name}」", "Can’t Rename “{name}”"],
    "err.move":         ["无法移动「{name}」", "Can’t Move “{name}”"]
]

/// 取当前语言的文案。缺 key 回退中文，表里压根没有就原样返回 key —— 宁可露馅也别崩
func L(_ key: String) -> String {
    guard let pair = SHELL_TEXT[key] else { return key }
    return pair[min(uiLangIdx, pair.count - 1)]
}

/// 带占位符的版本：文案模板里写 {name}，调用处传参（名字插在句子中间的那批）
func LF(_ key: String, _ args: [String: String]) -> String {
    var s = L(key)
    for (k, v) in args { s = s.replacingOccurrences(of: "{\(k)}", with: v) }
    return s
}

// MARK: - 注入渲染进程的 bridge（atDocumentStart，先于页面脚本）

/// 主题模式 → 系统外观。**全仓库唯一一份**（`setAppearance` 与启动首帧共用）。
/// **护眼按浅色算**：它是一张暖色的纸，配深色标题栏与红绿灯是「上半截深、下半截浅」。
/// 原先它落在 `else` 里跟随系统，于是系统深色 + 护眼正文 = 首帧先黑一下再变纸色。
func appearanceFor(_ mode: String) -> NSAppearance? {
    switch mode {
    case "dark": return NSAppearance(named: .darkAqua)
    case "light", "sepia": return NSAppearance(named: .aqua)
    default: return nil // system：交还给系统
    }
}

/**
 * 启动首帧的外观。**必须赶在任何窗口出现之前**（`applicationWillFinishLaunching`）。
 *
 * 页面那半本来就不闪：`base.css` 里有一份 `@media (prefers-color-scheme: dark)`
 * 专管「JS 起来之前的首帧」。但它跟的是**系统**外观，而 WKWebView 的
 * `prefers-color-scheme` 跟的是 `NSApp.appearance` —— 于是「系统浅色 + 用户手动选了
 * 深色」这一种，首帧仍然是白的（data-theme 要等渲染层读完 localStorage 才钉上，
 * 按 P4-6 的实测那是页面开跑后 216–271ms）。这里把上次记下的模式提前摆上，
 * 那份媒体查询自己就把首帧画对了 —— 不必给渲染层注入任何东西。
 *
 * 自检下不恢复：探针会显式切主题并按像素目检，带着上次的模式跑等于起点不确定。
 */
func applyStartupAppearance() {
    guard !smokeAuto, let mode = UserDefaults.standard.string(forKey: "appearance") else { return }
    NSApp.appearance = appearanceFor(mode)
}

/**
 * 捏合一档有多大（0.4.1）。手势的 `magnification` 是这一小段的增量，攒够这个数
 * 就发一条 `view:zoom-in/out` 给渲染层 —— **档位表、夹住、记住全在那一侧**
 * （`ui/zoom.ts`），壳这边只负责把手势翻成「上一档 / 下一档」。
 *
 * 0.08 是试出来的：再小，一次轻捏就窜过两三档；再大，得用力捏半天才动一格。
 */
let PINCH_STEP: CGFloat = 0.08

let BRIDGE_JS = """
(() => {
  // 把渲染进程的报错转发给原生（定位初始化失败用）
  const origError = console.error.bind(console)
  const origWarn = console.warn.bind(console)
  const forward = (level) => (...a) => {
    try { window.webkit.messageHandlers.shell.postMessage({ id: -1, method: 'console', args: [level, a.map(String).join(' ')] }) } catch {}
    ;(level === 'error' ? origError : origWarn)(...a)
  }
  console.error = forward('error')
  console.warn = forward('warn')
  window.addEventListener('error', (e) => forward('error')('uncaught: ' + e.message + ' @' + e.filename + ':' + e.lineno))
  window.addEventListener('unhandledrejection', (e) => forward('error')('unhandledrejection: ' + e.reason))
})();

(() => {
  const pending = new Map()
  let seq = 0
  const listeners = { menu: [], 'file:opened': [], 'folder:opened': [], 'file:changed-externally': [], 'dir:changed': [], 'image:dropped': [], 'search:hits': [], 'search:done': [], 'prefs:changed': [] }

  function call(method, args = []) {
    return new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      window.webkit.messageHandlers.shell.postMessage({ id, method, args })
    })
  }

  const callMethods = {
    openDialog: () => call('openDialog'),
    read: (path) => call('read', [path]),
    save: (path, content, fingerprint) => call('save', [path, content, fingerprint]),
    saveAs: (current, content, fingerprint) => call('saveAs', [current, content, fingerprint]),
    setDocState: (state) => call('setDocState', [state]),
    confirmClose: () => call('confirmClose'),
    confirmDiscard: (name) => call('confirmDiscard', [name]),
    openExternal: (url) => call('openExternal', [url]),
    checkUpdate: () => call('checkUpdate'),
    pickFolder: () => call('pickFolder'),
    readDir: (path) => call('readDir', [path]),
    createFile: (dir) => call('createFile', [dir]),
    createFolder: (dir) => call('createFolder', [dir]),
    trashItem: (path) => call('trashItem', [path]),
    restoreItem: (trashed, to) => call('restoreItem', [trashed, to]),
    renameItem: (path) => call('renameItem', [path]),
    moveItem: (src, destDir) => call('moveItem', [src, destDir]),
    revealInFinder: (path) => call('revealInFinder', [path]),
    searchFiles: (token, root, query, opts) => call('searchFiles', [token, root, query, opts]),
    replaceInFiles: (targets, replacement) => call('replaceInFiles', [targets, replacement]),
    undoReplaceInFiles: (token) => call('undoReplaceInFiles', [token]),
    cancelSearch: (token) => call('cancelSearch', [token]),
    userThemes: () => call('userThemes'),
    exportHtml: (html, name) => call('exportHtml', [html, name]),
    exportPng: (html, name, width) => call('exportPng', [html, name, width]),
    newWindow: (path) => call('newWindow', [path ?? null]),
    workspaceRoot: () => call('workspaceRoot'),
    readClipboardText: () => call('readClipboardText'),
    writeClipboardText: (text) => call('writeClipboardText', [text]),
    copyHtml: (html, plain) => call('copyHtml', [html, plain]),
    listFiles: (root) => call('listFiles', [root]),
    snapshotSave: (path, content) => call('snapshotSave', [path, content]),
    snapshotList: (path) => call('snapshotList', [path]),
    snapshotRead: (path, id) => call('snapshotRead', [path, id]),
    pasteImage: (dir) => call('pasteImage', [dir]),
    setAppearance: (mode) => call('setAppearance', [mode]),
    setTitlebarHoles: (holes) => call('setTitlebarHoles', [holes]),
    setViewFlags: (flags) => call('setViewFlags', [flags]),
    setLanguage: (lang) => call('setLanguage', [lang]),
    setImageDir: (mode) => call('setImageDir', [mode]),
    syncPrefs: (values) => call('syncPrefs', [values]),
    scratchSave: (id, content, fp) => call('scratchSave', [id, content, fp]),
    scratchList: () => call('scratchList'),
    scratchClear: (id) => call('scratchClear', [id]),
    confirmReload: (name) => call('confirmReload', [name]),
    openTabs: (paths) => call('openTabs', [paths]),
    watchDirs: (paths) => call('watchDirs', [paths])
  }

  function subscribe(event, fn) {
    listeners[event].push(fn)
    return () => { listeners[event] = listeners[event].filter(f => f !== fn) }
  }

  window.api = {
    ...callMethods,
    onMenu: (fn) => subscribe('menu', fn),
    onFileOpened: (fn) => subscribe('file:opened', fn),
    onFolderOpened: (fn) => subscribe('folder:opened', fn),
    onFileChangedExternal: (fn) => subscribe('file:changed-externally', fn),
    onDirChanged: (fn) => subscribe('dir:changed', fn),
    onImageDropped: (fn) => subscribe('image:dropped', fn),
    onSearchHits: (fn) => subscribe('search:hits', fn),
    onSearchDone: (fn) => subscribe('search:done', fn),
    onPrefsChanged: (fn) => subscribe('prefs:changed', fn),

    // —— 以下供原生侧回调 ——
    _resolve: (id, value) => {
      const p = pending.get(id)
      if (p) { pending.delete(id); p.resolve(value) }
    },
    _reject: (id, message) => {
      const p = pending.get(id)
      if (p) { pending.delete(id); p.reject(new Error(message)) }
    },
    _emit: (event, payload) => { for (const fn of [...listeners[event]]) fn(payload) }
  }
  window.__shellEmit = (event, payload) => window.api._emit(event, payload)

  // CURSIVE_TIMING=1 时壳会把这个口子开出来（见 TIMING_JS）：渲染层用它报自己这边的
  // 时刻。壳侧的 mark() 全都停在「文档推给渲染层」之前，而启动速度真正的终点是
  // 文档进编辑器/上屏 —— 只有页面知道那一刻。平时 window.__cursiveMark 根本不存在，
  // 调用方 `?.()` 一下就过去了，一个字节的消息都不发。

  // 渲染层就绪 = main.js 末尾给 window.__cursive 赋值。壳等的就是这一刻（要把
  // Finder / argv 打开的那份文档推进来）。**别让壳去轮询**：轮询那会儿 JS 线程
  // 正忙着跑一兆多的模块，每一发 evaluateJavaScript 都得排在它后面，实测白等
  // 150–200ms，正好顶在「双击文件 → 看见字」的关键路径上。
  // 这里给 __cursive 装一个 setter，赋值的瞬间捎一条消息回壳（壳那边还留着轮询兜底）。
  let cursiveValue
  Object.defineProperty(window, '__cursive', {
    configurable: true,
    get: () => cursiveValue,
    set: (v) => {
      cursiveValue = v
      try { window.webkit.messageHandlers.shell.postMessage({ type: 'ready' }) } catch (e) { /* 没桥就算了 */ }
    }
  })
})()
"""

/// 只在 `CURSIVE_TIMING=1` 下注入：给渲染层开一个报时刻的口子。
/// 平时不注入 = 页面上压根没有这个函数，`__cursiveMark?.(...)` 直接短路，
/// 启动路径上不会多一发跨进程消息（要量的东西自己别成为开销）。
let TIMING_JS = """
window.__cursiveMark = (label) => {
  try { window.webkit.messageHandlers.shell.postMessage({ type: 'timing', label: String(label) }) } catch {}
}
"""

// MARK: - 文件协议：app://r（服务 out/renderer）与 safe-file://local（绝对路径图片）共用
//
// app:// 必须存在：<script type="module" crossorigin> 在 WKWebView 的 file:// 下
// 因 opaque origin 静默失败（等价于 Electron 的 registerSafeFileProtocol 思路）。
// safe-file://local<encodeURI(绝对路径)> 由渲染层 live-preview/decorate.ts 生成。

final class FileSchemeHandler: NSObject, WKURLSchemeHandler {
    /// nil = safe-file 模式：path 本身是绝对文件路径；非 nil = app 模式：相对该目录
    let root: URL?

    static let mime = [
        "html": "text/html", "js": "text/javascript", "mjs": "text/javascript",
        "css": "text/css", "json": "application/json", "svg": "image/svg+xml",
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "gif": "image/gif", "webp": "image/webp", "avif": "image/avif",
        "bmp": "image/bmp", "ico": "image/x-icon",
        "woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf"
    ]

    init(root: URL?) { self.root = root }

    /// 按模式解析出目标文件：root 模式（app://r）相对目录 + 防穿越；nil（safe-file）绝对路径
    private func resolvedFile(path: String) -> URL? {
        if let root {
            let rel = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let parts = rel.split(separator: "/").map(String.init)
            guard !parts.isEmpty, !parts.contains(".."), !rel.contains("//") else { return nil }
            let candidate = root.appendingPathComponent(rel).standardizedFileURL
            guard candidate.path.hasPrefix(root.standardizedFileURL.path) else { return nil }
            return candidate
        }
        guard path.hasPrefix("/"),
              !path.contains("/../"), !path.hasSuffix("/.."), path != "/.." else { return nil }
        return URL(fileURLWithPath: path).standardizedFileURL
    }

    private func fail(_ task: WKURLSchemeTask) {
        let resp = URLResponse(url: task.request.url!, mimeType: nil, expectedContentLength: 0, textEncodingName: nil)
        task.didReceive(resp)
        task.didFailWithError(URLError(.fileDoesNotExist))
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return fail(task) }
        // ⚠️ WebKit 会对自定义 scheme 的 URL 再做一次百分号编码（% → %25），
        // 而渲染层拼 safe-file URL 时已经 encodeURI 过了 —— 所以这里要
        // 逐级解码：先解一次，文件不存在再解一次（两种情况都对字面 % 文件名成立）
        // 要的是**还带着百分号编码**的那一份（下面靠它逐级解码），所以不能用 `url.path`
        // —— 那个是解码后的。`URL.path(percentEncoded:)` 语义正好，但它要 macOS 13，
        // 而这个项目承诺的是 12+（Info.plist 的 LSMinimumSystemVersion 与 README 都这么写）。
        // `URLComponents.percentEncodedPath` 给的是同一个串，10.10 就有
        let raw = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? url.path
        var path = raw.removingPercentEncoding ?? raw
        var file: URL?
        for _ in 0..<2 {
            file = resolvedFile(path: path)
            if file != nil, let f = file, FileManager.default.fileExists(atPath: f.path) { break }
            guard let next = path.removingPercentEncoding, next != path else { break }
            path = next
            file = nil
        }
        guard let file, let data = try? Data(contentsOf: file) else {
            FileHandle.standardError.write("[scheme] 404 \(url.absoluteString)\n".data(using: .utf8)!)
            return fail(task)
        }
        let ext = file.pathExtension.lowercased()
        // 必须用 HTTPURLResponse 显式带 Cache-Control: no-store ——
        // 裸 URLResponse 不带任何缓存指令时，WKWebView 会把 app://r 的响应持久缓存，
        // 重新构建后浏览器还在跑旧 bundle（症状极其感拐：改了代码却永远不生效，
        // 因为 index.html 是固定文件名，永远是同一个缓存键）。本地磁盘读取便宜，
        // 换取「每次启动都拿到当前产物」是唯一正确的取舍。
        // Content-Type 必须显式给：.js 不是 text/javascript 的话 ES module 会被拒载。
        let mime = Self.mime[ext] ?? "application/octet-stream"
        let charset = ext == "js" || ext == "css" || ext == "html" ? "; charset=utf-8" : ""
        let resp = HTTPURLResponse(url: url,
                                   statusCode: 200,
                                   httpVersion: "HTTP/1.1",
                                   headerFields: [
                                    "Cache-Control": "no-store",
                                    "Content-Type": "\(mime)\(charset)",
                                    "Content-Length": String(data.count)
                                   ])!
        task.didReceive(resp)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

// MARK: - JSON / 路径工具

/// Any → JSON 字面量（可直接嵌进 evaluateJavaScript 表达式）
func jsonLiteral(_ v: Any) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: [v]),
          let s = String(data: data, encoding: .utf8) else { return "null" }
    return String(s.dropFirst().dropLast())   // 去掉数组包装 [ ]
}

/// renderer 资源根：① 打包态 Bundle Resources（Cursive.app/Contents/Resources/renderer）
/// ② cwd/out/renderer（项目根开发）③ 可执行位置回退
func findRendererRoot() -> URL {
    if let res = Bundle.main.resourceURL {
        let inBundle = res.appendingPathComponent("renderer")
        if FileManager.default.fileExists(atPath: inBundle.path) { return inBundle }
    }
    let cwd = FileManager.default.currentDirectoryPath
    let byCwd = URL(fileURLWithPath: "\(cwd)/out/renderer")
    if FileManager.default.fileExists(atPath: byCwd.path) { return byCwd }
    let exeDir = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
    return exeDir.deletingLastPathComponent().appendingPathComponent("out/renderer")
}

// MARK: - 主 WebView
// 关键：WKWebView 的 performKeyEquivalent 会把带 ⌘ 的按键吞掉转给网页进程，
// 导致菜单快捷键（⌘\ ⌘S ⌘P ⌘W…）失灵 —— 这是「文件树隐藏不了」的真因。
// 命令键组合全部交还给菜单系统处理。
final class MainWebView: WKWebView {
    /// P2-5：Finder 拖入文件（图片落盘 / .md 开新标签）。由 AppDelegate 处理。
    var dropHandler: (([URL]) -> Bool)?

    /// 0.4.1：把一条菜单动作交给页面（眼下只有捏合缩放在用）。
    /// 走 `WindowController.send` 那条路而不是自己 `evaluateJavaScript` ——
    /// 「谁在跟页面说话」保持只有一处
    var menuHandler: ((String) -> Void)?

    /// 捏合攒下的增量，够一档就发一条（见 `PINCH_STEP`）
    private var pinchAccum: CGFloat = 0

    /**
     * 自检期间**吞掉一切真实按键**。
     *
     * 不是洁癖，是 `release.sh` 会随机变红的真因（2026-09-15 抓到两次实证）：
     * 自检的 app 会 `NSApp.activate(ignoringOtherApps: true)` 抢到最前面，
     * 于是**跑 E2E 的那几十秒里，人在键盘上敲的每一下都落进编辑器**——
     * 光标在新开文档的 0 位，敲下的字就成了文档的第一个字符，
     * 接着被自动保存写进夹具。症状是 `kitchen-sink.md` 变成 `u---`、
     * `long.md` 变成 `ge# 长文档…`，然后某条毫不相干的断言挂掉
     * （前者让 front matter 不成立、大纲探针全崩，后者让标题数变成 0、PDF 书签为 0）。
     * 最难查的地方在于它**不可复现**，而且失败点离真因十万八千里。
     *
     * 探针自己发的是合成事件（`dispatchEvent`），根本不走这条路，所以吞掉零影响。
     * `performKeyEquivalent` 返回 true = 「我处理了」，⌘S / ⌘W 这类也一并挡住。
     */
    override func keyDown(with event: NSEvent) {
        if smokeAuto { return }
        super.keyDown(with: event)
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if smokeAuto { return true }
        if event.modifierFlags.contains(.command) { return false }
        return super.performKeyEquivalent(with: event)
    }

    /**
     * 触控板捏合缩放（0.2.x；0.4.1 改成只缩正文）。
     *
     * ⌘+ / ⌘− 早就有了，可在 macOS 上「两指一捏」才是最自然的那一下 ——
     * Safari、预览、地图、Finder 全是这个手势，缺了它就会一直有人对着屏幕捏一下
     * 然后发现没反应。
     *
     * **不再动 `pageZoom`**（那是整张网页一起放大：侧栏、标签、状态栏、按钮全跟着
     * 变粗），也不是 `allowsMagnification`（那是举个放大镜，正文不重新折行还多一条
     * 横向滚动条）。缩放归渲染层（`ui/zoom.ts`：只乘正文字号与栏宽），这里把手势
     * 攒成「上一档 / 下一档」发过去 —— **与 ⌘+ 走同一条路、同一张档位表**，
     * 各算各的话状态栏上迟早出现 133.1% 这种读数。
     *
     * `magnification` 是这一小段手势的增量，所以是累加而不是连乘。
     * 自检下不接：探针里有一批按像素来的断言。
     */
    override func magnify(with event: NSEvent) {
        if smokeAuto { return }
        pinchAccum += event.magnification
        while abs(pinchAccum) >= PINCH_STEP {
            let up = pinchAccum > 0
            pinchAccum += up ? -PINCH_STEP : PINCH_STEP
            menuHandler?(up ? "view:zoom-in" : "view:zoom-out")
        }
    }

    /// 注册文件 URL 拖入（判断 3：渲染层拿不到真实路径，拖拽由壳接管）
    func enableFileDrop() {
        registerForDraggedTypes([.fileURL])
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        return droppedURLs(sender).isEmpty ? [] : .copy
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = droppedURLs(sender)
        return urls.isEmpty ? false : (dropHandler?(urls) ?? false)
    }

    private func droppedURLs(_ sender: NSDraggingInfo) -> [URL] {
        let opts: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        let items = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: opts)
        return (items as? [URL]) ?? []
    }
}

// MARK: - 原生拖拽条
// `-webkit-app-region: drag` 是 Electron 专有扩展，WKWebView 不认识；
// 且 WKWebView 把 mouseDownCanMoveWindow 重写为 false（自己要处理鼠标事件），
// 所以窗口拖拽必须用一个透明的原生 NSView 叠在顶部实现。
// 高度对应 src/renderer/themes/base.css 的 --drag-strip: 38px，改那边记得同步这里。
final class DragStripView: NSView {
    /// 只为读 pageZoom —— 页面一缩放 CSS px 就不等于点，挖洞区得跟着换算。
    /// **0.4.1 起壳不再动 pageZoom（缩放只缩正文），这个数于是恒为 1** ——
    /// 换算留着是因为它是壳侧唯一正确的写法，而不是因为眼下有人会把它变成别的值
    weak var host: WKWebView?

    /// 渲染层报上来的放行区段（契约 v26，CSS px 的 `[左, 右]`，见 `ui/drag-holes.ts`）。
    ///
    /// 0.2.x 之前这里写死两段（两颗面板开关），base.css 的内边距与这几个数字得手动对齐。
    /// **正文的标签顶到最上面之后那样不够用了**：要放行的段数与位置跟着标签数、窗口宽度、
    /// 两侧面板的显隐一起变，只有页面自己知道。于是改成页面量、这里照做。
    ///
    /// 反过来（条子自己去问页面）做不到：`hitTest` 是同步的，`evaluateJavaScript` 是异步的。
    var holes: [(CGFloat, CGFloat)] = []

    /// 兜底：页面还没报上来的那一瞬（首帧、reload），两端那两颗按钮也得能点。
    /// 数字是 0.2.x 以前的那套（base.css 左内边距 78 + `.tb-btn` 宽 26；
    /// 右 `.tb-group` 26×3 + 间隙 2×2 = 82 + 右内边距 10），探针 tbHoleLeft/tbHoleRight 把关
    private func fallbackPasses(_ x: CGFloat, _ z: CGFloat) -> Bool {
        (x >= 72 * z && x <= 110 * z) || (x >= bounds.maxX - 96 * z && x <= bounds.maxX - 6 * z)
    }

    /// 条子上第一处**还能拖窗口**的横坐标（点）。只给探针用。
    ///
    /// 顶栏合并之后「条子正中」多半是一个标签（正中恰好在洞里），原来那条
    /// 「hitTest(条子正中) === 条子」的自检于是永远是红的 —— 但它要问的事没变：
    /// **这条上还有没有地方拖得动窗口**。所以改成在放行区段之外找第一处空当。
    /// 一处都找不到 = 整条被挖穿，窗口再也拖不动，那时它就该红。
    ///
    /// `after` 从红绿灯右边起算：灯本身是窗口 frame view 上的原生按钮，
    /// 在那儿做 hitTest 命中的是灯，不是条子。
    func firstDraggableX(after: CGFloat) -> CGFloat? {
        let z = host?.pageZoom ?? 1
        let gap: CGFloat = 8      // 空当窄过这个数，人也按不准
        var x = after
        for h in holes.map({ ($0.0 * z, $0.1 * z) }).sorted(by: { $0.0 < $1.0 }) {
            if h.0 - x > gap { return (x + h.0) / 2 }
            x = max(x, h.1)
        }
        return bounds.maxX - x > gap ? (x + bounds.maxX) / 2 : nil
    }

    /// 条子整条盖在 webview 上，这里不返回 nil 的话洞里那些东西永远收不到点击
    private func passesThrough(_ p: NSPoint) -> Bool {
        let z = host?.pageZoom ?? 1
        if holes.isEmpty { return fallbackPasses(p.x, z) }
        return holes.contains { p.x >= $0.0 * z && p.x <= $0.1 * z }
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard let hit = super.hitTest(point) else { return nil }   // 压根不在条子里
        return passesThrough(convert(point, from: superview)) ? nil : hit
    }

    override func mouseDown(with event: NSEvent) {
        // 双击 = 系统标题栏那套行为。titleVisibility=.hidden 之后这条就是唯一的
        // 标题栏，AppKit 不会替我们接：拖拽自己实现了，双击也得自己实现。
        // （单击先走 performDrag，它跑完拖拽循环才返回；第二次 mouseDown
        //   照常带 clickCount=2 送进来，两者不冲突）
        if event.clickCount == 2 {
            performDoubleClickAction()
            return
        }
        // 确定性拖拽：直接进入窗口拖拽循环，不依赖 isMovableByWindowBackground 机制
        window?.performDrag(with: event)
    }

    /// 「系统设置 → 桌面与程序坞 → 连按窗口标题栏时」：Maximize（默认）/ Minimize / None。
    /// 该偏好写在 NSGlobalDomain，standard defaults 会自动查到。
    var doubleClickAction: String {
        UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
    }

    func performDoubleClickAction() {
        guard let window else { return }
        switch doubleClickAction {
        case "Minimize": window.performMiniaturize(nil)
        case "None": break
        default: window.performZoom(nil)   // 放大 ⇄ 还原（与绿灯同一动作）
        }
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var mouseDownCanMoveWindow: Bool { true }
}

// MARK: - PDF 导出：打印 P4-1 的导出 HTML（P4-2 真分页）
//
// 老做法是把**编辑器**装进离屏 WKWebView、注入一段 printCSS 把界面藏掉，再用
// `WKPDFConfiguration.rect` 截一张整文档高的图 —— 出来的 PDF 只有一页、几米长；
// 那段 printCSS 里还抄了一份 base.css 的浅色 token（改一边忘一边就走样）。
//
// 现在走 P4-1 的导出 HTML：渲染层给一份语义 HTML（样式内联、图已经是 data: URI），
// 壳把它装进离屏 webView 交给 `printOperation(with:)` 真分页。于是
//   · 纸张 / 页边距 / 分页全归 NSPrintInfo 一处管（导出 CSS 里刻意不写 `@page size`，
//     两处各说一套时 WebKit 的行为没有定义）；
//   · 导出 HTML 与导出 PDF 永远长得一样，不会各走各的；
//   · 那份 token 副本连同整段 printCSS 一起没了。
//
// 打印本身的四条铁律写在 `PDFPrinter` 的注释里 —— 那四条都是实测撞出来的，
// 尤其第 3 条（开印前碰一下打印视图就会随机印出空白页）会让前面几条全看着像「时好时坏」。

enum PaperSize: String, CaseIterable {
    case a4, letter
    var title: String { self == .a4 ? "A4" : "US Letter" }
    /// 点（1/72 英寸）。A4 = 210×297 mm
    var size: NSSize {
        self == .a4 ? NSSize(width: 595.28, height: 841.89) : NSSize(width: 612, height: 792)
    }
}

enum PageMargin: String, CaseIterable {
    case narrow, normal, wide
    var title: String {
        switch self {
        case .narrow: return L("pdf.margin.narrow")
        case .normal: return L("pdf.margin.normal")
        case .wide: return L("pdf.margin.wide")
        }
    }
    var points: CGFloat {
        let mm: CGFloat = self == .narrow ? 12 : (self == .normal ? 18 : 25)
        return mm * 72 / 25.4
    }
}

struct PDFOptions {
    var paper: PaperSize = .a4
    var margin: PageMargin = .normal
    var pageNumbers = true

    /// 上次用的那一套（保存面板每次都重新问，但默认值该跟着上次走）
    static func remembered() -> PDFOptions {
        let d = UserDefaults.standard
        var o = PDFOptions()
        if let p = d.string(forKey: "pdfPaper"), let v = PaperSize(rawValue: p) { o.paper = v }
        if let m = d.string(forKey: "pdfMargin"), let v = PageMargin(rawValue: m) { o.margin = v }
        if d.object(forKey: "pdfPageNumbers") != nil { o.pageNumbers = d.bool(forKey: "pdfPageNumbers") }
        return o
    }

    func remember() {
        let d = UserDefaults.standard
        d.set(paper.rawValue, forKey: "pdfPaper")
        d.set(margin.rawValue, forKey: "pdfMargin")
        d.set(pageNumbers, forKey: "pdfPageNumbers")
    }
}

/// 保存面板上的那块附件：纸张 / 页边距 / 页码
final class PDFOptionsView: NSView {
    private let paperPop = NSPopUpButton(frame: NSRect(x: 56, y: 36, width: 108, height: 25))
    private let marginPop = NSPopUpButton(frame: NSRect(x: 230, y: 36, width: 124, height: 25))
    private let numberBox = NSButton(checkboxWithTitle: L("pdf.pageNumbers"), target: nil, action: nil)

    init(initial: PDFOptions) {
        super.init(frame: NSRect(x: 0, y: 0, width: 372, height: 74))
        addLabel(L("pdf.paper"), x: 8, y: 41, width: 44)
        addLabel(L("pdf.margins"), x: 166, y: 41, width: 58)
        paperPop.addItems(withTitles: PaperSize.allCases.map { $0.title })
        paperPop.selectItem(at: PaperSize.allCases.firstIndex(of: initial.paper) ?? 0)
        marginPop.addItems(withTitles: PageMargin.allCases.map { $0.title })
        marginPop.selectItem(at: PageMargin.allCases.firstIndex(of: initial.margin) ?? 1)
        numberBox.frame = NSRect(x: 54, y: 10, width: 200, height: 18)
        numberBox.state = initial.pageNumbers ? .on : .off
        addSubview(paperPop)
        addSubview(marginPop)
        addSubview(numberBox)
    }

    required init?(coder: NSCoder) { nil }

    private func addLabel(_ text: String, x: CGFloat, y: CGFloat, width: CGFloat) {
        let label = NSTextField(labelWithString: text)
        label.frame = NSRect(x: x, y: y, width: width, height: 17)
        label.alignment = .right
        addSubview(label)
    }

    var options: PDFOptions {
        PDFOptions(
            paper: PaperSize.allCases[max(0, paperPop.indexOfSelectedItem)],
            margin: PageMargin.allCases[max(0, marginPop.indexOfSelectedItem)],
            pageNumbers: numberBox.state == .on
        )
    }
}

/// 打印结果：给自检用的结构信号（**不提取文本** —— PDFKit 提中文严重失真，见 CONTEXT）
struct PDFStats {
    var pages = 0
    var width: CGFloat = 0
    var height: CGFloat = 0
    /// 0.2.0：写进文件的书签条数（含各层）
    var bookmarks = 0
    /// 写完之后重新读回来、PDFKit 认出几条顶层书签 —— 两个数一起才说明「写得出且读得回」
    var readBack = 0
}

/**
 * 把一份自足的 HTML 打印成真分页 PDF。
 *
 * 这条路上有**五条铁律**，每一条都是实测出来的（前四条来自 `printtest` 那轮走查，
 * 第五条是 0.4.0 加真打印机时撞的）：
 *
 * 1. **必须 `runModal(for:)`，不能 `op.run()`**。`run()` 把主线程堵死，而 WKWebView 的
 *    分页是 web 进程**异步**算完再回报的 —— 回报进不来，`knowsPageRange` 就一直是
 *    `{1, Int.max}`，AppKit 于是无穷无尽地要下一页：实测 20 秒写出 1.8 GB 的 PDF。
 * 2. **web view 必须挂在一个真 NSWindow 上**（`runModal(for:)` 要一个宿主窗口）。
 *    窗口摆到屏幕外 + `orderBack`，用户看不见闪一下。
 * 3. **开印前绝不碰打印视图**。调一次 `knowsPageRange`（哪怕只为打日志）就会把这次
 *    打印搅坏 —— 症状是随机印出空白页，同一份文档三次里错两次。这条最阴：
 *    它让前面三条看起来都「时好时坏」，查起来全是假线索。
 * 4. **等版面稳定要用 `setTimeout`，不能用 `requestAnimationFrame`**。离屏窗口里
 *    WKWebView 判自己 `visibilityState: 'hidden'`，rAF 一次都不回调，整条流程直接吊死
 *    （P3-8 的打字机滚动踩过同一个坑，见 CONTEXT）。
 * 5. **要弹面板时，`runModal(for:)` 的宿主必须是看得见的那只窗口**（0.4.0 真打印机）。
 *    打印面板与进度面板都是 **sheet**，挂在上面那只离屏窗口（x = -30000）上时，
 *    它们跟着落到屏幕外 —— 人看到的是「⌘P 之后卡住」：模态会话开着，而那张要点的
 *    面板在屏幕外面。导出那条不弹任何面板，挂哪儿都行；打印这条要把主窗口传进来。
 *    进度面板一并关掉（系统打印队列里本来就有进度）。
 */
/// 一条目录项（0.2.0 PDF 书签）。层级与文字都来自渲染层的 `collectHeadings` ——
/// 与大纲面板、`[TOC]`、锚点补全同一份取数，壳这边不认识 Markdown
struct OutlineItem {
    let level: Int
    let text: String
}

/**
 * 给一份已经印好的 PDF 补一棵书签树（0.2.0）。
 *
 * ## 为什么要自己写字节
 *
 * 直觉做法是 `doc.outlineRoot = root; doc.write(to:)`。**它不成立** —— 实测：
 * 设完 `numberOfChildren` 是 1，`write(to:)` 返回 true，重新读回来 `outlineRoot` 是 nil。
 * `dataRepresentation()` 与 `dataRepresentation(options:)` 一样。
 * PDFKit 能**读**大纲，但没有任何一条写出路径会把它序列化出去。
 *
 * 另一条路是 `CGPDFContextSetOutline` + 逐页 `drawPDFPage` 重绘 —— 那会把链接注记
 * 全部丢掉（P4-2 的页码之所以走 freeText 注记而不是重绘，就是这个原因）。
 * 文档里的链接比书签重要，不能拿它换。
 *
 * 于是剩下这一条：**增量更新**（PDF 32000 §7.5.6）。只往文件尾部追加 ——
 * 原有的每一个字节都不动，所以链接、注记、页码、字体子集一样不少。
 *
 * ## 只支持经典 xref 表
 *
 * WebKit / CoreGraphics 印出来的是 PDF 1.3：明文 `xref` 表 + 明文 `trailer`，
 * 没有交叉引用流、没有对象流。解析这种结构只需要几条正则。
 * 万一哪天换了格式（trailer 找不着、已经有 /Outlines、页对象数不对），
 * 一律**原样返回 0、一个字节都不写** —— 书签是锦上添花，不值得冒毁掉 PDF 的风险。
 */
enum PDFOutlineWriter {
    struct Item {
        let level: Int
        let title: String
        /// 0 起的页序号
        let page: Int
        /// 页面坐标系里的纵向落点（PDF 原点在左下）
        let top: CGFloat
    }

    /// 返回真的写进去几条；0 = 文件没动过
    static func append(to url: URL, items: [Item]) -> Int {
        guard !items.isEmpty,
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .isoLatin1) else { return 0 }
        let ns = text as NSString

        // ---- 1. trailer：/Root、/Size，以及上一个 xref 的位置 ----
        guard let trailerAt = lastLocation(of: "trailer", ns) else { return 0 }
        let trailerTail = ns.substring(from: trailerAt)
        guard let trailerDict = firstDict(in: trailerTail),
              let rootNum = int(in: trailerDict, #"/Root\s+(\d+)\s+\d+\s+R"#),
              let size = int(in: trailerDict, #"/Size\s+(\d+)"#),
              let prev = lastInt(in: text, #"startxref\s+(\d+)"#) else { return 0 }

        // ---- 2. 对象偏移表 ----
        // CoreGraphics 把每个 `N 0 obj` 都写在行首，扫一遍就够，不必解析 xref 表本身
        var offsets: [Int: Int] = [:]
        for m in matches(in: text, #"(?m)^(\d+)\s+0\s+obj\b"#) {
            if let n = Int(ns.substring(with: m.range(at: 1))) { offsets[n] = m.range.location }
        }

        // ---- 3. 目录对象与页对象编号 ----
        guard let catalog = objectBody(rootNum, ns, offsets), !catalog.contains("/Outlines"),
              let catDict = firstDict(in: catalog),
              let pagesNum = int(in: catDict, #"/Pages\s+(\d+)\s+\d+\s+R"#) else { return 0 }
        var pageRefs: [Int] = []
        collectPages(pagesNum, ns, offsets, into: &pageRefs, depth: 0)
        guard !pageRefs.isEmpty else { return 0 }

        // ---- 4. 建树 ----
        let nodes = buildTree(items.filter { $0.page >= 0 && $0.page < pageRefs.count })
        guard !nodes.isEmpty else { return 0 }

        // ---- 5. 追加对象 ----
        var body = Data()
        var newOffsets: [Int: Int] = [:]
        var base = data.count
        // 原文件末尾没有换行的话先补一个，免得 `%%EOF109 0 obj` 粘在一起
        var prefix = Data()
        if data.last != 0x0A { prefix = Data([0x0A]); base += 1 }

        func emit(_ num: Int, _ dict: String) {
            newOffsets[num] = base + body.count
            body.append(("\(num) 0 obj\n" + dict + "\nendobj\n").data(using: .isoLatin1) ?? Data())
        }

        let outlineRootNum = size
        for (i, node) in nodes.enumerated() {
            let num = size + 1 + i
            var parts = ["/Title \(pdfString(node.item.title))"]
            parts.append("/Parent \(node.parent < 0 ? outlineRootNum : size + 1 + node.parent) 0 R")
            // 目标：页对象 + /XYZ（左、上、缩放）。null 表示「这一维不变」
            parts.append("/Dest [ \(pageRefs[node.item.page]) 0 R /XYZ null \(fmt(node.item.top)) null ]")
            if let first = node.children.first { parts.append("/First \(size + 1 + first) 0 R") }
            if let last = node.children.last { parts.append("/Last \(size + 1 + last) 0 R") }
            // Count 为正 = 默认展开。全展开是对的：这本来就是一份「文档目录」
            if !node.descendants.isEmpty { parts.append("/Count \(node.descendants.count)") }
            if let prevSib = node.prev { parts.append("/Prev \(size + 1 + prevSib) 0 R") }
            if let nextSib = node.next { parts.append("/Next \(size + 1 + nextSib) 0 R") }
            emit(num, "<< " + parts.joined(separator: " ") + " >>")
        }
        let tops = nodes.indices.filter { nodes[$0].parent < 0 }
        emit(outlineRootNum, "<< /Type /Outlines /First \(size + 1 + tops.first!) 0 R"
             + " /Last \(size + 1 + tops.last!) 0 R /Count \(nodes.count) >>")
        // 目录对象重写一份：`<<` 之后插一条 /Outlines，其余原样
        emit(rootNum, "<< /Outlines \(outlineRootNum) 0 R " + String(catDict.dropFirst(2)))

        // ---- 6. 新 xref + trailer ----
        let xrefAt = base + body.count
        var xref = "xref\n0 1\n0000000000 65535 f \n"
        for (first, count) in runs(of: newOffsets.keys.sorted()) {
            xref += "\(first) \(count)\n"
            for num in first..<(first + count) {
                xref += String(format: "%010d %05d n \n", newOffsets[num] ?? 0, 0)
            }
        }
        let newSize = size + 1 + nodes.count
        var trailer = replace(trailerDict, #"/Size\s+\d+"#, with: "/Size \(newSize)")
        trailer = trailer.range(of: "/Prev") != nil
            ? replace(trailer, #"/Prev\s+\d+"#, with: "/Prev \(prev)")
            : "<< /Prev \(prev) " + String(trailer.dropFirst(2))
        xref += "trailer\n" + trailer + "\nstartxref\n\(xrefAt)\n%%EOF\n"

        var out = data
        out.append(prefix)
        out.append(body)
        out.append(xref.data(using: .isoLatin1) ?? Data())
        guard (try? out.write(to: url)) != nil else { return 0 }
        return nodes.count
    }

    // ---------- 建树 ----------

    private struct Node {
        let item: Item
        var parent: Int = -1
        var children: [Int] = []
        var descendants: [Int] = []
        var prev: Int?
        var next: Int?
    }

    /// 按 level 串成树。层级跳跃（H1 之后直接 H3）按「挂在最近的更浅一级下面」处理，
    /// 和大纲面板的做法一致 —— Markdown 里跳级是常态，不该因此丢掉条目
    private static func buildTree(_ items: [Item]) -> [Node] {
        var nodes = items.map { Node(item: $0) }
        var stack: [Int] = []   // 当前各层级最近的节点下标
        for i in nodes.indices {
            let level = min(max(nodes[i].item.level, 1), 6)
            while let top = stack.last, nodes[top].item.level >= level { stack.removeLast() }
            if let parent = stack.last {
                nodes[i].parent = parent
                if let sibling = nodes[parent].children.last {
                    nodes[i].prev = sibling
                    nodes[sibling].next = i
                }
                nodes[parent].children.append(i)
            } else if let sibling = nodes.indices.filter({ nodes[$0].parent < 0 && $0 < i }).last {
                nodes[i].prev = sibling
                nodes[sibling].next = i
            }
            stack.append(i)
        }
        // 后代表（/Count 要的是「全展开时能看见几条」，不是直接子节点数）
        for i in nodes.indices.reversed() {
            var all: [Int] = []
            for c in nodes[i].children { all.append(c); all.append(contentsOf: nodes[c].descendants) }
            nodes[i].descendants = all
        }
        return nodes
    }

    // ---------- 字节层小工具 ----------

    /// PDF 字符串。一律走 UTF-16BE + BOM 的十六进制写法 ——
    /// 中文标题用 PDFDocEncoding 根本表示不了，而十六进制形式对任何阅读器都成立
    private static func pdfString(_ s: String) -> String {
        var hex = "FEFF"
        for unit in Array(s.utf16) { hex += String(format: "%04X", unit) }
        return "<" + hex + ">"
    }

    private static func fmt(_ v: CGFloat) -> String {
        String(format: "%.2f", v)
    }

    /// 连续的对象号切成若干段（xref 的子段要求号码连续）
    private static func runs(of sorted: [Int]) -> [(Int, Int)] {
        var out: [(Int, Int)] = []
        for num in sorted {
            if let last = out.last, last.0 + last.1 == num { out[out.count - 1].1 += 1 }
            else { out.append((num, 1)) }
        }
        return out
    }

    private static func collectPages(_ num: Int, _ ns: NSString, _ offsets: [Int: Int],
                                     into out: inout [Int], depth: Int) {
        guard depth < 16, let body = objectBody(num, ns, offsets) else { return }
        guard body.contains("/Kids") else {
            if body.contains("/Page") { out.append(num) }
            return
        }
        guard let kids = capture(in: body, #"/Kids\s*\[([^\]]*)\]"#) else { return }
        for m in matches(in: kids, #"(\d+)\s+\d+\s+R"#) {
            let kidsNS = kids as NSString
            if let kid = Int(kidsNS.substring(with: m.range(at: 1))) {
                collectPages(kid, ns, offsets, into: &out, depth: depth + 1)
            }
        }
    }

    /// `N 0 obj … endobj` 之间那一段
    private static func objectBody(_ num: Int, _ ns: NSString, _ offsets: [Int: Int]) -> String? {
        guard let start = offsets[num] else { return nil }
        let rest = NSRange(location: start, length: ns.length - start)
        let end = ns.range(of: "endobj", options: [], range: rest)
        guard end.location != NSNotFound else { return nil }
        return ns.substring(with: NSRange(location: start, length: end.location - start))
    }

    /// 第一个 `<< … >>`（按嵌套层数配对，不是找第一个 `>>`）
    private static func firstDict(in s: String) -> String? {
        let ns = s as NSString
        let open = ns.range(of: "<<")
        guard open.location != NSNotFound else { return nil }
        var depth = 0
        var i = open.location
        while i + 1 < ns.length {
            let two = ns.substring(with: NSRange(location: i, length: 2))
            if two == "<<" { depth += 1; i += 2; continue }
            if two == ">>" {
                depth -= 1
                i += 2
                if depth == 0 { return ns.substring(with: NSRange(location: open.location, length: i - open.location)) }
                continue
            }
            i += 1
        }
        return nil
    }

    private static func matches(in s: String, _ pattern: String) -> [NSTextCheckingResult] {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return [] }
        return re.matches(in: s, range: NSRange(location: 0, length: (s as NSString).length))
    }

    private static func capture(in s: String, _ pattern: String) -> String? {
        guard let m = matches(in: s, pattern).first, m.numberOfRanges > 1 else { return nil }
        return (s as NSString).substring(with: m.range(at: 1))
    }

    private static func int(in s: String, _ pattern: String) -> Int? {
        capture(in: s, pattern).flatMap { Int($0) }
    }

    private static func lastInt(in s: String, _ pattern: String) -> Int? {
        guard let m = matches(in: s, pattern).last, m.numberOfRanges > 1 else { return nil }
        return Int((s as NSString).substring(with: m.range(at: 1)))
    }

    private static func lastLocation(of needle: String, _ ns: NSString) -> Int? {
        let r = ns.range(of: needle, options: .backwards)
        return r.location == NSNotFound ? nil : r.location
    }

    private static func replace(_ s: String, _ pattern: String, with repl: String) -> String {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return s }
        return re.stringByReplacingMatches(
            in: s, range: NSRange(location: 0, length: (s as NSString).length),
            withTemplate: NSRegularExpression.escapedTemplate(for: repl))
    }
}

/**
 * 这份文档印到哪儿去（0.4.0 还的第四条账）。
 *
 * 从前只有 `.file`：⌘P 直接导出 PDF，**根本没有真打印机那条路**
 * （`jobDisposition = .save` 把打印任务改成了写文件）。`.printer` 走系统打印面板 ——
 * 选哪台机器、几份、纸张都归它，「存为 PDF」也在那张面板的左下角。
 */
enum PDFDestination {
    case file(URL)
    case printer
}

final class PDFPrinter: NSObject, WKNavigationDelegate {
    private let html: String
    private let dest: PDFDestination
    /// 打印面板/进度挂在**哪个窗口**上（sheet 的宿主）。
    /// 导出那条不弹面板，挂自己那只离屏窗口无所谓；**打印那条必须挂到看得见的窗口上** ——
    /// 挂在离屏窗口上时，面板与进度条都落在屏幕外，人看到的就是「点了 Print 之后卡住」
    private let host: NSWindow?
    private let out: URL
    private let opts: PDFOptions
    private let outline: [OutlineItem]
    private var wv: WKWebView?
    private var window: NSWindow?
    private var completion: ((Result<PDFStats, Error>) -> Void)?
    /// 真的写进文件的书签条数（E2E 靠它证明这条路没有空跑）
    private var bookmarksWritten = 0

    init(html: String, dest: PDFDestination, opts: PDFOptions, outline: [OutlineItem],
         host: NSWindow? = nil) {
        self.html = html
        self.dest = dest
        self.host = host
        // 打印那条不写文件，`out` 只是个占位（下面所有用到它的分支都在 .file 里）
        if case .file(let url) = dest { self.out = url } else { self.out = URL(fileURLWithPath: "/dev/null") }
        self.opts = opts
        self.outline = outline
    }

    func run(completion: @escaping (Result<PDFStats, Error>) -> Void) {
        self.completion = completion
        let m = opts.margin.points
        let content = NSSize(width: opts.paper.size.width - m * 2,
                             height: opts.paper.size.height - m * 2)
        let wv = WKWebView(frame: NSRect(origin: .zero, size: content))
        wv.navigationDelegate = self
        self.wv = wv
        // 铁律 2：挂窗口。摆到屏幕外，用户看不见
        let win = NSWindow(contentRect: NSRect(x: -30000, y: 0,
                                               width: content.width, height: content.height),
                           styleMask: [.borderless], backing: .buffered, defer: false)
        win.contentView = wv
        win.orderBack(nil)
        window = win
        // 导出 HTML 是自足的（样式内联、图已经是 data: URI），没有 baseURL 也全都在
        wv.loadHTMLString(html, baseURL: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // 字体与图片没稳定就开印会印出半张空白。**铁律 4**：这里不能用 rAF
        let body = """
        await document.fonts.ready
        await Promise.all([...document.images].map(i => i.decode().catch(() => {})))
        await new Promise(r => setTimeout(r, 120))
        return document.body.scrollHeight
        """
        webView.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { [weak self] _ in
            self?.printToFile()
        }
    }

    private func finish(_ result: Result<PDFStats, Error>) {
        completion?(result)
        completion = nil
        window?.orderOut(nil)
        window?.contentView = nil
        window = nil
        wv = nil
    }

    private func fail(_ msg: String) {
        finish(.failure(NSError(domain: "cursive.export", code: 2,
                                userInfo: [NSLocalizedDescriptionKey: msg])))
    }

    private func printToFile() {
        guard let wv, let window else { return fail(L("err.pdf.noView")) }
        let m = opts.margin.points
        let info = NSPrintInfo()
        info.paperSize = opts.paper.size
        info.topMargin = m
        info.bottomMargin = m
        info.leftMargin = m
        info.rightMargin = m
        // 横向 .fit：内容比纸宽时缩着放进来，而不是横着再分出一叠页
        info.horizontalPagination = .fit
        info.verticalPagination = .automatic
        info.isHorizontallyCentered = false
        info.isVerticallyCentered = false
        // 唯一的分岔口：导出把打印任务改成写文件，打印就让它是打印
        if case .file(let url) = dest {
            info.jobDisposition = .save
            info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = url as NSURL
        }

        let op = wv.printOperation(with: info)
        let printing: Bool
        if case .printer = dest { printing = true } else { printing = false }
        op.showsPrintPanel = printing
        // **进度面板一律不开**：它也是一张 sheet，而这条流程的宿主窗口是离屏的那只时
        // 它就落在屏幕外 —— 人看到的是「点完 Print 卡住」。打印进度系统队列里本来就有
        op.showsProgressPanel = false
        // 打印视图默认零尺寸；挂了窗口之后其实不给也行，留着当保险（实测两种都对）
        op.view?.frame = NSRect(origin: .zero,
                                size: NSSize(width: info.paperSize.width - m * 2,
                                             height: info.paperSize.height - m * 2))
        try? FileManager.default.removeItem(at: out)
        // 铁律 1 + 3：走 runModal，且在这之前一个字都别问打印视图。
        // 宿主窗口：打印那条挂**看得见的那只**（面板是 sheet，挂离屏窗口等于卡住）
        op.runModal(for: host ?? window, delegate: self,
                    didRun: #selector(printDidRun(_:success:contextInfo:)), contextInfo: nil)
    }

    /// 铁律 5（这条是**崩给我看的**）：`runModal(for:)` 的 didRun 回调**不在主线程上** ——
    /// AppKit 的 `_continueModalOperationToTheEnd:` 起了自己的线程。关窗口、弹面板、
    /// `NSApp.terminate` 全是主线程的事，在这儿直接做就是一个 EXC_BREAKPOINT
    /// （堆栈落在 `_WMWindow setVisible:`，而 PDF 其实已经好好地写在盘上了 ——
    /// 于是它长得像「导完就闪退」，最容易被当成别的问题）。
    @objc private func printDidRun(_ op: NSPrintOperation, success: Bool,
                                   contextInfo: UnsafeMutableRawPointer?) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            // 打印那条不产出文件：面板里按了取消也算走完（success=false），不当失败报
            if case .printer = self.dest {
                return self.finish(.success(PDFStats()))
            }
            guard success, FileManager.default.fileExists(atPath: self.out.path) else {
                return self.fail(L("err.pdf.noFile"))
            }
            self.postProcess()
            self.finish(.success(self.stats()))
        }
    }

    /// 印完之后的两件事：盖页码、装书签。
    ///
    /// **合成一次开-改-写**：`PDFDocument(url:)` 解析 + `write(to:)` 重写是整份文档的活，
    /// 分两遍做等于把一份几十页的 PDF 读写两次，还要多担一次「第二次写覆盖第一次」的风险。
    private func postProcess() {
        // 页码：PDFKit 的注记走得通，照旧开-改-写
        if opts.pageNumbers, let doc = PDFDocument(url: out), doc.pageCount > 0 {
            stampPageNumbers(doc)
            doc.write(to: out)
        }
        // 书签：PDFKit **写不出去**（见 PDFOutlineWriter 顶上的实测记录），于是分两步 ——
        // 先用它「读」出每个标题落在哪一页的什么高度，再自己往文件尾追加一次增量更新。
        // 顺序不能反：页码那一步会重写整个文件，把追加的部分整段冲掉
        guard !outline.isEmpty, let doc = PDFDocument(url: out), doc.pageCount > 0 else { return }
        let located = resolveOutline(doc)
        if !located.isEmpty { bookmarksWritten = PDFOutlineWriter.append(to: out, items: located) }
    }

    /// 每页盖一个「3 / 12」。走 PDFKit 的 freeText 注记而**不是重绘整页** ——
    /// 重绘（CGContext + drawPDFPage）会把链接注记一起丢掉，而这只是个页码。
    /// 数字与斜杠都是 ASCII，不牵扯中文字体。
    private func stampPageNumbers(_ doc: PDFDocument) {
        let total = doc.pageCount
        for i in 0..<total {
            guard let page = doc.page(at: i) else { continue }
            let box = page.bounds(for: .mediaBox)
            let w: CGFloat = 90, h: CGFloat = 14
            // 落在下页边距的中间；页边距很窄时也别贴着纸边
            let y = max(8, opts.margin.points / 2 - h / 2)
            let a = PDFAnnotation(bounds: CGRect(x: (box.width - w) / 2, y: y, width: w, height: h),
                                  forType: .freeText, withProperties: nil)
            a.font = NSFont.systemFont(ofSize: 8.5)
            a.fontColor = NSColor(white: 0.45, alpha: 1)
            a.color = .clear
            a.alignment = .center
            a.contents = "\(i + 1) / \(total)"
            a.border = nil
            a.shouldPrint = true
            page.addAnnotation(a)
        }
    }

    /**
     * 0.2.0 PDF 书签：把每个标题定位到「第几页、多高」。
     *
     * **怎么知道一个标题落在第几页**：WebKit 的打印不产出命名目标，PDF 里也没有 id，
     * 所以只能按标题文字去页面文本里搜。两条约束让它足够准：
     *
     * 1. **单调推进**：标题在文档里是有序的，所以每一条只在上一条落点**之后**找。
     *    不这么做的话，正文里出现过的同名词会把书签拽回前面去；
     * 2. **跳过落在链接注记上的命中**。`[TOC]` 生成的目录项是链接、正文里的交叉引用
     *    也是链接，而**真正的标题不是** —— 这一条正好把「书签全指向目录页」那个
     *    最常见的错法挡掉。代价是 `## [标题](url)` 这种标题本身是链接的拿不到书签，
     *    很少见，且只是少一条目录项，不会指错地方。
     *
     * 找不到就跳过：书签是尽力而为的东西，缺一条远好过指到错的页。
     */
    private func resolveOutline(_ doc: PDFDocument) -> [PDFOutlineWriter.Item] {
        var out: [PDFOutlineWriter.Item] = []
        var cursor = 0
        for item in outline {
            let text = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard text.count >= 2 else { continue }
            guard let hit = locate(doc, text: text, from: cursor) else { continue }
            cursor = hit.index
            out.append(PDFOutlineWriter.Item(level: item.level, title: text,
                                             page: hit.index, top: hit.top))
        }
        return out
    }

    /**
     * 从第 `from` 页往后找这段文字，返回落点。跳过命中在链接注记上的那些（见 buildOutline）。
     *
     * **不能用 `PDFDocument.findString`** —— 这一条是实测摔出来的：WebKit 印出来的
     * PDF，中文抽出来是**康熙部首形**（`⽂` U+2F42，不是 `文` U+6587；`用`→`⽤`、
     * `几`→`⼏` 同理），字形一模一样、码位不同。于是 `findString("长文档")` 一条都找不到，
     * 而 `findString("真分页")`（三个字都没有部首形）却好好的 —— 症状是「有的标题有书签、
     * 有的没有」，看上去像随机。
     *
     * 办法：两边都过一遍 NFKC 再比。**必须逐字 fold**，不能整串 `precomposedString…`：
     * 整串会把 `ﬁ`→`fi` 这类一变多的映射也做掉，UTF-16 下标当场错位，
     * 而后面要靠这个下标回查 `selection(for:)` 拿版面坐标。
     */
    private func locate(_ doc: PDFDocument, text: String,
                        from: Int) -> (index: Int, top: CGFloat)? {
        let needle = PDFPrinter.foldCompat(text) as String
        guard !needle.isEmpty else { return nil }
        for index in from..<doc.pageCount {
            guard let page = doc.page(at: index), let raw = page.string else { continue }
            let hay = PDFPrinter.foldCompat(raw)
            var searchFrom = 0
            while searchFrom < hay.length {
                let found = hay.range(of: needle,
                                      range: NSRange(location: searchFrom,
                                                     length: hay.length - searchFrom))
                if found.location == NSNotFound { break }
                if let sel = page.selection(for: found) {
                    let bounds = sel.bounds(for: page)
                    if !isInsideLink(page, bounds) { return (index, bounds.maxY) }
                }
                searchFrom = found.location + max(1, found.length)
            }
        }
        return nil
    }

    /**
     * NFKC **折不回来**的那一批（0.2.x 补）。
     *
     * 上面那条注释说的是康熙部首区（U+2F00–U+2FD5），它有兼容分解，NFKC 能折回去。
     * 但 PingFang 印出来的 PDF 里还有一批字落在**「CJK 部首补充」区**
     * （U+2E80–U+2EF3，简体部首形），而**那个区没有任何兼容分解** ——
     * `⻓`(U+2ED3) 折完还是 `⻓`，与文档里的 `长`(U+957F) 永远对不上，
     * 于是标题里只要有「长 / 页 / 见 / 车 / 门 / 马」这类字，那一条书签就定位不到。
     *
     * **这是导出跟随字体设置之后才浮出来的**：衬线那套（Georgia + Songti SC）不走这条路，
     * 换成无衬线（PingFang SC）才会。顺带说清楚代价：这类 PDF 在**任何**阅读器里
     * 搜「长文档」也搜不到 —— 那是 WebKit 给 PingFang 写 ToUnicode 时的老毛病，
     * 不在这个应用能改的范围里；这里能做到的是**我们自己的书签照样定位得准**。
     *
     * 表是**量出来的**，不是猜的：把本仓库全部中文里的 1340 个不同汉字排成一篇印成 PDF，
     * 再把抽出来的文本逐字与原字比对。要重新生成就照这个办法再跑一遍。
     * 每条都是 1 个字 → 1 个字，长度不变 —— `foldCompat` 的下标必须原样对得上。
     */
    private static let GLYPH_FIX: [UInt32: UInt32] = [
        0x2E8E: 0x5140, 0x2EC4: 0x897F, 0x2EC5: 0x89C1, 0x2EC6: 0x89D2, 0x2EC9: 0x8D1D,
        0x2ECB: 0x8F66, 0x2ED3: 0x957F, 0x2ED4: 0x95E8, 0x2EDA: 0x9875, 0x2EDB: 0x98CE,
        0x2EDC: 0x98DE, 0x2EDD: 0x98DF, 0x2EE2: 0x9A6C, 0x2EE3: 0x9AA8, 0x2EE5: 0x9C7C,
        0x2EE9: 0x9EC4, 0x2EEC: 0x9F50, 0x2EF0: 0x9F99,
        // 部首之外还有一个：PingFang 把「胶」的字形映到了 CJK 扩展 A 区的 㬵
        0x3B35: 0x80F6
    ]

    /// 表里有就换过来（1:1，长度不变）；没有原样返回
    private static func fixGlyph(_ s: String) -> String {
        guard s.unicodeScalars.count == 1, let from = s.unicodeScalars.first?.value,
              let to = GLYPH_FIX[from], let scalar = Unicode.Scalar(to) else { return s }
        return String(Character(scalar))
    }

    /// 逐字兼容分解（NFKC）。保证输出与输入的 UTF-16 长度逐字相等 ——
    /// 折出来长度变了的那个字就原样留着，宁可它匹配不上，也不能让整串的下标错位
    static func foldCompat(_ s: String) -> NSString {
        let ns = s as NSString
        let out = NSMutableString(capacity: ns.length)
        var i = 0
        while i < ns.length {
            let r = ns.rangeOfComposedCharacterSequence(at: i)
            let piece = ns.substring(with: r)
            let folded = fixGlyph(piece.precomposedStringWithCompatibilityMapping)
            out.append((folded as NSString).length == r.length ? folded : piece)
            i = r.location + r.length
        }
        return out
    }

    private func isInsideLink(_ page: PDFPage, _ bounds: CGRect) -> Bool {
        page.annotations.contains { ann in
            ann.type == "Link" && ann.bounds.intersects(bounds)
        }
    }

    private func stats() -> PDFStats {
        guard let doc = PDFDocument(url: out), let first = doc.page(at: 0) else { return PDFStats() }
        let box = first.bounds(for: .mediaBox)
        // 报的是**写进去的条数**而不是只有 `numberOfChildren`：后者只算顶层，
        // 一份「一个 H1 带十个 H2」的文档会报 1，看不出深层写成没有。两个数一起看
        return PDFStats(pages: doc.pageCount, width: box.width, height: box.height,
                        bookmarks: bookmarksWritten,
                        readBack: doc.outlineRoot?.numberOfChildren ?? 0)
    }
}

// MARK: - 0.3.0 T3：导出为长图（同一份导出 HTML → 离屏 WKWebView → takeSnapshot）

/// 长图的**像素**上限（高）。超过就只出前面那些，并在状态栏说一句。
///
/// **这个数不是 WebKit 的极限，是「有用」与「验得到」的极限**（量过才定的，见 ROADMAP T3）：
/// 本机（macOS 27 / Apple Silicon）实测 800 段的文档出到 **1344×111982、26 MB** 都没碎，
/// 所以不是撞不撞得爆的问题。真正的两条理由是 ——
/// ① **内存**：位图是 4 字节/像素，1344 宽时 32768 高已经是 172 MB 的瞬时峰值，
///    112000 高就是 600 MB。一次菜单点击不该在背后吃掉半个 G；
/// ② **32768 = 2^15 是各家图形栈的经典位图边长上限**，而这个项目**验不到** Intel
///    与更老的 macOS（同 T1 的处境）—— 越过它是在没有依据的地方赌。
///
/// 超了不是失败：只出前面那些，状态栏明说「这张图是截断的」。
/// 一张「看起来完整」的残图，比一条报错难发现得多。
let PNG_MAX_HEIGHT_PX: CGFloat = 32768

/// 成图倍率。2 倍是「发进 IM 里别人放大还能读」的最低档
let PNG_SCALE: CGFloat = 2

/// 正文栏宽的上下界（CSS px）。渲染层量多少壳照做，但还是夹一次：
/// 过窄读不了，过宽发出去没人愿意横着拉
let PNG_WIDTH_MIN: CGFloat = 320
let PNG_WIDTH_MAX: CGFloat = 1600

/**
 * 长图快门。**与 `PDFPrinter` 同一个形状**：离屏 WKWebView + 一个摆到屏幕外的窗口
 * （WebKit 不给没上屏的视图渲染，这是 PDF 那条路上踩出来的铁律 2），
 * 加载的是**同一份导出 HTML** —— 三条导出的长相必须永远一致。
 */
final class PNGShooter: NSObject, WKNavigationDelegate {
    struct Shot {
        let pixelsWide: Int
        let pixelsHigh: Int
        let bytes: Int
        /// 文档比上限还长，只出了前面那些
        let clipped: Bool
    }

    private let html: String
    private let out: URL
    private let width: CGFloat
    private var wv: WKWebView?
    private var window: NSWindow?
    private var completion: ((Result<Shot, Error>) -> Void)?

    init(html: String, out: URL, width: CGFloat) {
        self.html = html
        self.out = out
        self.width = min(max(width, PNG_WIDTH_MIN), PNG_WIDTH_MAX)
    }

    func run(completion: @escaping (Result<Shot, Error>) -> Void) {
        self.completion = completion
        // 起步高度随便给一个：真正的高度要等文档排完才知道（didFinish 里量 scrollHeight）
        let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: 800))
        wv.navigationDelegate = self
        self.wv = wv
        let win = NSWindow(contentRect: NSRect(x: -30000, y: 0, width: width, height: 800),
                           styleMask: [.borderless], backing: .buffered, defer: false)
        win.contentView = wv
        win.orderBack(nil)
        window = win
        // 导出 HTML 是自足的（样式内联、图片已经是 data: URI），没有 baseURL 也全都在
        wv.loadHTMLString(html, baseURL: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // 字体与图片没稳定就按快门会拍到半张空白（同 PDF 那条路，不能用 rAF）
        let body = """
        // 导出 CSS 的 `padding-bottom: 30vh` 是「读的时候最后一行能滚上来」的余量，
        // 而这里的视口有整篇那么高 —— 那条余量会变成一条几百像素的白边。
        // 这不是另起渲染路径（正文样式一个字没动），是把「为滚动准备的余量」换成纸面留白
        const pad = document.createElement('style')
        pad.textContent = '.cursive-doc{padding-bottom:48px}'
        document.head.append(pad)
        await document.fonts.ready
        await Promise.all([...document.images].map(i => i.decode().catch(() => {})))
        await new Promise(r => setTimeout(r, 120))
        return document.body.scrollHeight
        """
        webView.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { [weak self] result in
            var height: CGFloat = 0
            if case .success(let v) = result, let n = v as? Double { height = CGFloat(n) }
            self?.shoot(contentHeight: height)
        }
    }

    private func shoot(contentHeight: CGFloat) {
        guard let wv, let window else { return fail(L("err.pdf.noView")) }
        let maxPoints = PNG_MAX_HEIGHT_PX / PNG_SCALE
        let full = max(contentHeight, 1)
        let clipped = full > maxPoints
        let height = min(full, maxPoints)
        // **把视图撑到整篇那么高**：WebKit 按视图 bounds 排版与绘制，不撑开的话
        // 截到的只有第一屏，底下全是白的（而那张图看起来是「完整的」）
        window.setContentSize(NSSize(width: width, height: height))
        wv.frame = NSRect(x: 0, y: 0, width: width, height: height)
        let cfg = WKSnapshotConfiguration()
        cfg.rect = CGRect(x: 0, y: 0, width: width, height: height)
        // 2 倍图。`snapshotWidth` 的单位是**点**，出来的位图还要再乘一次屏幕的
        // backing scale —— 所以先除回去，否则 Retina 上拿到的是 4 倍（一张几十 MB 的 PNG）
        let scale = max(window.backingScaleFactor, 1)
        cfg.snapshotWidth = NSNumber(value: Double(width * PNG_SCALE / scale))
        // 改完 frame 要给排版与绘制一帧时间，否则快门比重排快
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            wv.takeSnapshot(with: cfg) { image, err in
                guard let self else { return }
                guard let image, let tiff = image.tiffRepresentation,
                      let rep = NSBitmapImageRep(data: tiff),
                      let png = rep.representation(using: .png, properties: [:]) else {
                    return self.fail(err?.localizedDescription ?? L("err.png.shot"))
                }
                do {
                    try png.write(to: self.out)
                    self.finish(.success(Shot(pixelsWide: rep.pixelsWide, pixelsHigh: rep.pixelsHigh,
                                              bytes: png.count, clipped: clipped)))
                } catch {
                    self.fail(error.localizedDescription)
                }
            }
        }
    }

    private func finish(_ result: Result<Shot, Error>) {
        completion?(result)
        completion = nil
        window?.orderOut(nil)
        window?.contentView = nil
        window = nil
        wv = nil
    }

    private func fail(_ msg: String) {
        finish(.failure(NSError(domain: "cursive.export", code: 3,
                                userInfo: [NSLocalizedDescriptionKey: msg])))
    }
}

// MARK: - P3-2 跨文件搜索
//
// **必须在壳侧跑**：渲染层递归 readDir 会让 IPC 往返爆炸（一个几百篇的库就是几百次桥调用）。
// 走 Operation 是为了可取消 —— 边打字边搜时，上一次搜索要能在半路停下，
// 否则一个大目录的结果会追着新查询往回喷。
// 结果**按文件成批**回推（一个文件的命中一起发）：既是天然的批次，也正好是 UI 的分组单位。
/// 「哪些目录不进、哪些后缀算文档」—— 跨文件搜索（P3-2）、快速打开的文件索引（0.2.0）
/// 与文件树（readDir 的后缀过滤）用的是同一套判断。各写一份的话，两处迟早在某次
/// 加后缀时分道扬镳：搜得到的文件在树里看不见、快速打开里找不着，是最难自查的那种不一致。
enum DocScan {
    /// 目录名黑名单：这些目录里的 .md 是依赖或产物，不是用户的文档
    static let skipDirs: Set<String> = ["node_modules", "dist", "out", "build", "vendor", "Pods", ".git"]
    static let exts: Set<String> = ["md", "markdown", "mdown", "mkd", "txt"]

    /// 树根下的全部文档路径，按 `nameOrder` 排序（与文件树同一条规则）。**上限 4000** —— 这一份是一次性整包过桥的
    /// （判断 3 说的是「图片字节」那种量级，几千条路径约几百 KB，与搜索回推的批次同级），
    /// 但再往上就该改成流式了，所以这里钉一个明确的顶而不是让它无限涨。
    static func list(root: String, limit: Int = 4000) -> [String] {
        let fm = FileManager.default
        var out: [String] = []
        let walker = fm.enumerator(at: URL(fileURLWithPath: root),
                                   includingPropertiesForKeys: [.isDirectoryKey],
                                   options: [.skipsHiddenFiles, .skipsPackageDescendants])
        while let url = walker?.nextObject() as? URL {
            let isDir = (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true
            if isDir {
                if skipDirs.contains(url.lastPathComponent) { walker?.skipDescendants() }
                continue
            }
            guard exts.contains(url.pathExtension.lowercased()) else { continue }
            out.append(url.path)
            if out.count >= limit { break }
        }
        return out.sorted(by: nameOrder)
    }
}

/// 名字与名字之间怎么比 —— **文件树（`readDir`）与快速打开的索引（`DocScan.list`）共用这一条**。
///
/// 从前两处都是裸 `sorted()`，那是按 Unicode 码位比，一口气错三处：中文按码位排
/// （上→北→工→广，而不是拼音 běi→gōng→guǎng→shàng）、数字按字符串排（`第10章`
/// 跑到 `第2章` 前面）、大小写分家（`README` 排在 `alpha` 前面）。
/// `localizedStandardCompare` **就是 Finder 自己用的那个 API**，三件一起对，且跟着系统区域走。
///
/// 它自带 `forcedOrdering`，只差大小写的同名也有确定次序 —— 这条很要紧：渲染层的
/// `sameEntries` 是**逐位**比新旧两份清单的，比较器一抖，两次读之间就会白重建一棵树。
func nameOrder(_ a: String, _ b: String) -> Bool {
    a.localizedStandardCompare(b) == .orderedAscending
}

final class SearchOperation: Operation, @unchecked Sendable {
    private let token: Int
    private let root: String
    private let regex: NSRegularExpression?
    private let emit: (String, Any) -> Void

    /// 上限：命中 800 处 / 扫 6000 个文件 / 单文件 2 MB。触顶就停，UI 会说明结果不完整
    private let maxHits = 800
    private let maxFiles = 6000
    private let maxBytes = 2 << 20
    /// 目录黑名单与后缀白名单归 `DocScan`（快速打开的索引共用同一套判断）
    private let skipDirs = DocScan.skipDirs
    private let exts = DocScan.exts

    init(token: Int, root: String, query: String, opts: [String: Any],
         emit: @escaping (String, Any) -> Void) {
        self.token = token
        self.root = root
        self.emit = emit
        // 字面量与正则走同一条路：字面量先转义再拼，大小写/整词两个开关就只有一处实现
        var pattern = (opts["regex"] as? Bool == true)
            ? query : NSRegularExpression.escapedPattern(for: query)
        if opts["wholeWord"] as? Bool == true { pattern = "\\b" + pattern + "\\b" }
        let options: NSRegularExpression.Options =
            (opts["caseSensitive"] as? Bool == true) ? [] : [.caseInsensitive]
        self.regex = try? NSRegularExpression(pattern: pattern, options: options)
        super.init()
    }

    override func main() {
        var files = 0
        var hits = 0
        var truncated = false
        guard let regex else {
            emit("search:done", ["token": token, "files": 0, "hits": 0,
                                 "truncated": false, "cancelled": false, "badQuery": true])
            return
        }
        let fm = FileManager.default
        let rootURL = URL(fileURLWithPath: root)
        let walker = fm.enumerator(at: rootURL, includingPropertiesForKeys: [.isDirectoryKey],
                                   options: [.skipsHiddenFiles, .skipsPackageDescendants])
        while let url = walker?.nextObject() as? URL {
            if isCancelled { break }
            let isDir = (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true
            if isDir {
                if skipDirs.contains(url.lastPathComponent) { walker?.skipDescendants() }
                continue
            }
            guard exts.contains(url.pathExtension.lowercased()) else { continue }
            files += 1
            if files > maxFiles { truncated = true; break }
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
            if size > maxBytes { continue }
            // 这里**有意**用会吃掉 BOM 的那条读法：搜索报的是行列，而替换是在
            // `decodeDoc` 之后（同样不含 BOM）的文本上按行列定位的 —— 两边都不含才对得齐
            guard let text = try? String(contentsOf: url, encoding: .utf8) else { continue }

            var fileHits: [[String: Any]] = []
            var lineNo = 0
            text.enumerateLines { line, stop in
                lineNo += 1
                if self.isCancelled { stop = true; return }
                let ns = line as NSString
                let found = regex.matches(in: line, range: NSRange(location: 0, length: ns.length))
                guard !found.isEmpty else { return }
                // Markdown 的一个段落常常就是**一整行几百上千字符**，所以窗口要围着
                // 命中点裁，不能从行首截 —— 从行首截的话段落中部的命中根本进不了画面。
                // 裁完偏移变了，于是回推两个列：col 给跳转（文档坐标），textCol 给高亮（展示坐标）
                for m in found.prefix(20) where m.range.length > 0 {
                    let start = max(0, m.range.location - 40)
                    let len = min(ns.length - start, 300)
                    let clipped = start > 0
                    let shown = (clipped ? "…" : "") + ns.substring(with: NSRange(location: start, length: len))
                    fileHits.append([
                        "path": url.path, "line": lineNo,
                        "col": m.range.location, "length": m.range.length,
                        "text": shown, "textCol": m.range.location - start + (clipped ? 1 : 0)
                    ])
                }
            }
            if isCancelled { break }
            guard !fileHits.isEmpty else { continue }
            if hits + fileHits.count > maxHits {
                fileHits = Array(fileHits.prefix(maxHits - hits))
                truncated = true
            }
            hits += fileHits.count
            emit("search:hits", ["token": token, "hits": fileHits])
            if truncated { break }
        }
        emit("search:done", ["token": token, "files": files, "hits": hits,
                             "truncated": truncated, "cancelled": isCancelled])
    }
}

// MARK: - AppDelegate

/// 一个窗口 = 一个 `WindowController`：窗口 + webView + **只属于这个窗口的那份状态**
/// （脏标记、当前文档、文件树根、外部变更监听、PDF 导出）。P3-7 之前这一整块就是
/// AppDelegate 自己 —— 多窗口做的事情就是把「每个窗口各一份」的东西从单例里拎出来。
/// 菜单、最近文件、Dock 菜单仍归 `AppDelegate`：它们本来就是**应用级**的，
/// 每个窗口各建一份菜单反而会打架。
/// `CURSIVE_TIMING=1 ./cursive-shell a.md` 打印启动各阶段的毫秒数。
/// 留着不是摆设：启动速度是排期里的待办（ROADMAP P4-5），改之前先量、改之后再量
let launchStart = Date()
func mark(_ what: String) {
    guard ProcessInfo.processInfo.environment["CURSIVE_TIMING"] != nil else { return }
    let ms = Int(Date().timeIntervalSince(launchStart) * 1000)
    FileHandle.standardError.write("[timing] \(ms)ms \(what)\n".data(using: .utf8)!)
}

/// 崩溃恢复的**候选集**：进程启动那一刻盘上已经有的 scratch id。
///
/// 没有这一层，`scratchList` 会把**当前正开着的窗口刚落盘的草稿**也当成「上次崩溃留下的」
/// 递给后开的窗口：在 A 窗口的未命名文档里打几个字（停 2s 自动落盘），再开一个窗口，
/// 那几个字就跟过去了 —— 而且两边各存一份、各自再落盘，越滚越多。
///
/// 两条规矩合起来才够：① 只认**启动前**就在盘上的（那才叫「上次留下的」）；
/// ② 交出去一份就划掉 —— 恢复是**一次性**的，第二个窗口不该再拿到同一份。
var recoverableScratch: Set<String> = []
/// 自检模式（E2E）。三件事都看它：**一律不弹模态**（`runModal` 会把无人值守的自检
/// 直接卡死，名字取 `CURSIVE_SMOKE_NAME`、删除确认当成「确定」、「是否保存」取
/// `CURSIVE_SMOKE_DISCARD`）、**不碰剪贴板**、以及 `MainWebView` 里**吞掉真实按键**。
/// 全局而不是某个类的私有属性 —— `MainWebView` 也要用，而它不是 `WindowController`
let smokeAuto = ProcessInfo.processInfo.environment["CURSIVE_SMOKE"] != nil

/// E2E 用（0.2.0 复制为富文本）：自检下不写剪贴板，只记下 [html 长度, 纯文本长度]
var smokeCopyHtml: [Int] = []

/// E2E 用（0.2.0 链接跳转）：自检下**不把浏览器唤起来**，只记下交出去的地址。
/// 跑一轮 E2E 弹出五个浏览器标签很不礼貌（同上面那条不碰剪贴板），而要验的本来也是
/// 「渲染层把哪条地址交给了系统」—— 尤其是本地文件那半（`file://` 编码对不对）
var smokeExternal: [String] = []

/// 0.4.0 F2 跨文件替换的撤销底本。**只留最近那一次** —— 状态栏那颗撤销是 8 秒的事，
/// 留更多只是白占内存；再往前要找就去版本历史（每个被改的文件改前都留了一份）
var replaceUndo: (token: Int, entries: [(path: String, content: String, fp: Fingerprint)])?
var replaceToken = 0

/// E2E 用（0.3.0 T2 检查更新）：自检下**一个字节都不联网**，按 `CURSIVE_SMOKE_UPDATE`
/// 里逗号分隔的版本依次作答（用完停在最后一个）。要逗号是因为一轮 E2E 得把**四条**分支
/// 都走到（有新版本 / 已是最新 / 那边还没发过 release / 没问着），而一个进程只有一份环境变量
var smokeUpdateCalls = 0

/// E2E 用：`scratchList` 被问过几次 / 一共交出去过几份。「一次性」这条不变量光看一个窗口看不出来
var scratchQueries = 0
var scratchHandouts = 0

/// 无路径文档的暂存目录（崩溃恢复）。窗口与 AppDelegate 都要够得着，所以摆在文件级
func scratchDirURL() -> URL {
    let fm = FileManager.default
    let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    let dir = base.appendingPathComponent("cursive/scratch", isDirectory: true)
    // 改名 typmd → cursive：旧目录还在、新的还没建过，就把崩溃恢复的暂存整个挪过来
    let legacy = base.appendingPathComponent("typmd", isDirectory: true)
    if fm.fileExists(atPath: legacy.path), !fm.fileExists(atPath: dir.path) {
        try? fm.createDirectory(at: dir.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? fm.moveItem(at: legacy.appendingPathComponent("scratch"), to: dir)
        try? fm.removeItem(at: legacy)
    }
    try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

/// **必须在第一个窗口出现之前调**（`applicationWillFinishLaunching`）：晚一步，
/// 这一轮自己写的草稿就会混进候选集，等于没修
func snapshotRecoverableScratch() {
    let files = (try? FileManager.default.contentsOfDirectory(
        at: scratchDirURL(), includingPropertiesForKeys: nil)) ?? []
    recoverableScratch = Set(
        files.filter { $0.pathExtension == "json" }.map { $0.deletingPathExtension().lastPathComponent })
}

/// `/a/b/c.md` → `/a/b`。**必须是绝对路径**（树根同时是防穿越守卫的界，相对路径守不住），
/// 根目录不算 —— 把 `/` 挂成树根等于让文件树去读整个磁盘
func parentDir(_ path: String) -> String? {
    let dir = (path as NSString).deletingLastPathComponent
    return dir.hasPrefix("/") && dir != "/" ? dir : nil
}

/// 文件级：WindowController 与 AppDelegate 都要判「这是个文件夹吗」
func isDirectory(_ path: String) -> Bool {
    var flag: ObjCBool = false
    return FileManager.default.fileExists(atPath: path, isDirectory: &flag) && flag.boolValue
}

final class WindowController: NSObject, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    /// 第一个窗口。E2E 探针只在它身上跑 —— 探针末尾会 `NSApp.terminate`，
    /// 每个窗口都跑一遍的话后开的窗口会把整个自检打断
    let isPrimary: Bool
    var window: NSWindow!
    var webView: WKWebView!
    /// 顶部那条原生拖拽条。渲染层报上来的放行区段写进它（契约 v26）
    var dragStrip: DragStripView?
    var dirty = false
    var forceClose = false
    var pendingOpen: String?
    /// 待推给渲染层的「树根文件夹」（新窗口带着文件夹开出来时用），同 pendingOpen 要等就绪
    var pendingFolder: String?
    var lastDocPath: String?
    /// **这个窗口的工作区根**（契约 v19）：带文件夹开出来的 = 那个文件夹，带文件开出来的
    /// = 文件所在的目录，空手开的 = 上次 pickFolder 选过的那个。同时是文件树增删的
    /// 防穿越守卫之界（P3-1）
    var treeRoot: String?
    /// 渲染层推来的当前文档路径（setDocState），用于导出文件名与相对图片解析
    var docPath: String?
    /// 外部变更监听：path → DispatchSource
    var watchers: [String: DispatchSourceFileSystemObject] = [:]
    var lastNotify: [String: Date] = [:]
    /// 文件树的**目录**监听（契约 v32）。与上面那张分开放：那张认的是「打开着的
    /// 文档」，两张单子各自更新、报的也是两个不同的事件，混在一起就没法各自撤销
    var dirWatchers: [String: DispatchSourceFileSystemObject] = [:]
    /// 目录变更的合并窗：从 Finder 拷一批文件进来是一条条到的
    var dirNotify: [String: DispatchWorkItem] = [:]

    var scratchDir: URL { scratchDirURL() }

    /// P0-3：外部变更监听。rename/delete 后必须重开重注册（rename-replace 保存会让 fd 失效）
    private func watch(_ path: String) {
        watchers[path]?.cancel()
        let fd = open(path, O_EVTONLY)
        guard fd >= 0 else { watchers.removeValue(forKey: path); return }
        let src = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: .main)
        src.setEventHandler { [weak self] in
            guard let self, let src = self.watchers[path] else { return }
            let data = src.data
            if data.contains(.rename) || data.contains(.delete) { self.watch(path) }
            if let last = self.lastNotify[path], Date().timeIntervalSince(last) < 0.8 { return }
            self.lastNotify[path] = Date()
            self.webView.evaluateJavaScript(
                "window.__shellEmit('file:changed-externally', \(jsonLiteral(path)))")
        }
        src.setCancelHandler { close(fd) }
        src.resume()
        watchers[path] = src
    }

    private func updateWatchers(_ paths: [String]) {
        let set = Set(paths)
        for (p, src) in watchers where !set.contains(p) {
            src.cancel()
            watchers.removeValue(forKey: p)
        }
        for p in paths where watchers[p] == nil { watch(p) }
    }

    /// 契约 v32：盯着一个**目录**（文件树里已经读进来的那些）。
    ///
    /// kqueue 在目录上报的是「这一级的**条目**变了」——
    /// **不递归**（子目录里的动静得由子目录自己那一份去收，所以渲染层报的是一整张单子），
    /// **也不看文件内容**（原地改写一个已经在的文件不会吵醒它）。唯一的例外是我们
    /// 自己：`save` 走 `atomically: true` = 临时文件 + rename，那在目录看来就是条目变了
    /// —— 所以边打字边自动保存，当前文档所在的这一级每两秒就要被吵醒一次。
    /// **挡在渲染层**（比对条目清单，一样就不重画），这里不猜「是不是我们自己干的」：
    /// 猜错一次就是丢掉一次真的外部变更。
    private func watchDir(_ path: String) {
        dirWatchers[path]?.cancel()
        let fd = open(path, O_EVTONLY)
        guard fd >= 0 else { dirWatchers.removeValue(forKey: path); return }
        let src = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: .main)
        src.setEventHandler { [weak self] in
            guard let self, let src = self.dirWatchers[path] else { return }
            let data = src.data
            if data.contains(.rename) || data.contains(.delete) {
                // 这个目录自己没了 / 改了名：fd 不再指着这个路径，重开一次（同文件那条）。
                // 重开不上就**别报**——它的消失该由父目录那一份去说（那边收到的才是
                // 「条目变了」），从这儿报等于让渲染层去读一个已经不在的目录
                self.watchDir(path)
                guard self.dirWatchers[path] != nil else { return }
            }
            // **尾部去抖**（不是头部节流）：拷一批文件是一条条到的，头部节流会把最后
            // 几条丢掉 —— 那正好是「树停在半路」。静 300ms 才报，这点延迟人看不出来
            self.dirNotify[path]?.cancel()
            let job = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.dirNotify.removeValue(forKey: path)
                self.webView.evaluateJavaScript(
                    "window.__shellEmit('dir:changed', \(jsonLiteral(path)))")
            }
            self.dirNotify[path] = job
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: job)
        }
        src.setCancelHandler { close(fd) }
        src.resume()
        dirWatchers[path] = src
    }

    private func updateDirWatchers(_ paths: [String]) {
        let set = Set(paths)
        for (p, src) in dirWatchers where !set.contains(p) {
            src.cancel()
            dirWatchers.removeValue(forKey: p)
            dirNotify.removeValue(forKey: p)?.cancel()
        }
        for p in paths where dirWatchers[p] == nil { watchDir(p) }
    }
    var pdfPrinter: PDFPrinter?
    /// 0.4.0 还的第三条账：图片落到哪个 assets/（"doc" 文档同级 / "root" 工作区根）。
    /// 真相在渲染层的偏好，启动与切换时经契约 v31 推过来；壳不持久化（同主题 / 语言那条规矩）
    var imageDirMode = "doc"
    /// 0.3.0 T3：长图那台快门。不拿住引用的话，`case "exportPng"` 一出作用域它就没了 ——
    /// 而整条路是异步的（加载 → 等字体图片 → 按快门），当场就成了「点了没反应」
    var pngShooter: PNGShooter?
    /// P3-2 跨文件搜索：串行队列 + 每次新搜索先取消上一次（边打字边搜时旧结果不许追上来）
    private let searchQueue: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        q.qualityOfService = .userInitiated
        return q
    }()

    /// 一份文件的全部快照，**按时间戳升序**（最后一条是最新的）
    func snapshotFiles(_ dir: URL) -> [URL] {
        let all = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.fileSizeKey])) ?? []
        return all
            .filter { $0.pathExtension == "md" && Double($0.deletingPathExtension().lastPathComponent) != nil }
            .sorted { a, b in
                (Double(a.deletingPathExtension().lastPathComponent) ?? 0)
                    < (Double(b.deletingPathExtension().lastPathComponent) ?? 0)
            }
    }

    /// 留存上限。从**最旧的**开始删，删到「既不超量、也没有过期的」为止，
    /// 但无论如何留下至少 `floor` 条。
    ///
    /// 两个条件是「或」不是「且」：超量要删（今天连改二十遍，最旧的那些没人回头看），
    /// 过期也要删（一份三个月没动的文档，历史没必要一直占着地方）。
    /// 而 `floor` 是兜底 —— 一份很久没动的文档，它最后那几版恰恰是最该留住的。
    func pruneSnapshots(_ dir: URL, keep: Int = 50, days: Double = 30, floor: Int = 10) {
        let files = snapshotFiles(dir)          // 旧 → 新
        let cutoff = Date().timeIntervalSince1970 - days * 86400
        var dropped = 0
        while files.count - dropped > floor {
            let url = files[dropped]
            let stamp = (Double(url.deletingPathExtension().lastPathComponent) ?? 0) / 1000
            let tooMany = files.count - dropped > keep
            let tooOld = stamp < cutoff
            guard tooMany || tooOld else { break }
            try? FileManager.default.removeItem(at: url)
            dropped += 1
        }
    }

    /// 0.2.0 版本历史目录：`…/cursive/history/<路径摘要>/`（与 scratch 同一个应用支持目录）
    func historyDir(for path: String) -> URL {
        let base = scratchDir.deletingLastPathComponent()
            .appendingPathComponent("history", isDirectory: true)
        return base.appendingPathComponent(pathKey(path), isDirectory: true)
    }

    /// 绝对路径 → 文件名安全的短摘要。
    /// **不能直接拿路径当目录名**：里面有 `/`，还可能长到超过文件名上限。
    /// 取 SHA-256 前 16 个十六进制字符（64 位），个人文档量级下碰撞概率可以忽略
    func pathKey(_ path: String) -> String {
        let digest = SHA256.hash(data: Data(path.utf8))
        return digest.prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    /// P3-4 用户自定义主题目录（与 scratch 同一个应用支持目录）
    var themesDir: URL {
        let dir = scratchDir.deletingLastPathComponent().appendingPathComponent("themes", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    // ---- 启动 ----

    init(primary: Bool, open path: String? = nil) {
        self.isPrimary = primary
        super.init()
        if let path, isDirectory(path) { pendingFolder = path } else { pendingOpen = path }
        setup()
    }

    private func setup() {
        // 上次打开的文件夹：渲染层 restore() 会把它挂成树根，防穿越守卫也得先认得它。
        // **自检下一律不恢复** —— treeProbe 会在树根里真的建文件、删文件，
        // 恢复用户上次那个文件夹等于拿人家的目录做实验
        // 带着文件夹开出来的窗口：树根立刻就位（防穿越守卫要用，不能等渲染层就绪）。
        // **带着文件开出来的窗口：树根 = 它所在的目录** —— 一个窗口 = 一个工作区，从 Finder
        // 双击一个 .md 进来，工作区就是它旁边那些文件。这里回落到 `lastFolder` 的话，侧栏会
        // 挂着一棵与这份文档毫不相干的树（「打开一个文件，带出上次那个文件夹」就是这么来的），
        // 而且渲染层 `setActive` 的兜底（「没开过文件夹就挂文档所在目录」）也顶不上 ——
        // 它的条件是 `!root`，而这时 root 已经被那个历史文件夹占住了
        treeRoot = pendingFolder
            ?? pendingOpen.flatMap(parentDir)
            ?? (smokeAuto ? nil : UserDefaults.standard.string(forKey: "lastFolder"))
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(FileSchemeHandler(root: findRendererRoot()), forURLScheme: "app")
        config.setURLSchemeHandler(FileSchemeHandler(root: nil), forURLScheme: "safe-file")
        config.userContentController.add(self, name: "shell")
        config.userContentController.addUserScript(
            WKUserScript(source: BRIDGE_JS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        if ProcessInfo.processInfo.environment["CURSIVE_TIMING"] != nil {
            config.userContentController.addUserScript(WKUserScript(
                source: TIMING_JS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        // P4-6①：argv / Finder 那份文档**随页面一起进来**，不再「等渲染层就绪 → 推一趟 IPC」。
        // 窗口创建这一刻就已经知道要开哪个文件，同步读完注成一个全局常量即可
        // （`atDocumentStart` = 先于页面的模块脚本，渲染层建第一个 EditorState 时它就在）。
        // 省掉的不只是那一趟往返：`flushPendingOpen` 的轮询、以及「崩溃恢复的 scratch
        // 与这份文档谁先到」那条竞态，一并没有了。
        // 读盘失败就什么也不做 —— pendingOpen 还在，老路（就绪后 openPath）照走，
        // 顺带把真正的错误提示留给它（那边有 showError）。
        if let p = pendingOpen, let doc = try? readDoc(p) {
            lastDocPath = p
            NSDocumentController.shared.noteNewRecentDocumentURL(URL(fileURLWithPath: p))
            // `JSON.parse('…')` 而不是直接写对象字面量：整份文档要在 documentStart 被
            // JS 引擎编译一遍，几十上百 KB 的字面量走的是完整的语法分析，而 JSON.parse
            // 走的是专用的快路径。外层 jsonLiteral 把内层那串 JSON 再转义成一个 JS 字符串
            config.userContentController.addUserScript(WKUserScript(
                source: "window.__cursiveInitialDoc = JSON.parse(\(jsonLiteral(jsonLiteral(doc))));",
                injectionTime: .atDocumentStart, forMainFrameOnly: true))
            pendingOpen = nil
            mark("首个文档随页面注入")
        }
        // 契约 v24：**自检标记**。自检下渲染层要停掉一切「把上次的样子恢复出来」的行为
        // —— 会话恢复会把上一轮探针开过的文件又开回来，标签数/大纲行数这类断言就跟着飘，
        // 而且探针改文档是常态，恢复出来的那几份还会被一并改写。
        // 与壳侧 `lastFolder` 在 smokeAuto 下短路是同一条理由（见 `setup()` 里那段注释）。
        if smokeAuto {
            config.userContentController.addUserScript(WKUserScript(
                source: "window.__cursiveSelfCheck = true;",
                injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        // DevTools：右键页面 →「检查元素」
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        webView = MainWebView(frame: .zero, configuration: config)
        // 0.4.1：**壳不再碰 `pageZoom`**（它从此恒为 1）。缩放改成只缩正文，归渲染层
        // （localStorage `cursive.zoom`，见 `ui/zoom.ts`）—— 页面缩放会把侧栏、标签、
        // 状态栏、按钮一起放大，而人按 ⌘+ 要的只是「字大一点」。
        // 老版本记在 UserDefaults 里那份就地清掉：留着也没人读了
        UserDefaults.standard.removeObject(forKey: "pageZoom")
        if let main = webView as? MainWebView {
            main.enableFileDrop()
            main.dropHandler = { [weak self] urls in self?.handleDroppedFiles(urls) ?? false }
            // 捏合缩放：手势攒够一档，按菜单那条路发给页面
            main.menuHandler = { [weak self] action in self?.send(action) }
        }
        webView.navigationDelegate = self
        webView.autoresizingMask = [.width, .height]

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1080, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "Cursive"
        window.titlebarAppearsTransparent = true          // ≈ Electron hiddenInset
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true         // 替代 -webkit-app-region: drag
        window.minSize = NSSize(width: 480, height: 360)
        // 容器：webView + 顶部拖拽条是平级兄弟（不能把子视图挂在 webView 上，
        // 否则 relativeTo 自身未定义，且 WKWebView 会重排内部子视图）
        let container = NSView(frame: window.contentRect(forFrameRect: window.frame))
        container.autoresizingMask = [.width, .height]
        window.contentView = container
        webView.frame = container.bounds
        webView.autoresizingMask = [.width, .height]
        container.addSubview(webView)

        // 顶部拖拽条（叠在 webview 上方，与渲染层的 #drag-strip 重合）
        let dragStrip = DragStripView(frame: .zero)
        self.dragStrip = dragStrip
        dragStrip.host = webView
        dragStrip.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(dragStrip, positioned: .above, relativeTo: webView)
        NSLayoutConstraint.activate([
            dragStrip.topAnchor.constraint(equalTo: container.topAnchor),
            dragStrip.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            dragStrip.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            dragStrip.heightAnchor.constraint(equalToConstant: 38)
        ])

        window.delegate = self
        applyFrameAutosave(restore: true)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // 直接 load。这里曾经先 `removeData` 清一遍 WebKit 磁盘/内存缓存、在它的回调里才
        // 加载 —— 用 CURSIVE_TIMING 量过，那个回调要等 140–250ms，**而且等的是一件不必做
        // 的事**：`FileSchemeHandler` 每条响应都显式带 `Cache-Control: no-store`（原因见那边
        // 的注释），app://r 的东西根本进不了缓存，没有「旧 bundle」可清。
        webView.load(URLRequest(url: URL(string: "app://r/index.html")!))

    }

    /// 已经开着的窗口收到「打开这个文件」：webView 还没加载完就先记下，
    /// `flushPendingOpen` 会等 `window.__cursive` 就绪再发
    func openFile(_ path: String) {
        if isDirectory(path) {
            if webView != nil, webView.url != nil { openFolder(path) } else { pendingFolder = path }
            return
        }
        if webView != nil, webView.url != nil { openPath(path) } else { pendingOpen = path }
    }

    /// 把一个文件夹挂成这个窗口的树根（契约 v14：`newWindow(dir)` / Finder 打开文件夹）。
    /// `treeRoot` 同时是文件树增删的防穿越界，必须一起更新
    func openFolder(_ dir: String) {
        treeRoot = dir
        UserDefaults.standard.set(dir, forKey: "lastFolder")
        emit("folder:opened", dir)
    }

    // ---- 菜单（动作字符串与 src/main/menu.ts 完全一致）----

    func send(_ action: String) {
        webView.evaluateJavaScript("window.__shellEmit('menu', \(jsValue(action)))")
    }

    // ---- PDF 导出（P4-2：打印 P4-1 的导出 HTML，真分页）----

    @objc func exportPDF(_ sender: Any?) {
        // 要的是**渲染层此刻的导出 HTML**（含未保存的修改），不是文档源码 ——
        // 壳不再自己渲染一遍 markdown，导出 HTML 与导出 PDF 从此同一条路
        fetchExportHtml { [weak self] html in
            guard let self, let html else { return }
            // 0.2.0：同一次导出顺带要一份目录，PDF 装上书签。
            // 单独一趟往返（而不是把它塞进导出 HTML 再从标签里抠出来）—— 那份 HTML
            // 是给别人看的产物，不该为壳的方便往里掺元数据
            self.fetchOutline { outline in
                self.runPDFFlow(html: html, outline: outline)
            }
        }
    }

    /**
     * 0.4.0 还的第四条账：**真打印机**。
     *
     * 与导出 PDF 同一条流程（同一份导出 HTML、同一台 `PDFPrinter`），只换一个去处：
     * `.printer` 让 AppKit 弹系统打印面板 —— 选哪台机器、几份、纸张都归它，
     * 「存为 PDF」也在那张面板上。从前 ⌘P 直接导出 PDF，这条路根本不存在。
     *
     * 自检下不跑：`runModal` 弹出来的打印面板会把无人值守的 E2E 卡死。
     */
    @objc func printDocument(_ sender: Any?) {
        guard !smokeAuto else { return }
        fetchExportHtml { [weak self] html in
            guard let self, let html else { return }
            self.fetchOutline { outline in
                let printer = PDFPrinter(html: self.inlineImages(html, embed: true),
                                         dest: .printer, opts: PDFOptions(), outline: outline,
                                         host: self.window)
                self.pdfPrinter = printer
                printer.run { [weak self] result in
                    self?.pdfPrinter = nil
                    if case .failure(let e) = result {
                        self?.alertError(L("err.print"), e.localizedDescription)
                    }
                }
            }
        }
    }

    /// 向渲染层要一份目录（0.2.0 PDF 书签）。要不到就当没有 —— 书签是尽力而为的
    private func fetchOutline(_ then: @escaping ([OutlineItem]) -> Void) {
        let js = "return window.__cursive && window.__cursive.outlineSource"
            + " ? window.__cursive.outlineSource() : []"
        webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
            guard case .success(let value) = result, let rows = value as? [[String: Any]] else {
                return then([])
            }
            then(rows.compactMap { row in
                guard let level = row["level"] as? Int, let text = row["text"] as? String,
                      !text.isEmpty else { return nil }
                return OutlineItem(level: level, text: text)
            })
        }
    }

    /// 向渲染层要一份导出 HTML；渲染层还没就绪或抛了异常就回 nil
    private func fetchExportHtml(_ then: @escaping (String?) -> Void) {
        let js = "return window.__cursive ? await window.__cursive.exportHtmlSource() : ''"
        webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard case .success(let value) = result, let html = value as? String, !html.isEmpty else {
                self?.alertError(L("err.export"), L("err.export.empty"))
                return then(nil)
            }
            then(html)
        }
    }

    private func runPDFFlow(html: String, outline: [OutlineItem]) {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.pdf]
        let base = docPath.map { (($0 as NSString).lastPathComponent as NSString).deletingPathExtension } ?? L("doc.untitled")
        panel.nameFieldStringValue = base + ".pdf"
        let accessory = PDFOptionsView(initial: .remembered())
        panel.accessoryView = accessory
        guard panel.runModal() == .OK, let out = panel.url else { return }
        let opts = accessory.options
        opts.remember()

        printPDF(html: html, out: out, opts: opts, outline: outline) { [weak self] result in
            switch result {
            case .success(let stats):
                let alert = NSAlert()
                alert.messageText = L("pdf.done")
                alert.informativeText = LF("pdf.done.body", ["path": out.path, "pages": String(stats.pages)])
                alert.addButton(withTitle: L("dlg.ok"))
                alert.addButton(withTitle: L("dlg.reveal"))
                if alert.runModal() == .alertSecondButtonReturn {
                    NSWorkspace.shared.activateFileViewerSelecting([out])
                }
            case .failure(let e):
                self?.showError(L("err.export"), e.localizedDescription)
            }
        }
    }

    /// 打印那一步。**图片一律嵌成 data: URI** —— 离屏打印视图没有 baseURL，
    /// 相对路径在它那儿什么也找不到（导出 HTML 那条路才有「不嵌」的选项）
    private func printPDF(html: String, out: URL, opts: PDFOptions, outline: [OutlineItem],
                          then: @escaping (Result<PDFStats, Error>) -> Void) {
        let printer = PDFPrinter(html: inlineImages(html, embed: true), dest: .file(out),
                                 opts: opts, outline: outline)
        pdfPrinter = printer
        printer.run { [weak self] result in
            self?.pdfPrinter = nil
            then(result)
        }
    }

    /**
     * 0.3.0 T5：窗口位置**按工作区记**。
     *
     * 从前所有窗口共用一个 `Main`，于是只有第一个窗口的位置算数 —— 而
     * 「一个窗口 = 一个工作区」是这个应用的分栏前提（⌘⇧O 打开文件夹 = 开新窗口），
     * 工作区之间切来切去时每个窗口都摆在同一个地方，那条前提只兑现了一半。
     *
     * 键按**工作区根**分，与会话恢复（契约 v24）同一个口径；名字里那串摘要走壳里
     * 唯一那份 `pathKey`（版本历史的目录名也是它）—— 不为这件事再算第二份。
     * 没有工作区根的（未命名 / 还没挂上树）仍归 `Main`。
     *
     * `setFrameAutosaveName` 回 false 只有一种情况：**另一个开着的窗口已经占了这个名字**，
     * 也就是「同一个工作区开了第二个窗口」。那一种照旧层叠错开 ——
     * 两个窗口抢同一份位置记忆，结果是互相覆盖 + 后开的精确压在先开的身上。
     *
     * `restore` 只在建窗口时为真：工作区是**中途换的**（在一个空窗口里 ⌘⇧O）时，
     * 把窗口当场挪到「那个工作区上次的位置」太吓人 —— 记下来，下次开它的时候再说。
     */
    /// 位置记忆的键：工作区根一份，没有根的（未命名 / 还没挂上树）归 `Main`
    var frameAutosaveKey: String { treeRoot.map { "Main-" + pathKey($0) } ?? "Main" }

    private func applyFrameAutosave(restore: Bool) {
        // **自检下既不恢复也不记住**（同 `applyStartupAppearance` 那条规矩）。
        // 两个理由，第二个是这一轮踩出来的：
        // ① 无人值守的自检不该把开发机记住的窗口位置改掉；
        // ② 起点必须确定 —— E2E 里有一批断言是**视口敏感**的（块级装饰只给视口里的块建，
        //    见 0.2.x 的增量化），窗口一大一小，数出来的东西就不一样。
        //    这条以前是「碰巧成立」的：所有窗口共用一个 `Main`，而开发机上那个键恰好
        //    存着 700×500 —— 换台机器（或清掉偏好）跑，自检当场就不是同一个窗口
        guard !smokeAuto else { return }
        let name = frameAutosaveKey
        guard window.setFrameAutosaveName(name) else {
            if let last = appDelegate?.windows.last?.window, last !== window {
                window.setFrameTopLeftPoint(NSPoint(x: last.frame.minX + 26, y: last.frame.maxY - 26))
            }
            return
        }
        // **名字注册了不等于位置回来了**：setFrameUsingName 才是「按这个名字摆回去」那一步，
        // 没存过就原样不动（返回 false，不必理会）
        if restore { _ = window.setFrameUsingName(name) }
    }

    // ---- 关闭拦截（与 Electron 版行为一致）----

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if forceClose || !dirty { return true }
        send("file:save-and-close")   // 渲染进程存盘后会回调 confirmClose
        return false
    }

    /// 窗口关掉了：注销外部变更监听（fd 会一直占着）、把自己从窗口表里摘掉。
    /// 不摘的话 `key` 还会挑中一个已经关掉的窗口，菜单命令就发给了空的 webView
    func windowWillClose(_ notification: Notification) {
        for src in watchers.values { src.cancel() }
        watchers.removeAll()
        for src in dirWatchers.values { src.cancel() }
        dirWatchers.removeAll()
        for job in dirNotify.values { job.cancel() }
        dirNotify.removeAll()
        appDelegate?.windowClosed(self)
    }

    // ---- shell -> renderer 推送 ----

    private func jsValue(_ v: Any) -> String { jsonLiteral(v) }

    /// 向渲染层推事件（与 openPath 里的内联写法等价，供拖拽等回调使用）
    private func emit(_ event: String, _ payload: Any) {
        let js = "window.__shellEmit('\(event)', \(jsonLiteral(payload)))"
        webView.evaluateJavaScript(js)
    }

    /// 契约 v17：别的窗口改了偏好，转给这个窗口的渲染层（`emit` 是 private，
    /// Swift 的 private 不跨类型，AppDelegate 够不着 —— 这里开一个口子）
    func receivePrefs(_ values: Any) { emit("prefs:changed", values) }

    func openPath(_ path: String) {
        mark("openPath 推文档")
        do {
            lastDocPath = path
            NSDocumentController.shared.noteNewRecentDocumentURL(URL(fileURLWithPath: path))
            let doc = try readDoc(path)
            let js = "window.__shellEmit('file:opened', \(jsValue(doc)))"
            webView.evaluateJavaScript(js) { _, err in
                if let err {
                    let msg = "[openPath] emit error: \(err)\n"
                    FileHandle.standardError.write(msg.data(using: .utf8)!)
                }
            }
        } catch { showError(L("err.open"), error.localizedDescription) }
    }

    /// P2-5：Finder 拖入。.md → 开新标签（openPath）；图片 → 复制进 <docDir>/assets/ 并通知渲染层插链接
    private func handleDroppedFiles(_ urls: [URL]) -> Bool {
        var handled = false
        for url in urls {
            let ext = url.pathExtension.lowercased()
            if ["md", "markdown", "mdown", "mkd"].contains(ext) {
                openPath(url.path)
                handled = true
            } else if ["png", "jpg", "jpeg", "gif", "webp", "avif", "tiff", "tif", "heic", "bmp"].contains(ext),
                      let rel = copyImageToAssets(from: url) {
                emit("image:dropped", rel)
                handled = true
            }
        }
        return handled
    }

    /**
     * 0.4.0 还的第三条账：图片落到哪个 `assets/`。
     *
     * 从前写死「当前文档同级」。写作时两种习惯都常见 —— 一篇一个文件夹的人要文档同级，
     * 一个仓库一堆散篇的人要**工作区根**一处收着（不然 assets 会散得到处都是）。
     * 偏好在渲染层（`PrefValues.imageDir`），经契约 v31 的 `setImageDir` 推过来，
     * **落脚与算相对路径都收在这一处**：粘贴与拖入两条路各算一遍的话，迟早一边对一边错。
     */
    private func assetsBaseDir(_ docDir: String?) -> String {
        let doc = docDir ?? (lastDocPath as NSString?)?.deletingLastPathComponent
            ?? FileManager.default.currentDirectoryPath
        guard imageDirMode == "root", let root = treeRoot else { return doc }
        return root
    }

    /// 落盘位置 → **相对当前文档**的写法（图片链接是相对文档解析的）。
    /// 落在工作区根时这里就会出现 `../assets/x.png` —— 渲染层原样插进文档
    private func assetRelPath(_ full: String, docDir: String?) -> String {
        let doc = ((docDir ?? (lastDocPath as NSString?)?.deletingLastPathComponent
            ?? FileManager.default.currentDirectoryPath) as NSString).standardizingPath
        let target = (full as NSString).standardizingPath
        let a = doc.split(separator: "/").map(String.init)
        let b = target.split(separator: "/").map(String.init)
        var i = 0
        while i < a.count, i < b.count, a[i] == b[i] { i += 1 }
        if i == 0 { return target }
        return (Array(repeating: "..", count: a.count - i) + b[i...]).joined(separator: "/")
    }

    /// 把外部图片复制进 assets/，重名自动加序号，返回**相对当前文档**的路径
    private func copyImageToAssets(from url: URL) -> String? {
        let baseDir = assetsBaseDir(nil)
        let assets = (baseDir as NSString).appendingPathComponent("assets")
        try? FileManager.default.createDirectory(atPath: assets, withIntermediateDirectories: true)
        let stem = url.deletingPathExtension().lastPathComponent
        let ext = url.pathExtension
        var name = url.lastPathComponent
        var n = 1
        while FileManager.default.fileExists(atPath: (assets as NSString).appendingPathComponent(name)) {
            name = "\(stem)-\(n).\(ext)"
            n += 1
        }
        let full = (assets as NSString).appendingPathComponent(name)
        do { try FileManager.default.copyItem(at: url, to: URL(fileURLWithPath: full)) } catch { return nil }
        return assetRelPath(full, docDir: nil)
    }

    // ---- P4-1 导出 HTML：图片嵌入 ----

    /// `<img src="…" data-abs="/绝对/路径" …>` → 换成 data: URI（不嵌入时只把 data-abs 摘掉）。
    /// 只认渲染层自己拼的这一种形状（src 紧挨着 data-abs），所以不需要真的解析 HTML。
    private func inlineImages(_ html: String, embed: Bool) -> String {
        guard let re = try? NSRegularExpression(pattern: "<img src=\"([^\"]*)\" data-abs=\"([^\"]*)\"")
        else { return html }
        let ns = html as NSString
        var out = ""
        var last = 0
        for m in re.matches(in: html, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            let src = ns.substring(with: m.range(at: 1))
            let abs = ns.substring(with: m.range(at: 2))
            out += "<img src=\"\(embed ? (dataURI(forFile: abs) ?? src) : src)\""
            last = m.range.location + m.range.length
        }
        return out + ns.substring(from: last)
    }

    /// 读盘 → data: URI。路径是渲染层从 markdown 里原样拼出来的，可能带百分号编码 ——
    /// 逐级解码去找，和 `FileSchemeHandler` 那段同一个道理。
    /// 单张超过 16 MB 就不嵌（返回 nil = 保留相对路径）：一张图撑爆整份导出不值得。
    private func dataURI(forFile path: String) -> String? {
        var candidate = path
        var found: String?
        for _ in 0..<3 {
            if FileManager.default.fileExists(atPath: candidate) { found = candidate; break }
            guard let next = candidate.removingPercentEncoding, next != candidate else { break }
            candidate = next
        }
        guard let file = found, let data = try? Data(contentsOf: URL(fileURLWithPath: file)),
              data.count <= 16 * 1024 * 1024 else { return nil }
        let ext = (file as NSString).pathExtension.lowercased()
        let mime = FileSchemeHandler.mime[ext] ?? "application/octet-stream"
        return "data:\(mime);base64,\(data.base64EncodedString())"
    }

    private func showError(_ title: String, _ msg: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = msg
        alert.runModal()
    }

    // MARK: - renderer -> shell（15 个通道）

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        // 渲染层就绪：BRIDGE_JS 在 window.__cursive 被赋值的那一刻捎回来的，
        // 于是「等就绪」不再是轮询而是推送（轮询仍留着兜底，见 flushPendingOpen）
        if let dict = message.body as? [String: Any], dict["type"] as? String == "ready" {
            mark("渲染层 ready（推送）")
            flushPendingOpen()
            return
        }
        // 渲染层自己报的时刻（window.__cursiveMark）：只在 CURSIVE_TIMING 下有输出
        if let dict = message.body as? [String: Any], dict["type"] as? String == "timing" {
            mark(dict["label"] as? String ?? "?")
            return
        }
        guard let dict = message.body as? [String: Any],
              let id = dict["id"] as? Int,
              let method = dict["method"] as? String,
              let args = dict["args"] as? [Any] else { return }
        // NSOpenPanel/NSAlert 用同步 runModal，量级和 Electron 的 dialog.showOpenDialogSync 相同
        switch method {
        case "openDialog":
            let panel = NSOpenPanel()
            panel.allowedContentTypes = ["md", "markdown", "mdown", "mkd", "txt"]
                .compactMap { UTType(filenameExtension: $0) }
            if panel.runModal() == .OK, let url = panel.url {
                let doc = try? readDoc(url.path)
                respond(id, doc ?? NSNull())
            } else { respond(id, NSNull()) }

        case "read":
            do { respond(id, try readDoc(args[0] as? String ?? "")) }
            catch { reject(id, "读不到文件：\(args[0])") }

        case "save", "saveAs":
            let current = args[0] as? String
            let target: String?
            if method == "save", let p = current { target = p }
            else {
                let panel = NSSavePanel()
                panel.nameFieldStringValue = (current as NSString?)?.lastPathComponent ?? L("doc.untitledMd")
                panel.allowedContentTypes = ["md", "markdown", "mdown", "mkd", "txt"]
                    .compactMap { UTType(filenameExtension: $0) }
                target = panel.runModal() == .OK ? panel.url?.path : nil
            }
            guard let path = target, let content = args[1] as? String,
                  let fpDict = args[2] as? [String: Any] else { respond(id, NSNull()); break }
            let fp = Fingerprint(eol: fpDict["eol"] as? String ?? "\n", bom: fpDict["bom"] as? Bool ?? false)
            do {
                try encodeDoc(content, fp).write(to: URL(fileURLWithPath: path), atomically: true, encoding: .utf8)
                dirty = false; window.isDocumentEdited = false
                NSDocumentController.shared.noteNewRecentDocumentURL(URL(fileURLWithPath: path))
                respond(id, ["path": path])
            } catch { reject(id, "写入失败：\(error.localizedDescription)") }

        case "setDocState":
            let st = args[0] as? [String: Any] ?? [:]
            let path = st["path"] as? String
            docPath = path
            if let p = path { updateWatchers([p]) }
            dirty = st["dirty"] as? Bool ?? false
            let name = path.map { ($0 as NSString).lastPathComponent } ?? L("doc.untitled")
            window.title = "\(dirty ? "• " : "")\(name) — Cursive"
            window.isDocumentEdited = dirty
            if let p = path { window.representedFilename = p }
            respond(id, NSNull())

        case "confirmClose":
            forceClose = true
            window.close()
            respond(id, NSNull())

        case "confirmDiscard":
            // 自检下**绝不弹**（同新建/重命名那几处）：`runModal` 会把无人值守的 E2E
            // 直接卡死在这儿，而且卡的样子是「跑了十分钟没输出」，很难一眼看出是谁。
            // `CURSIVE_SMOKE_DISCARD=save|discard|cancel` 指定替身答案，默认 discard
            // —— 探针里任何一次误关脏标签都该当场过去，而不是把整轮挂起。
            // 有了它，「批量关闭时取消要中止整批」这条才测得到（那是最容易丢东西的一条）
            if smokeAuto {
                let pick = ProcessInfo.processInfo.environment["CURSIVE_SMOKE_DISCARD"] ?? "discard"
                respond(id, ["save", "discard", "cancel"].contains(pick) ? pick : "discard")
                break
            }
            let alert = NSAlert()
            alert.messageText = L("dlg.saveChanges")
            alert.informativeText = LF("dlg.saveChanges.body",
                ["name": args[0] as? String ?? L("doc.untitledDoc")])
            alert.addButton(withTitle: L("dlg.save"))
            alert.addButton(withTitle: L("dlg.dontSave"))
            alert.addButton(withTitle: L("dlg.cancel"))
            let choice = ["save", "discard", "cancel"][
                alert.runModal().rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
            ]
            respond(id, choice)

        case "writeClipboardText":
            let pb = NSPasteboard.general
            pb.clearContents()
            pb.setString(args.first as? String ?? "", forType: .string)
            respond(id, NSNull())

        // ---- 0.2.0 复制为富文本（契约 v20）----
        // 正文仍由渲染层渲染（和 P4-1 导出、P4-2 打印同一份 HTML，共用同一棵语法树），
        // 壳只做一件事：把它按 `.html` 放上剪贴板。**两种风味一起放** ——
        // 粘进邮件 / 飞书 / Notion 拿到的是带格式的版面，粘进终端 / 代码框拿到的是
        // Markdown 源码。只放 html 的话，纯文本目标会收到一堆标签
        case "copyHtml":
            let html = args.first as? String ?? ""
            let plain = (args.count > 1 ? args[1] as? String : nil) ?? ""
            // **自检下不碰剪贴板**：E2E 是开发者在自己机器上跑的，抢走他手里的剪贴板
            // 很不礼貌（同「自检下所有模态一律不弹」那条）。要验的是渲染层交出了
            // 一对非空的 html/plain、而且过得了桥；真正写剪贴板是下面三行没有分支的代码
            if smokeAuto {
                smokeCopyHtml = [html.count, plain.count]
            } else {
                let pb = NSPasteboard.general
                pb.clearContents()
                pb.declareTypes([.html, .string], owner: nil)
                pb.setString(html, forType: .html)
                pb.setString(plain, forType: .string)
            }
            respond(id, NSNull())

        // ---- 0.2.0 文件索引（契约 v21）----
        // 快速打开（⌘T）要一份树根下的文档清单。判断 3 的精神照旧：**遍历在壳侧做**
        // —— 渲染层递归 readDir 是几百次桥调用，而这里一趟就够。
        //
        // 走后台队列而**不占 `searchQueue`**：那条队列是串行的，索引一挂上去就会把
        // 用户正在打字的跨文件搜索顶掉（`searchFiles` 每次都 cancelAllOperations）
        case "listFiles":
            let root = args.first as? String ?? ""
            guard !root.isEmpty, isDirectory(root) else { respond(id, [String]()); break }
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let paths = DocScan.list(root: root)
                DispatchQueue.main.async { self?.respond(id, paths) }
            }

        case "setViewFlags":
            appDelegate?.syncViewFlags(args.first as? [String: Any] ?? [:])
            respond(id, NSNull())

        case "setAppearance":
            // nil = 交还给系统。标题栏、红绿灯、NSAlert、NSOpenPanel 都吃 NSApp.appearance，
            // 不设的话切主题只切了网页那一半，系统面板还是亮的
            let mode = args.first as? String ?? "system"
            NSApp.appearance = appearanceFor(mode)
            // **记下来给下次启动用**（见 `applyStartupAppearance`）。真相仍在渲染层的
            // localStorage，这一份只是「上一次是什么样」的影子，够首帧用就行
            UserDefaults.standard.set(mode, forKey: "appearance")
            appDelegate?.syncThemeMenu(mode)
            respond(id, NSNull())

        case "setTitlebarHoles":
            // 契约 v26：渲染层量好的「这一条上哪几段不归拖拽」（CSS px）。
            // 壳只是照做 —— 段数与位置只有页面知道（标签数、窗口宽度、面板显隐一起变）。
            // 报空数组 = 整条都归拖拽；久久不报则走 `DragStripView` 里那份兜底区间
            dragStrip?.holes = (args.first as? [[Double]] ?? []).compactMap {
                $0.count == 2 ? (CGFloat($0[0]), CGFloat($0[1])) : nil
            }
            respond(id, NSNull())

        case "setImageDir":
            // 契约 v31：只记在内存里。真相是渲染层的偏好，壳不持久化
            imageDirMode = (args.first as? String) == "root" ? "root" : "doc"
            respond(id, true)

        case "setLanguage":
            // 契约 v16：真相在渲染层，壳只是跟着换。菜单栏整个重建（buildMenu 可重入），
            // 对话框文案是弹出时现查的，天然就换过来了
            if let lang = args.first as? String {
                uiLangIdx = lang == "en" ? 1 : 0
                appDelegate?.buildMenu()
            }
            respond(id, NSNull())

        case "syncPrefs":
            // 契约 v17：偏好的真相在渲染层的 localStorage，而各窗口在启动时各读一份进内存。
            // 壳**既不读内容也不持久化**（与主题 / 语言 / 视图开关同一条规矩），
            // 只把整份原样转给除发起者以外的窗口 —— 它在这里纯粹是条总线
            if let values = args.first, !(values is NSNull) {
                appDelegate?.broadcastPrefs(values, except: self)
            }
            respond(id, NSNull())

        case "openExternal":
            // 回「系统真的接手了吗」：地址不合法、本地文件已经不在了都会是 false，
            // 渲染层拿它在状态栏说一句「打不开」—— 否则一次失败的点击与成功的长得一模一样
            var opened = false
            if let s = args[0] as? String, let url = URL(string: s) {
                // 自检下只记账、不真的唤起浏览器（见 smokeExternal）。
                // **本地文件仍按「在不在」回话**：不这样的话「打不开」那条路
                // （状态栏说一句）在 E2E 里永远走不到 —— 替身太宽容，等于没测
                if smokeAuto {
                    smokeExternal.append(s)
                    opened = url.isFileURL ? FileManager.default.fileExists(atPath: url.path) : true
                } else {
                    opened = NSWorkspace.shared.open(url)
                }
            }
            respond(id, opened)

        case "checkUpdate":
            checkUpdate(id)

        case "pickFolder":
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            let picked = panel.runModal() == .OK ? panel.url?.path : nil
            // 记下来：文件树的增删要靠它判断「动土的地方在不在树根以内」。
            // 顺带持久化 —— `lastFolder` 通道一直只读不写，于是「恢复上次的文件夹」
            // 从来没真正生效过（渲染层每次拿到的都是 null）
            if let picked {
                treeRoot = picked
                UserDefaults.standard.set(picked, forKey: "lastFolder")
                // 0.3.0 T5：工作区换了，位置记忆跟着换一处（不挪窗口，见 applyFrameAutosave）
                applyFrameAutosave(restore: false)
            }
            respond(id, picked ?? NSNull())

        case "readDir":
            let path = args[0] as? String ?? ""
            let fm = FileManager.default
            // **一次批量取属性**：从前是每条一次 `fileExists`，一个 1500 篇的库就是 1500 次
            // 系统调用。`.skipsHiddenFiles` 顺手把点文件挡掉（原先是手写的 hasPrefix(".")），
            // 而且连带认了「带隐藏标记但不以点开头」的那些
            let urls = (try? fm.contentsOfDirectory(at: URL(fileURLWithPath: path),
                                                    includingPropertiesForKeys: [.isDirectoryKey],
                                                    options: [.skipsHiddenFiles])) ?? []
            var rows: [(name: String, isDir: Bool)] = []
            for url in urls {
                let isDir = (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true
                // 文件树只放「能打开的文档」（与 DocScan.exts 同一套白名单）和目录：
                // 本编辑器打不开的文件进了树，点了也只是白报一次错
                if !isDir, !DocScan.exts.contains(url.pathExtension.lowercased()) { continue }
                rows.append((url.lastPathComponent, isDir))
            }
            // **目录在前，然后按 `nameOrder`**。目录在前不是 Finder 的默认（它默认混排，
            // 那个开关默认关着），是编辑器惯例（VS Code / Obsidian / Xcode）—— 这棵树是
            // 导航控件不是文件管理器，目录聚成一堆，层级才扫得出来。
            // 路径仍然按原样拼：渲染层拿**路径当身份**（`expanded` 集合、`byPath` 索引、
            // 拖拽落点全是它），换成 `url.path` 会在个别边界上悄悄换一个串
            let entries: [[String: Any]] = rows
                .sorted { $0.isDir != $1.isDir ? $0.isDir : nameOrder($0.name, $1.name) }
                .map { ["name": $0.name, "path": "\(path)/\($0.name)", "isDir": $0.isDir] }
            respond(id, entries)

        // ---- P3-1 文件树读写：新建 / 删除 ----
        case "createFile", "createFolder":
            let wantFolder = method == "createFolder"
            guard let dir = safeTarget(args[0] as? String ?? ""), isDirectory(dir) else {
                respond(id, NSNull()); break
            }
            guard let name = promptName(
                title: wantFolder ? L("dlg.newFolder") : L("dlg.newFile"),
                initial: wantFolder ? L("dlg.newFolder.init") : L("doc.untitledMd")
            ) else { respond(id, NSNull()); break }
            let target = uniquePath("\(dir)/\(name)")
            do {
                if wantFolder {
                    try FileManager.default.createDirectory(
                        atPath: target, withIntermediateDirectories: false)
                } else if !FileManager.default.createFile(atPath: target, contents: Data()) {
                    throw CocoaError(.fileWriteUnknown)
                }
                respond(id, ["path": target])
            } catch {
                alertError(LF("err.create", ["name": name]), error.localizedDescription)
                respond(id, NSNull())
            }

        case "trashItem":
            // 一律进废纸篓，不用 removeItem —— 误删能在 Finder 里找回
            guard let victim = safeTarget(args[0] as? String ?? ""),
                  FileManager.default.fileExists(atPath: victim) else { respond(id, NSNull()); break }
            if !smokeAuto {
                let alert = NSAlert()
                let name = (victim as NSString).lastPathComponent
                alert.messageText = LF("dlg.trash", ["name": name])
                alert.informativeText = isDirectory(victim) ? L("dlg.trash.folder") : L("dlg.trash.body")
                alert.addButton(withTitle: L("dlg.trash.ok"))
                alert.addButton(withTitle: L("dlg.cancel"))
                guard alert.runModal() == .alertFirstButtonReturn else { respond(id, NSNull()); break }
            }
            do {
                // 契约 v25：把**落点**带回去。只有这儿知道它被放到了废纸篓的哪个名字下
                // （同名冲突时系统会改名），而那是状态栏那颗「撤销」唯一的线索
                var landed: NSURL?
                try FileManager.default.trashItem(
                    at: URL(fileURLWithPath: victim), resultingItemURL: &landed)
                respond(id, ["trashed": (landed as URL?)?.path ?? ""])
            } catch {
                alertError(L("err.trash"), error.localizedDescription)
                respond(id, NSNull())
            }

        case "restoreItem":
            // 契约 v25 撤销删除。**两道闸，方向相反**：
            //   · 源头必须真的在废纸篓里 —— `safeTarget` 在这儿用不上（废纸篓本来就不在
            //     树根底下），换成「路径里有 .Trash 那一节」这条。两种形状都要认：
            //     主盘是 `~/.Trash/…`，外置盘是 `/Volumes/X/.Trashes/<uid>/…`；
            //   · 落点照旧过 `safeTarget`，而且**此刻必须不存在** —— 删掉之后又新建了
            //     同名文件时宁可撤不回来，也不能悄悄盖掉那个新文件。
            let from = ((args[0] as? String ?? "") as NSString).standardizingPath
            guard from.contains("/.Trash/") || from.contains("/.Trashes/") else { respond(id, false); break }
            guard FileManager.default.fileExists(atPath: from),
                  let back = safeTarget(args[1] as? String ?? ""),
                  !FileManager.default.fileExists(atPath: back) else { respond(id, false); break }
            do {
                try FileManager.default.moveItem(atPath: from, toPath: back)
                respond(id, true)
            } catch {
                alertError(L("err.trash"), error.localizedDescription)
                respond(id, false)
            }

        // ---- P3-1 收尾：重命名 / 拖拽移动 / 在 Finder 中显示（契约 v10）----
        case "renameItem":
            guard let victim = safeTarget(args[0] as? String ?? ""),
                  FileManager.default.fileExists(atPath: victim) else { respond(id, NSNull()); break }
            let oldName = (victim as NSString).lastPathComponent
            guard let newName = promptName(title: L("dlg.rename"), initial: oldName, confirm: L("dlg.rename"),
                                           smokeEnv: "CURSIVE_SMOKE_RENAME"),
                  newName != oldName else { respond(id, NSNull()); break }
            let parent = (victim as NSString).deletingLastPathComponent
            let renamed = uniquePath("\(parent)/\(newName)")
            do {
                try FileManager.default.moveItem(atPath: victim, toPath: renamed)
                respond(id, ["path": renamed])
            } catch {
                alertError(LF("err.rename", ["name": oldName]), error.localizedDescription)
                respond(id, NSNull())
            }

        case "moveItem":
            guard let src = safeTarget(args[0] as? String ?? ""),
                  let destDir = safeTarget(args[1] as? String ?? ""),
                  isDirectory(destDir), FileManager.default.fileExists(atPath: src)
            else { respond(id, NSNull()); break }
            // 拖进自己、拖进自己的子孙目录 = 把目录搬进自己肚子里；原地拖 = 什么都不用做
            if destDir == src || destDir.hasPrefix("\(src)/")
                || (src as NSString).deletingLastPathComponent == destDir {
                respond(id, NSNull()); break
            }
            let moved = uniquePath("\(destDir)/\((src as NSString).lastPathComponent)")
            do {
                try FileManager.default.moveItem(atPath: src, toPath: moved)
                respond(id, ["path": moved])
            } catch {
                alertError(LF("err.move", ["name": (src as NSString).lastPathComponent]),
                           error.localizedDescription)
                respond(id, NSNull())
            }

        case "revealInFinder":
            if let target = safeTarget(args[0] as? String ?? ""),
               FileManager.default.fileExists(atPath: target) {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: target)])
            }
            respond(id, NSNull())

        // ---- P3-2 跨文件搜索（契约 v11）----
        case "searchFiles":
            searchQueue.cancelAllOperations()   // 同一时刻只跑一个：上一次的结果不许追上来
            let token = args[0] as? Int ?? 0
            let root = args[1] as? String ?? ""
            let query = args[2] as? String ?? ""
            if !query.isEmpty, !root.isEmpty, safeTarget(root) != nil || isDirectory(root) {
                searchQueue.addOperation(SearchOperation(
                    token: token, root: root, query: query,
                    opts: args[3] as? [String: Any] ?? [:]
                ) { [weak self] event, payload in
                    // Operation 在后台线程跑，evaluateJavaScript 必须回主线程
                    DispatchQueue.main.async { self?.emit(event, payload) }
                })
            }
            respond(id, NSNull())

        case "cancelSearch":
            searchQueue.cancelAllOperations()
            respond(id, NSNull())

        // ---- P3-4 用户自定义主题（契约 v12）----
        case "replaceInFiles":
            guard let rawTargets = args.first as? [[String: Any]],
                  let replacement = args.count > 1 ? args[1] as? String : nil else {
                respond(id, NSNull())
                break
            }
            var changedFiles = 0
            var changedHits = 0
            var skipped: [String] = []
            var undo: [(path: String, content: String, fp: Fingerprint)] = []
            for target in rawTargets {
                let rawPath = target["path"] as? String ?? ""
                // 只认工作区（或当前文档目录）底下的文件 —— 路径是渲染层递过来的，
                // 而这条通道能写盘
                guard let path = safeTarget(rawPath),
                      let hits = target["hits"] as? [[String: Any]], !hits.isEmpty,
                      let raw = try? readRawDoc(path) else {
                    if !rawPath.isEmpty { skipped.append(rawPath) }
                    continue
                }
                let (text, fp) = decodeDoc(raw)
                guard let next = applyReplacements(text, hits: hits, with: replacement) else {
                    skipped.append(path)
                    continue
                }
                // 改之前先留一份（契约 v22 的版本历史）。8 秒那颗撤销过期之后，
                // 这是唯一还找得回来的地方 —— 所以它必须在**写盘之前**
                saveSnapshot(path: path, content: text)
                do {
                    try encodeDoc(next.text, fp)
                        .write(to: URL(fileURLWithPath: path), atomically: true, encoding: .utf8)
                    undo.append((path, text, fp))
                    changedFiles += 1
                    changedHits += next.count
                } catch {
                    skipped.append(path)
                }
            }
            replaceToken += 1
            if undo.isEmpty {
                replaceUndo = nil
            } else {
                replaceUndo = (token: replaceToken, entries: undo)
            }
            let undoToken = undo.isEmpty ? 0 : replaceToken
            respond(id, ["files": changedFiles, "hits": changedHits,
                         "skipped": skipped, "token": undoToken])

        case "undoReplaceInFiles":
            guard let token = args.first as? Int, let saved = replaceUndo, saved.token == token else {
                respond(id, 0)
                break
            }
            replaceUndo = nil
            var restored = 0
            for e in saved.entries {
                // 原样写回去（连指纹一起）—— 撤销之后应当与替换前逐字节相同
                if (try? encodeDoc(e.content, e.fp)
                    .write(to: URL(fileURLWithPath: e.path), atomically: true, encoding: .utf8)) != nil {
                    restored += 1
                }
            }
            respond(id, restored)

        case "userThemes":
            var themes: [[String: Any]] = []
            if let files = try? FileManager.default.contentsOfDirectory(
                at: themesDir, includingPropertiesForKeys: nil) {
                for f in files.sorted(by: { $0.lastPathComponent < $1.lastPathComponent })
                where f.pathExtension.lowercased() == "css" {
                    if let css = try? String(contentsOf: f, encoding: .utf8) {
                        themes.append(["name": f.deletingPathExtension().lastPathComponent, "css": css])
                    }
                }
            }
            respond(id, themes)

        // ---- P3-7 多窗口（契约 v13）----
        // ---- P4-1 导出 HTML（契约 v15）----
        // 正文由渲染层渲染，壳只管两件事：保存面板 + 把本地图片按需嵌成 data: URI。
        // **图片字节不过 IPC 桥**（判断 3）—— 渲染层只在 <img data-abs> 里写清楚去哪儿取
        case "exportHtml":
            guard let html = args.first as? String else { respond(id, NSNull()); break }
            let suggested = (args.count > 1 ? args[1] as? String : nil) ?? L("export.defaultName")
            var target: String?
            var embed = true
            if smokeAuto {
                // 自检绕过保存面板：runModal 会把无人值守的自检直接卡死。空串当没设
                let env = ProcessInfo.processInfo.environment["CURSIVE_SMOKE_HTML"]
                target = (env?.isEmpty ?? true) ? nil : env
            } else {
                let panel = NSSavePanel()
                panel.allowedContentTypes = [.html]
                panel.nameFieldStringValue = suggested
                let check = NSButton(checkboxWithTitle: L("export.embedImages"), target: nil, action: nil)
                check.state = .on
                check.toolTip = L("export.embedImages.tip")
                check.frame = NSRect(x: 16, y: 8, width: 240, height: 18)
                let box = NSView(frame: NSRect(x: 0, y: 0, width: 272, height: 34))
                box.addSubview(check)
                panel.accessoryView = box
                target = panel.runModal() == .OK ? panel.url?.path : nil
                embed = check.state == .on
            }
            guard let out = target else { respond(id, NSNull()); break }
            do {
                try inlineImages(html, embed: embed)
                    .write(to: URL(fileURLWithPath: out), atomically: true, encoding: .utf8)
                respond(id, ["path": out])
            } catch {
                alertError(L("err.export"), error.localizedDescription)
                respond(id, NSNull())
            }

        case "exportPng":
            // 0.3.0 T3：与导出 HTML 同一份 HTML 进来，区别只在**怎么落地**
            guard let html = args.first as? String else { respond(id, NSNull()); break }
            let pngName = (args.count > 1 ? args[1] as? String : nil) ?? L("export.defaultPng")
            let pngWidth = (args.count > 2 ? args[2] as? Double : nil) ?? 720
            var pngTarget: String?
            if smokeAuto {
                let env = ProcessInfo.processInfo.environment["CURSIVE_SMOKE_PNG"]
                pngTarget = (env?.isEmpty ?? true) ? nil : env
            } else {
                let panel = NSSavePanel()
                panel.allowedContentTypes = [.png]
                panel.nameFieldStringValue = pngName
                pngTarget = panel.runModal() == .OK ? panel.url?.path : nil
            }
            guard let pngOut = pngTarget else { respond(id, NSNull()); break }
            // 图片一律嵌成 data: URI：一张 PNG 指不着本地文件（HTML 那条路才有得选）
            let shooter = PNGShooter(html: inlineImages(html, embed: true),
                                     out: URL(fileURLWithPath: pngOut), width: CGFloat(pngWidth))
            pngShooter = shooter
            shooter.run { [weak self] result in
                guard let self else { return }
                self.pngShooter = nil
                switch result {
                case .success(let shot):
                    self.respond(id, ["path": pngOut,
                                      "pixels": [shot.pixelsWide, shot.pixelsHigh],
                                      "clipped": shot.clipped])
                case .failure(let e):
                    self.alertError(L("err.export"), e.localizedDescription)
                    self.respond(id, NSNull())
                }
            }

        case "newWindow":
            // 契约 v14：带路径就让新窗口直接落在那个文件 / 文件夹上
            appDelegate?.newWindow(open: args.first as? String)
            respond(id, NSNull())

        case "workspaceRoot":
            // 契约 v19：**这个窗口的**工作区根，不是全局的「上次那个文件夹」。
            // 三种来源（带文件夹 / 带文件 / 空手开）都在 `setup()` 里一次定好，这里只管报
            respond(id, treeRoot ?? NSNull())

        case "readClipboardText":
            // ⇧⌥⌘V 粘贴为纯文本：剪贴板由壳侧读（判断 3：渲染层不碰原生）
            respond(id, NSPasteboard.general.string(forType: .string) ?? "")

        case "pasteImage":
            // P2-5：剪贴板里的图落盘到 <docDir>/assets/，只回一个相对路径
            let dirArg = args[0] as? String
            let docDir: String? = dirArg?.isEmpty == false ? dirArg : nil
            let baseDir = assetsBaseDir(docDir)
            let pb = NSPasteboard.general
            var png: Data? = pb.data(forType: .png)
            if png == nil, let tiff = pb.data(forType: .tiff),
               let rep = NSBitmapImageRep(data: tiff) {
                png = rep.representation(using: .png, properties: [:])
            }
            guard let data = png else { respond(id, NSNull()); break }
            let assets = (baseDir as NSString).appendingPathComponent("assets")
            try? FileManager.default.createDirectory(atPath: assets, withIntermediateDirectories: true)
            // 文件名 = <文档名>-<时间戳>.png（文档名从当前文档路径推，避免多文档撞名）
            let docName = (self.lastDocPath as NSString?)?.lastPathComponent ?? "image"
            let stem = (docName as NSString).deletingPathExtension
            let stamp = Int(Date().timeIntervalSince1970)
            let file = "\(stem.isEmpty ? "image" : stem)-\(stamp).png"
            let full = (assets as NSString).appendingPathComponent(file)
            do {
                try data.write(to: URL(fileURLWithPath: full))
            } catch {
                respond(id, NSNull()); break
            }
            respond(id, ["relPath": assetRelPath(full, docDir: docDir)])

        // ---- 0.2.0 版本历史（契约 v22）----
        // 每次保存到真实路径之后留一份快照。三条约束全在壳侧，渲染层只管发一次请求：
        // 去重（同一份内容不重复写）、留存上限（最近 50 条 / 30 天）、只认带路径的文档
        case "snapshotSave":
            guard let path = args.first as? String, !path.isEmpty,
                  let content = args.count > 1 ? args[1] as? String : nil else {
                respond(id, false); break
            }
            let dir = historyDir(for: path)
            let fm = FileManager.default
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
            // **去重**：自动保存每隔两秒就可能触发一次，内容没变的话历史里全是同一份。
            // 只比最新那一条就够 —— 快照按时间单调追加，中间不会插队
            let existing = snapshotFiles(dir)
            if let newest = existing.last,
               let old = try? String(contentsOf: newest, encoding: .utf8), old == content {
                respond(id, false); break
            }
            // 落盘目录里只放正文：原路径与时间戳分别由 `path.txt` 和文件名记着，
            // 不再为每份快照多写一个元数据文件（那会让目录里的文件数翻倍）
            try? content.write(to: dir.appendingPathComponent("\(Int(Date().timeIntervalSince1970 * 1000)).md"),
                               atomically: true, encoding: .utf8)
            try? path.write(to: dir.appendingPathComponent("path.txt"), atomically: true, encoding: .utf8)
            pruneSnapshots(dir)
            respond(id, true)

        case "snapshotList":
            guard let path = args.first as? String, !path.isEmpty else { respond(id, []); break }
            let files = snapshotFiles(historyDir(for: path))
            let iso = ISO8601DateFormatter()
            // 新的在前 —— 列表里最想先看到的是「刚才那一版」
            respond(id, files.reversed().map { url -> [String: Any] in
                let stamp = Double(url.deletingPathExtension().lastPathComponent) ?? 0
                let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
                return [
                    "id": url.deletingPathExtension().lastPathComponent,
                    "savedAt": iso.string(from: Date(timeIntervalSince1970: stamp / 1000)),
                    "bytes": size
                ]
            })

        case "snapshotRead":
            guard let path = args.first as? String,
                  let sid = args.count > 1 ? args[1] as? String : nil,
                  // 快照 id 直接拼进路径，必须挡住穿越：只允许纯数字（时间戳）
                  sid.allSatisfy({ $0.isNumber }), !sid.isEmpty else { respond(id, NSNull()); break }
            let file = historyDir(for: path).appendingPathComponent("\(sid).md")
            respond(id, (try? String(contentsOf: file, encoding: .utf8)) ?? NSNull())

        case "scratchSave":
            guard let sid = args[0] as? String, let content = args[1] as? String,
                  let fpDict = args[2] as? [String: Any] else { respond(id, NSNull()); break }
            let fp = Fingerprint(eol: fpDict["eol"] as? String ?? "\n", bom: fpDict["bom"] as? Bool ?? false)
            let payload: [String: Any] = [
                "content": content, "fingerprint": ["eol": fp.eol, "bom": fp.bom],
                "savedAt": ISO8601DateFormatter().string(from: Date())
            ]
            do {
                let data = try JSONSerialization.data(withJSONObject: payload)
                try data.write(to: scratchDir.appendingPathComponent("\(sid).json"))
                respond(id, true)
            } catch { reject(id, "scratch 写入失败：\(error.localizedDescription)") }

        case "scratchList":
            var list: [[String: Any]] = []
            scratchQueries += 1
            if let files = try? FileManager.default.contentsOfDirectory(at: scratchDir, includingPropertiesForKeys: nil) {
                for f in files.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) where f.pathExtension == "json" {
                    let sid = f.deletingPathExtension().lastPathComponent
                    // 只认启动前就在盘上的，而且只认一次（见 `recoverableScratch`）——
                    // 少了这一句，A 窗口正在编辑的未命名文档会被当成崩溃残留递给每个新窗口
                    guard recoverableScratch.contains(sid) else { continue }
                    if let data = try? Data(contentsOf: f),
                       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let content = obj["content"] as? String,
                       let fp = obj["fingerprint"] as? [String: Any] {
                        recoverableScratch.remove(sid)
                        scratchHandouts += 1
                        list.append([
                            "id": sid,
                            "content": content,
                            "fp": ["eol": fp["eol"] ?? "\n", "bom": fp["bom"] ?? false]
                        ])
                    }
                }
            }
            // 冒烟用：拖慢恢复的应答，制造「文件先到、崩溃恢复后到」的竞态 ——
            // 正常顺序下 scratchList 几毫秒就回来了，那条路永远测不到
            if let d = ProcessInfo.processInfo.environment["CURSIVE_SMOKE_SCRATCH_DELAY"],
               let ms = Double(d) {
                let payload = list
                DispatchQueue.main.asyncAfter(deadline: .now() + ms / 1000) { self.respond(id, payload) }
            } else {
                respond(id, list)
            }

        case "scratchClear":
            if let sid = args[0] as? String {
                try? FileManager.default.removeItem(at: scratchDir.appendingPathComponent("\(sid).json"))
            }
            respond(id, true)

        case "confirmReload":
            let alert = NSAlert()
            alert.messageText = L("dlg.reload")
            alert.informativeText = LF("dlg.reload.body",
                ["name": args[0] as? String ?? L("doc.untitled")])
            alert.addButton(withTitle: L("dlg.reload.ok"))
            alert.addButton(withTitle: L("dlg.reload.keep"))
            let choice = alert.runModal() == .alertFirstButtonReturn ? "reload" : "keep"
            respond(id, choice)

        case "openTabs":
            if let paths = args[0] as? [String] { updateWatchers(paths) }
            respond(id, NSNull())

        case "watchDirs":
            // 契约 v32：文件树报上来「树里缓存着哪几级目录」，壳照着这张单子挂 kqueue
            if let paths = args[0] as? [String] { updateDirWatchers(paths) }
            respond(id, NSNull())

        case "console":
            FileHandle.standardError.write(((args.map { "\($0)" }.joined(separator: " ")) + "\n").data(using: .utf8)!)

        default:
            reject(id, "未知通道：\(method)")
        }
    }

    // ---- P3-1 文件树读写的公共件 ----

    /// 防穿越：消解 `..`、必须是绝对路径，而且必须落在**当前树根**
    /// （pickFolder 选的文件夹）或当前文档所在目录之下。
    /// 渲染层传来的路径全部来自 readDir，正常不会越界；这是第二道闸。
    private func safeTarget(_ raw: String) -> String? {
        let path = (raw as NSString).standardizingPath
        guard path.hasPrefix("/") else { return nil }
        var roots: [String] = []
        if let treeRoot { roots.append((treeRoot as NSString).standardizingPath) }
        if let lastDocPath {
            roots.append(((lastDocPath as NSString).deletingLastPathComponent as NSString)
                .standardizingPath)
        }
        return roots.contains { path == $0 || path.hasPrefix("\($0)/") } ? path : nil
    }

    /**
     * 0.4.0 F2：按「行号 + 列 + 原文」逐处替换。**有一处对不上就整份放弃**（回 nil）。
     *
     * 搜完之后文件被别处改过时，按行列硬改会改到别的地方去 —— 那是最坏的一种损坏，
     * 因为它看起来成功了。宁可整份跳过、让人重搜一次。
     *
     * 同一行里有好几处时**从右往左改**：先改左边的话，右边那些的列号当场失效。
     * 列按 UTF-16 码元算（`SearchHit` 的口径），所以整行按 `utf16` 拆。
     */
    private func applyReplacements(_ text: String, hits: [[String: Any]],
                                   with replacement: String) -> (text: String, count: Int)? {
        struct Hit { let line: Int; let col: Int; let length: Int; let match: String }
        let parsed = hits.compactMap { h -> Hit? in
            guard let line = h["line"] as? Int, let col = h["col"] as? Int,
                  let length = h["length"] as? Int, let match = h["match"] as? String,
                  length >= 0 else { return nil }
            return Hit(line: line, col: col, length: length, match: match)
        }
        guard parsed.count == hits.count else { return nil }
        var lines = text.components(separatedBy: "\n")
        let repl = Array(replacement.utf16)
        for h in parsed.sorted(by: { $0.line == $1.line ? $0.col > $1.col : $0.line > $1.line }) {
            let idx = h.line - 1   // SearchHit.line 是 1 起
            guard idx >= 0, idx < lines.count else { return nil }
            let u = Array(lines[idx].utf16)
            guard h.col >= 0, h.col + h.length <= u.count else { return nil }
            let found = String(utf16CodeUnits: Array(u[h.col..<(h.col + h.length)]), count: h.length)
            guard found == h.match else { return nil }
            var next = Array(u[0..<h.col])
            next.append(contentsOf: repl)
            next.append(contentsOf: Array(u[(h.col + h.length)...]))
            lines[idx] = String(utf16CodeUnits: next, count: next.count)
        }
        return (lines.joined(separator: "\n"), parsed.count)
    }

    /// 版本历史落一份（契约 v22）。`snapshotSave` 通道与跨文件替换共用这一份实现 ——
    /// 各写一遍的话，迟早有一边忘了去重或忘了清理
    @discardableResult
    func saveSnapshot(path: String, content: String) -> Bool {
        let dir = historyDir(for: path)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let existing = snapshotFiles(dir)
        if let newest = existing.last,
           let old = try? String(contentsOf: newest, encoding: .utf8), old == content {
            return false
        }
        try? content.write(
            to: dir.appendingPathComponent("\(Int(Date().timeIntervalSince1970 * 1000)).md"),
            atomically: true, encoding: .utf8)
        try? path.write(to: dir.appendingPathComponent("path.txt"), atomically: true, encoding: .utf8)
        pruneSnapshots(dir)
        return true
    }

    /// 重名就在扩展名前加 `-2`、`-3`…，绝不覆盖已有文件
    private func uniquePath(_ path: String) -> String {
        let fm = FileManager.default
        guard fm.fileExists(atPath: path) else { return path }
        let ns = path as NSString
        let ext = ns.pathExtension
        let stem = ns.deletingPathExtension
        var n = 2
        while true {
            let next = ext.isEmpty ? "\(stem)-\(n)" : "\(stem)-\(n).\(ext)"
            if !fm.fileExists(atPath: next) { return next }
            n += 1
        }
    }

    /// 原生输入框问一个名字；取消、空白、带路径分隔符都返回 nil
    private func promptName(title: String, initial: String, confirm: String = L("dlg.create"),
                            smokeEnv: String = "CURSIVE_SMOKE_NAME") -> String? {
        var name = initial
        if smokeAuto {
            name = ProcessInfo.processInfo.environment[smokeEnv] ?? initial
        } else {
            let alert = NSAlert()
            alert.messageText = title
            alert.addButton(withTitle: confirm)
            alert.addButton(withTitle: L("dlg.cancel"))
            let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 248, height: 24))
            field.stringValue = initial
            alert.accessoryView = field
            alert.window.initialFirstResponder = field
            guard alert.runModal() == .alertFirstButtonReturn else { return nil }
            name = field.stringValue
        }
        name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        // 名字里出现 / 就等于任意路径写入，直接拒绝（safeTarget 只管父目录）
        guard !name.isEmpty, !name.contains("/"), name != ".", name != ".." else { return nil }
        return name
    }

    private func alertError(_ text: String, _ detail: String) {
        guard !smokeAuto else { return }
        let alert = NSAlert()
        alert.messageText = text
        alert.informativeText = detail
        alert.addButton(withTitle: L("dlg.ok"))
        alert.runModal()
    }

    // ---- 文件读写（types.ts 的 DocPayload 形状）----

    /**
     * 读一份文档的原文。**自己认 BOM**。
     *
     * `String(contentsOfFile:encoding:.utf8)` 会把开头那三个字节当编码标记**吃掉**，
     * 于是 `decodeDoc` 永远看不到 BOM、指纹里 `bom` 恒为 false ——
     * 打开一个带 BOM 的文件再保存，那三个字节就没了。**这是红线一（保存零损耗）
     * 上的一个洞**，而且一直没人发现：`test/textfile.test.ts` 测的是 TS 那份实现，
     * 壳这边的读盘从来没有被 E2E 覆盖过（`bom.md` 不在用例表里，0.4.0 F2 补上了）。
     *
     * **跨文件搜索那一侧仍然读 BOM-less 的文本**（`SearchOperation`）：那边报的是
     * 行列，而替换是在 `decodeDoc` **之后**的文本上按行列定位的 —— 两边都不含 BOM
     * 才对得齐。谁要改其中一边，另一边必须一起改。
     */
    func readRawDoc(_ path: String) throws -> String {
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        let hasBOM = data.starts(with: [0xEF, 0xBB, 0xBF])
        guard let text = String(data: hasBOM ? data.dropFirst(3) : data, encoding: .utf8) else {
            throw NSError(domain: "cursive.io", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "不是 UTF-8 文本"])
        }
        return hasBOM ? "\u{feff}" + text : text
    }

    private func readDoc(_ path: String) throws -> [String: Any] {
        let raw = try readRawDoc(path)
        let (text, fp) = decodeDoc(raw)
        return ["path": path, "content": text, "fingerprint": ["eol": fp.eol, "bom": fp.bom]]
    }

    /// 检查更新要问的仓库。**这一处说了算** —— 问谁、去哪儿看，两处都从它拼
    private static let updateRepo = "lawrence1912/cursive"

    /**
     * 0.3.0 T2 检查更新（契约 v27）。**只在用户点那一下联网**，而且只问一句
     * 「最新那条 release 的 tag 是什么」。不下载、不安装、不碰 /Applications 里的任何东西。
     *
     * 三处有意收窄：
     * ① **响应里只取 `tag_name`** —— 去处是壳自己拼的常量（`releases/latest` 那一页，
     *    GitHub 自己会转到最新那条），于是「网络说去哪儿就去哪儿」这条路根本不存在；
     * ② **不带 UA 之外的任何东西**：无 token、无 cookie、不记住谁点过；
     * ③ **不吃缓存** —— 点「检查更新」要的是此刻的答案，共享缓存会让第二次点击原地复读。
     *
     * 用 `dataTask` 而不是 `await URLSession.data(for:)` 是硬约束：x86_64 那一片是
     * `-runtime-compatibility-version none` 编的，壳里一出现 Swift 并发，
     * `compile.sh` 那道 guard 就当场拦下（见 ROADMAP 的 T1 —— 这是它挡住的第一件真事）。
     */
    private func checkUpdate(_ id: Int) {
        // 裸二进制（开发构建）没有 Info.plist，读不到就当 0.0.0 ——
        // 于是开发机上点一下永远是「有新版本」，那句话本来也没说错
        let current = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
        let page = "https://github.com/\(Self.updateRepo)/releases/latest"
        if smokeAuto {
            let canned = (ProcessInfo.processInfo.environment["CURSIVE_SMOKE_UPDATE"] ?? "")
                .split(separator: ",").map(String.init)
            guard !canned.isEmpty else { respond(id, NSNull()); return }
            let tag = canned[min(smokeUpdateCalls, canned.count - 1)]
            smokeUpdateCalls += 1
            // 两个记号：`fail` = 没问着（断网那一种）；`none` = 问着了但那边一个
            // release 都没有（真实世界里的 404）—— 这两条分支说的话不一样，E2E 都要走到
            if tag == "fail" {
                respond(id, NSNull())
                return
            }
            let latest: Any = tag == "none" ? NSNull() : tag
            respond(id, ["current": current, "latest": latest, "url": page])
            return
        }
        guard let api = URL(string: "https://api.github.com/repos/\(Self.updateRepo)/releases/latest") else {
            respond(id, NSNull())
            return
        }
        var req = URLRequest(url: api)
        req.timeoutInterval = 10
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.httpShouldHandleCookies = false
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        URLSession.shared.dataTask(with: req) { [weak self] data, response, error in
            // 回调在后台线程，而 respond 要走 evaluateJavaScript —— 必须回主线程
            DispatchQueue.main.async {
                guard let self else { return }
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                // 404 = 问着了，只是那边**一个 release 都没有**（打了 tag 不等于发了 release）。
                // 把它和「连不上」说成同一句话就是在冤枉网络，而这两件事该做的下一步也不同
                if code == 404 {
                    self.respond(id, ["current": current, "latest": NSNull(), "url": page])
                    return
                }
                var tag = ""
                if let data,
                   let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                   let t = obj["tag_name"] as? String { tag = t }
                // 断网 / 超时 / 限流 / 响应里没有 tag：对用户是同一件事（没问着），
                // 但排查时想知道是哪一种 —— 所以理由只写进 stderr，不进状态栏
                guard code == 200, !tag.isEmpty, tag.count <= 64 else {
                    let why = error?.localizedDescription ?? "HTTP \(code)"
                    FileHandle.standardError.write("[update] 没问着：\(why)\n".data(using: .utf8)!)
                    self.respond(id, NSNull())
                    return
                }
                self.respond(id, ["current": current, "latest": tag, "url": page])
            }
        }.resume()
    }

    private func respond(_ id: Int, _ value: Any) {
        webView.evaluateJavaScript("window.api._resolve(\(id), \(jsValue(value)))")
    }
    private func reject(_ id: Int, _ message: String) {
        webView.evaluateJavaScript("window.api._reject(\(id), \(jsValue(message)))")
    }

    // ---- 加载完成后：写入自检结果 + 处理 Finder 打开 ----

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        mark("didFinish (页面加载完)")
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.runProbe() }
        // P0-3 验收：+1.5s 模拟一次外部修改（干净标签应静默重载）。
        // **必须锁在自检里**：这一句是往用户的文件末尾真写字节。少了这个 guard，
        // 每一次正常打开文档都会在 1.5 秒后被追加一行 marker —— 编辑器把自己打开的
        // 每一份文件都改了。曾经就是这样（漏了 guard，2026-09-14 修）。
        // SHOT_CLEAN 也要挡掉：那条路要的就是「文档一个字不动」，不然拍进去的图里
        // 文末挂着一行 marker
        guard ProcessInfo.processInfo.environment["CURSIVE_SMOKE"] != nil,
              ProcessInfo.processInfo.environment["CURSIVE_SMOKE_SHOT_CLEAN"] == nil else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self, let p = self.lastDocPath,
                  let h = FileHandle(forWritingAtPath: p) else { return }
            h.seekToEndOfFile()
            h.write("external-append-marker\n".data(using: .utf8)!)
            try? h.close()
        }
    }

    /// didFinish 可能早于渲染层模块执行完（监听器未注册时 emit 会静默丢失），
    /// 轮询 window.__cursive（main.js 末尾暴露的就绪标记）就绪后再发 file:opened。
    /// P4-6① 之后**文件一般走不到这里**（启动那份已经随页面注进去了），剩下两种情况：
    /// 带文件夹开出来的窗口（pendingFolder），以及注入时读盘失败的回退
    private func flushPendingOpen(attempt: Int = 0) {
        guard pendingOpen != nil || pendingFolder != nil, attempt < 100 else { return }
        webView.evaluateJavaScript("typeof window.__cursive === 'object'") { [weak self] ready, _ in
            guard let self else { return }
            guard (ready as? Bool) == true else {
                // 就绪前这段空转直接顶在「双击文件 → 看见字」的关键路径上，
                // 所以头几次隔 16ms 再问（一帧），之后才退回 100ms 的慢轮询
                let delay = attempt < 30 ? 0.016 : 0.1
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                    self.flushPendingOpen(attempt: attempt + 1)
                }
                return
            }
            if let dir = self.pendingFolder {
                self.pendingFolder = nil
                self.openFolder(dir)
            }
            if let p = self.pendingOpen {
                self.pendingOpen = nil
                self.openPath(p)
            }
        }
    }

    private func writeJSON(_ obj: Any, to path: String) {
        if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: path))
        }
    }

    private func runProbe() {
        // 探针/E2E 只在 CURSIVE_SMOKE 下运行；普通启动是正常交互应用，绝不自动退出
        guard isPrimary,
              ProcessInfo.processInfo.environment["CURSIVE_SMOKE"] != nil else { return }

        // CURSIVE_SMOKE_SHOT_CLEAN=1：**只截图，不跑探针**。
        // 探针会改东西 —— 改标题层级、往表格里打字、追加 marker，自动保存还会落盘；
        // treeProbe 更狠，会在**树根目录里真的建文件、改名、移动、删除**。
        // 而 captureShot 特意排在探针之后，那是给「目检 chrome」用的：右键菜单还开着、
        // 表格工具栏还浮着、搜索面板还留着，正好看得见。
        // 要拍一张给人看的图，这些全是噪声，文档还会被改花 —— 所以这条分支直接跳到
        // 截图再退出：文档一个字不动，树根一个文件不碰。
        if ProcessInfo.processInfo.environment["CURSIVE_SMOKE_SHOT_CLEAN"] != nil {
            captureShot { NSApp.terminate(nil) }
            return
        }
        let probe = """
        (() => ({
          title: document.title,
          hasApi: typeof window.api === 'object',
          apiKeys: window.api ? Object.keys(window.api).length : 0,
          cm: !!document.querySelector('.cm-editor'),
          cmState: !!document.querySelector('.cm-content'),
          host: !!document.querySelector('#editor-host'),
          sidebar: !!document.querySelector('#sidebar'),
          status: (document.querySelector('#status-file') || {}).textContent || null,
          sbRows: document.querySelectorAll('.sb-row').length,
          // 契约 v19：侧栏真的挂在这份文档所在的目录上（`.sb-title` 的 title = 树根全路径）
          sbRoot: (document.querySelector('.sb-title') || {}).title || null,
          sbDisplay: getComputedStyle(document.getElementById('sidebar')).display,
          cmTextLen: (document.querySelector('.cm-content')?.textContent || '').length,
          tabs: document.querySelectorAll('.tab-item').length,
          tabList: [...document.querySelectorAll('.tab-item')].map(e => e.title),
          // 0.2.x 顶栏合并：正文的标签坐到了原生拖拽条底下。把第一个标签的中心报上去，
          // 原生侧照着做一次真 hitTest（下面的 tabNativeHole）—— 挖洞区没覆盖到它的话，
          // 点击 / 拖拽重排 / 右键菜单全会被窗口拖拽吃掉，而页面这一侧完全看不出来
          tabRect: (() => {
            const r = document.querySelector('.tab-item')?.getBoundingClientRect()
            return r ? { x: r.left + r.width / 2, top: r.top } : null
          })(),
          outlineRows: document.querySelectorAll('.ol-row').length
        }))()
        """
        webView.evaluateJavaScript(probe) { [weak self] result, _ in
            guard let self, var obj = result as? [String: Any] else { return }
            // 原生侧自检：拖拽条就位、命中测试命中它（performDrag 的充分前置）。
            // **取点是条子上第一处空当**，不再是条子正中 —— 顶栏合并之后正中多半是一个
            // 标签，那儿本来就该漏给 webview（见 `firstDraggableX`）
            if let container = self.webView.superview,
               let strip = container.subviews.compactMap({ $0 as? DragStripView }).first {
                // 0.4.1：缩放只缩正文，壳不再碰 pageZoom。这条断言守的是「没人偷偷把它
                // 改回去」—— 页面那侧看不见 pageZoom，只有原生这儿报得出来
                obj["pageZoom"] = Double(self.webView.pageZoom)
                let trafficEnd = self.window.standardWindowButton(.zoomButton)?.frame.maxX ?? 69
                let dragX = strip.firstDraggableX(after: trafficEnd + 4)
                obj["dragGapX"] = dragX.map(Double.init) ?? -1
                let p = strip.convert(CGPoint(x: dragX ?? strip.bounds.midX, y: strip.bounds.midY),
                                      to: container.superview)
                obj["dragStripHit"] = (dragX != nil && container.superview?.hitTest(p) === strip)
                obj["stripFrame"] = "\(strip.frame)"
                // 红绿灯占到哪儿：base.css `#drag-strip` 的左内边距（78）必须躲开它，
                // 不然按钮和红绿灯叠在一起 —— 用真值把关，别拍脑袋
                if let zoomBtn = self.window.standardWindowButton(.zoomButton) {
                    obj["trafficEnd"] = Double(zoomBtn.frame.maxX)
                    // 红绿灯圆心离窗口顶多远（窗口坐标系原点在左下，要翻过来）——
                    // base.css 用它把 .tb-btn 钉到同一条水平线上
                    let inWin = zoomBtn.convert(zoomBtn.bounds, to: nil)
                    obj["trafficMidFromTop"] = Double(self.window.frame.height - inWin.midY)
                    obj["trafficSize"] = "\(zoomBtn.frame.size)"
                }
                // 挖洞：这几个点必须漏给 webview，别处照旧归拖拽。
                // **坐标是 CSS px，得乘 pageZoom 才是点**（0.4.1 起壳不动它，恒为 1；
                // 换算留着的理由同 `DragStripView.host`）
                let z = self.webView.pageZoom
                var passes: [(String, CGFloat)] = [
                    ("tbHoleLeft", 91 * z),                        // 文件树开关的圆心
                    ("tbHoleRight", strip.bounds.maxX - 23 * z)    // 大纲开关的圆心
                ]
                // 契约 v26：正文的标签顶到最上面之后也坐在条子底下，挖洞区必须把它放行
                if let r = obj["tabRect"] as? [String: Any], let cx = r["x"] as? Double {
                    passes.append(("tabNativeHole", CGFloat(cx) * z))
                    // 标签真的落在条子那一带，上面那条 hitTest 才算测到了东西
                    obj["tabUnderStrip"] = CGFloat((r["top"] as? Double) ?? 999) * z < strip.bounds.height
                }
                for (key, x) in passes {
                    let q = strip.convert(CGPoint(x: x, y: strip.bounds.midY), to: container.superview)
                    obj[key] = (container.superview?.hitTest(q) !== strip)
                }
                // 双击标题栏 → 缩放：真跑一次动作，看窗口是否变大，跑完还原原 frame。
                // 必须先缩到一个确定的小 frame —— 窗口若已在 standard state（上次
                // 运行把 zoom 后的 frame 存进了 setFrameAutosaveName），zoom 只会尝试
                // 回到 user state，而新窗口没有 user state，frame 纹丝不动 → 假阴性。
                // 系统偏好设成 Minimize/None 时这条不成立，只记录动作名，不判定
                obj["dblClickAction"] = strip.doubleClickAction
                if strip.doubleClickAction == "Maximize", let w = self.window {
                    let saved = w.frame
                    let small = NSRect(x: saved.minX, y: saved.minY, width: 700, height: 500)
                    w.setFrame(small, display: false)
                    strip.performDoubleClickAction()
                    obj["dblClickZoomed"] = (w.frame.width > small.width + 1
                                             || w.frame.height > small.height + 1)
                    w.setFrame(saved, display: true)
                }
            } else {
                obj["dragStripHit"] = false
            }
            // 0.4.0 还的第四条账（真打印机）：菜单是原生的，网页那侧看不见 ——
            // 把「文件」菜单里那几条的键位报上去，让 release.sh 对账：
            // ⌘P 必须是「打印…」，导出 PDF 让到 ⇧⌘P
            if let file = NSApp.mainMenu?.items.first(where: { $0.submenu?.title == L("menu.file") })?.submenu {
                obj["fileMenu"] = file.items.filter { !$0.isSeparatorItem }.map { mi -> [String: Any] in
                    ["title": mi.title, "key": mi.keyEquivalent,
                     "shift": mi.keyEquivalentModifierMask.contains(.shift)]
                }
            }
            // 0.3.0 T5：位置记忆按工作区分的键（release.sh 拿工作区根的 SHA-256 前 16 位对账）。
            // 报的是**算出来的键**，不是窗口上挂着的名字 —— 自检下压根不挂（见 applyFrameAutosave），
            // 而要守的正是「键是按工作区算的」这件事
            obj["frameAutosaveKey"] = self.frameAutosaveKey
            obj["frameAutosaveLive"] = self.window.frameAutosaveName
            self.writeJSON(obj, to: "/tmp/cursive-shell-check.json")
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.runE2E() }
        }
    }

    /// E2E：read → save 逐字节往返（验证 BOM/EOL 指纹）+ live-preview 图片加载检测。
    /// 仅 CURSIVE_SMOKE 模式；完成后自动退出（自动化验收用）
    private func runE2E() {
        let source = lastDocPath ?? "/tmp/cursive-e2e/img.md"
        let outPath = "/tmp/cursive-e2e/roundtrip.out"
        let docDir = (source as NSString).deletingLastPathComponent
        // P2-5：往剪贴板放一张图，供「粘贴落盘」E2E 调用 pasteImage
        let seedImg = "\(docDir)/assets/中文 图.png"
        if let img = try? Data(contentsOf: URL(fileURLWithPath: seedImg)) {
            let pb = NSPasteboard.general
            pb.clearContents()
            pb.setData(img, forType: .png)
            // P2-5 拖拽：只对 img.md 用例模拟（其它用例插了图片会触发通用的 img.loaded 断言）
            if (source as NSString).lastPathComponent == "img.md" {
                let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
                    .appendingPathComponent("cursive-drop-test.png")
                try? img.write(to: tmp)
                _ = handleDroppedFiles([tmp])
            }
        }
        let body = """
        try {
        // 写作模式是**持久化**的（localStorage `cursive.writing`），上一轮或手工走查留下
        // 什么都可能。专注模式一开着，代码块的高亮会整块压成同一个灰 —— codeHl 那条
        // 断言就莫名其妙地挂了（真出现过）。所以在**量任何颜色之前**先摆成「都关着」，
        // 和开头清 scratch 目录是同一个道理：用例不该依赖上一轮留下的状态
        {
          const ed = window.__cursive.view.dom
          for (const [act, cls] of [['view:toggle-focus', 'cursive-focus'],
                                    ['view:toggle-typewriter', 'cursive-typewriter']]) {
            if (!ed.classList.contains(cls)) continue
            window.__shellEmit('menu', act)
            await new Promise(r => setTimeout(r, 120))
          }
        }
        const doc = await window.api.read(path)
        // P0-3 外部变更：**等它，而不是在某个固定时刻采一次样**。
        // 那一行 marker 是壳在 +1.5s 写进文件的，探针在 +3s 起跑 —— 中间这 1.5 秒够不够，
        // 取决于机器此刻忙不忙、mermaid 那 2 MB 的 chunk 在不在系统缓存里。
        // 固定采样点因此是一场赌局：单跑十次全过，整条流水线连着跑就偶尔 FAIL 一次，
        // 而 FAIL 的是「重载没发生」这种看起来很严重、其实只是晚了 200ms 的事。
        // 轮询到 3 秒，`reloadWaited` 一并报回去 —— 真退化成「压根不重载」时它会顶到上限
        let reloaded = window.__cursive.view.state.doc.toString().includes('external-append-marker')
        let reloadWaited = 0
        while (!reloaded && reloadWaited < 3000) {
          await new Promise(r => setTimeout(r, 100)); reloadWaited += 100
          reloaded = window.__cursive.view.state.doc.toString().includes('external-append-marker')
        }
        // P0-2 验收：编辑器追加标记 → 2s 防抖自动保存应落盘。
        // **等它，别在固定时刻采一次样**（同上面那条外部变更）：原先是等 2600ms 读一次，
        // 对 2000ms 的防抖只剩 600ms 余量 —— 单跑十次全过，整条流水线连着跑就偶尔 FAIL。
        // 先睡过防抖窗口，再每 200ms 问一次，`autosaveWaited` 一并报回去
        const v = window.__cursive.view
        v.dispatch({ changes: { from: v.state.doc.length, insert: '\\nautosave-check-marker' } })
        await new Promise(r => setTimeout(r, 2100))
        let after = await window.api.read(path)
        let autosaveWaited = 0
        while (!after.content.includes('autosave-check-marker') && autosaveWaited < 5000) {
          await new Promise(r => setTimeout(r, 200)); autosaveWaited += 200
          after = await window.api.read(path)
        }
        const img = document.querySelector('.cm-lp-image img')
        // 侧边栏开关回归验证：发两次菜单事件，查 computed display
        window.__shellEmit('menu', 'view:toggle-sidebar')
        await new Promise(r => setTimeout(r, 80))
        const sb = document.getElementById('sidebar')
        const sbAfterToggle = getComputedStyle(sb).display
        const sbClassAfter = sb.className
        // 文件树藏起来后，第一个标签的中心必须点得到标签本身 ——
        // 「唤回浮标」当年就钉在 #main 左上角，正好压住第一个标签。浮标已删，这条防回归
        const r0 = document.querySelector('.tab-item').getBoundingClientRect()
        const hitEl = document.elementFromPoint(r0.left + r0.width / 2, r0.top + r0.height / 2)
        const tabHit = !!(hitEl && hitEl.closest('.tab-item'))
        // 侧栏藏起来时，红绿灯右边那一截空当必须还在（base.css `#topbar.is-inset-left`
        // 让开的 140 里，104 之后那 30px）。挖洞是按真实 rect 报的 —— 这一截上没有任何
        // 元素 = 它仍归原生拖拽条。**两侧面板都藏起来 + 标签排满时，这是唯一还能拖窗口
        // 的地方**，没有它整条顶边会被挖穿，窗口从此拖不动
        const gutterEl = document.elementFromPoint(122, 16)
        const tbGutter = !!(gutterEl && gutterEl.id === 'topbar')
        window.__shellEmit('menu', 'view:toggle-sidebar')
        await new Promise(r => setTimeout(r, 80))
        const sbRestored = getComputedStyle(sb).display
        // 壳挖的洞（左 91、右 maxX-23）落在页面里必须正好是这两个按钮 ——
        // 合起来才是「真鼠标点得到」的闭环：原生放行 + 页面命中
        const tbLeftAt = document.elementFromPoint(91, 16)
        const tbRightAt = document.elementFromPoint(window.innerWidth - 23, 16)
        // 按钮圆心的 y，拿去和原生量到的红绿灯圆心（trafficMidFromTop）比，必须同一条线
        const tbBox = document.getElementById('tb-sidebar').getBoundingClientRect()
        const tbMidY = tbBox.top + tbBox.height / 2
        const tbHitPage = !!(tbLeftAt && tbLeftAt.closest('#tb-sidebar')
                             && tbRightAt && tbRightAt.closest('#tb-outline'))
        // 标题栏按钮（面板开关搬到拖拽条两端之后的主路径）：点一下藏、再点一下回来
        const tbBtn = document.getElementById('tb-sidebar')
        tbBtn.click()
        await new Promise(r => setTimeout(r, 60))
        const tbHidden = getComputedStyle(sb).display
        const tbOn = tbBtn.classList.contains('is-on')
        tbBtn.click()
        await new Promise(r => setTimeout(r, 60))
        const tbBack = getComputedStyle(sb).display
        const counts = {}
        for (const cls of ['cm-lp-image', 'cm-lp-checkbox', 'cm-lp-bullet', 'cm-lp-rule', 'cm-lp-tableview', 'cm-lp-mathview', 'cm-lp-math-inline', 'cm-lp-mermaid', 'cm-lp-codebar', 'cm-lp-toc', 'cm-lp-footnote-ref', 'cm-lp-footnote-def', 'cm-lp-emoji', 'cm-lp-highlight', 'cm-lp-sup', 'cm-lp-sub', 'cm-lp-callout', 'cm-lp-callout-note', 'cm-lp-callout-danger', 'cm-lp-callout-mark', 'cm-lp-callout-more',
          // 0.4.0 还的第一条账：脚注定义区里的行内语法
          'cm-lp-seg-strong', 'cm-lp-inline-code',
          // 0.4.1 front matter 属性表：键名一列、数组里每项一颗标签、两条 `---` 收成边
          'cm-lp-fm-key', 'cm-lp-fm-tag', 'cm-lp-fm-edge'])
          counts[cls] = document.querySelectorAll('.' + cls).length
        // P1-1：KaTeX 字体必须真的加载了（CSP 拦掉的话公式会用系统字体凑合，
        // 肉眼不一定看得出）。fonts.ready 之后任一 KaTeX_* 字体到位即算过
        await document.fonts.ready
        const math = {
          inline: counts['cm-lp-math-inline'],
          block: counts['cm-lp-mathview'],
          font: [...document.fonts].some((f) => /^['"]?KaTeX_/.test(f.family) && f.status === 'loaded')
        }
        // P1-2：mermaid 异步渲染（动态 import + render），多等一会儿
        await new Promise((r) => setTimeout(r, 700))
        // **先把文末滚进视口再数**（0.3.0 T5 逼出来的）：块级装饰只给视口里的块建
        // （0.2.x 增量化的设计），而第一张图有多高要看窗口有多宽 —— 窗口一大，
        // 第二个块就被挤到视口外，数出来是 1。这条断言要的是「两个块都渲染了」，
        // 不是「它们恰好同屏」。滚完等一轮渲染，数完滚回去（后面还有量位置的探针）
        {
          const sc = window.__cursive.view.scrollDOM
          sc.scrollTop = sc.scrollHeight
          await new Promise((r) => setTimeout(r, 700))
        }
        const mermaidEls = [...document.querySelectorAll('.cm-lp-mermaid')]
        const mermaid = {
          count: mermaidEls.length,
          svg: mermaidEls.filter((el) => el.querySelector('svg')).length,
          error: mermaidEls.filter((el) => el.classList.contains('is-error')).length
        }
        {
          const sc = window.__cursive.view.scrollDOM
          sc.scrollTop = 0
          await new Promise((r) => setTimeout(r, 200))
        }
        // P1-4 代码块嵌套语法高亮：解析侧（language-data 动态 import 语言包）与
        // 上色侧（theme.ts 的 markdownHighlight）都通了才有颜色，缺任一边都不报错、
        // 只是「看起来很素」—— 单测查不到的第三种死法是 --hl-* 变量没解析到
        // （var() 落空 → 所有 span 都继承同一个色），所以这里数的是**计算后的颜色**。
        // 放在 mermaid 那 700ms 之后：语言包是动态 import 的，得等它回来重解析一遍
        const hlSpans = [...document.querySelectorAll('.cm-lp-code span[class]')]
          .filter((el) => !el.closest('.cm-lp-codebar'))
        const codeHl = {
          spans: hlSpans.length,
          colors: new Set(hlSpans.map((el) => getComputedStyle(el).color)).size
        }
        // 围栏藏起来了：开围栏那行整条换成语言条（写的是 TypeScript 这种给人看的名字，
        // 不是 ```ts），闭围栏那行没有文字、塌成卡片的下边距。
        // **先把代码块滚进视口**：自检窗口只有 500 高，而实时预览只铺可视区间 ——
        // 闭围栏那一行本来落在视口外，压根没有对应的 DOM（首版探针就栽在这儿）
        let codeFence = null
        {
          const v = window.__cursive.view
          const text = v.state.doc.toString()
          const openAt = text.indexOf('```')
          const closeAt = openAt > -1 ? text.indexOf('```', openAt + 3) : -1
          if (closeAt > -1) {
            // 把光标停在代码块**下面**一点：停在围栏行上就回显 ``` 源码了什么都测不到，
            // 停在代码体里又不够 —— 视口本来就到代码体为止，不滚动闭围栏还是没 DOM
            v.dispatch({
              selection: { anchor: Math.min(v.state.doc.length, closeAt + 120) },
              scrollIntoView: true
            })
            await new Promise(r => setTimeout(r, 120))
          }
          const codeOpen = document.querySelector('.cm-lp-code-open')
          const codeClose = document.querySelector('.cm-lp-code-close')
          codeFence = {
            off: !!codeOpen && codeOpen.classList.contains('cm-lp-fence-off'),
            lang: ((document.querySelector('.cm-lp-codebar-lang span') || {}).textContent || '').trim(),
            ticks: codeOpen ? (codeOpen.textContent || '').indexOf('`') : 0,
            closeOff: !!codeClose && codeClose.classList.contains('cm-lp-fence-off'),
            closeText: codeClose ? (codeClose.textContent || '').trim() : 'x',
            closeH: codeClose ? Math.round(codeClose.getBoundingClientRect().height) : -1,
            copy: !!document.querySelector('.cm-lp-codebar-copy')
          }
          // 语言选择器：点条子上的语言名 → 筛选 → 选中，围栏行里只该换掉语言那个词。
          // 选走再选回来，文档回到原样（末尾还有字节级往返断言盯着这份文档）
          const pickLang = async (q) => {
            const btn = document.querySelector('.cm-lp-codebar-lang')
            if (!btn) return null
            btn.click()
            await new Promise(r => setTimeout(r, 90))
            const pick = document.querySelector('.lang-pick')
            if (!pick) return null
            const filter = pick.querySelector('.lang-filter')
            filter.value = q
            filter.dispatchEvent(new Event('input', { bubbles: true }))
            await new Promise(r => setTimeout(r, 60))
            const first = pick.querySelector('.lang-item')
            const name = first ? ((first.querySelector('.lang-name') || {}).textContent || '').trim() : null
            codeFence.picker = !!first
            if (first) first.click()
            await new Promise(r => setTimeout(r, 100))
            return name
          }
          if (openAt > -1 && document.querySelector('.cm-lp-codebar-lang')) {
            codeFence.before = v.state.doc.lineAt(openAt).text
            codeFence.pickName = await pickLang('rust')
            codeFence.after = v.state.doc.lineAt(openAt).text
            codeFence.afterLabel = ((document.querySelector('.cm-lp-codebar-lang span') || {}).textContent || '').trim()
            await pickLang('typescript')
            codeFence.restored = v.state.doc.lineAt(openAt).text
          }
        }
        // P2-6 表格就地编辑回归：点进单元格之后表格**不能**回落源码（历史行为正相反），
        // 改一格只替换那一格的源码片段 —— 同一行其余列的手工对齐必须一字不动
        let tableEdit = null
        const td = document.querySelector('.cm-lp-tableview td')
        if (td) {
          // 合成 mousedown 不会触发原生聚焦，直接 focus() 走 focusin 那条真路径
          td.focus()
          await new Promise(done => setTimeout(done, 80))
          const focused = document.activeElement
          const enter = {
            rendered: !!document.querySelector('.cm-lp-tableview'),
            cell: !!(focused && focused.tagName === 'TD' && focused.isContentEditable)
          }
          // 浏览器改 DOM → input → widget 写回文档（用户打字走的就是这条）
          td.textContent = 'a2'
          td.dispatchEvent(new InputEvent('input', { bubbles: true }))
          await new Promise(done => setTimeout(done, 80))
          const st = window.__cursive.view.state
          const line = st.doc.lineAt(st.selection.main.head).text
          // 底部浮动工具栏：只在就地编辑时露面，按钮作用于当前那一格
          const bar = document.querySelector('.cm-lp-tbl-bar')
          const tool = (name) => {
            const b = bar && bar.querySelector('[data-tool="' + name + '"]')
            if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
            return new Promise(done => setTimeout(done, 60))
          }
          const rowsBefore = window.__cursive.view.state.doc.lines
          await tool('row-down')
          const addedRow = window.__cursive.view.state.doc.lines - rowsBefore
          await tool('al-center')
          const delim = window.__cursive.view.state.doc.line(4).text
          // 「整理对齐」：整块重排，之后每一行的显示宽度应当一致（壳外用 Python 核）
          await tool('tidy')
          const doc2 = window.__cursive.view.state.doc
          const tidyLines = []
          for (let n = 3; n <= doc2.lines && doc2.line(n).text.indexOf('|') === 0; n++) {
            tidyLines.push(doc2.line(n).text)
          }
          // 0.4.0 修：**⌘Z 的去路**。撤销原先挂 AppKit 的 `undo:`，撤的是 WebKit 自己
          // 那套 DOM 编辑撤销栈；表格一改结构整张表的格子都会重建，栈顶那条记录当场
          // 变成死记录 —— 不派 `beforeinput` 也不做事，而 `canUndo` 还是真，菜单项
          // 照亮照吃 ⌘Z。于是「在格子里打过字之后回车加一行，⌘Z 一点反应都没有」。
          // 这一段复刻的就是那个现场：**先打一个字**（往 WebKit 栈里压一条真记录，
          // 这是「偶发」的另一半），再回车加行，然后走菜单那条真路径撤销/重做。
          let undoRound = null
          {
            // **末行**那一格：回车在中间行只是走到下一行，只有末行才新建
            const bodyRows = document.querySelectorAll('.cm-lp-tableview tbody tr')
            const c0 = bodyRows.length ? bodyRows[bodyRows.length - 1].cells[0] : null
            if (c0) {
              c0.focus()
              await new Promise(r => setTimeout(r, 80))
              const clean = window.__cursive.view.state.doc.toString()
              document.execCommand('insertText', false, 'u')
              await new Promise(r => setTimeout(r, 140))
              const typed = window.__cursive.view.state.doc.toString()
              document.activeElement.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
              await new Promise(r => setTimeout(r, 170))
              const added = window.__cursive.view.state.doc.toString()
              // WebKit 那边照旧说「可以撤销」—— 骗过菜单项的正是这一下
              const webkitCanUndo = document.queryCommandEnabled('undo')
              const fire = async (a) => {
                window.__shellEmit('menu', a)
                await new Promise(r => setTimeout(r, 170))
                return window.__cursive.view.state.doc.toString()
              }
              const undone = await fire('edit:undo')
              const redone = await fire('edit:redo')
              await fire('edit:undo')
              undoRound = {
                typedIn: typed !== clean,
                addedRow: added !== typed,
                webkitCanUndo,
                // 撤销要**逐字节**回到加行之前，而且只撤那一行（打的字还在）
                undone: undone === typed,
                redone: redone === added,
                // 撤销不许把表格掀回管道符源码（事务不带 setTableEdit，靠 isHistory 那条分支）
                stillRendered: !!document.querySelector('.cm-lp-tableview')
              }
            }
          }
          tableEdit = {
            rendered: enter.rendered && !!document.querySelector('.cm-lp-tableview'),
            focused: enter.cell,
            line,
            barOn: !!bar && bar.hidden === false,
            addedRow,
            delim,
            tidyLines,
            undoRound,
            // 格内行内语法：`**粗体**` 在渲染态里就是 <strong>，不再是一串星号
            strong: document.querySelectorAll('.cm-lp-tableview td strong').length
          }
        }
        // P2-1 格式化命令：菜单事件 → 渲染层 fmt.ts 的端到端回归。
        // 在文末插一行受控文本，选中 alpha，发两次 fmt:bold，验证幂等
        let formatProbe = null
        {
          const v = window.__cursive.view
          v.dispatch({ changes: { from: v.state.doc.length, insert: '\\n\\nfmtprobe alpha beta' } })
          const line = v.state.doc.line(v.state.doc.lines)
          const start = line.text.indexOf('alpha')
          v.dispatch({ selection: { anchor: line.from + start, head: line.from + start + 5 } })
          window.__shellEmit('menu', 'fmt:bold')
          await new Promise(r => setTimeout(r, 60))
          const once = v.state.doc.line(v.state.doc.lines).text
          window.__shellEmit('menu', 'fmt:bold')
          await new Promise(r => setTimeout(r, 60))
          const twice = v.state.doc.line(v.state.doc.lines).text
          formatProbe = {
            once,
            bolded: once.includes('**alpha**'),
            toggledBack: !twice.includes('**') && twice.includes('alpha')
          }
        }
        // P2-8 底部悬浮格式栏：点按钮 = 走同一条 fmt 命令表，高亮跟着光标走
        let barProbe = null
        {
          const v = window.__cursive.view
          const bar = document.getElementById('format-bar')
          const hit = (act) => {
            const b = bar && bar.querySelector('[data-action="' + act + '"]')
            if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
            return new Promise(r => setTimeout(r, 60))
          }
          const lit = (act) => !!(bar && bar.querySelector('[data-action="' + act + '"].is-on'))
          const last = v.state.doc.line(v.state.doc.lines)
          const at = last.text.indexOf('alpha')
          v.dispatch({ selection: { anchor: last.from + at, head: last.from + at + 5 } })
          await new Promise(r => setTimeout(r, 60))
          await hit('fmt:bold')
          const bolded = v.state.doc.line(v.state.doc.lines).text.includes('**alpha**')
          const onAfterBold = lit('fmt:bold')
          await hit('fmt:bold')
          // 块类型下拉：光标落到一个二级标题上，条子该显示「标题 2」；再从下拉里升到三级
          let headNo = 0
          for (let n = 1; n <= v.state.doc.lines; n++) {
            if (v.state.doc.line(n).text.indexOf('## ') === 0) { headNo = n; break }
          }
          let pickName = ''
          let menuOpened = false
          let promoted = ''
          if (headNo) {
            v.dispatch({ selection: { anchor: v.state.doc.line(headNo).from + 4 } })
            await new Promise(r => setTimeout(r, 60))
            const nameEl = bar && bar.querySelector('.fb-pick-name')
            pickName = nameEl ? nameEl.textContent : ''
            const pick = bar && bar.querySelector('.fb-pick')
            if (pick) pick.dispatchEvent(new MouseEvent('click', { bubbles: true }))
            await new Promise(r => setTimeout(r, 60))
            const menu = bar && bar.querySelector('.fb-menu')
            menuOpened = !!menu && menu.hidden === false
            await hit('fmt:h3')
            promoted = v.state.doc.line(headNo).text
          }
          // P2-9 命令表补齐：新增的行内 4 键与「插入」下拉走的是同一条按钮→MenuAction 的路
          const btnCount = bar ? bar.querySelectorAll('.fb-bar .fb-btn').length : 0
          const lastLine = () => v.state.doc.line(v.state.doc.lines)
          let highlighted = ''
          let hlLit = false
          let hlRestored = false
          {
            const ln = lastLine()
            const at2 = ln.text.indexOf('alpha')
            if (at2 >= 0) {
              v.dispatch({ selection: { anchor: ln.from + at2, head: ln.from + at2 + 5 } })
              await new Promise(r => setTimeout(r, 60))
              await hit('fmt:highlight')
              highlighted = lastLine().text
              hlLit = lit('fmt:highlight')
              await hit('fmt:highlight')
              hlRestored = lastLine().text.indexOf('==') < 0
            }
          }
          // 两个下拉互斥：块类型开着时点「插入」，前者必须收起来
          const insBtn = bar && bar.querySelector('.fb-ins')
          const pickBtn = bar && bar.querySelector('.fb-pick:not(.fb-ins)')
          const pickMenu = bar && bar.querySelector('.fb-menu-pick')
          const insMenu = bar && bar.querySelector('.fb-menu-insert')
          const clickEl = (el) => {
            if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
            return new Promise(r => setTimeout(r, 60))
          }
          await clickEl(pickBtn)
          await clickEl(insBtn)
          const insOpened = !!insMenu && insMenu.hidden === false
          const pickClosed = !!pickMenu && pickMenu.hidden === true
          const insItems = insMenu ? insMenu.querySelectorAll('[data-action]').length : 0
          // 插入表格：按钮 → fmt 引擎 → setTableEdit → widget，整条路一次走完。
          // 光标此刻在末行，骨架落在文档尾 —— 量完按区间删回去，别把后面的探针搅乱
          const tablesBefore = document.querySelectorAll('.cm-content table').length
          v.dispatch({ selection: { anchor: lastLine().to } })
          await new Promise(r => setTimeout(r, 60))
          const lenBefore = v.state.doc.length
          await hit('fmt:table')
          await new Promise(r => setTimeout(r, 120))
          const tableInserted = document.querySelectorAll('.cm-content table').length > tablesBefore
          const tableCellFocused = !!(document.activeElement
            && document.activeElement.closest
            && document.activeElement.closest('td'))
          if (v.state.doc.length > lenBefore) {
            v.dispatch({ changes: { from: lenBefore, to: v.state.doc.length } })
          }
          v.focus()
          await new Promise(r => setTimeout(r, 60))
          barProbe = {
            present: !!bar,
            visible: !!bar && bar.classList.contains('is-hidden') === false,
            bolded,
            onAfterBold,
            restored: v.state.doc.line(v.state.doc.lines).text.indexOf('**') < 0,
            pickName,
            menuOpened,
            promoted,
            btnCount,
            highlighted,
            hlLit,
            hlRestored,
            insOpened,
            pickClosed,
            insItems,
            tableInserted,
            tableCellFocused
          }
        }
        // 查找面板重做：右上角浮层（不再贴底通栏）+ 面板内计数 + ⌥⌘R 摊开替换
        let searchProbe = null
        {
          window.__shellEmit('menu', 'edit:find')
          await new Promise(r => setTimeout(r, 80))
          const panel = document.querySelector('.cs-panel')
          const nextBtn = panel ? panel.querySelector('button[name="next"]') : null
          const input = panel ? panel.querySelector('input[name="search"]') : null
          let matchText = ''
          let panelCount = ''
          if (input) {
            input.value = 'alpha'
            // 自家这版面板认 input 事件（默认那版只认 change / keyup，
            // 而 input 才是输入法安全的那条路），这一发就是在测「往查找框里打字」
            input.dispatchEvent(new Event('input', { bubbles: true }))
            await new Promise(r => setTimeout(r, 120))
            matchText = (document.getElementById('status-match') || {}).textContent || ''
            panelCount = (panel.querySelector('.cs-count') || {}).textContent || ''
          }
          // 替换那一行平时收着，⌥⌘R（edit:replace）把它摊开
          window.__shellEmit('menu', 'edit:replace')
          await new Promise(r => setTimeout(r, 80))
          const replaceRow = panel ? panel.querySelector('.cs-replace') : null
          const replaceShownNow = replaceRow ? replaceRow.hidden === false : null
          const fb = document.getElementById('format-bar')
          const ed = document.querySelector('.cm-editor')
          const pr = panel ? panel.getBoundingClientRect() : null
          const er = ed ? ed.getBoundingClientRect() : null
          // 收起替换那行：`[hidden]` 压不过作者写的 display:flex，少写一条 CSS 就永远收不起来
          const foldBtn = panel ? panel.querySelector('.cs-fold') : null
          if (foldBtn) { foldBtn.click(); await new Promise(r => setTimeout(r, 60)) }
          const replaceFolded = replaceRow ? getComputedStyle(replaceRow).display === 'none' : null
          if (foldBtn) { foldBtn.click(); await new Promise(r => setTimeout(r, 60)) }
          // 关闭键点得着（浮层压在编辑区上，hitTest 走的是另一条路）
          const closeBtn = panel ? panel.querySelector('button[name="close"]') : null
          if (closeBtn) { closeBtn.click(); await new Promise(r => setTimeout(r, 60)) }
          const closed = !document.querySelector('.cs-panel')
          // 再开回来：后面的写作模式探针正好要「面板开着、焦点在查找框里」这个状态
          window.__shellEmit('menu', 'edit:find')
          await new Promise(r => setTimeout(r, 80))
          searchProbe = {
            open: !!panel,
            nextLabel: nextBtn ? nextBtn.getAttribute('aria-label') : null,
            matchText,
            panelCount,
            replaceShown: replaceShownNow,
            replaceFolded,
            // 浮在编辑区右上角：贴着上沿与右沿
            floatTop: pr && er ? Math.round(pr.top - er.top) : -1,
            floatRight: pr && er ? Math.round(er.right - pr.right) : -1,
            // 面板不再占版面，格式栏也就不用再抬高让位（老版本这里是个非空的 px 值）
            closed,
            barBottom: fb ? fb.style.bottom : ''
          }
        }
        // 截图（captureShot 在探针之后跑）里要看得见表格工具栏 —— 它只在就地编辑时露面，
        // 而 searchProbe 已经把选区带走了。重新点回第一格，供目检 chrome
        // 顺带验一次悬停 +/− 手柄：鼠标扫到哪一格，那一列上边框/那一行左边框各浮一颗药丸
        const shotCell = document.querySelector('.cm-lp-tableview td')
        let handles = null
        if (shotCell) {
          shotCell.focus()
          shotCell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
          await new Promise(r => setTimeout(r, 80))
          const layer = document.querySelector('.cm-lp-tbl-handles')
          handles = {
            on: !!layer && layer.hidden === false,
            pills: layer ? layer.querySelectorAll('.cm-lp-tbl-handle').length : 0
          }
        }
        // P2-5：拖拽插入的链接应已在文里
        const dropProbe = window.__cursive.view.state.doc.toString().includes('](assets/cursive-drop-test')
        const pasteRes = await window.api.pasteImage(docDir)
        const pasteProbe = pasteRes ? pasteRes.relPath : null
        // 「保存零损耗」的取样必须放在**最后**：探针后面还会改文档（格式化 / 表格工具栏 /
        // 格式栏），而自动保存 2s 后会把源文件也改一遍 —— 中途取样就和源文件对不上了。
        // 这条以前靠「整个探针跑得比 2s 快」侥幸成立，加一个探针就炸
        await new Promise(r => setTimeout(r, 2200))
        const sampled = window.__cursive.view.state.doc.toString()
        await window.api.save(outPath, sampled, doc.fingerprint)
        // 0.4.1 折叠一条列表。摆在 kitchen-sink.md 上 —— 它有现成的
        // 「- 无序项二 / 　- 嵌套项」这一对，而 callout.md（foldProbe 那条）一条列表都没有。
        //
        // **必须排在这儿**：再往后 treeProbe 会把新建的文件开成活动标签、跨文件搜索
        // 那条又会跳到 table.md，`window.__cursive.view` 里就不是这份文档了
        //（第一版排在后面，indexOf('嵌套项') 当场回 -1）。
        //
        // **要害是「手边最近的那一层说了算」**：光标放进嵌套项里按菜单，折起来的
        // 必须是那条父项，不是它所在的整节。只断言「少了几行」的话，折错一层也是绿的
        let listFoldProbe = null
        if (path.indexOf('kitchen-sink.md') >= 0) {
          try {
            const wait = (ms) => new Promise(r => setTimeout(r, ms))
            const v = window.__cursive.view
            // **看「那一行还在不在屏幕上」，不看行数**：这份文档里有表格、公式、
            // mermaid，光标一进来它们就回显源码，`.cm-line` 的个数当场多出好几条 ——
            // 第一版拿行数做判据，折叠明明成了，before(24) 却小于 folded(25)
            const shown = () => [...document.querySelectorAll('.cm-line')]
              .some((el) => (el.textContent || '').indexOf('嵌套项') >= 0)
            const docBefore = v.state.doc.toString()
            const at = docBefore.indexOf('嵌套项')
            // **scrollIntoView 是必需的**：跑到这儿时前面的探针早把视口滚到别处了
            // （实测 scrollTop 1907、viewport [585,1006]，而这张列表在 140 上下）。
            // CM 只渲染视口，光标那一行例外 —— 不滚过来的话，before 靠「光标恰好在
            // 嵌套项上」侥幸为真，折完光标挪到父项，那一行就再也不渲染，back 永远是假
            v.dispatch({ selection: { anchor: at }, scrollIntoView: true })
            await wait(300)
            const before = shown()
            window.__shellEmit('menu', 'view:toggle-fold')
            await wait(300)
            const folded = shown()
            // 折的是哪一条：光标要落在**父项**那一行（子项自己没东西可折，由内而外
            // 退了一层）。落在「- 嵌套项」上就说明压根没退，落在别处 = 退到整节去了
            const caretLine = v.state.doc.lineAt(v.state.selection.main.head).text
            const pill = document.querySelector('.cm-lp-section-more')
            const pillText = pill ? pill.textContent : null
            // 药丸点一下展开，那一行要回来。**400ms 不是随手写的**：单独跑这一段 300ms
            // 就够，而在整条探针链里（前面刚 await 过 2.2s 的自动保存 + 一次落盘）
            // 300ms 时展开还没画完，back 会假阴性一次
            if (pill) pill.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
            await wait(400)
            const back = shown()
            listFoldProbe = { before, folded, back, caretLine, pillText,
                              byteSafe: v.state.doc.toString() === docBefore }
          } catch (e) {
            listFoldProbe = { err: String(e) }
          }
        }
        // 0.4.1 ⌘+点击 front matter 里的标签 = 拿它去搜整个工作区。夹具头上是
        // `tags: [markdown, 测试]`，点的是**中文那颗** —— 这条路上最容易错的就是它：
        // 换成 `\\b测试\\b` 的话一条都搜不到（词边界按 \\w 算，中文两侧没有 \\w）。
        //
        // 收尾要把面板关掉、正则开关恢复原样：后面还有跨文件搜索、跨文件替换两条
        // 探针要用这块地方，而开关一旦留在开着，那两条就是在另一种模式下跑的
        let tagProbe = null
        if (path.indexOf('kitchen-sink.md') >= 0) {
          try {
            const wait = (ms) => new Promise(r => setTimeout(r, ms))
            const regexBtn = document.querySelector('.fs-opts button[data-opt="regex"]')
            const regexBefore = regexBtn ? regexBtn.classList.contains('is-on') : null
            const chip = [...document.querySelectorAll('.cm-lp-fm-tag')]
              .find((e) => e.textContent.trim() === '测试')
            const title = chip ? chip.title : null
            if (chip) {
              const r = chip.getBoundingClientRect()
              const at = { bubbles: true, metaKey: true,
                           clientX: Math.round(r.x + r.width / 2),
                           clientY: Math.round(r.y + r.height / 2) }
              chip.dispatchEvent(new MouseEvent('mousedown', at))
              // **mouseup 不能省**：`pointer-selection.ts` 在 mousedown 上按下
              // 「手势期间固定回显」的闸，松手才放。只派 mousedown 的话那个闸一直合着，
              // 而打字机的归位遇到 `pointerSelection` 非空会直接不滚 ——
              // 表现是几百行之后 writingProbe.ratio 变成 1.98（该是 0.42），
              // 一条毫不相干的断言替这儿背锅。标签那颗药丸是 mark 不是 widget，
              // 挡不住那个闸（widget 走的是 `contenteditable=false` 那条豁免）
              chip.dispatchEvent(new MouseEvent('mouseup', at))
            }
            await wait(1500)
            const input = document.querySelector('.fs-input')
            const query = input ? input.value : null
            const regexOn = !!document.querySelector('.fs-opts button[data-opt="regex"].is-on')
            const files = [...document.querySelectorAll('.fs-file')].map((e) => e.title || '')
            tagProbe = { title, query, regexOn, hits: files.length,
                         self: files.some((f) => f.indexOf('kitchen-sink.md') >= 0) }
            // 收干净：开关退回去（点标签只改这一次搜索，不该改人存着的偏好）、面板关掉
            if (regexBefore === false && regexOn)
              document.querySelector('.fs-opts button[data-opt="regex"]').click()
            await wait(200)
            // 外层那个 `sb` 是 #sidebar 这个 DOM 元素，不是 Sidebar 实例 —— 要的是后者
            window.__cursive.sidebar.closeSearch()
            await wait(200)
            tagProbe.cleaned = !document.querySelector('.sb-tree').hidden
          } catch (e) {
            tagProbe = { err: String(e) }
          }
        }
        // 0.4.1 正文缩放：⌘+ / ⌘− / ⌥⌘0 现在走渲染层，缩的**只有正文**。
        // 这条探针要守的正是那个「只」字：正文字号与栏宽跟着变，而状态栏、侧栏
        // 一个像素都不许动 —— 从前走 `pageZoom`，整张网页一起放大，那才是被换掉的行为。
        //
        // 摆在 math.md 上：它的断言全是「渲染出来了没有」，不量像素。
        // **自己收尾复位到 100%**：后面还有一批按坐标来的断言（打字机归位、挖洞区），
        // 带着 125% 跑就全飘了（同 CONTEXT 里那条「离开取样态的探针都得自己收尾」）
        let zoomProbe = null
        if (path.indexOf('math.md') >= 0) {
          try {
            const wait = (ms) => new Promise(r => setTimeout(r, ms))
            const badge = document.getElementById('status-zoom')
            const fs = (sel) => getComputedStyle(document.querySelector(sel)).fontSize
            const shot = () => ({
              zoom: getComputedStyle(document.documentElement).getPropertyValue('--zoom').trim(),
              body: fs('.cm-editor'),
              column: getComputedStyle(document.querySelector('.cm-content')).maxWidth,
              status: fs('#status-bar'),
              tree: fs('#sidebar'),
              badge: badge.textContent
            })
            const before = shot()
            window.__shellEmit('menu', 'view:zoom-in')
            await wait(120)
            window.__shellEmit('menu', 'view:zoom-in')
            await wait(220)
            const zoomed = shot()
            // 点状态栏那一格 = 回到 100%（缩着的时候它既是读数也是那颗按钮）
            badge.dispatchEvent(new MouseEvent('click', { bubbles: true }))
            await wait(220)
            zoomProbe = { before, zoomed, reset: shot() }
          } catch (e) {
            zoomProbe = { err: String(e) }
          }
        }
        // P3-1 文件树右键新建 / 删除。放在**取样之后**：新建会把新文件开成活动标签，
        // 早一步跑就把 roundtrip 采成空文件了。只对 kitchen-sink 跑 —— 删除是真的进
        // 废纸篓，没必要每个用例都往里扔一个
        let treeProbe = null
        if (path.indexOf('kitchen-sink.md') >= 0) {
          // 行的层级现在挂在 `--depth` 上（缩进与缩进参考线共用它一个数，见 base.css），
          // 不再是行内 padding-left
          const depthOf = (r) => +(r.style.getPropertyValue('--depth') || 0)
          // A1 排序：**在动手建文件之前采一份根目录的顺序** —— 下面几步会新建 / 改名 /
          // 移动 / 删除，采晚了看到的就不是夹具原本的样子
          const rootOrder = [...document.querySelectorAll('.sb-row')]
            .filter((r) => depthOf(r) === 0)
            .map((r) => ({ name: (r.textContent || '').trim(), dir: r.classList.contains('is-dir') }))
          // B3 滚动发丝线：滚过才画。**夹具这二十来行必须真的滚得动**，
          // 否则 on/off 两条都是空转 —— 所以把 scrollable 一起报上去当前提
          const sbTree = document.querySelector('.sb-tree')
          const sbHead = document.querySelector('.sb-head')
          const scrollProbe = {
            scrollable: sbTree.scrollHeight > sbTree.clientHeight + 4,
            idle: !sbHead.classList.contains('is-scrolled')
          }
          sbTree.scrollTop = 40
          await new Promise((r) => setTimeout(r, 120))
          scrollProbe.on = sbHead.classList.contains('is-scrolled')
          sbTree.scrollTop = 0
          await new Promise((r) => setTimeout(r, 120))
          scrollProbe.off = !sbHead.classList.contains('is-scrolled')
          const rowNamed = (name) => [...document.querySelectorAll('.sb-row')]
            .find((r) => (r.textContent || '').trim() === name)
          const menuItems = () =>
            [...document.querySelectorAll('.ctx-menu .ctx-item')].map((b) => b.textContent)
          const clickItem = (label) => {
            const b = [...document.querySelectorAll('.ctx-menu .ctx-item')]
              .find((x) => x.textContent === label)
            if (b) b.click()
            return new Promise((r) => setTimeout(r, 500))
          }
          const rowContext = (row) => {
            row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }))
            return new Promise((r) => setTimeout(r, 80))
          }
          // 空白处右键 = 作用于树根，没有「重命名 / 删除」（树根自己不能在树里删）
          const tree = document.querySelector('.sb-tree')
          tree.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 320 }))
          await new Promise((r) => setTimeout(r, 80))
          const rootMenu = menuItems()
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          // 工具栏那颗「新建文件」（P3-1 收尾：右键之外的第二个入口）
          const tools = [...document.querySelectorAll('.sb-tool')].map((b) => b.dataset.act)
          document.querySelector('.sb-tool[data-act="new-file"]').click()
          await new Promise((r) => setTimeout(r, 500))
          const created = !!rowNamed('e2e-新建')
          // A2 切标签**不重建整棵树**：抓住一行 DOM，切回上一个标签，它必须还在文档里
          // （`render()` 是 replaceChildren，重建过它就不在了 —— 同 autoQuiet 那一手）。
          // 守的是「`setActive` 只在沿途真展开过目录时才重建」：1500 行的库里那一次
          // 重建实测建 DOM 8~11ms + 布局 22~23ms，一次切换吃掉两帧。
          // 顺带证明高亮真的跟着换了（`paintActive`），否则「不重建」等于「不更新」
          let tabQuiet = null
          const tabEls = [...document.querySelectorAll('.tab-item')]
          if (tabEls.length >= 2) {
            const held = document.querySelector('.sb-row')
            tabEls[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
            await new Promise((r) => setTimeout(r, 300))
            const on = document.querySelector('.sb-row.is-active')
            tabQuiet = document.contains(held) && !!on &&
              (on.textContent || '').trim() === 'kitchen-sink'
          }
          // 行上右键 = 多出「重命名 / 删除」两项
          let rowMenu = []
          let renamed = false
          let moved = false
          let deleted = false
          const row = rowNamed('e2e-新建')
          if (row) {
            await rowContext(row)
            rowMenu = menuItems()
            await clickItem('重命名…')
            renamed = !!rowNamed('e2e-改名') && !rowNamed('e2e-新建')
          }
          // 拖到目录行上 = 移动。走 mousedown/mousemove/mouseup（与大纲重排同一个理由：
          // DataTransfer 在无头自检里造不出来，HTML5 拖放整条路径测不到）
          const src = rowNamed('e2e-改名')
          const dirRow = document.querySelector('.sb-row.is-dir')
          if (src && dirRow) {
            const a = src.getBoundingClientRect()
            const b = dirRow.getBoundingClientRect()
            const at = (t, x, y) => new MouseEvent(t, { bubbles: true, clientX: x, clientY: y, button: 0 })
            src.dispatchEvent(at('mousedown', a.left + 40, a.top + 8))
            window.dispatchEvent(at('mousemove', a.left + 40, a.top + 20))
            window.dispatchEvent(at('mousemove', b.left + 40, b.top + 8))
            const dropShown = !!document.querySelector('.sb-row.is-drop')
            window.dispatchEvent(at('mouseup', b.left + 40, b.top + 8))
            await new Promise((r) => setTimeout(r, 600))
            const landed = rowNamed('e2e-改名')
            // 搬进目录里 = 缩进变深了；顺带证明目标目录被自动展开
            moved = dropShown && !!landed && depthOf(landed) > 0
          }
          // 顺手过一遍懒加载展开：目录行读得出子项，子项缩进比父级深。
          // 得在删除之前数 —— 搬进 assets 的那份是当时唯一的子行；树里只放
          // 能打开的文档之后，assets 里的 png 不再进树，删完就数不到东西了
          const nested = [...document.querySelectorAll('.sb-row')].some((r) => depthOf(r) > 0)
          // B2 缩进参考线：背景宽度按 --depth 裁 —— 根这一层一条都不画，
          // 第 N 层正好 N 条（周期就是 --tree-indent，所以宽度 = N × 16px）
          const deepRow = [...document.querySelectorAll('.sb-row')].find((r) => depthOf(r) > 0)
          const guides = deepRow
            ? {
                depth: depthOf(deepRow),
                size: getComputedStyle(deepRow).backgroundSize,
                root: getComputedStyle(document.querySelector('.sb-row')).backgroundSize
              }
            : null
          const gone = rowNamed('e2e-改名')
          if (gone) {
            await rowContext(gone)
            await clickItem('删除文件')
            deleted = !rowNamed('e2e-改名')
          }
          // 契约 v32 自动刷新：**绕开这棵树**在盘上动手，看树自己跟不跟得上。
          // `window.api.save` 是直接写盘（原子写，与别的应用保存没有区别），侧栏完全
          // 不知情 —— 这正是「外部变更」的定义。三件事一起钉：来了要看见、走了要消失、
          // 而**我们自己的原子写不该让树重画一次**（自噬那条闸，`sameEntries`）
          const sbRoot = (document.querySelector('.sb-title') || {}).title || ''
          const outsider = sbRoot + '/e2e-外来.md'
          let autoAdded = false
          let autoWaited = 0
          let autoGone = false
          let autoQuiet = null
          if (sbRoot) {
            await window.api.save(outsider, '# 外来', doc.fingerprint)
            // **等它，别在固定时刻采一次样**（同 P0-3 那条）：壳侧还有 300ms 合并窗，
            // 加上一趟 readDir，够不够取决于机器此刻忙不忙。顶到上限 = 真的没跟上
            while (!autoAdded && autoWaited < 3000) {
              await new Promise((r) => setTimeout(r, 100)); autoWaited += 100
              autoAdded = !!rowNamed('e2e-外来')
            }
            // 原样再写一遍：目录条目又变了一次（临时文件 + rename），壳一定会报，
            // 但清单没变 —— 树不该重画。抓住一行 DOM，`render()` 是 replaceChildren，
            // 重画过它就不在文档里了
            const held = document.querySelector('.sb-row')
            await window.api.save(outsider, '# 外来', doc.fingerprint)
            await new Promise((r) => setTimeout(r, 800))
            autoQuiet = document.contains(held) && !!rowNamed('e2e-外来')
            await window.api.trashItem(outsider)
            let goneWaited = 0
            while (!autoGone && goneWaited < 3000) {
              await new Promise((r) => setTimeout(r, 100)); goneWaited += 100
              autoGone = !rowNamed('e2e-外来')
            }
          }
          // P2-9 完全折叠：先确保真有展开的目录，再点工具栏那颗 —— 深缩进的行该一次全收
          const deep = () => [...document.querySelectorAll('.sb-row')].filter((r) => depthOf(r) > 0).length
          const firstDir = document.querySelector('.sb-row.is-dir')
          if (!deep() && firstDir) {
            firstDir.click()
            await new Promise((r) => setTimeout(r, 400))
          }
          const collapseBtn = document.querySelector('.sb-tool[data-act="collapse"]')
          const deepBefore = deep()
          const enabledBefore = collapseBtn ? collapseBtn.disabled === false : null
          if (collapseBtn) collapseBtn.click()
          await new Promise((r) => setTimeout(r, 120))
          const collapseProbe = {
            present: !!collapseBtn,
            enabledBefore,
            deepBefore,
            deepAfter: deep(),
            // 没得可折了就该灰掉 —— 否则按下去毫无反应，用户分不清是坏了还是本来就折着
            disabledAfter: collapseBtn ? collapseBtn.disabled : null
          }
          treeProbe = { rootOrder, rootMenu, tools, created, tabQuiet, rowMenu, renamed, moved,
                        deleted, nested, guides, scrollProbe, collapseProbe,
                        autoAdded, autoWaited, autoQuiet, autoGone }
          // 截图里留着右键菜单，供目检（captureShot 在探针之后跑）
          const shotRow = document.querySelector('.sb-row')
          if (shotRow) {
            const box = shotRow.getBoundingClientRect()
            shotRow.dispatchEvent(new MouseEvent('contextmenu',
              { bubbles: true, clientX: box.left + 60, clientY: box.bottom }))
          }
        }
        // P1-6 告示块：卡片色真的落到线上（--cal-* 落空的话每一档都同色）、
        // 图标 widget 在、没写标题的补了中文名、折叠三角真的折而且不碰文档
        let calloutProbe = null
        {
          const danger = document.querySelector('.cm-lp-callout-danger')
          const note = document.querySelector('.cm-lp-callout-note')
          if (danger && note) {
            const more = () => document.querySelectorAll('.cm-lp-callout-more').length
            const docLen = window.__cursive.view.state.doc.length
            const more0 = more()   // `[!summary]-` 默认就是折起来的
            const chevron = () => document.querySelector('.cm-lp-callout-fold')
            const click = async () => {
              const el = chevron()
              if (el) el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
              await new Promise(r => setTimeout(r, 80))
            }
            await click()
            const more1 = more()
            await click()
            const more2 = more()
            calloutProbe = {
              icons: document.querySelectorAll('.cm-lp-callout-icon svg').length,
              names: [...document.querySelectorAll('.cm-lp-callout-name')].map(el => el.textContent),
              danger: getComputedStyle(danger).borderLeftColor,
              note: getComputedStyle(note).borderLeftColor,
              more0, more1, more2,
              docLen,
              docLenAfter: window.__cursive.view.state.doc.length
            }
          }
        }
        // P3-6：大纲条目是给人看的文字 —— setext 的下划线、标题里的行内语法都不该漏进来
        const outlineRows = [...document.querySelectorAll('.ol-text')].map(e => e.textContent)
        // P3-3 专注模式 / 打字机模式
        let writingProbe = null
        {
          const v = window.__cursive.view
          // 先把光标放到一段正文里并滚到视口内 —— 装饰只铺可视范围，
          // 光标在屏幕外的话一条 .cm-focus-line 都不会有
          let paraNo = 0
          for (let n = 1; n <= v.state.doc.lines; n++) {
            if (v.state.doc.line(n).text.indexOf('这是一段带') === 0) { paraNo = n; break }
          }
          // 两个模式的开关状态是持久化的（localStorage），上一轮留下什么都可能 ——
          // 先摆成确定的「都关着」，再按剧本切，否则断言量到的是上一轮的残留
          const setMode = async (action, cls, want) => {
            if (v.dom.classList.contains(cls) !== want) {
              window.__shellEmit('menu', action)
              await new Promise(r => setTimeout(r, 120))
            }
          }
          if (paraNo) {
            await setMode('view:toggle-focus', 'cursive-focus', false)
            await setMode('view:toggle-typewriter', 'cursive-typewriter', false)
            v.dispatch({ selection: { anchor: v.state.doc.line(paraNo).from + 2 }, scrollIntoView: true })
            await new Promise(r => setTimeout(r, 80))
            // 这会儿焦点还在查找框里（上面的 searchProbe 留下的）。菜单切模式会走
            // view.focus()，而 WebKit 会顺手把旧 DOM 选区滚进视口 —— main.ts 的
            // focusEditor() 就是挡这一下的，lit 断言同时也在守它：跳了的话这一段
            // 正文早滚出视口，一条 .cm-focus-line 都不会有
            const scrollBefore = Math.round(v.scrollDOM.scrollTop)
            await setMode('view:toggle-focus', 'cursive-focus', true)
            const scrollKept = Math.round(v.scrollDOM.scrollTop) === scrollBefore
            // 压暗有 0.18s 过渡，量早了读到的是过渡中间值
            await new Promise(r => setTimeout(r, 320))
            const lines = [...document.querySelectorAll('.cm-content > .cm-line')]
            const lit = lines.filter(e => e.classList.contains('cm-focus-line'))
            const dim = lines.filter(e => !e.classList.contains('cm-focus-line'))
            const focusOn = v.dom.classList.contains('cursive-focus')
            // 压暗只该改文字颜色。**opacity 必须仍是 1** —— 盖遮罩那版会把代码块底色、
            // 图片、表格边框一起褪成灰，整页像蒙了层纱，这条就是守着它别回去
            const litColor = lit.length ? getComputedStyle(lit[0]).color : ''
            const dimColor = dim.length ? getComputedStyle(dim[0]).color : ''
            const dimOpacity = dim.length ? Number(getComputedStyle(dim[0]).opacity) : -1
            const litOpacity = lit.length ? Number(getComputedStyle(lit[0]).opacity) : -1
            // 夹在暗区里的图片也不该被蒙住（它不吃 color，只要没人给它压 opacity）
            const dimImg = document.querySelector('.cm-content > *:not(.cm-focus-line) .cm-lp-image img')
            const imgOpacity = dimImg ? Number(getComputedStyle(dimImg).opacity) : 1
            await setMode('view:toggle-focus', 'cursive-focus', false)
            const focusOff = !v.dom.classList.contains('cursive-focus')
                             && document.querySelectorAll('.cm-focus-line').length === 0

            // 打字机：光标行顶边停在视口 42% 高度上（writing-modes.ts 的 ANCHOR）
            await setMode('view:toggle-typewriter', 'cursive-typewriter', true)
            const padTop = parseFloat(getComputedStyle(v.contentDOM).paddingTop)
            const deep = Math.max(1, Math.floor(v.state.doc.lines * 0.6))
            v.dispatch({ selection: { anchor: v.state.doc.line(deep).from } })
            // 跳到文档 60% 处是一次大跨度滚动：CM 要先把估算行高换成实测行高，
            // 滚动位置可能要好几帧才收敛（rAF 里派的 scrollTarget，机器忙时更慢）。
            // 固定等 200ms 会量到中途值 —— 实测偶发 ratio≈2.3，整条用例随机 FAIL。
            // 改成轮询到位、最多 2s：真坏了照样过不了下面那条断言
            let ratio = -1
            for (let i = 0; i < 40 && Math.abs(ratio - 0.42) > 0.02; i++) {
              await new Promise(r => setTimeout(r, 50))
              const box = v.scrollDOM.getBoundingClientRect()
              const co = v.coordsAtPos(v.state.selection.main.head)
              ratio = co ? (co.top - box.top) / v.scrollDOM.clientHeight : -1
            }
            await setMode('view:toggle-typewriter', 'cursive-typewriter', false)
            writingProbe = {
              // 窗口被别的窗口整个盖住时 WKWebView 会停掉 rAF，打字机的滚动就永远不发生。
              // 断言它是 'visible'，免得下次再把「rAF 没跑」误读成「打字机算错了」
              vis: document.visibilityState,
              focusOn, focusOff, lit: lit.length, litOpacity, dimOpacity,
              litColor, dimColor, imgOpacity,
              padTop, ratio,
              scrollKept,
              typewriterOff: !v.dom.classList.contains('cursive-typewriter')
            }
          }
        }
        // P3-6 大纲下半场：每节字数 / 折叠 / 层级档位 / 过滤框 / 右键菜单 / 拖拽重排
        let outlineProbe = null
        try {
          const v = window.__cursive.view
          const rows = () => [...document.querySelectorAll('.ol-row')]
          const texts = () => rows().map(r => r.querySelector('.ol-text').textContent)
          const wait = (ms) => new Promise(r => setTimeout(r, ms))
          const twistOf = (pos) => document.querySelector('.ol-row[data-pos="' + pos + '"] .ol-twist')
          // **先把层级档位摆回「全部」**：它是 localStorage 记着的（`cursive.outlineLevel`），
          // 上一轮探针要是在中途抛了异常，就会停在「只看一级」上 —— 下一轮里
          // 「降一级」把唯一那个标题变成二级，大纲当场空掉，`rows()[0]` 直接炸
          // （真摔过：table.md 连着三轮同一个 TypeError）。自检要一个确定的起点，同契约 v24
          document.querySelector('.ol-levels button[data-level="6"]').click()
          await wait(80)
          const all = rows().length
          const words = [...document.querySelectorAll('.ol-words')].map(e => Number(e.textContent))

          // ① 折叠：收起第一个有三角的行，它名下的行该少掉；再点回来要复原
          const parent = rows().find(r => r.querySelector('.ol-twist').style.visibility !== 'hidden')
          let foldedCount = -1
          let unfoldedCount = -1
          if (parent) {
            const pos = parent.dataset.pos
            twistOf(pos).click()
            await wait(60)
            foldedCount = rows().length
            twistOf(pos).click()
            await wait(60)
            unfoldedCount = rows().length
          }

          // ② 层级档位：点「1」只剩一级标题，再点一次回到全部
          const lv1 = document.querySelector('.ol-levels button[data-level="1"]')
          lv1.click()
          await wait(60)
          const onlyH1 = rows().every(r => r.classList.contains('ol-l1')) && rows().length > 0
          const h1Count = rows().length
          lv1.click()
          await wait(60)
          const backToAll = rows().length === all

          // ③ 过滤框：输入即筛 + 命中片段套 <mark>
          const input = document.querySelector('.ol-filter input')
          // 清空按钮只在有内容时露面（`[hidden]` 压不过 display:flex，踩过一次）
          const clearHiddenAtRest = document.querySelector('.ol-clear').offsetParent === null
          input.value = '表格'
          input.dispatchEvent(new Event('input'))
          await wait(60)
          const filtered = texts()
          const marks = document.querySelectorAll('.ol-text mark').length
          const clearShownWhenTyped = document.querySelector('.ol-clear').offsetParent !== null
          input.value = ''
          input.dispatchEvent(new Event('input'))
          await wait(60)

          // ④ 右键菜单：条目齐不齐 + 「降一级」真的加了一个 #
          // 没有标题的文档就到此为止 —— img.md 的探针会往光标（文首）插图片链接，
          // 把它唯一那行标题撞成图片行，大纲这时本来就该是空的（断言只挂在 kitchen-sink 上）
          const row0 = rows()[0]
          if (!row0) {
            outlineProbe = { all, atMenu: rows().length, words, foldedCount, unfoldedCount,
                             onlyH1, h1Count, backToAll, filtered, marks, skipped: true }
            throw { __skip: true }
          }
          const b0 = row0.getBoundingClientRect()
          row0.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: b0.left + 10, clientY: b0.top + 8 }))
          await wait(80)
          const menu = [...document.querySelectorAll('.ctx-menu .ctx-item')].map(b => b.textContent)
          const headLine = v.state.doc.lineAt(Number(row0.dataset.pos)).number
          const beforeHead = v.state.doc.line(headLine).text
          const demote = [...document.querySelectorAll('.ctx-menu .ctx-item')].find(b => b.textContent === '降一级')
          if (demote) demote.click()
          await wait(80)    // 改完大纲是立刻重建的（不等那 450ms 防抖），等一帧就够
          const afterHead = v.state.doc.line(headLine).text
          // 大纲行上的 pos 必须已经是改完之后的：拿它去 doc.lineAt 应正好落在那一行
          const freshPos = Number(rows()[0].dataset.pos)
          const posFresh = v.state.doc.lineAt(freshPos).text === afterHead

          // ⑤ 拖拽重排：把最后一节拖到第一行之前。字节只该换顺序，总量一个不差
          const src = v.state.doc.toString()
          const list = rows()
          const last = list[list.length - 1]
          const first = list[0]
          const lb = last.getBoundingClientRect()
          const fb = first.getBoundingClientRect()
          const at = (t, x, y, el) => (el || window).dispatchEvent(
            new MouseEvent(t, { bubbles: true, button: 0, clientX: x, clientY: y }))
          at('mousedown', lb.left + 20, lb.top + lb.height / 2, last)
          at('mousemove', lb.left + 20, lb.top + lb.height / 2 - 20)
          at('mousemove', fb.left + 20, fb.top + 2)
          const dropShown = document.querySelector('.ol-drop').hidden === false
          at('mouseup', fb.left + 20, fb.top + 2)
          await wait(120)
          const after = v.state.doc.toString()

          outlineProbe = {
            all, words, foldedCount, unfoldedCount, onlyH1, h1Count, backToAll,
            filtered, marks, menu, clearHiddenAtRest, clearShownWhenTyped, posFresh,
            demoted: beforeHead !== afterHead && afterHead === '#' + beforeHead,
            dropShown,
            movedBytesEqual: after !== src && after.length === src.length
              && [...after].sort().join('') === [...src].sort().join('')
          }
        } catch (e) {
          if (!e || !e.__skip) throw e
        }
        // P3-8：状态栏光标行列 / 选区字数 / 详细统计面板。
        // 放在 outlineProbe 之后、且整段都在「往返落盘」那一步（save(outPath)）之后跑 ——
        // 它只动选区不动文档，但顺序仍按这条规矩来，免得以后加断言时踩到 bytesEqual
        let statsProbe = null
        try {
          const v = window.__cursive.view
          const wait = (ms) => new Promise(r => setTimeout(r, ms))
          const elCount = document.getElementById('status-count')
          const elPos = document.getElementById('status-pos')
          // 找一行有实打实内容的，空行上选不出东西来
          let n = 1
          for (let i = 1; i <= v.state.doc.lines; i++) {
            if (v.state.doc.line(i).text.trim().length >= 6) { n = i; break }
          }
          const line = v.state.doc.line(n)
          // ① 行列：光标放在该行第 2 列上（列从 1 起）
          v.dispatch({ selection: { anchor: line.from + 1 } })
          await wait(200)
          const pos = elPos.textContent
          const docText = elCount.textContent
          // ② 选区：整行选中 → 字数条换成「已选 …」
          v.dispatch({ selection: { anchor: line.from, head: line.to } })
          await wait(220)
          const selText = elCount.textContent
          const selClass = elCount.classList.contains('is-sel')
          // ③ 点开详细统计。mousedown 被 preventDefault 挡住焦点转移，
          // 选区因此还在 —— 「选中」那一列才有东西
          elCount.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
          elCount.click()
          await wait(80)
          const panel = document.getElementById('stats')
          const labels = panel ? [...panel.querySelectorAll('.st-label')].map(e => e.textContent) : []
          const cols = panel ? panel.querySelectorAll('.st-col').length : 0
          const nums = panel ? panel.querySelectorAll('.st-num').length : 0
          const hasSel = panel ? panel.classList.contains('has-sel') : false
          const selDone = v.state.selection.main.empty === false
          // ④ Escape 关闭（面板不抢焦点，键盘事件走 window 捕获）
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          await wait(60)
          const closed = !document.getElementById('stats')
          // ⑤ 取消选区 → 读数回到全文那份
          v.dispatch({ selection: { anchor: line.from } })
          await wait(220)
          statsProbe = { line: n, pos, docText, selText, selClass, labels, cols, nums,
                         hasSel, selDone, closed, backText: elCount.textContent }
          // 截图（captureShot 排在探针之后）里要看得见这块面板 —— 上面那步刚把它关掉，
          // 重新点开留给目检，同表格工具栏的做法
          elCount.click()
        } catch (e) {
          statsProbe = { err: String(e) }
        }
        // 「保存零损耗」那条断言比的是**源文件**与 roundtrip.out。取样之后的探针还会改文档
        // （大纲的降级 / 搬节），而自动保存 2s 后会把改动也写进源文件 —— 于是这条断言退化成
        // 「整个探针跑得比 2s 快」的赌局，再加一个探针就翻车（P3-8 的 statsProbe 就真的翻了：
        // table.md 的源文件被autosave 改成了 `## 表格测试`，outPath 里还是 `#`）。
        // 两步收干净，从此与探针跑多久无关：① 把文档恢复成取样时那份 —— 此后任何一次自动保存
        // 写的都是同一内容；② 把源文件显式写回去 —— 盖掉取样后可能已经落盘的那一次
        {
          const back = window.__cursive.view
          if (back.state.doc.toString() !== sampled) {
            back.dispatch({ changes: { from: 0, to: back.state.doc.length, insert: sampled } })
          }
          await window.api.save(path, sampled, doc.fingerprint)
        }
        // P4-1 导出 HTML。同样排在「收干净」之后，而且**必须排在跨文件搜索之前** ——
        // findProbe 点一处命中会切到别的标签，导出的却是当前活动标签，顺序反了就导错文档。
        // 自检下壳绕过保存面板，落到 CURSIVE_SMOKE_HTML 指的路径（没设就返回 null，
        // 那时这一步只验证「整条渲染路径不抛异常」）
        let htmlProbe = null
        try {
          const res = await window.__cursive.exportHtml()
          htmlProbe = { path: (res && res.path) || null }
        } catch (e) {
          htmlProbe = { error: String(e) }
        }
        // ---- 0.2.0：补全 / 命令面板 / 快速打开 / 复制为富文本 ----
        // 摆在导出之后、跨文件搜索之前：前三样都不改文档（补全那一发插完当场删回去），
        // 而 findProbe 会切标签，放它后面就不是在测这一份文档了
        let v020 = null
        try {
          const emit = (a) => window.__shellEmit('menu', a)
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
          const v = window.__cursive.view

          // ① 自动补全：真的敲一段 `:sm` 让面板自己弹（走 activateOnTyping 那条路，
          //    而不是直接调 startCompletion —— 后者测不到「挂没挂上」）
          const end = v.state.doc.length
          v.dispatch({
            changes: { from: end, insert: '\\n:sm' },
            selection: { anchor: end + 4 },
            userEvent: 'input.type'
          })
          // **等它，别在固定时刻采一次样**（同自动刷新那条、同 P0-3 那条）。
          // CM 的 activateOnTyping 自带 100ms 延迟，面板还要再画一帧，而这条用例链上
          // 前面刚导过一次 HTML、跑完一整套文件树增删 —— 原先那句固定 `sleep(400)`
          // 在忙一点的机器上会**随机**采空（实测同一份二进制连跑三次红一次，红出来的
          // 还是「补全根本没挂上」这种看着很吓人的假象）。顶到上限还没有 = 真的没弹
          let tip = null
          let tipWaited = 0
          while (!tip && tipWaited < 2500) {
            await sleep(100)
            tipWaited += 100
            const box = document.querySelector('.cm-tooltip-autocomplete')
            if (box && box.querySelectorAll('li').length) tip = box
          }
          const rows = tip ? tip.querySelectorAll('li').length : 0
          const first = tip ? (tip.querySelector('li') || {}).textContent || '' : ''
          // 原样删回去。文档此后与 `sampled` 逐字节相同，后面哪一次自动保存都无所谓
          v.dispatch({ changes: { from: end, to: v.state.doc.length } })
          const restored = v.state.doc.toString() === sampled

          // ①b 0.4.0 F3 的两个新源：公式命令与链接目的地。
          //     公式那条在**正文里不许弹**（那儿的反斜杠是转义），只在 `$…$` 里认
          // **先摆好上下文，再「打」出触发的那几个字**：CM 的 activateOnTyping 只在
          // 光标落在这一次插入的末尾时才弹，一次性把整行连光标位置塞进去是弹不出来的
          const probeSource = async (setup, caretBack, typed) => {
            const at = v.state.doc.length
            v.dispatch({ changes: { from: at, insert: '\\n' + setup }, userEvent: 'input.type' })
            const caret = v.state.doc.length - caretBack
            v.dispatch({ selection: { anchor: caret } })
            await sleep(80)
            v.dispatch({
              changes: { from: caret, insert: typed },
              selection: { anchor: caret + typed.length },
              userEvent: 'input.type'
            })
            await sleep(450)   // 链接那条要等壳侧 listFiles 走一趟目录
            const box = document.querySelector('.cm-tooltip-autocomplete')
            const items = box ? [...box.querySelectorAll('li')].map((li) => li.textContent) : []
            v.dispatch({ changes: { from: at, to: v.state.doc.length } })
            await sleep(80)
            return items
          }
          // 公式里打反斜杠 al 会弹；正文里同样两个字符**不许**弹（那儿的反斜杠是转义）
          const mathItems = await probeSource('$x + $', 1, '\\\\al')
          const plainItems = await probeSource('正文 ', 0, '\\\\al')
          const linkItems = await probeSource('[看]', 0, '(')
          // **再收一次干净**：上面三发前后插了一秒多的临时文字，而自动保存的防抖是 2s ——
          // 它完全可能正好在中间落一次盘，把临时文字写进夹具（`bytesEqual` 于是偶发变红，
          // 而且失败点离真因很远）。显式写回取样时那份，此后再自动保存也是同一内容
          await window.api.save(path, sampled, doc.fingerprint)
          const completeRestored = v.state.doc.toString() === sampled

          // ② 命令面板：列的应当是 MenuAction 全表，筛一个词只剩少数几条
          emit('view:command-palette')
          await sleep(80)
          const pal = document.getElementById('palette')
          const input = pal.querySelector('.pl-input')
          const cmdAll = pal.querySelectorAll('.pl-row').length
          input.value = '高亮'
          input.dispatchEvent(new Event('input', { bubbles: true }))
          await sleep(60)
          const cmdHit = (pal.querySelector('.pl-row .pl-label') || {}).textContent || ''
          // Esc 关面板：**派在 document 上**。元素级的合成 KeyboardEvent 在这个
          // WKWebView 里送不到监听器（实测：同一元素上 `new Event('keydown')` 能触发、
          // `new KeyboardEvent(...)` 不能），而面板的 Esc 本来就挂在 window 捕获上
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          await sleep(40)
          const cmdClosed = pal.hidden

          // ③ 快速打开：索引由壳侧遍历（契约 v21），等它一趟
          emit('file:quick-open')
          await sleep(600)
          const files = pal.querySelectorAll('.pl-row').length
          const fileFirst = (pal.querySelector('.pl-row .pl-label') || {}).textContent || ''
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          await sleep(40)
          const fileClosed = pal.hidden

          // ④ 复制为富文本（契约 v20）。自检下壳不碰剪贴板，只记两个长度
          emit('edit:copy-html')
          await sleep(500)

          // ⑤ 版本历史（契约 v22）。前面「收干净」那一步保存过一次，所以至少有一份快照。
          // 点开第一条看差异 —— 差异行数为 0 说明要么没读回内容、要么 diff 算错了
          emit('file:history')
          await sleep(600)
          const hi = document.getElementById('history')
          const hiRows = hi.querySelectorAll('.hi-row').length
          let hiLines = 0
          let hiStat = ''
          if (hiRows > 0) {
            // 点**最旧**那一条。第一条（最新）多半与当前文档逐字节相同 ——
            // 面板那时显示的是「与当前文档完全相同」，一行差异都不该有，
            // 拿它来断言 diff 算没算对等于什么都没测
            const all = hi.querySelectorAll('.hi-row')
            all[all.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
            await sleep(400)
            hiLines = hi.querySelectorAll('.hi-line').length
            hiStat = (hi.querySelector('.hi-stat') || {}).textContent || ''
          }
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          await sleep(40)
          const hiClosed = hi.hidden

          v020 = { rows, first, tipWaited, restored, cmdAll, cmdHit, cmdClosed, files, fileFirst, fileClosed,
                   hiRows, hiLines, hiStat, hiClosed,
                   // 0.4.0 F3 的两个新源
                   mathItems, plainItems, linkItems, completeRestored }
        } catch (e) {
          v020 = { err: String(e) }
        }
        // ---- 0.2.0 标签右键菜单（关闭 左边 / 其他 / 右边 / 所有）----
        // 只在 dialect.md 这条用例上跑：它要开关一堆标签，别和别的探针抢活动标签。
        // 这条用例的「是否保存」替身答案是 cancel（release.sh 里设的），
        // 所以最后那一段能验到「取消要中止整批」—— 那是唯一一条错了会真丢东西的分支
        let tabProbe = null
        if (path.indexOf('dialect.md') >= 0) {
          try {
            const nap = (ms) => new Promise((r) => setTimeout(r, ms))
            const tabEls = () => [...document.querySelectorAll('#tabbar .tab-item')]
            const openSide = async (name) => {
              const row = document.querySelector('.sb-row[data-path$="/' + name + '"]')
              if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await nap(200)
            }
            const rightClick = async (i) => {
              const el = tabEls()[i]
              const b = el.getBoundingClientRect()
              el.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true, clientX: b.left + 10, clientY: b.top + 8
              }))
              await nap(70)
            }
            const menu = () => [...document.querySelectorAll('.ctx-menu .ctx-item')]
            const pick = async (idx) => {
              const b = menu()[idx]
              if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await nap(320)
            }

            // ① 三个标签加原来那个，右键第一个：菜单五条，只有「关闭左边」该是灰的。
            //    起手可能不止一个标签（崩溃恢复的草稿会先开一个），所以数**增量**
            const before = tabEls().length
            await openSide('callout.md'); await openSide('crlf.md'); await openSide('math.md')
            const added = tabEls().length - before
            await rightClick(0)
            const labels = menu().map((b) => b.textContent)
            const offAtFirst = menu().map((b) => b.disabled)
            const marked = tabEls()[0].classList.contains('is-context')
            // ② 关闭右边 → 只剩被右键的那个；菜单收起后高亮也该跟着消失
            await pick(3)
            const afterRight = tabEls().length
            const stillContext = tabEls()[0].classList.contains('is-context')

            // ③ 再开两个，右键最后一个：这回该灰的是「关闭右边」。关闭左边 → 同样只剩它
            await openSide('callout.md'); await openSide('crlf.md')
            await rightClick(2)
            const offAtLast = menu().map((b) => b.disabled)
            await pick(1)
            const afterLeft = tabEls().length

            // ④ 脏标签 + 取消：整批必须停下，那一个要留着。
            //    **放在最后一步**：`activate()` 会给切走的标签发一次自动保存，
            //    于是「改脏 → 再改回去」在竞态里反而会变成第二次变脏 —— 收拾不干净。
            //    改脏的是 tabs.md（release.sh 专为这条用例造的一次性夹具），
            //    留着不管也不伤任何别的用例
            await openSide('tabs.md')
            const v2 = window.__cursive.view
            v2.dispatch({ changes: { from: v2.state.doc.length, insert: 'x' } })
            await nap(60)
            const beforeCancel = tabEls().length
            await rightClick(0)
            await pick(2)                    // 关闭其他
            const afterCancel = tabEls().length

            tabProbe = { added, labels, offAtFirst, offAtLast, marked, stillContext,
                         afterRight, afterLeft, beforeCancel, afterCancel }
          } catch (e) {
            tabProbe = { err: String(e) }
          }
        }
        // P3-2 跨文件搜索。**必须排在上面那段「收干净」之后** —— 点一处命中会切到别的
        // 标签，而收尾那两步操作的是「当前活动标签」，顺序反了就会把内容写进错的文档里
        let findProbe = null
        if (path.indexOf('kitchen-sink.md') >= 0) {
          try {
            const sb = window.__cursive.sidebar
            sb.openSearch()
            const input = document.querySelector('.fs-input')
            input.value = '表格'
            input.dispatchEvent(new Event('input', { bubbles: true }))
            // 防抖 220ms + 壳侧扫一遍夹具目录
            await new Promise((r) => setTimeout(r, 1400))
            const groups = document.querySelectorAll('.fs-group').length
            const hits = document.querySelectorAll('.fs-hit').length
            const marks = document.querySelectorAll('.fs-hit mark').length
            const markText = (document.querySelector('.fs-hit mark') || {}).textContent
            const status = (document.querySelector('.fs-status') || {}).textContent
            const treeHidden = document.querySelector('.sb-tree').hidden
            // 点一处落在**别的文件**里的命中：应该开出那个文件并把这一处选中
            const other = [...document.querySelectorAll('.fs-group')]
              .find((g) => (g.querySelector('.fs-file').title || '').indexOf('table.md') >= 0)
            let jumped = null
            let openedPath = null
            if (other) {
              other.querySelector('.fs-hit').click()
              await new Promise((r) => setTimeout(r, 800))
              const v2 = window.__cursive.view
              const sel = v2.state.selection.main
              jumped = v2.state.sliceDoc(sel.from, sel.to)
              openedPath = document.getElementById('status-file').title
            }
            sb.closeSearch()
            const treeBack = !document.querySelector('.sb-tree').hidden
            findProbe = { groups, hits, marks, markText, status, treeHidden, treeBack, jumped, openedPath }
            // 截图走查用：断言全部量完之后再把面板开回来（同统计面板末尾那一下）
            if (shotSearch) {
              sb.openSearch()
              input.value = '表格'
              input.dispatchEvent(new Event('input', { bubbles: true }))
              await new Promise((r) => setTimeout(r, 900))
            }
          } catch (e) {
            findProbe = { err: String(e) }
          }
        }
        // 0.2.0 链接跳转：⌘+点击的四条去处各走一遍。
        // **必须和 findProbe 一样排在「收干净」之后** —— 点一条本地文档链接会切到别的标签，
        // 而前面那些操作的是「当前活动标签」。外部地址在自检下只记账（smokeExternal），
        // 不会真的把浏览器唤起来
        let linkProbe = null
        if (path.indexOf('links.md') >= 0) {
          try {
            const modClick = (el) => {
              /*
               * **先滚进视口再点。** 探针按元素的 rect 派事件，而链接处理器是**按坐标
               * 反查文档位置**的（`editor/link.ts` 走 `posAtCoords`）—— 元素在视口外时，
               * 那个坐标落在渲染范围之外，CM 只能把它夹到文末：实测「别的文档」这一下
               * 解析到了 `external-append-marker` 那一行，于是「点了没反应」，
               * 看着像链接不通，其实是点在了别处。真人也只能点看得见的东西。
               * 居中还顺带躲开底部那条悬浮格式栏。
               */
              el.scrollIntoView({ block: 'center' })
              // **取第一个 client rect，不是包围盒**：一行里摞着好几条链接时，长的那条
              // 会折到下一行，而包围盒是所有折行的并集 —— 它的中点落在第二行上，
              // 甚至落到底部悬浮格式栏后面（实测 h=48、命中 `.fb-pick`，于是这一下
              // 点了什么也没发生，看着像「链接不通」，其实是探针点歪了）
              const b = el.getClientRects()[0] || el.getBoundingClientRect()
              // 点在链接文字的**左端**：光标恰好停在这一行时地址会回显成源码，
              // 中点就落到 `](…)` 那半边去了（仍是同一个 Link 节点，但离得远不如左端稳）
              el.dispatchEvent(new MouseEvent('mousedown', {
                bubbles: true, cancelable: true, metaKey: true,
                clientX: b.left + Math.min(6, b.width / 2), clientY: b.top + b.height / 2
              }))
            }
            const linkBy = (text) => [...document.querySelectorAll('.cm-lp-link')]
              .find((e) => e.textContent.indexOf(text) >= 0)
            const lineNow = () => {
              const vv = window.__cursive.view
              return vv.state.doc.lineAt(vv.state.selection.main.head).text
            }
            const backToLinks = async () => {
              const tab = [...document.querySelectorAll('.tab-item')].find((e) => e.title === 'links')
              if (tab) tab.click()
              await new Promise((r) => setTimeout(r, 300))
            }
            // **先把状态栏那句话清空**：这一节里有三条断言的内容是「这一下不该报错」
            // （angNote / pctNote / bareNote 必须是空的），而上一节刚跑完的复制为富文本
            // 会在状态栏留一句 4 秒的回执 —— 不清的话那句话会被当成这一下的抱怨。
            // 自检要一个确定的起点，同大纲层级档位那条
            document.getElementById('status-note').textContent = ''
            // 悬停提示：预览里地址是藏着的，title 是「这条链接通向哪儿」的唯一线索
            const title = linkBy('跳到小节').getAttribute('title')
            // ① 本文锚点 → 光标落到那一节的标题上
            modClick(linkBy('跳到小节'))
            await new Promise((r) => setTimeout(r, 300))
            const anchorLine = lineNow()
            // ② 本地文档 + 锚点 → 开一个**标签**（不是新窗口），并落在目标文档的那一节上
            const tabsBefore = document.querySelectorAll('.tab-item').length
            modClick(linkBy('别的文档'))
            await new Promise((r) => setTimeout(r, 900))
            const openedPath = document.getElementById('status-file').title
            const openedLine = lineNow()
            const tabsAfter = document.querySelectorAll('.tab-item').length
            await backToLinks()
            // ②b **文件名带空格**（中文笔记最常见的样子）：尖括号写法与百分号写法
            // 必须落到同一份文件上。这一段守的是整条链 —— 渲染层拼路径、过桥、
            // 壳侧 readDoc 按原样读盘，中间任何一步把空格弄丢都会变成「找不到文件」
            modClick(linkBy('尖括号写法'))
            await new Promise((r) => setTimeout(r, 900))
            const angPath = document.getElementById('status-file').title
            const angLine = lineNow()
            const angNote = document.getElementById('status-note').textContent
            await backToLinks()
            modClick(linkBy('百分号写法'))
            await new Promise((r) => setTimeout(r, 900))
            const pctPath = document.getElementById('status-file').title
            const pctNote = document.getElementById('status-note').textContent
            await backToLinks()
            // **裸空格写法**（方言放宽之后才算数的那一条）：CommonMark 说不行，
            // 而带空格的文件名是中文笔记的常态 —— 它必须和上面两种写法落到同一处
            modClick(linkBy('裸空格写法'))
            await new Promise((r) => setTimeout(r, 900))
            const barePath = document.getElementById('status-file').title
            const bareLine = lineNow()
            const bareNote = document.getElementById('status-note').textContent
            await backToLinks()
            // ③ 外部地址、④ 本地的其它文件（带空格的文件名走尖括号写法）：都交给系统
            modClick(linkBy('外部地址'))
            await new Promise((r) => setTimeout(r, 200))
            modClick(linkBy('一张图'))
            await new Promise((r) => setTimeout(r, 200))
            // ⑤ 文件不在了、⑥ 没有这个锚点：状态栏必须说一句话 —— 点了没反应是最糟的失败方式
            modClick(linkBy('缺失文件'))
            await new Promise((r) => setTimeout(r, 500))
            const missingNote = document.getElementById('status-note').textContent
            modClick(linkBy('缺失锚点'))
            await new Promise((r) => setTimeout(r, 300))
            const anchorNote = document.getElementById('status-note').textContent
            // ⑦ 本地的其它文件不在了：交给系统之后系统说「没接手」，状态栏跟着说一句
            modClick(linkBy('缺失图片'))
            await new Promise((r) => setTimeout(r, 400))
            const fileNote = document.getElementById('status-note').textContent
            // ⑧ 地址里有空格：CommonMark 压根不认这种写法（连 Link 节点都没有），
            // 而带空格的文件名正是中文笔记最常见的样子 —— 必须说清楚为什么点不动。
            // 它不是链接，DOM 里没有 .cm-lp-link 可点，只能按**文档位置**换算坐标
            const vv = window.__cursive.view
            const at = vv.state.doc.toString().indexOf('看不出是文件')
            const box = at >= 0 ? vv.coordsAtPos(at + 2) : null
            if (box) {
              const x = box.left + 1
              const y = (box.top + box.bottom) / 2
              ;(document.elementFromPoint(x, y) || vv.contentDOM).dispatchEvent(
                new MouseEvent('mousedown', { bubbles: true, cancelable: true, metaKey: true, clientX: x, clientY: y })
              )
            }
            await new Promise((r) => setTimeout(r, 300))
            const spacedNote = document.getElementById('status-note').textContent
            linkProbe = { title, anchorLine, openedPath, openedLine,
                          angPath, angLine, angNote, pctPath, pctNote,
                          barePath, bareLine, bareNote,
                          tabsBefore, tabsAfter, missingNote, anchorNote, fileNote, spacedNote,
                          backOnLinks: (document.getElementById('status-file').title || '').endsWith('links.md') }
          } catch (e) {
            linkProbe = { err: String(e) }
          }
        }
        // 0.4.0 F2 跨文件替换（契约 v30）—— **全应用风险最高的一个动作**：一次改几十个
        // 没打开过的文件。这一段走完两轮：① 改掉三份夹具（LF / CRLF / BOM 各一份），
        // 中间**勾掉一处**证明「所见即所改」；② 另一份改完当场撤销。
        // 盘上的字节由 release.sh 的 python 收尾对账（指纹、没命中的行、版本历史快照）
        let replaceProbe = null
        if (path.indexOf('crlf.md') >= 0) {
          try {
            const wait = (ms) => new Promise(r => setTimeout(r, ms))
            const noteEl = document.getElementById('status-note')
            const runSearch = async (q) => {
              window.__cursive.sidebar.openSearch()
              await wait(200)
              const input = document.querySelector('.fs-input')
              input.value = q
              input.dispatchEvent(new Event('input', { bubbles: true }))
              await wait(1400)   // 防抖 220ms + 壳侧扫一遍夹具目录
            }
            // ① 三份夹具里的「术语」→「名词」，但**最后一处勾掉**
            await runSearch('术语')
            const found = document.querySelectorAll('.fs-hit').length
            const picks = [...document.querySelectorAll('.fs-pick')]
            const offRow = picks.length ? picks[picks.length - 1].closest('.fs-hit') : null
            const offText = offRow ? offRow.textContent : null
            if (picks.length) picks[picks.length - 1].click()
            await wait(150)
            const btnLabel = document.querySelector('.fs-replace-all').textContent
            document.querySelector('.fs-replace').value = '名词'
            noteEl.textContent = ''
            document.querySelector('.fs-replace-all').click()
            await wait(1800)
            const replacedNote = noteEl.textContent
            // ② 另一份：改完当场撤销，盘上要逐字节回到改之前
            await runSearch('待撤销')
            document.querySelector('.fs-replace').value = '改过了'
            noteEl.textContent = ''
            document.querySelector('.fs-replace-all').click()
            await wait(1800)
            const undoNote = noteEl.textContent
            const undoBtn = noteEl.querySelector('.note-act')
            if (undoBtn) undoBtn.click()
            await wait(1500)
            replaceProbe = { found, offText, btnLabel, replacedNote, undoNote,
                             undoneNote: noteEl.textContent }
          } catch (e) {
            replaceProbe = { err: String(e) }
          }
        }
        // 0.4.0 F1 折叠一节：把手 → 折起来 → 药丸 → 展开，外加菜单那条路。
        // **看行数**（.cm-line 的个数）而不是看装饰在不在：折叠这件事要的就是
        // 「屏幕上真的少了几行」，装饰对不对是单测的事
        // 摆在 callout.md 上：它有一个标题、正文够长，而且**这条用例不切标签**
        // （dialect.md 那条的标签右键探针跑完，活动标签早就换成别的文档了）
        let foldProbe = null
        if (path.indexOf('callout.md') >= 0) {
          try {
            const wait = (ms) => new Promise(r => setTimeout(r, ms))
            const v = window.__cursive.view
            const lines = () => document.querySelectorAll('.cm-line').length
            const docBefore = v.state.doc.toString()
            const before = lines()
            // ① 标题行右边那颗把手（平时透明，鼠标扫到才显形 —— 探针直接派事件）
            const handle = document.querySelector('.cm-lp-fold')
            const handles = document.querySelectorAll('.cm-lp-fold').length
            if (handle) handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
            await wait(300)
            const folded = lines()
            const pill = document.querySelector('.cm-lp-section-more')
            const pillText = pill ? pill.textContent : null
            // ② 药丸点一下展开
            if (pill) pill.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
            await wait(300)
            const back = lines()
            // ③ 菜单那条路：光标放进第二节的正文里再折，折完光标要落在标题行上
            //（不挪的话它就留在藏起来的正文里，而「落点掉进折叠区」会当场把它展开）
            const hs = [...document.querySelectorAll('.cm-lp-h2, .cm-lp-h1')]
            const anchor = v.state.doc.line(Math.min(v.state.doc.lines, 4)).from
            v.dispatch({ selection: { anchor } })
            await wait(120)
            window.__shellEmit('menu', 'view:toggle-fold')
            await wait(300)
            const menuFolded = lines()
            const caretLine = v.state.doc.lineAt(v.state.selection.main.head).text
            // ④ 落点掉进折叠区 = 当场展开（查找 / 大纲 / 跨文件搜索都走这条）
            const deep = Math.min(v.state.doc.length - 1, v.state.doc.line(Math.min(v.state.doc.lines, 8)).from)
            v.dispatch({ selection: { anchor: deep } })
            await wait(300)
            const reopened = lines()
            foldProbe = { before, folded, back, handles, pillText, menuFolded, caretLine,
                          reopened, byteSafe: v.state.doc.toString() === docBefore }
          } catch (e) {
            foldProbe = { err: String(e) }
          }
        }
        // 0.3.0 T4 停用自定义皮肤（安全出口）。release.sh 在 themes/ 里放了一张
        // 认得出来的皮肤（把 .cm-content 染成 rgb(1,2,3)），这一段走完整条路：
        // 面板里选上 → 真的生效 → 菜单停用 → 真的摘掉 → 再启用 → 又回来。
        // **断言看的是计算样式而不是那个 <style> 元素在不在** —— 「挂上了但一条没生效」
        // 正是这一轮顺带要补的那种静默失败，拿元素当证据等于没测
        let skinProbe = null
        if (path.indexOf('table.md') >= 0) {
          try {
            const wait = (ms) => new Promise(r => setTimeout(r, ms))
            const bg = () => getComputedStyle(document.querySelector('.cm-content')).backgroundColor
            const noteEl = document.getElementById('status-note')
            window.__shellEmit('menu', 'app:preferences')
            await wait(400)
            const sel = document.querySelector('#pf-custom')
            const listed = sel ? [...sel.options].map(o => o.value) : []
            if (sel) {
              sel.value = 'e2e-skin'
              sel.dispatchEvent(new Event('change', { bubbles: true }))
              await wait(300)
            }
            const onBg = bg()
            window.__shellEmit('menu', 'app:preferences')   // 关面板
            await wait(200)
            noteEl.textContent = ''
            // 停用：这条菜单项是皮肤把界面画花时唯一还按得到的东西
            window.__shellEmit('menu', 'view:disable-custom-theme')
            await wait(300)
            const offBg = bg()
            const offNote = noteEl.textContent
            // 再按一次要回得去（皮肤改好之后人手边只有这条菜单）
            window.__shellEmit('menu', 'view:disable-custom-theme')
            await wait(300)
            const backBg = bg()
            const backNote = noteEl.textContent
            // 收干净：把皮肤退选，别让它跟着 localStorage 留给后面的用例和开发机
            window.__shellEmit('menu', 'app:preferences')
            await wait(300)
            const sel2 = document.querySelector('#pf-custom')
            if (sel2) {
              sel2.value = ''
              sel2.dispatchEvent(new Event('change', { bubbles: true }))
              await wait(200)
            }
            window.__shellEmit('menu', 'app:preferences')
            await wait(150)
            skinProbe = { listed, onBg, offBg, backBg, offNote, backNote, cleaned: bg() }
          } catch (e) {
            skinProbe = { err: String(e) }
          }
        }
        // 0.3.0 T3 导出为长图：与导出 HTML 同一份 HTML，壳侧离屏渲染 + 快门。
        // 自检下壳绕过保存面板，落到 CURSIVE_SMOKE_PNG 指的路径（没设就整段不跑）
        let pngProbe = null
        if (pngOut) {
          try {
            const noteEl = document.getElementById('status-note')
            noteEl.textContent = ''
            // 要的宽度 = 正文栏宽（`--column` 是 rem，导出物根字号 16px）。
            // 报上去让 release.sh 对账：成图宽度必须正好是它的 2 倍
            const colRem = parseFloat(getComputedStyle(document.documentElement)
              .getPropertyValue('--column')) || 42
            window.__shellEmit('menu', 'file:export-png')
            // 离屏加载 → 等字体与图片 → 快门 → 写盘，给够时间
            await new Promise((r) => setTimeout(r, 3000))
            pngProbe = { note: noteEl.textContent, wantWidth: Math.round(colRem * 16) }
          } catch (e) {
            pngProbe = { err: String(e) }
          }
        }
        // 0.3.0 T2 检查更新：菜单 → 壳 → 状态栏 → 那颗按钮。自检下壳**一个字节都不联网**
        // （`CURSIVE_SMOKE_UPDATE` 里逗号分隔的版本依次作答），所以这条用例在断网的机器上
        // 也跑得过 —— E2E 要验的本来就是「这条线通不通」，不是 GitHub 今天在不在
        let updateProbe = null
        if (path.indexOf('crlf.md') >= 0) {
          try {
            const wait = (ms) => new Promise(r => setTimeout(r, ms))
            const noteEl = document.getElementById('status-note')
            noteEl.textContent = ''
            // ① 有新版本。**先不 await**：`note('正在检查更新…')` 是同步发生的，
            // 这一读守的是「点完当场有声」——一次往返要过网络，中间静默就是「点了没反应」
            window.__shellEmit('menu', 'app:check-update')
            const pendingText = noteEl.textContent
            await wait(500)
            const foundText = noteEl.textContent
            const btn = noteEl.querySelector('.note-act')
            const foundBtn = btn ? btn.textContent : null
            // 按下那颗按钮才把 release 页交给系统（自检下只记账，见 smokeExternal）——
            // 「点一下菜单就跳出浏览器」不是这个应用说话的方式
            if (btn) btn.click()
            await wait(300)
            // ② 同一个进程里再问一次，替身这回回的是当前版本 → 已是最新，且不该有按钮
            window.__shellEmit('menu', 'app:check-update')
            await wait(500)
            const latestText = noteEl.textContent
            const latestBtn = noteEl.querySelector('.note-act')
            // ③ 那边还没发过 release（真实世界里的 404）。**不是失败**，所以不该是黄的
            window.__shellEmit('menu', 'app:check-update')
            await wait(500)
            const noneText = noteEl.textContent
            const noneWarn = noteEl.classList.contains('is-warn')
            // ④ 没问着（断网那一种）：只有这一句是黄的
            window.__shellEmit('menu', 'app:check-update')
            await wait(500)
            const failText = noteEl.textContent
            const failWarn = noteEl.classList.contains('is-warn')
            updateProbe = { pendingText, foundText, foundBtn, latestText, latestBtn: !!latestBtn,
                            noneText, noneWarn, failText, failWarn }
          } catch (e) {
            updateProbe = { err: String(e) }
          }
        }
        // P3-7 多窗口：放在**最末尾** —— 新窗口会抢走 key，前面那些量位置/焦点的断言
        // 必须都跑完了。窗口数由壳侧在写 JSON 时补上（网页看不到原生的窗口表）
        // 契约 v14：带文件夹开新窗口（「打开文件夹 = 新窗口」走的就是这条）
        // secondWindow：崩溃恢复用例也开一个 —— 「草稿只交出去一次」这条不变量，
        // 得有第二个窗口真去问一次 scratchList 才测得出来。它要跑完整条启动路径，等久一点
        const wantsSecond = path.indexOf('kitchen-sink.md') >= 0 || secondWindow
        if (wantsSecond) window.api.newWindow(docDir)
        await new Promise((r) => setTimeout(r, secondWindow ? 1600 : 700))
        return {
          fingerprint: doc.fingerprint,
          autosaved: after.content.includes('autosave-check-marker'),
          autosaveWaited,
          reloaded, reloadWaited,
          jsOK: true,
          img: img
            ? { loaded: img.complete && img.naturalWidth > 0, src: img.getAttribute('src') }
            : null,
          v020,
          tabProbe,
          sbToggle: { afterToggle: sbAfterToggle, sbClassAfter, restored: sbRestored },
          tabHit,
          tbGutter,
          tbToggle: { hidden: tbHidden, restored: tbBack, onWhileHidden: tbOn },
          tbHitPage,
          tbMidY,
          tableEdit,
          handles,
          treeProbe,
          findProbe,
          linkProbe,
          foldProbe,
          listFoldProbe,
          tagProbe,
          zoomProbe,
          replaceProbe,
          skinProbe,
          pngProbe,
          updateProbe,
          htmlProbe,
          formatProbe,
          barProbe,
          codeFence,
          searchProbe,
          pasteProbe,
          dropProbe,
          math,
          mermaid,
          codeHl,
          calloutProbe,
          outlineRows,
          writingProbe,
          outlineProbe,
          statsProbe,
          counts,
          cmLines: document.querySelectorAll('.cm-line').length
        }
        } catch (e) {
          return { jsError: String(e), stack: e && e.stack ? String(e.stack).slice(0, 300) : null }
        }
        """
        webView.callAsyncJavaScript(
            body,
            arguments: ["path": source, "outPath": outPath, "docDir": docDir,
                        // 目检开关：截图前把跨文件搜索面板留在开着的状态
                        "shotSearch": ProcessInfo.processInfo.environment["CURSIVE_SMOKE_SHOT_SEARCH"] != nil,
                        // 崩溃恢复那一轮（种了草稿 + 拖慢应答）末尾也开第二个窗口
                        "secondWindow": ProcessInfo.processInfo.environment["CURSIVE_SMOKE_SCRATCH_DELAY"] != nil,
                        // 0.3.0 T3：设了才跑导出长图那一段（壳侧据它绕过保存面板）
                        "pngOut": ProcessInfo.processInfo.environment["CURSIVE_SMOKE_PNG"] ?? "",
],
            in: nil, in: .page
        ) { [weak self] result in
            guard let self else { return }
            var out: [String: Any] = [
                "source": source, "roundtrip": outPath,
                "recents": NSDocumentController.shared.recentDocumentURLs.count
            ]
            // P3-7：探针刚请壳开了第二个窗口，这里数一下窗口表（网页那侧看不到原生窗口）
            out["windows"] = appDelegate?.windows.count ?? 0
            // 每个窗口的树根：带文件夹开出来的那个应该立刻就位（守卫要用）
            out["windowRoots"] = appDelegate?.windows.map { $0.treeRoot ?? "" } ?? []
            // 崩溃恢复的「一次性」不变量（见 `recoverableScratch`）：
            // 问过几次 / 交出去几份 / 候选集里还剩几份
            // 0.2.0：复制为富文本走到了没有、两种风味都非空没有（自检下不写剪贴板）
            out["copyHtml"] = smokeCopyHtml
            // 0.2.0 链接跳转：⌘+点击把哪些地址交给了系统（自检下没真的打开）
            out["external"] = smokeExternal
            out["scratchQueries"] = scratchQueries
            out["scratchHandouts"] = scratchHandouts
            out["scratchPending"] = recoverableScratch.count
            switch result {
            case .success(let v):
                out["result"] = v
                if let a = try? Data(contentsOf: URL(fileURLWithPath: source)),
                   let b = try? Data(contentsOf: URL(fileURLWithPath: outPath)) {
                    out["bytesEqual"] = a == b
                } else { out["bytesEqual"] = false }
            case .failure(let e):
                out["error"] = e.localizedDescription
                out["bytesEqual"] = false
            }
            self.writeJSON(out, to: "/tmp/cursive-shell-e2e.json")
            self.captureShot {
            // CURSIVE_SMOKE_PDF=<路径>：顺带验证 PDF 导出（绕过保存面板）
            // 空串当没设：release.sh 里这个变量对大多数用例是空的（只有 mermaid 那条导 PDF）
            if let pdfOut = ProcessInfo.processInfo.environment["CURSIVE_SMOKE_PDF"], !pdfOut.isEmpty {
                let finish: ([String: Any]) -> Void = { result in
                    self.writeJSON(result, to: "/tmp/cursive-shell-pdf.json")
                    NSApp.terminate(nil)
                }
                self.fetchExportHtml { html in
                    guard let html else { return finish(["out": pdfOut, "error": "没拿到导出 HTML"]) }
                    // 自检默认 A4 + 标准页边距 + 页码；另两档纸张/页边距用环境变量走查
                    var opts = PDFOptions()
                    let env = ProcessInfo.processInfo.environment
                    if let p = env["CURSIVE_SMOKE_PDF_PAPER"], let v = PaperSize(rawValue: p) { opts.paper = v }
                    if let m = env["CURSIVE_SMOKE_PDF_MARGIN"], let v = PageMargin(rawValue: m) { opts.margin = v }
                    // 0.2.0：书签走和真导出同一条路（fetchOutline → printPDF），
                    // 自检才守得住它 —— 只在真导出里接一遍，等于没接
                    self.fetchOutline { outline in
                        self.printPDF(html: html, out: URL(fileURLWithPath: pdfOut), opts: opts,
                                      outline: outline) { result in
                            var pdfResult: [String: Any] = ["out": pdfOut, "headings": outline.count]
                            switch result {
                            case .success(let stats):
                                pdfResult["bytes"] = (try? Data(contentsOf: URL(fileURLWithPath: pdfOut)))?.count ?? 0
                                pdfResult["pages"] = stats.pages
                                pdfResult["width"] = Int(stats.width.rounded())
                                pdfResult["height"] = Int(stats.height.rounded())
                                pdfResult["bookmarks"] = stats.bookmarks
                                pdfResult["bookmarksReadBack"] = stats.readBack
                            case .failure(let e):
                                pdfResult["error"] = e.localizedDescription
                            }
                            finish(pdfResult)
                        }
                    }
                }
            } else {
                NSApp.terminate(nil)
            }
            }
        }
    }

    /// CURSIVE_SMOKE_SHOT=<路径>：整窗截图（含 sidebar / tabbar / outline / status-bar）。
    /// 目检 chrome 必须走这条 —— PDF 那条路的 printCSS 第一行就把这些面板全 display:none 了。
    private func captureShot(then next: @escaping () -> Void) {
        guard let out = ProcessInfo.processInfo.environment["CURSIVE_SMOKE_SHOT"] else { return next() }
        // 两个开关**可以叠加**（0.2.0 改）：主题先切、再派菜单动作，于是
        // 「深色下的命令面板」「护眼下的版本历史」这类走查一条命令就能拍。
        // 原先各自 return，谁在前谁独占 —— 想拍深色面板只能改代码
        //
        // CURSIVE_SMOKE_THEME=dark|light|sepia|system：截图前先切主题（视觉走查三套配色用；
        // 它会写进 localStorage，走查完记得用 system 复位）
        // CURSIVE_SMOKE_MENU=<action>：截图前派一个任意菜单动作（目检设置面板这类用）
        let env = ProcessInfo.processInfo.environment
        let theme = env["CURSIVE_SMOKE_THEME"].flatMap {
            ["dark", "light", "sepia", "system"].contains($0) ? $0 : nil
        }
        let action = env["CURSIVE_SMOKE_MENU"]
        if theme == nil, action == nil { return shotJS(to: out, then: next) }
        if let theme { webView.evaluateJavaScript("window.__shellEmit('menu', 'view:theme-\(theme)')") }
        // 主题切换要重建整份装饰，等它落定再派第二个动作（面板要在新配色上画出来）
        let gap = theme == nil ? 0.0 : 0.4
        DispatchQueue.main.asyncAfter(deadline: .now() + gap) {
            if let action { self.webView.evaluateJavaScript("window.__shellEmit('menu', \(jsonLiteral(action)))") }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.shotJS(to: out, then: next) }
        }
    }

    /// CURSIVE_SMOKE_SHOT_JS=<一段 JS>：快门按下之前跑一次，用来给截图「摆姿势」——
    /// 把光标挪走（不然光标所在行会回显源码，标题上挂着个 `#`，不知情的人会以为没渲染）、
    /// 收掉浮动格式栏、滚到某一处。跑完等一帧再拍。
    private func shotJS(to out: String, then next: @escaping () -> Void) {
        guard let js = ProcessInfo.processInfo.environment["CURSIVE_SMOKE_SHOT_JS"] else {
            return snapshot(to: out, then: next)
        }
        // `CURSIVE_SMOKE_SHOT_WAIT=<毫秒>`：快门前多等一会儿。
        // **异步的摆姿势脚本需要它**：`evaluateJavaScript` 在脚本**开始**执行时就回调了
        // （一个 async IIFE 当场就返回 Promise），默认那 350ms 等不到它做完 ——
        // 想拍「开几个标签再右键」这种画面，不给够时间拍到的是菜单弹出之前的一帧
        let wait = Double(ProcessInfo.processInfo.environment["CURSIVE_SMOKE_SHOT_WAIT"] ?? "") ?? 350
        webView.evaluateJavaScript(js) { _, err in
            if let err { FileHandle.standardError.write("[shotJS] \(err)\n".data(using: .utf8)!) }
            DispatchQueue.main.asyncAfter(deadline: .now() + wait / 1000) { self.snapshot(to: out, then: next) }
        }
    }

    private func snapshot(to out: String, then next: @escaping () -> Void) {
        let cfg = WKSnapshotConfiguration()
        cfg.rect = webView.bounds
        webView.takeSnapshot(with: cfg) { [weak self] image, err in
            var res: [String: Any] = ["out": out]
            if let image, let tiff = image.tiffRepresentation,
               let rep = NSBitmapImageRep(data: tiff),
               let png = rep.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: out))
                res["bytes"] = png.count
                res["size"] = "\(rep.pixelsWide)x\(rep.pixelsHigh)"
            } else {
                res["error"] = err?.localizedDescription ?? "snapshot failed"
            }
            self?.writeJSON(res, to: "/tmp/cursive-shell-shot.json")
            next()
        }
    }
}


// MARK: - AppDelegate（应用级：菜单 / 最近文件 / 窗口表）

/// 全局单例引用：窗口侧要回调菜单勾选与「再开一个窗口」。
/// `NSApp.delegate as? AppDelegate` 每次都要转型，不如存一份
weak var appDelegate: AppDelegate?

final class AppDelegate: NSObject, NSApplicationDelegate {
    /// 视图 → 主题 的四个菜单项，setAppearance 回来时同步勾选
    private var themeItems: [NSMenuItem] = []
    /// 视图里带勾的开关项（键名与 types.ts 的 ViewFlags 字段一一对应）
    private var viewFlagItems: [String: NSMenuItem] = [:]
    /// 所有开着的窗口。强引用在这里 —— WindowController 自己不被别人持有
    private(set) var windows: [WindowController] = []

    /// 菜单命令落到哪个窗口：当前 key 窗口，没有 key（比如刚从 Dock 点回来）就取最后开的那个
    var key: WindowController? {
        windows.first { $0.window?.isKeyWindow == true } ?? windows.last
    }

    /// **菜单和全局引用必须在这里就位**：Finder 双击 .md 时 `application(_:openFile:)`
    /// 排在 will 与 did 之间，那会儿就要开窗口了 —— 放在 didFinishLaunching 里等于晚一步
    func applicationWillFinishLaunching(_ notification: Notification) {
        mark("willFinishLaunching")
        appDelegate = self
        // 首帧的深浅（见 `applyStartupAppearance`）—— 要赶在第一个窗口之前
        applyStartupAppearance()
        // **在任何窗口出现之前**把「上次留下的草稿」定下来（见 `recoverableScratch`）
        snapshotRecoverableScratch()
        buildMenu()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // **只在一个窗口都还没有时才开**：Finder 双击 / `open file.md` 走的是
        // `application(_:openFile:)`，它排在 didFinishLaunching **之前**，
        // 那会儿窗口已经开好了 —— 这里再开一个就是「打开一个 md 弹出两个窗口」。
        // argv 那条路同理：带文件名直接跑二进制时 openFile: 照样会先到一发
        guard windows.isEmpty else { return }
        // argv 打开文档：cursive-shell /path/to/file.md
        let arg = CommandLine.arguments.dropFirst().first {
            !$0.hasPrefix("-") && FileManager.default.fileExists(atPath: $0)
        }
        newWindow(open: arg.map { URL(fileURLWithPath: $0).standardizedFileURL.path })
    }

    /// 契约 v17：把一份偏好转给**除发起者以外**的窗口。
    /// 发起者自己已经改完了，再推回去等于让它把自己 adopt 一遍（多余，且容易演成互推）
    func broadcastPrefs(_ values: Any, except origin: WindowController) {
        for wc in windows where wc !== origin { wc.receivePrefs(values) }
    }

    @discardableResult
    func newWindow(open path: String? = nil) -> WindowController {
        let wc = WindowController(primary: windows.isEmpty, open: path)
        windows.append(wc)
        return wc
    }

    @objc func newWindowItem(_ sender: Any?) { newWindow() }

    func windowClosed(_ wc: WindowController) {
        windows.removeAll { $0 === wc }
    }

    /// Finder 双击 .md / 「打开方式」/ `open -a`：**开在一个工作区罩得住它的那个窗口里**。
    /// 有窗口的树根正好是它所在的目录（或祖先目录）→ 在那儿开一个新标签（同一个文件夹里的
    /// 第二个文件不该再弹一个窗口）；没有 → 新开一个，树根落在它自己的目录上。
    /// 从前是「一律塞给当前窗口」，于是一个窗口里会同时摆着 A 文件夹的树和 B 文件夹的文档。
    /// **文件夹一律开新窗口** —— 一个窗口 = 一个工作区（与渲染层的「打开文件夹」同一条规矩）
    func application(_ sender: NSApplication, openFile filename: String) -> Bool {
        // **先转成绝对路径**：命令行 `cursive-shell a.md` 也会先走这一发（见
        // `applicationDidFinishLaunching` 的注释），AppKit 把 argv 里那个相对路径原样递过来。
        // 相对路径进了渲染层，`shared/path.ts` 的 `dirname()` 找不到目录分隔符 → 返回 null
        // → `docDir` 是 null → 正文里 `![](docs/x.png)` 这类相对路径图片**一张都渲染不出来**
        // （退化成 alt + 灰路径），侧边栏也开不出文件树。argv 那条路本来就 standardize 过，
        // 这里补齐的是「openFile: 抢先到达」的那条。
        let path = URL(fileURLWithPath: filename).standardizedFileURL.path
        if isDirectory(path) { newWindow(open: path); return true }
        if let wc = windowOwning(path) {
            wc.window?.makeKeyAndOrderFront(nil)
            wc.openFile(path)
        } else {
            newWindow(open: path)
        }
        return true
    }

    /// 工作区罩得住这个文件的窗口：树根就是它所在的目录，或者是它的祖先目录
    /// （后者正是渲染层 `setActive` 会逐级展开到它的那种情形）。当前窗口优先。
    private func windowOwning(_ path: String) -> WindowController? {
        guard let dir = parentDir(path).map({ ($0 as NSString).standardizingPath }) else { return nil }
        let owns = { (wc: WindowController) -> Bool in
            guard let root = wc.treeRoot.map({ ($0 as NSString).standardizingPath }), !root.isEmpty
            else { return false }
            return dir == root || dir.hasPrefix(root + "/")
        }
        if let current = key, owns(current) { return current }
        return windows.first(where: owns)
    }

    /// 最后一个窗口关掉后应用不退出（多窗口应用的标准行为）；
    /// 点 Dock 图标回来时没有窗口就补一个，否则只剩一条菜单栏、无路可走
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if windows.isEmpty { newWindow() }
        return true
    }

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu(title: "Cursive")
        appMenu.addItem(NSMenuItem(title: L("menu.app.about"), action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""))
        // 0.3.0 T2：紧跟「关于」—— 两条都是「这个 app 本身」那一类，
        // 而 macOS 上找「有没有新版本」的人第一眼就看这儿
        appMenu.addItem(item(L("menu.app.checkUpdate"), "app:check-update", key: ""))
        appMenu.addItem(.separator())
        appMenu.addItem(item(L("menu.app.settings"), "app:preferences", key: ","))
        appMenu.addItem(.separator())
        appMenu.addItem(NSMenuItem(title: L("menu.app.hide"), action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"))
        appMenu.addItem(NSMenuItem(title: L("menu.app.hideOthers"), action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h"))
        appMenu.addItem(NSMenuItem(title: L("menu.app.quit"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appItem.submenu = appMenu

        let fileItem = NSMenuItem(); main.addItem(fileItem)
        let file = NSMenu(title: L("menu.file"))
        file.addItem(item(L("menu.file.new"), "file:new", key: "n"))
        // P3-7：新窗口由壳自己开（不经渲染层），所以走 #selector 而不是 menuAction
        file.addItem(NSMenuItem(title: L("menu.file.newWindow"), action: #selector(newWindowItem(_:)), keyEquivalent: "N"))
        file.addItem(item(L("menu.file.open"), "file:open", key: "o"))
        file.addItem(item(L("menu.file.openFolder"), "file:open-folder", key: "o", modifiers: [.command, .shift]))
        // 0.2.0 快速打开：⌘T 而不是同类编辑器常见的 ⌘P —— ⌘P 在 macOS 上是「打印」，
        // 这份菜单里已经归了导出 PDF（那才是用户按 ⌘P 时想要的东西）
        file.addItem(item(L("menu.file.quickOpen"), "file:quick-open", key: "t"))

        let recentItem = NSMenuItem(title: L("menu.file.recent"), action: nil, keyEquivalent: "")
        recentItem.submenu = recentMenu()
        file.addItem(recentItem)
        file.addItem(.separator())
        file.addItem(item(L("menu.file.save"), "file:save", key: "s"))
        file.addItem(item(L("menu.file.saveAs"), "file:save-as", key: "s", modifiers: [.command, .shift]))
        file.addItem(.separator())
        // P4-1：导出走渲染层（正文与实时预览同一棵语法树），所以是 menuAction 而不是 #selector
        // 0.2.0 版本历史：和导出摆在一起 —— 都是「对这份文件做点什么」，不是编辑动作。
        // 不给快捷键：⌥⌘H 在 macOS 上是「隐藏其他」，别的空位也都不顺手，
        // 它本来就是偶尔用一次的东西（命令面板里一样找得到）
        file.addItem(item(L("menu.file.history"), "file:history", key: ""))
        file.addItem(.separator())
        file.addItem(item(L("menu.file.exportHtml"), "file:export-html", key: "e", modifiers: [.command, .shift]))
        // 0.4.0 还的第四条账之后 **⌘P 归「打印」**（macOS 的通行键位），导出 PDF 让到 ⇧⌘P。
        // 从前的安排是「⌘P 直接导出 PDF」，理由是「那才是按 ⌘P 的人想要的」——
        // 有了真打印机路径之后这条理由不成立了：系统打印面板左下角就有「存为 PDF」，
        // 而一台真打印机在从前那套里**根本够不着**
        let pdfItem = NSMenuItem(title: L("menu.file.exportPdf"), action: #selector(exportPDF(_:)),
                                 keyEquivalent: "p")
        pdfItem.keyEquivalentModifierMask = [.command, .shift]
        file.addItem(pdfItem)
        // 0.3.0 T3：三条导出连在一起。不给快捷键 —— ⌘P/⇧⌘E 已经占了两条顺手的键位，
        // 而剩下的空位没有一个是「导出长图」按下去顺理成章的（命令面板里一样找得到）
        file.addItem(item(L("menu.file.exportPng"), "file:export-png", key: ""))
        file.addItem(.separator())
        file.addItem(NSMenuItem(title: L("menu.file.print"), action: #selector(printDocument(_:)),
                                keyEquivalent: "p"))
        file.addItem(.separator())
        // ⌘W 关标签（渲染层管标签表）、⇧⌘W 关窗口 —— macOS 上有标签的应用都是这么分的
        file.addItem(item(L("menu.file.closeTab"), "file:close-tab", key: "w"))
        file.addItem(NSMenuItem(title: L("menu.file.close"), action: Selector(("performClose:")), keyEquivalent: "W"))
        fileItem.submenu = file

        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: L("menu.edit"))
        // ⚠️ WKWebView 里 ⌘C/⌘V 生效的前提：存在接线的「编辑」菜单
        // 撤销 / 重做走渲染层（0.4.0 修）。**不能是 AppKit 的 `undo:`/`redo:`** ——
        // 那两个选择器沿响应链落进 WKWebView，撤的是 WebKit 自己那套 DOM 编辑撤销栈，
        // 而文档的真历史在 CodeMirror 里。表格改结构时整张表的格子都会重建，
        // WebKit 栈里的记录当场变成死记录：`canUndo` 还是真（菜单项照亮、照吃 ⌘Z），
        // 可它既不派 `beforeinput` 也不做事 —— ⌘Z 落进死路。理由全文见
        // `src/shared/types.ts` 里 `MenuAction` 的 'edit:undo'。
        // 剪切/拷贝/粘贴仍用原生选择器：那三条本来就该归 WebKit（见上面那行 ⚠️）
        edit.addItem(item(L("menu.edit.undo"), "edit:undo", key: "z"))
        edit.addItem(item(L("menu.edit.redo"), "edit:redo", key: "z", modifiers: [.command, .shift]))
        edit.addItem(.separator())
        edit.addItem(NSMenuItem(title: L("menu.edit.cut"), action: Selector(("cut:")), keyEquivalent: "x"))
        edit.addItem(NSMenuItem(title: L("menu.edit.copy"), action: Selector(("copy:")), keyEquivalent: "c"))
        edit.addItem(NSMenuItem(title: L("menu.edit.paste"), action: Selector(("paste:")), keyEquivalent: "v"))
        edit.addItem(NSMenuItem(title: L("menu.edit.selectAll"), action: Selector(("selectAll:")), keyEquivalent: "a"))
        edit.addItem(.separator())
        // P2-4：粘贴为纯文本（⇧⌥⌘V）—— ⌘ 组合一律走菜单（判断 1）
        edit.addItem(item(L("menu.edit.pastePlain"), "edit:paste-plain", key: "v", modifiers: [.command, .option, .shift]))
        // 0.2.0：拷贝的对面 —— 把当前文档按富文本放上剪贴板（契约 v20）
        edit.addItem(item(L("menu.edit.copyHtml"), "edit:copy-html", key: "c", modifiers: [.command, .option, .shift]))
        edit.addItem(.separator())
        edit.addItem(item(L("menu.edit.find"), "edit:find", key: "f"))
        // 面板里的替换那一行平时收着，这条菜单（和面板左边那颗三角）是把它摊开的两条路。
        // **不是 macOS 标准的 ⌥⌘F** —— 那个键位这里归「专注模式」（P3-3 先占的），
        // 而 AppKit 按菜单顺序取第一个匹配、编辑菜单排在视图菜单前面，
        // 真写成 ⌥⌘F 就等于把专注模式的键抢走了（同 ⌃⌘F 全屏那条坑）
        edit.addItem(item(L("menu.edit.replace"), "edit:replace", key: "r", modifiers: [.command, .option]))
        // P3-2：⌘⇧F 从 P3-3 起就给它留着了（专注模式那时特意避开）
        edit.addItem(item(L("menu.edit.findInFiles"), "edit:find-in-files", key: "f", modifiers: [.command, .shift]))
        edit.addItem(item(L("menu.edit.findNext"), "edit:find-next", key: "g"))
        edit.addItem(item(L("menu.edit.findPrev"), "edit:find-prev", key: "g", modifiers: [.command, .shift]))
        // 0.2.0 多光标：`allowMultipleSelections` 与 `rectangularSelection` 早就挂着，
        // 缺的一直是一个**按得到**的键 —— `performKeyEquivalent` 把所有带 ⌘ 的事件
        // 交还给菜单（判断 1），而菜单里没有这一条，于是 searchKeymap 的 ⌘D 一直是死的。
        // 补一条菜单项就活了，且不必去赌「⌘ 键能不能落回 CodeMirror」那个没实测过的问题
        edit.addItem(item(L("menu.edit.selectNext"), "edit:select-next", key: "d"))
        editItem.submenu = edit

        // P2-1：格式菜单 —— ⌘ 组合全部走原生菜单（判断 1），
        // 绝不交给 CM keymap（performKeyEquivalent 放行了命令键反而会乱）
        let formatItem = NSMenuItem(); main.addItem(formatItem)
        let format = NSMenu(title: L("menu.format"))
        format.addItem(item(L("fmt.bold"), "fmt:bold", key: "b"))
        format.addItem(item(L("fmt.italic"), "fmt:italic", key: "i"))
        format.addItem(item(L("fmt.underline"), "fmt:underline", key: "u"))
        format.addItem(item(L("fmt.strike"), "fmt:strikethrough", key: "x", modifiers: [.command, .shift]))
        format.addItem(item(L("fmt.codeInline"), "fmt:code-inline", key: "c", modifiers: [.command, .control]))
        // P2-9 命令表补齐。键位都挑的空位：h / m / = / - 在整份菜单里原先一个都没占，
        // ⌃⌘ 这一档本来就是「行内某某」（行内代码就在上一行）
        format.addItem(item(L("fmt.highlight"), "fmt:highlight", key: "h", modifiers: [.command, .shift]))
        format.addItem(item(L("fmt.superscript"), "fmt:superscript", key: "=", modifiers: [.command, .control]))
        format.addItem(item(L("fmt.subscript"), "fmt:subscript", key: "-", modifiers: [.command, .control]))
        format.addItem(item(L("fmt.mathInline"), "fmt:math-inline", key: "m", modifiers: [.command, .control]))
        format.addItem(item(L("fmt.link"), "fmt:link", key: "k"))
        format.addItem(.separator())
        format.addItem(item(L("fmt.h1"), "fmt:h1", key: "1"))
        format.addItem(item(L("fmt.h2"), "fmt:h2", key: "2"))
        format.addItem(item(L("fmt.h3"), "fmt:h3", key: "3"))
        format.addItem(item(L("fmt.h4"), "fmt:h4", key: "4"))
        format.addItem(item(L("fmt.h5"), "fmt:h5", key: "5"))
        format.addItem(item(L("fmt.h6"), "fmt:h6", key: "6"))
        format.addItem(item(L("fmt.p"), "fmt:p", key: "0"))
        format.addItem(.separator())
        format.addItem(item(L("fmt.codeBlock"), "fmt:code-block", key: "k", modifiers: [.command, .shift]))
        format.addItem(item(L("fmt.quote"), "fmt:quote", key: "q", modifiers: [.command, .shift]))
        format.addItem(item(L("fmt.ulist"), "fmt:ulist", key: "[", modifiers: [.command, .shift]))
        format.addItem(item(L("fmt.olist"), "fmt:olist", key: "]", modifiers: [.command, .shift]))
        format.addItem(item(L("fmt.task"), "fmt:task", key: "c", modifiers: [.command, .shift]))
        // P2-9 插入类：不是开关而是「在光标处插一段骨架」，收进子菜单与上面那些分开。
        // 只有表格给了键位（⌃⌘T —— ⇧⌘T 归大纲、⌥⌘T 归打字机），其余全靠菜单和格式栏
        format.addItem(.separator())
        let insertItem = NSMenuItem(title: L("menu.insert"), action: nil, keyEquivalent: "")
        let insert = NSMenu(title: L("menu.insert"))
        insert.addItem(item(L("fmt.table"), "fmt:table", key: "t", modifiers: [.command, .control]))
        insert.addItem(item(L("fmt.image"), "fmt:image", key: ""))
        insert.addItem(item(L("fmt.hr"), "fmt:hr", key: ""))
        insert.addItem(item(L("fmt.mathBlock"), "fmt:math-block", key: ""))
        insert.addItem(item(L("fmt.callout"), "fmt:callout", key: ""))
        insert.addItem(item(L("fmt.mermaid"), "fmt:mermaid", key: ""))
        insert.addItem(item(L("fmt.footnote"), "fmt:footnote", key: ""))
        insert.addItem(item(L("fmt.toc"), "fmt:toc", key: ""))
        insertItem.submenu = insert
        format.addItem(insertItem)
        formatItem.submenu = format

        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: L("menu.view"))
        viewFlagItems = [
            "sidebar": item(L("view.sidebar"), "view:toggle-sidebar", key: "\\"),
            "outline": item(L("view.outline"), "view:toggle-outline", key: "t", modifiers: [.command, .shift]),
            // P2-8 底部悬浮格式栏；不给快捷键 —— 视图菜单里这几个键位已经很挤了
            "formatBar": item(L("view.formatBar"), "view:toggle-format-bar", key: ""),
            "source": item(L("view.source"), "view:toggle-source", key: "/"),
            // 0.3.0 T4：勾上 = 皮肤停着。不给快捷键 —— 它是个「出事那次才用」的开关
            "customOff": item(L("view.customOff"), "view:disable-custom-theme", key: ""),
            // P3-3 写作模式。⌥⌘F / ⌥⌘T：⌘ 组合一律走菜单（判断 1），
            // 且避开 ⌘⇧F（留给 P3-2 跨文件搜索）
            "focus": item(L("view.focus"), "view:toggle-focus", key: "f", modifiers: [.command, .option]),
            "typewriter": item(L("view.typewriter"), "view:toggle-typewriter", key: "t", modifiers: [.command, .option])
        ]
        // 这几项的勾由渲染层推过来（setViewFlags），标题就不再写「显示/隐藏」——
        // 勾本身已经说明了当前是开还是关
        for key in ["sidebar", "outline", "formatBar"] { view.addItem(viewFlagItems[key]!) }
        view.addItem(.separator())
        // 0.2.0 命令面板：⇧⌘P 是这类面板的通行键位，且这份菜单里还空着。
        // 它列的就是**这份菜单自己**（渲染层按 MenuAction 表生成），
        // 所以「菜单里有、面板里没有」这种漂移不会发生
        view.addItem(item(L("menu.view.palette"), "view:command-palette", key: "p", modifiers: [.command, .shift]))
        view.addItem(.separator())
        for key in ["source", "focus", "typewriter"] { view.addItem(viewFlagItems[key]!) }
        // 0.4.0 F1 折叠一节 / 0.4.1 折叠一条列表。**不带勾** —— 它不是视图开关，
        // 是对光标手边那一层的一次动作（里层的列表项优先于外层的小节）。
        //
        // ⌥⌘[ 是 VS Code 的折叠键位，这份菜单里空着；⇧⌘[ 在「格式」里是无序列表，
        // 差一个修饰键但不同菜单、不同动作，按错了也不会改文档。**一个键管折与展**：
        // 这条命令本来就是 toggle，再分出一个「展开」键等于让人记两个
        view.addItem(item(L("view.toggleFold"), "view:toggle-fold", key: "[", modifiers: [.command, .option]))
        view.addItem(.separator())
        let themeRoot = NSMenuItem(title: L("view.theme"), action: nil, keyEquivalent: "")
        let themeMenu = NSMenu(title: L("view.theme"))
        // 顺序必须与 syncThemeMenu 里的 order 一一对应
        themeItems = [
            item(L("theme.system"), "view:theme-system", key: ""),
            item(L("theme.light"), "view:theme-light", key: ""),
            item(L("theme.dark"), "view:theme-dark", key: ""),
            item(L("theme.sepia"), "view:theme-sepia", key: "")
        ]
        for mi in themeItems { themeMenu.addItem(mi) }
        themeMenu.addItem(.separator())
        // 标题栏右上角那颗月亮按钮的键盘版：在浅/深之间直接对切
        themeMenu.addItem(item(L("theme.toggleDark"), "view:toggle-dark", key: "d", modifiers: [.command, .control]))
        themeRoot.submenu = themeMenu
        view.addItem(themeRoot)
        // 0.3.0 T4 安全出口：紧跟主题子菜单（它就是主题那一类）。**带勾的开关**，
        // 而不是一次性的「停用」—— 皮肤改好之后要回得去，而那会儿人手边只有这条菜单。
        // 摆在原生菜单里是全部要点：页面被皮肤画成一片空白时，它照样在
        view.addItem(viewFlagItems["customOff"]!)
        view.addItem(.separator())
        // 0.4.1 正文缩放：三条都改走渲染层（缩的是正文字号与栏宽，不再是整张网页）。
        //
        // **「实际大小」从 ⌘0 挪到 ⌥⌘0**：⌘0 在「格式」菜单里是「正文」，而 AppKit
        // 按菜单顺序取第一个匹配、格式排在视图前面 —— 这条 ⌘0 从加进来那天起就是
        // 死键（判断 1 说的正是这件事）。⌘1–⌘6 是六级标题、⌘0 是正文，那一组更该留着
        view.addItem(item(L("view.actualSize"), "view:zoom-reset", key: "0", modifiers: [.command, .option]))
        view.addItem(item(L("view.zoomIn"), "view:zoom-in", key: "+"))
        view.addItem(item(L("view.zoomOut"), "view:zoom-out", key: "-"))
        view.addItem(.separator())
        // ⌃⌘F 是 macOS 全屏的标准键位。写成裸 "f" 的话就是 ⌘F，与编辑菜单的
        // 「查找」撞车 —— AppKit 按菜单顺序取第一个匹配，查找在前，全屏永远轮不到
        let fullScreen = NSMenuItem(title: L("view.fullScreen"), action: Selector(("toggleFullScreen:")), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        view.addItem(fullScreen)
        viewItem.submenu = view

        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: L("menu.window"))
        win.addItem(NSMenuItem(title: L("win.minimize"), action: Selector(("performMiniaturize:")), keyEquivalent: "m"))
        win.addItem(NSMenuItem(title: L("win.zoom"), action: Selector(("performZoom:")), keyEquivalent: ""))
        win.addItem(.separator())
        // 标签循环（0.2.x）。**必须是菜单项**：⌃Tab 落进 WKWebView 首先是 CodeMirror
        // 的事，而菜单的 performKeyEquivalent 排在所有键盘处理之前（判断 1 的同一条）。
        // 摆在「窗口」里也是与 Safari / Finder 同一个位置，顺带让这两条键看得见。
        // keyEquivalent 的 "\t" 就是 Tab —— AppKit 自己会把它画成 ⌃⇥ / ⌃⇧⇥
        win.addItem(item(L("win.nextTab"), "file:next-tab", key: "\t", modifiers: .control))
        win.addItem(item(L("win.prevTab"), "file:prev-tab", key: "\t", modifiers: [.control, .shift]))
        win.addItem(.separator())
        winItem.submenu = win
        // 交给 AppKit 自动维护窗口列表（标题来自 window.title，setDocState 每次都在刷）
        NSApp.windowsMenu = win

        NSApp.mainMenu = main
    }

    private func recentMenu() -> NSMenu {
        let menu = NSMenu(title: L("menu.file.recent"))
        let recents = NSDocumentController.shared.recentDocumentURLs.prefix(10)
        if recents.isEmpty {
            menu.addItem(NSMenuItem(title: L("recent.none"), action: nil, keyEquivalent: ""))
        } else {
            for url in recents {
                let mi = NSMenuItem(title: url.deletingPathExtension().lastPathComponent,
                                    action: #selector(openRecent(_:)), keyEquivalent: "")
                mi.representedObject = url.path
                mi.toolTip = url.path
                menu.addItem(mi)
            }
            menu.addItem(.separator())
            menu.addItem(NSMenuItem(title: L("recent.clear"),
                                    action: #selector(clearRecents(_:)), keyEquivalent: ""))
        }
        return menu
    }

    @objc func openRecent(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        if let wc = key { wc.openFile(path) } else { newWindow(open: path) }
    }

    @objc func clearRecents(_ sender: Any?) {
        NSDocumentController.shared.clearRecentDocuments(nil)
        buildMenu()
    }

    /// Dock 图标右键：最近文件
    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu(title: "dock")
        for url in NSDocumentController.shared.recentDocumentURLs.prefix(10) {
            let mi = NSMenuItem(title: url.deletingPathExtension().lastPathComponent,
                                action: #selector(openRecent(_:)), keyEquivalent: "")
            mi.representedObject = url.path
            mi.toolTip = url.path
            mi.target = self
            menu.addItem(mi)
        }
        return menu
    }

    private func item(_ title: String, _ action: String, key: String,
                      modifiers: NSEvent.ModifierFlags = .command) -> NSMenuItem {
        let mi = NSMenuItem(title: title, action: #selector(menuAction(_:)), keyEquivalent: key)
        mi.keyEquivalentModifierMask = modifiers
        mi.representedObject = action
        return mi
    }

    @objc func menuAction(_ sender: NSMenuItem) {
        key?.send(sender.representedObject as! String)
    }

    /// 「导出为 PDF…」「实际大小」这类要落到**某一个窗口**上的命令：
    /// 菜单是应用级的，动作转给当前 key 窗口
    @objc func exportPDF(_ sender: Any?) { key?.exportPDF(sender) }
    @objc func printDocument(_ sender: Any?) { key?.printDocument(sender) }

    /// 视图菜单的勾选状态。真相同样在渲染层，壳只是跟着显示
    func syncViewFlags(_ flags: [String: Any]) {
        for (key, mi) in viewFlagItems { mi.state = (flags[key] as? Bool) == true ? .on : .off }
    }

    /// 主题菜单的勾选状态。真相在渲染层（localStorage），壳只是跟着显示
    func syncThemeMenu(_ mode: String) {
        // 与 buildMenu 里 themeItems 的顺序一一对应；长度对不上就是越界，别用下标硬配
        let order = ["system", "light", "dark", "sepia"]
        for (i, mi) in themeItems.enumerated() where i < order.count {
            mi.state = order[i] == mode ? .on : .off
        }
    }
}

// MARK: - 入口

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
