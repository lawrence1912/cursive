// typmd 的原生 macOS 壳（spike → 可用的路线图起点）
//
// 目标：WKWebView 承载现有 out/renderer，window.api 的 15 个通道在 Swift 侧 1:1 实现，
// 渲染进程（CodeMirror 6 编辑器）零改动。
//
// 编译（无需 Xcode.app，CLT 即可）：
//   swiftc -O -swift-version 5 shell-swift/main.swift -o shell-swift/typmd-shell
// 运行（项目根目录）：
//   ./shell-swift/typmd-shell [file.md]

import AppKit
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

// MARK: - 注入渲染进程的 bridge（atDocumentStart，先于页面脚本）

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
  const listeners = { menu: [], 'file:opened': [], 'folder:opened': [] }

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
    pickFolder: () => call('pickFolder'),
    readDir: (path) => call('readDir', [path]),
    lastFolder: () => call('lastFolder')
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
})()
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
        let raw = url.path(percentEncoded: true)
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
        let resp = URLResponse(url: url,
                               mimeType: Self.mime[ext] ?? "application/octet-stream",
                               expectedContentLength: data.count, textEncodingName: ext == "js" || ext == "css" || ext == "html" ? "utf-8" : nil)
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

/// renderer 资源根：① 打包态 Bundle Resources（typmd.app/Contents/Resources/renderer）
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

// MARK: - 原生拖拽条
// `-webkit-app-region: drag` 是 Electron 专有扩展，WKWebView 不认识；
// 且 WKWebView 把 mouseDownCanMoveWindow 重写为 false（自己要处理鼠标事件），
// 所以窗口拖拽必须用一个透明的原生 NSView 叠在顶部实现。
// 高度对应 src/renderer/themes/base.css 的 --drag-strip: 38px，改那边记得同步这里。
final class DragStripView: NSView {
    override func mouseDown(with event: NSEvent) {
        // 确定性拖拽：直接进入窗口拖拽循环，不依赖 isMovableByWindowBackground 机制
        window?.performDrag(with: event)
    }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var mouseDownCanMoveWindow: Bool { true }
}

// MARK: - PDF 导出：离屏 A4 视图复用同一 renderer 渲染，createPDF 落盘
// 不改 renderer：加载 app://r/index.html，等 __typmd 就绪后用 __shellEmit 注入文档，
// 注入打印 CSS（隐 UI/白底/高度自适应），等字体+图片稳定后 capture。

final class PDFExporter: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    private let content: String
    private let docPath: String?
    private let out: URL
    private let rendererRoot: URL
    private var wv: WKWebView?
    private var completion: ((Result<URL, Error>) -> Void)?

    init(content: String, docPath: String?, out: URL, rendererRoot: URL) {
        self.content = content
        self.docPath = docPath
        self.out = out
        self.rendererRoot = rendererRoot
    }

    func run(completion: @escaping (Result<URL, Error>) -> Void) {
        self.completion = completion
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(FileSchemeHandler(root: rendererRoot), forURLScheme: "app")
        config.setURLSchemeHandler(FileSchemeHandler(root: nil), forURLScheme: "safe-file")
        config.userContentController.add(self, name: "shell")
        config.userContentController.addUserScript(
            WKUserScript(source: BRIDGE_JS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // A4：595 × 842 pt；高度在测量后由 createPDF 的 rect 决定
        let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: 595, height: 842), configuration: config)
        wv.navigationDelegate = self
        self.wv = wv
        wv.load(URLRequest(url: URL(string: "app://r/index.html")!))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        waitForEditor { [weak self] in self?.injectDoc() }
    }

    private func fail(_ msg: String) {
        completion?(.failure(NSError(domain: "typmd.export", code: 1,
                                     userInfo: [NSLocalizedDescriptionKey: msg])))
        completion = nil
    }

    private func waitForEditor(attempt: Int = 0, then: @escaping () -> Void) {
        guard attempt < 100 else { return fail("渲染层初始化超时") }
        wv?.evaluateJavaScript("typeof window.__typmd === 'object'") { [weak self] ready, _ in
            guard let self else { return }
            if (ready as? Bool) == true { then() }
            else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    self.waitForEditor(attempt: attempt + 1, then: then) } }
        }
    }

    private func injectDoc() {
        let doc: [String: Any] = [
            "path": docPath ?? "",
            "content": content,
            "fingerprint": ["eol": "\n", "bom": false]
        ]
        wv?.evaluateJavaScript("window.__shellEmit('file:opened', \(jsonLiteral(doc)))") {
            [weak self] _, _ in self?.injectPrintCSS()
        }
    }

    private static let printCSS = """
    html, body { height: auto !important; overflow: visible !important; }
    #drag-strip, #status-bar, #sidebar, #tabbar, #outline { display: none !important; }
    body { display: block !important; background: #fff !important; color: #24292f !important; }
    :root { --bg: #ffffff; --fg: #24292f; --code-bg: #f4f5f7; --border: #e6e8eb; --muted: #8b949e; --sel: transparent; }
    #workspace { display: block !important; }
    #editor-host { overflow: visible !important; height: auto !important; padding: 46px 42px !important; }
    .cm-editor { height: auto !important; background: #fff !important; }
    .cm-scroller { overflow: visible !important; height: auto !important; }
    .cm-content { padding-bottom: 40px !important; }
    .cm-cursor, .cm-dropCursor { display: none !important; }
    .cm-activeLine, .cm-activeLineGutter, .cm-selectionBackground { background: transparent !important; }
    """

    private func injectPrintCSS() {
        let js = """
        (() => { const s = document.createElement('style'); s.textContent = \(jsonLiteral(Self.printCSS)); document.head.appendChild(s); return true })()
        """
        wv?.evaluateJavaScript(js) { [weak self] _, _ in self?.settleAndCapture() }
    }

    private func settleAndCapture() {
        let body = """
        await document.fonts.ready
        await Promise.all([...document.images].map(i => i.decode().catch(() => {})))
        await new Promise(r => setTimeout(r, 400))
        return document.documentElement.scrollHeight
        """
        wv?.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self else { return }
            let height: CGFloat
            if case .success(let v) = result, let n = v as? NSNumber { height = CGFloat(n.doubleValue) }
            else { height = 842 }
            self.capture(height: max(height, 100))
        }
    }

    private func capture(height: CGFloat) {
        wv?.evaluateJavaScript("window.scrollTo(0, 0)", completionHandler: nil)
        let cfg = WKPDFConfiguration()
        cfg.rect = CGRect(x: 0, y: 0, width: 595, height: height)
        wv?.createPDF(configuration: cfg) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let data):
                do { try data.write(to: self.out); self.completion?(.success(self.out)) }
                catch { self.completion?(.failure(error)) }
            case .failure(let e):
                self.completion?(.failure(e))
            }
            self.completion = nil
        }
    }

    /// print 页里所有 api 请求一律回 null（编辑器 UI 的启动调用不影响渲染）
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let d = message.body as? [String: Any], let id = d["id"] as? Int else { return }
        wv?.evaluateJavaScript("window.api._resolve(\(id), null)")
    }
}

// MARK: - AppDelegate

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var dirty = false
    var forceClose = false
    var pendingOpen: String?
    var lastDocPath: String?
    /// 渲染层推来的当前文档路径（setDocState），用于导出文件名与相对图片解析
    var docPath: String?
    var pdfExporter: PDFExporter?

    // ---- 启动 ----

    func applicationDidFinishLaunching(_ notification: Notification) {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(FileSchemeHandler(root: findRendererRoot()), forURLScheme: "app")
        config.setURLSchemeHandler(FileSchemeHandler(root: nil), forURLScheme: "safe-file")
        config.userContentController.add(self, name: "shell")
        config.userContentController.addUserScript(
            WKUserScript(source: BRIDGE_JS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // DevTools：右键页面 →「检查元素」
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.autoresizingMask = [.width, .height]

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1080, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "typmd"
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
        dragStrip.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(dragStrip, positioned: .above, relativeTo: webView)
        NSLayoutConstraint.activate([
            dragStrip.topAnchor.constraint(equalTo: container.topAnchor),
            dragStrip.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            dragStrip.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            dragStrip.heightAnchor.constraint(equalToConstant: 38)
        ])

        window.delegate = self
        _ = window.setFrameAutosaveName("Main")           // 记住窗口位置（≈ windowBounds）
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        buildMenu()
        webView.load(URLRequest(url: URL(string: "app://r/index.html")!))

        // argv 打开文档：typmd-shell /path/to/file.md
        if let arg = CommandLine.arguments.dropFirst().first(where: {
            !$0.hasPrefix("-") && FileManager.default.fileExists(atPath: $0)
        }) {
            pendingOpen = URL(fileURLWithPath: arg).standardizedFileURL.path
        }
    }

    /// Finder 双击 .md
    func application(_ sender: NSApplication, openFile filename: String) -> Bool {
        if webView != nil, webView.url != nil { openPath(filename) } else { pendingOpen = filename }
        return true
    }

    // ---- 菜单（动作字符串与 src/main/menu.ts 完全一致）----

    private func send(_ action: String) {
        webView.evaluateJavaScript("window.__shellEmit('menu', \(jsValue(action)))")
    }

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu(title: "typmd")
        appMenu.addItem(NSMenuItem(title: "关于 typmd", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""))
        appMenu.addItem(.separator())
        appMenu.addItem(NSMenuItem(title: "隐藏 typmd", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"))
        appMenu.addItem(NSMenuItem(title: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h"))
        appMenu.addItem(NSMenuItem(title: "退出 typmd", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appItem.submenu = appMenu

        let fileItem = NSMenuItem(); main.addItem(fileItem)
        let file = NSMenu(title: "文件")
        file.addItem(item("新建", "file:new", key: "n"))
        file.addItem(item("打开…", "file:open", key: "o"))
        file.addItem(item("打开文件夹…", "file:open-folder", key: "o", modifiers: [.command, .shift]))
        file.addItem(.separator())
        file.addItem(item("保存", "file:save", key: "s"))
        file.addItem(item("另存为…", "file:save-as", key: "s", modifiers: [.command, .shift]))
        file.addItem(.separator())
        file.addItem(NSMenuItem(title: "导出为 PDF…", action: #selector(exportPDF(_:)), keyEquivalent: "p"))
        file.addItem(.separator())
        file.addItem(NSMenuItem(title: "关闭窗口", action: Selector(("performClose:")), keyEquivalent: "w"))
        fileItem.submenu = file

        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "编辑")
        // ⚠️ WKWebView 里 ⌘C/⌘V 生效的前提：存在接线的「编辑」菜单
        edit.addItem(NSMenuItem(title: "撤销", action: Selector(("undo:")), keyEquivalent: "z"))
        edit.addItem(NSMenuItem(title: "重做", action: Selector(("redo:")), keyEquivalent: "Z"))
        edit.addItem(.separator())
        edit.addItem(NSMenuItem(title: "剪切", action: Selector(("cut:")), keyEquivalent: "x"))
        edit.addItem(NSMenuItem(title: "拷贝", action: Selector(("copy:")), keyEquivalent: "c"))
        edit.addItem(NSMenuItem(title: "粘贴", action: Selector(("paste:")), keyEquivalent: "v"))
        edit.addItem(NSMenuItem(title: "全选", action: Selector(("selectAll:")), keyEquivalent: "a"))
        edit.addItem(.separator())
        edit.addItem(item("查找…", "edit:find", key: "f"))
        editItem.submenu = edit

        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "视图")
        view.addItem(item("显示/隐藏侧边栏", "view:toggle-sidebar", key: "\\"))
        view.addItem(item("显示/隐藏大纲", "view:toggle-outline", key: "t", modifiers: [.command, .shift]))
        view.addItem(item("源代码模式", "view:toggle-source", key: "/"))
        view.addItem(.separator())
        view.addItem(NSMenuItem(title: "实际大小", action: #selector(resetZoom(_:)), keyEquivalent: "0"))
        view.addItem(NSMenuItem(title: "放大", action: #selector(zoomIn(_:)), keyEquivalent: "+"))
        view.addItem(NSMenuItem(title: "缩小", action: #selector(zoomOut(_:)), keyEquivalent: "-"))
        view.addItem(.separator())
        view.addItem(NSMenuItem(title: "全屏", action: Selector(("toggleFullScreen:")), keyEquivalent: "f"))
        viewItem.submenu = view

        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: "窗口")
        win.addItem(NSMenuItem(title: "最小化", action: Selector(("performMiniaturize:")), keyEquivalent: "m"))
        winItem.submenu = win

        NSApp.mainMenu = main
    }

    private func item(_ title: String, _ action: String, key: String,
                      modifiers: NSEvent.ModifierFlags = .command) -> NSMenuItem {
        let mi = NSMenuItem(title: title, action: #selector(menuAction(_:)), keyEquivalent: key)
        mi.keyEquivalentModifierMask = modifiers
        mi.representedObject = action
        return mi
    }

    @objc func menuAction(_ sender: NSMenuItem) { send(sender.representedObject as! String) }
    @objc func zoomIn(_ sender: Any?) { webView.pageZoom *= 1.1 }
    @objc func zoomOut(_ sender: Any?) { webView.pageZoom /= 1.1 }
    @objc func resetZoom(_ sender: Any?) { webView.pageZoom = 1.0 }

    // ---- PDF 导出（离屏 A4 渲染，不走浏览器打印） ----

    @objc func exportPDF(_ sender: Any?) {
        // 从渲染层取实时内容（含未保存的修改）
        fetchLiveContent { [weak self] in self?.runExportFlow(content: $0) }
    }

    private func fetchLiveContent(_ then: @escaping (String) -> Void) {
        webView.evaluateJavaScript("(window.__typmd ? window.__typmd.view.state.doc.toString() : '')") {
            content, _ in
            if let text = content as? String { then(text) }
        }
    }

    private func runExportFlow(content: String) {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.pdf]
        let base = docPath.map { (($0 as NSString).lastPathComponent as NSString).deletingPathExtension } ?? "未命名"
        panel.nameFieldStringValue = base + ".pdf"
        guard panel.runModal() == .OK, let out = panel.url else { return }

        let exporter = PDFExporter(content: content, docPath: docPath, out: out, rendererRoot: findRendererRoot())
        pdfExporter = exporter
        exporter.run { [weak self] result in
            self?.pdfExporter = nil
            DispatchQueue.main.async {
                switch result {
                case .success(let url):
                    let alert = NSAlert()
                    alert.messageText = "PDF 已导出"
                    alert.informativeText = url.path
                    alert.addButton(withTitle: "好")
                    alert.addButton(withTitle: "在 Finder 中显示")
                    if alert.runModal() == .alertSecondButtonReturn {
                        NSWorkspace.shared.activateFileViewerSelecting([url])
                    }
                case .failure(let e):
                    self?.showError("导出失败", e.localizedDescription)
                }
            }
        }
    }

    // ---- 关闭拦截（与 Electron 版行为一致）----

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if forceClose || !dirty { return true }
        send("file:save-and-close")   // 渲染进程存盘后会回调 confirmClose
        return false
    }

    // ---- shell -> renderer 推送 ----

    private func jsValue(_ v: Any) -> String { jsonLiteral(v) }

    private func openPath(_ path: String) {
        do {
            lastDocPath = path
            let doc = try readDoc(path)
            let js = "window.__shellEmit('file:opened', \(jsValue(doc)))"
            webView.evaluateJavaScript(js) { _, err in
                if let err {
                    let msg = "[openPath] emit error: \(err)\n"
                    FileHandle.standardError.write(msg.data(using: .utf8)!)
                }
            }
        } catch { showError("打不开文件", error.localizedDescription) }
    }

    private func showError(_ title: String, _ msg: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = msg
        alert.runModal()
    }

    // MARK: - renderer -> shell（15 个通道）

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
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
                panel.nameFieldStringValue = (current as NSString?)?.lastPathComponent ?? "未命名.md"
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
                respond(id, ["path": path])
            } catch { reject(id, "写入失败：\(error.localizedDescription)") }

        case "setDocState":
            let st = args[0] as? [String: Any] ?? [:]
            let path = st["path"] as? String
            docPath = path
            dirty = st["dirty"] as? Bool ?? false
            let name = path.map { ($0 as NSString).lastPathComponent } ?? "未命名"
            window.title = "\(dirty ? "• " : "")\(name) — typmd"
            window.isDocumentEdited = dirty
            if let p = path { window.representedFilename = p }
            respond(id, NSNull())

        case "confirmClose":
            forceClose = true
            window.close()
            respond(id, NSNull())

        case "confirmDiscard":
            let alert = NSAlert()
            alert.messageText = "是否保存更改？"
            alert.informativeText = "\(args[0] as? String ?? "未命名文档") 有未保存的修改。"
            alert.addButton(withTitle: "保存")
            alert.addButton(withTitle: "不保存")
            alert.addButton(withTitle: "取消")
            let choice = ["save", "discard", "cancel"][
                alert.runModal().rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
            ]
            respond(id, choice)

        case "openExternal":
            if let s = args[0] as? String, let url = URL(string: s) { NSWorkspace.shared.open(url) }
            respond(id, NSNull())

        case "pickFolder":
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            let picked = panel.runModal() == .OK ? panel.url?.path : nil
            respond(id, picked ?? NSNull())

        case "readDir":
            let path = args[0] as? String ?? ""
            let fm = FileManager.default
            var entries: [[String: Any]] = []
            if let names = try? fm.contentsOfDirectory(atPath: path) {
                for name in names.sorted() where !name.hasPrefix(".") {
                    var isDir: ObjCBool = false
                    let p = "\(path)/\(name)"
                    _ = fm.fileExists(atPath: p, isDirectory: &isDir)
                    entries.append(["name": name, "path": p, "isDir": isDir.boolValue])
                }
            }
            respond(id, entries)

        case "lastFolder":
            respond(id, UserDefaults.standard.string(forKey: "lastFolder") ?? NSNull())

        case "console":
            FileHandle.standardError.write(((args.map { "\($0)" }.joined(separator: " ")) + "\n").data(using: .utf8)!)

        default:
            reject(id, "未知通道：\(method)")
        }
    }

    // ---- 文件读写（types.ts 的 DocPayload 形状）----

    private func readDoc(_ path: String) throws -> [String: Any] {
        let raw = try String(contentsOfFile: path, encoding: .utf8)
        let (text, fp) = decodeDoc(raw)
        return ["path": path, "content": text, "fingerprint": ["eol": fp.eol, "bom": fp.bom]]
    }

    private func respond(_ id: Int, _ value: Any) {
        webView.evaluateJavaScript("window.api._resolve(\(id), \(jsValue(value)))")
    }
    private func reject(_ id: Int, _ message: String) {
        webView.evaluateJavaScript("window.api._reject(\(id), \(jsValue(message)))")
    }

    // ---- 加载完成后：写入自检结果 + 处理 Finder 打开 ----

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.runProbe() }
        flushPendingOpen()
    }

    /// didFinish 可能早于渲染层模块执行完（监听器未注册时 emit 会静默丢失），
    /// 轮询 window.__typmd（main.js 末尾暴露的就绪标记）就绪后再发 file:opened
    private func flushPendingOpen(attempt: Int = 0) {
        guard let p = pendingOpen, attempt < 100 else { return }
        webView.evaluateJavaScript("typeof window.__typmd === 'object'") { [weak self] ready, _ in
            guard let self else { return }
            if (ready as? Bool) == true {
                self.pendingOpen = nil
                self.openPath(p)
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.flushPendingOpen(attempt: attempt + 1) }
            }
        }
    }

    private func writeJSON(_ obj: Any, to path: String) {
        if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: path))
        }
    }

    private func runProbe() {
        // 探针/E2E 只在 TYPMD_SMOKE 下运行；普通启动是正常交互应用，绝不自动退出
        guard ProcessInfo.processInfo.environment["TYPMD_SMOKE"] != nil else { return }
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
          tabs: document.querySelectorAll('.tab-item').length,
          outlineRows: document.querySelectorAll('.ol-item').length
        }))()
        """
        webView.evaluateJavaScript(probe) { [weak self] result, _ in
            guard let self, var obj = result as? [String: Any] else { return }
            // 原生侧自检：拖拽条就位、命中测试命中它（performDrag 的充分前置）
            if let container = self.webView.superview,
               let strip = container.subviews.compactMap({ $0 as? DragStripView }).first {
                let p = strip.convert(CGPoint(x: strip.bounds.midX, y: strip.bounds.midY), to: container.superview)
                obj["dragStripHit"] = (container.superview?.hitTest(p) === strip)
                obj["stripFrame"] = "\(strip.frame)"
            } else {
                obj["dragStripHit"] = false
            }
            self.writeJSON(obj, to: "/tmp/typmd-shell-check.json")
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.runE2E() }
        }
    }

    /// E2E：read → save 逐字节往返（验证 BOM/EOL 指纹）+ live-preview 图片加载检测。
    /// 仅 TYPMD_SMOKE 模式；完成后自动退出（自动化验收用）
    private func runE2E() {
        let source = lastDocPath ?? "/tmp/typmd-e2e/img.md"
        let outPath = "/tmp/typmd-e2e/roundtrip.out"
        let body = """
        const doc = await window.api.read(path)
        await window.api.save(outPath, doc.content, doc.fingerprint)
        const img = document.querySelector('.cm-lp-image img')
        const counts = {}
        for (const cls of ['cm-lp-image', 'cm-lp-checkbox', 'cm-lp-bullet', 'cm-lp-rule', 'cm-lp-tableview'])
          counts[cls] = document.querySelectorAll('.' + cls).length
        return {
          fingerprint: doc.fingerprint,
          img: img
            ? { loaded: img.complete && img.naturalWidth > 0, src: img.getAttribute('src') }
            : null,
          counts,
          cmLines: document.querySelectorAll('.cm-line').length
        }
        """
        webView.callAsyncJavaScript(
            body,
            arguments: ["path": source, "outPath": outPath],
            in: nil, in: .page
        ) { [weak self] result in
            guard let self else { return }
            var out: [String: Any] = ["source": source, "roundtrip": outPath]
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
            self.writeJSON(out, to: "/tmp/typmd-shell-e2e.json")
            // TYPMD_SMOKE_PDF=<路径>：顺带验证 PDF 导出（绕过保存面板）
            if let pdfOut = ProcessInfo.processInfo.environment["TYPMD_SMOKE_PDF"] {
                self.fetchLiveContent { text in
                    let exporter = PDFExporter(
                        content: text, docPath: self.lastDocPath,
                        out: URL(fileURLWithPath: pdfOut), rendererRoot: findRendererRoot())
                    self.pdfExporter = exporter
                    exporter.run { result in
                        self.pdfExporter = nil
                        var pdfResult: [String: Any] = ["out": pdfOut]
                        switch result {
                        case .success(let url):
                            pdfResult["bytes"] = (try? Data(contentsOf: url))?.count ?? 0
                        case .failure(let e):
                            pdfResult["error"] = e.localizedDescription
                        }
                        self.writeJSON(pdfResult, to: "/tmp/typmd-shell-pdf.json")
                        NSApp.terminate(nil)
                    }
                }
            } else {
                NSApp.terminate(nil)
            }
        }
    }
}

// MARK: - 入口

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
