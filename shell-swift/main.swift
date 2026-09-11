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

// MARK: - app:// 协议：把 out/renderer 当源站服务（绕开 file:// opaque origin 下
// <script type="module" crossorigin> 拉不到资源的问题，等价于 Electron 的 registerSafeFileProtocol）

final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    let root: URL  // out/renderer
    private static let mime = [
        "html": "text/html", "js": "text/javascript", "mjs": "text/javascript",
        "css": "text/css", "json": "application/json", "svg": "image/svg+xml",
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "gif": "image/gif", "webp": "image/webp", "ico": "image/x-icon",
        "woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf"
    ]

    init(root: URL) { self.root = root }

    private func fail(_ task: WKURLSchemeTask) {
        let resp = URLResponse(url: task.request.url!, mimeType: nil, expectedContentLength: 0, textEncodingName: nil)
        task.didReceive(resp)
        task.didFailWithError(URLError(.fileDoesNotExist))
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return fail(task) }
        let rel = (url.path.removingPercentEncoding ?? url.path).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let parts = rel.split(separator: "/").map(String.init)
        guard !parts.isEmpty, !parts.contains(".."), !rel.contains("//") else { return fail(task) }
        let file = root.appendingPathComponent(rel).standardizedFileURL
        guard file.path.hasPrefix(root.standardizedFileURL.path),
              let data = try? Data(contentsOf: file) else { return fail(task) }
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

// MARK: - AppDelegate

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var dirty = false
    var forceClose = false
    var pendingOpen: String?

    // ---- 启动 ----

    func applicationDidFinishLaunching(_ notification: Notification) {
        let config = WKWebViewConfiguration()
        let cwd = FileManager.default.currentDirectoryPath
        config.setURLSchemeHandler(AppSchemeHandler(root: URL(fileURLWithPath: "\(cwd)/out/renderer")), forURLScheme: "app")
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
        window.contentView = webView
        window.delegate = self
        _ = window.setFrameAutosaveName("Main")           // 记住窗口位置（≈ windowBounds）
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        buildMenu()
        webView.load(URLRequest(url: URL(string: "app://r/index.html")!))
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

    // ---- 关闭拦截（与 Electron 版行为一致）----

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if forceClose || !dirty { return true }
        send("file:save-and-close")   // 渲染进程存盘后会回调 confirmClose
        return false
    }

    // ---- shell -> renderer 推送 ----

    private func jsValue(_ v: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [v]),
              let s = String(data: data, encoding: .utf8) else { return "null" }
        return String(s.dropFirst().dropLast())   // 去掉数组包装 [ ]
    }

    private func openPath(_ path: String) {
        do {
            let doc = try readDoc(path)
            webView.evaluateJavaScript("window.__shellEmit('file:opened', \(jsValue(doc)))")
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
        // 延迟探针：给编辑器异步初始化留时间
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.runProbe() }
        if let p = pendingOpen { pendingOpen = nil; openPath(p) }
    }

    private func runProbe() {
        let probe = """
        (() => ({
          title: document.title,
          hasApi: typeof window.api === 'object',
          apiKeys: window.api ? Object.keys(window.api).length : 0,
          cm: !!document.querySelector('.cm-editor'),
          cmState: !!document.querySelector('.cm-content'),
          host: !!document.querySelector('#editor-host'),
          sidebar: !!document.querySelector('#sidebar'),
          status: (document.querySelector('#status-file') || {}).textContent || null
        }))()
        """
        webView.evaluateJavaScript(probe) { result, _ in
            if let data = try? JSONSerialization.data(withJSONObject: result ?? "-", options: [.prettyPrinted, .sortedKeys]) {
                try? data.write(to: URL(fileURLWithPath: "/tmp/typmd-shell-check.json"))
            }
            NSApp.terminate(nil)   // 自检完自动退出，便于脚本化验证
        }
    }
}

// MARK: - 入口

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
