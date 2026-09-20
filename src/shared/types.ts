import type { FileFingerprint } from './textfile.js'

export type MenuAction =
  | 'file:new'
  | 'file:open'
  | 'file:save'
  | 'file:save-as'
  | 'file:save-and-close'
  // ⌘W 关当前标签；关窗口是 ⇧⌘W（走壳侧 performClose:，不经这条通道）
  | 'file:close-tab'
  /**
   * 下一个 / 上一个标签（0.2.x，⌃Tab / ⌃⇧Tab）。
   *
   * **走原生菜单而不是渲染层的 keydown**（判断 1 的同一条理由）：⌃Tab 落在
   * WKWebView 里首先是 CodeMirror 的事，而菜单的 `performKeyEquivalent` 排在
   * 所有键盘处理之前 —— 摆进「窗口」菜单还顺带让人看得见这两条键。
   * 到头折回（最后一个的下一个 = 第一个），一个标签时原地不动
   */
  | 'file:next-tab'
  | 'file:prev-tab'
  | 'file:open-folder'
  // ---- P4-1 导出 HTML ----
  | 'file:export-html'
  | 'edit:find'
  | 'edit:replace'
  | 'edit:find-next'
  | 'edit:find-prev'
  | 'edit:paste-plain'
  // ---- 0.2.0 ----
  /** 复制为富文本（契约 v20）：同一份导出 HTML 进剪贴板，纯文本风味放 Markdown 源码 */
  | 'edit:copy-html'
  /**
   * 选择下一个匹配（多光标）。CodeMirror 的 `searchKeymap` 本来就带 ⌘D，
   * 但 `performKeyEquivalent` 把所有带 ⌘ 的事件交还给菜单系统（判断 1），
   * 菜单里没有这一条 = 这个键一直是死的。补一条菜单项，不必去赌键能不能落回编辑器
   */
  | 'edit:select-next'
  /** 快速打开：按名字模糊跳文件（索引走契约 v21 的 `listFiles`） */
  | 'file:quick-open'
  /** 命令面板：列的就是这份 `MenuAction` 表自己 */
  | 'view:command-palette'
  /** 版本历史：看这份文件历次保存留下的快照，并可整份回滚（契约 v22） */
  | 'file:history'
  | 'view:toggle-source'
  | 'view:toggle-sidebar'
  | 'view:toggle-outline'
  | 'view:toggle-format-bar'
  | 'view:toggle-focus'
  | 'view:toggle-typewriter'
  | 'view:theme-system'
  | 'view:theme-light'
  | 'view:theme-dark'
  | 'view:theme-sepia'
  /**
   * 停用 / 启用自定义皮肤（0.3.0 T4，契约 v29）。**安全出口**：皮肤是叠在内置主题
   * 后面的一整张 CSS，一条 `.cm-content{display:none}` 就能把编辑器变成一片空白 ——
   * 而设置面板、命令面板、状态栏全在同一张 CSS 底下，能按到的入口一起没了。
   * 原生菜单不受页面 CSS 影响，页面花成什么样它都画得出来（判断 1 的直接受益）。
   * 状态进偏好（不是会话级），否则重开一次又花一次
   */
  | 'view:disable-custom-theme'
  | 'view:toggle-dark'
  | 'app:preferences'
  /**
   * 检查更新（0.3.0 T2）。走原生菜单而不是设置面板里的一颗按钮：
   * 「这个 app 有没有新版本」与「我的字号排版」不是同一类事，而应用菜单
   * 本来就是 macOS 上找它的地方。点一下拉一次 GitHub，结果进状态栏（契约 v27）
   */
  | 'app:check-update'
  // ---- P3-2 跨文件搜索 ----
  | 'edit:find-in-files'
  // ---- P2-1 格式化命令（见 fmt.ts）----
  | 'fmt:bold'
  | 'fmt:italic'
  | 'fmt:underline'
  | 'fmt:strikethrough'
  | 'fmt:code-inline'
  | 'fmt:link'
  | 'fmt:h1'
  | 'fmt:h2'
  | 'fmt:h3'
  | 'fmt:h4'
  | 'fmt:h5'
  | 'fmt:h6'
  | 'fmt:p'
  | 'fmt:code-block'
  | 'fmt:quote'
  | 'fmt:ulist'
  | 'fmt:olist'
  | 'fmt:task'
  // ---- P2-9 命令表补齐：行内 ----
  // 方言在 P1-3 就通了（==高亮== / ^上标^ / ~下标~ / $公式$ 解析、实时预览、导出三条路
  // 全都在），命令表却停在 P2-1，这四个一直没有任何入口。形状与上面六个行内开关同构
  | 'fmt:highlight'
  | 'fmt:superscript'
  | 'fmt:subscript'
  | 'fmt:math-inline'
  // ---- P2-9 命令表补齐：插入 ----
  // 这一组**不是开关**，是在光标处插一段骨架（见 fmt.ts 的 insert 分支）。
  // 仍挂 `fmt:` 前缀是为了走 main.ts 那条 `action.startsWith('fmt:')` 的现成分发，
  // 它们本来也都摆在「格式」菜单里
  | 'fmt:table'
  | 'fmt:hr'
  | 'fmt:image'
  | 'fmt:math-block'
  | 'fmt:callout'
  | 'fmt:mermaid'
  | 'fmt:toc'
  | 'fmt:footnote'

/** 视图菜单里带勾的那几项。真相在渲染层，壳只负责把勾画出来（契约 v8） */
export interface ViewFlags {
  sidebar: boolean
  outline: boolean
  formatBar: boolean
  source: boolean
  focus: boolean
  typewriter: boolean
}

/**
 * 一份从磁盘读到的文档。
 *
 * 三条路会送来它：`read()` / `openDialog()` 的返回、`onFileOpened` 事件，
 * 以及**启动时随页面注入的那一份**（契约 v18，P4-6①）——
 * 后者不是 `window.api` 上的方法，而是壳用 `WKUserScript`（`atDocumentStart`）
 * 写进 `window.__cursiveInitialDoc` 的全局，声明在 `renderer/env.d.ts`。
 * 它与 `onFileOpened` **互斥**：注入成功就不会再推 `file:opened`，读盘失败才退回老路。
 */
export interface DocPayload {
  path: string
  /** 已剥 BOM、换行归一为 LF 的正文 */
  content: string
  /** 原文件的换行风格与 BOM，保存时原样还原 */
  fingerprint: FileFingerprint
}

/** 渲染进程推给主进程的当前文档状态，用于窗口标题与关闭拦截 */
export interface DocState {
  path: string | null
  dirty: boolean
}

/** ---- P3-2 跨文件搜索（契约 v11）----
 * 搜索必须在**壳侧**跑：渲染层递归 readDir 会让 IPC 往返爆炸。
 * 结果流式回推（`search:hits` 批次 + `search:done`），token 用来丢弃过期结果。 */
export interface SearchOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

/**
 * 一处命中。列一律按**码元**（UTF-16）算。
 *
 * `col` 是**文档里的列**（跳转用），`textCol` 是**展示串里的列**（画 `<mark>` 用）——
 * 两者必须分开：Markdown 的一个段落常常就是一行几百字符，壳侧要围着命中点裁一段窗口
 * 出来，裁完偏移就变了。合成一个字段的话，长段落里的高亮会画到别处去。
 */
export interface SearchHit {
  path: string
  /** 1 起 */
  line: number
  col: number
  length: number
  /** 围着命中点裁出来的一段（前面截断过就带一个前导 `…`） */
  text: string
  textCol: number
}

export interface SearchBatch {
  token: number
  hits: SearchHit[]
}

export interface SearchDone {
  token: number
  files: number
  hits: number
  /** 命中数或文件数触顶，结果不完整 */
  truncated: boolean
  cancelled: boolean
}

/** 界面语言。**只此一处**定义 —— `renderer/i18n` 的 `Lang` 就是它的别名 */
export type UiLang = 'zh' | 'en'

export type BodyFont = 'serif' | 'sans'

/**
 * 一整份界面偏好。**真相是渲染层的 localStorage `cursive.prefs`**，壳既不读也不存；
 * 它出现在这里是因为契约 v17 要把整份原样转发给别的窗口（见 `syncPrefs`）。
 */
export interface PrefValues {
  theme: AppearanceMode
  font: BodyFont
  /** 正文字号 px */
  size: number
  /** 行距倍数 */
  leading: number
  /** 栏宽 rem */
  column: number
  /** 用户自定义皮肤文件名（themes/<name>.css），null = 不叠 */
  custom: string | null
  /** 界面语言（契约 v16：切换时推 setLanguage 给壳重建菜单/对话框） */
  lang: UiLang
  /**
   * 系统拼写检查（0.2.0）。**默认关**。
   *
   * 开关落在 `EditorView.contentAttributes` 的 `spellcheck` 上 —— 可编辑区一旦声明
   * 要拼写检查，macOS 的 NSSpellChecker 在 WKWebView 里自动接管，红波浪线、
   * 右键改正菜单全是系统给的，这边一行代码都不用写。
   * 默认关是因为它对中文写作没有价值，而长文档上 WebKit 的扫描要实打实花 CPU
   */
  spellcheck: boolean
}

/** 用户自定义主题：`~/Library/Application Support/cursive/themes/*.css`（P3-4） */
export interface UserTheme {
  /** 文件名去掉 .css，同时用作持久化的键 */
  name: string
  css: string
}

/** 文件树里的一项 */
export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

/**
 * ---- 0.2.0 版本历史（契约 v22）----
 * 一次保存留下的快照。内容不在这里 —— 列表可能有几十条，全带上正文就是几 MB
 * 过一次桥（判断 3）；真要看哪一条，再用 `snapshotRead` 单取。
 */
export interface Snapshot {
  /** 快照 id，同时也是落盘的文件名（毫秒时间戳） */
  id: string
  /** ISO 时间串，界面上按本地时区显示 */
  savedAt: string
  /** 正文字节数，列表里给一个「这版有多大」的直观量 */
  bytes: number
}

/** scratch 自动保存文件里的一条未命名文档 */
export interface ScratchDoc {
  id: string
  content: string
  fp: FileFingerprint
}

/**
 * ---- 0.3.0 T2 检查更新（契约 v27）----
 * 壳拉回来的那一眼。**三个字段全是壳自己说了算**，网络回来的东西只借道 `latest`：
 * `current` 取自包的 `CFBundleShortVersionString`，`url` 是壳侧拼的常量
 * （`releases/latest` 那一页，GitHub 自己会转到最新那条）—— 响应里的 `html_url`
 * 一个字节都不进来，于是「网络说去哪儿就去哪儿」这条路从一开始就不存在。
 */
export interface UpdateInfo {
  /** 这个包自己的版本。开发构建（裸二进制、没有 Info.plist）读不到，回 `0.0.0` */
  current: string
  /**
    * 最新 release 的 tag，`v` 前缀原样带着（剥前缀是比版本那一步的事）。
    *
    * **`null` = 问着了，但那边一个 release 都没有**（GitHub 回 404 —— 打了 tag
    * 不等于发了 release）。它与「没问着」（整个返回 `null`）是两件事：
    * 说成同一句话就是在冤枉网络，而这个仓库在第一次发版之前一直是这一种。
    */
  latest: string | null
  /** 那个 release 的页面。渲染层只把它交给 `openExternal`，不解析、不拼接 */
  url: string
}

/** preload 通过 contextBridge 暴露给渲染进程的接口 */
export interface CursiveApi {
  openDialog(): Promise<DocPayload | null>
  read(path: string): Promise<DocPayload>
  save(
    path: string | null,
    content: string,
    fingerprint: FileFingerprint
  ): Promise<{ path: string } | null>
  saveAs(
    current: string | null,
    content: string,
    fingerprint: FileFingerprint
  ): Promise<{ path: string } | null>
  /** 返回取消订阅函数 */
  onMenu(fn: (action: MenuAction) => void): () => void
  onFileOpened(fn: (doc: DocPayload) => void): () => void
  onFolderOpened(fn: (dir: string) => void): () => void
  setDocState(state: DocState): void
  confirmClose(): void
  confirmDiscard(name: string): Promise<DiscardChoice>
  /**
   * 交给系统打开：外部地址给浏览器 / 邮件客户端，`file://` 给默认应用或 Finder。
   * **返回「系统真的接手了吗」**（`NSWorkspace.open` 的返回值）—— 本地文件被删、
   * 地址不合法都会是 false，渲染层据此在状态栏说一句「打不开」。
   * 不回这个的话，一次点击失败与成功长得一模一样，也就是最糟的那种失败：什么都没发生。
   */
  openExternal(url: string): Promise<boolean>
  pickFolder(): Promise<string | null>
  /** 列目录。文件只回「能打开的文档」（后缀白名单在壳侧 `DocScan.exts` 一处说了算，
   *  与跨文件搜索、快速打开共用），目录原样回，隐藏文件两头都不进树 */
  readDir(path: string): Promise<DirEntry[]>
  /** 这个窗口的工作区根（契约 v19）：带文件开出来的窗口 = 那个文件所在的目录，
   *  带文件夹开出来的 = 那个文件夹，空手开的 = 上次 `pickFolder` 选过的那个。
   *  **不是**全局的「上次打开的文件夹」—— 那会让「双击一个 .md」带出一棵无关的树 */
  workspaceRoot(): Promise<string | null>
  /** ---- P3-1 文件树读写（契约 v7）----
   * 新建的名字由**壳**弹原生输入框问（渲染层不碰原生 UI），取消或重名冲突返回 null；
   * 删除一律进废纸篓（`NSFileManager.trashItem`，可在 Finder 里找回），壳侧先弹确认。
   * 三个通道都过壳侧的 `safeTarget` 防穿越：消解 `..`，且必须落在当前树根之下 */
  createFile(dir: string): Promise<{ path: string } | null>
  createFolder(dir: string): Promise<{ path: string } | null>
  /**
   * 删除进废纸篓。返回它**在废纸篓里的落点**（`restoreItem` 撤销那一下要用），
   * 取消或失败 = null（契约 v25 把原来的 boolean 换成了这个 —— 只有壳知道
   * `trashItem(at:resultingItemURL:)` 把它放到了哪儿，而那正是撤销唯一的线索）
   */
  trashItem(path: string): Promise<{ trashed: string } | null>
  /**
   * 契约 v25：把废纸篓里那一份挪回原处（状态栏那颗「撤销」）。
   *
   * 壳侧两道闸：`trashed` **必须真的在用户的废纸篓里**（不是 `safeTarget` 那道 ——
   * 废纸篓本来就不在树根底下），`to` 必须过 `safeTarget` 且**此刻不存在**。
   * 不覆盖任何东西：删掉之后又新建了同名文件时，撤销直接失败（返回 false）——
   * 让用户自己去废纸篓拿 —— 悄悄盖掉新文件比撤不回来糟得多
   */
  restoreItem(trashed: string, to: string): Promise<boolean>
  /** ---- P3-1 收尾（契约 v10）----
   * `renameItem` 的新名字同样由壳弹原生输入框问（预填旧名），取消/同名返回 null；
   * `moveItem` 是文件树内拖拽，目标必须是目录，重名自动加 `-2`；
   * `revealInFinder` 走 `NSWorkspace.activateFileViewerSelecting`。三者都过 `safeTarget` */
  renameItem(path: string): Promise<{ path: string } | null>
  moveItem(src: string, destDir: string): Promise<{ path: string } | null>
  revealInFinder(path: string): void
  /** 读系统剪贴板的纯文本（⇧⌥⌘V 粘贴为纯文本用；剪贴板由壳侧读，渲染层不碰原生） */
  readClipboardText(): Promise<string>
  /** ---- 0.2.0 复制为富文本（契约 v20）----
   * 正文仍由渲染层渲染（与 P4-1 导出、P4-2 打印共用同一棵语法树），壳只负责把它
   * 按 `.html` 放上 `NSPasteboard`。**两种风味一起放**：`html` 给邮件 / 飞书 / Notion
   * 这类富文本目标，`plain`（Markdown 源码）给终端 / 代码框。只放 html 的话，
   * 纯文本目标收到的会是一堆标签 */
  copyHtml(html: string, plain: string): Promise<void>
  /** ---- 0.2.0 文件索引（契约 v21）----
   * 树根下的全部文档路径（与跨文件搜索同一套目录黑名单与后缀白名单，壳侧 `DocScan`）。
   * 遍历在壳侧做 —— 渲染层递归 `readDir` 是几百次桥调用（判断 3 同款理由）。
   * 上限 4000 条，超出即截断（快速打开的列表本来也只看前几十条） */
  listFiles(root: string): Promise<string[]>
  /** ---- 写剪贴板（契约 v9，P3-6 大纲「复制本节锚点」）----
   * 与读那条同源：剪贴板归壳管。`navigator.clipboard` 在 `app://r` 下不是安全上下文，
   * 压根拿不到，别绕这条路 */
  writeClipboardText(text: string): void
  /** ---- 图片粘贴（契约 v5）----
   * 把剪贴板里的图片落盘到 <docDir>/assets/，返回相对路径（不含 docDir）。
   * 渲染层只发一个请求、只收一个字符串 —— 图片数据不过 IPC 桥（判断 3）。 */
  pasteImage(docDir: string | null): Promise<{ relPath: string } | null>

  /** ---- P0 自动保存 / 崩溃恢复 / 外部变更（契约 v2，见 CONTEXT.md）---- */
  /** 无路径文档的静默落盘：写 ~/Library/Application Support/cursive/scratch/<id>.json */
  scratchSave(id: string, content: string, fp: FileFingerprint): Promise<void>
  scratchList(): Promise<ScratchDoc[]>
  /** 标签真正关闭或已另存为路径后，清掉对应 scratch */
  scratchClear(id: string): Promise<void>
  /** ---- 0.2.0 版本历史（契约 v22）----
   * 每次**保存到真实路径**之后留一份快照，落在
   * `~/Library/Application Support/cursive/history/<路径摘要>/<时间戳>.md`。
   *
   * 三条约束都在壳侧实现，渲染层不必知道：
   * ① **去重** —— 与最新那份逐字节相同就不写（自动保存会反复触发同一份内容）；
   * ② **留存上限** —— 每份文件只留最近 50 条，且丢掉 30 天前的（但至少保住 10 条）；
   * ③ 只有带路径的文档才有历史，未命名文档归 scratch 管（那是另一件事：崩溃恢复）。
   *
   * `snapshotSave` 返回是否真的写了一份（去重命中时是 false）。 */
  snapshotSave(path: string, content: string): Promise<boolean>
  snapshotList(path: string): Promise<Snapshot[]>
  /** 单取一份的正文；快照已被清理掉则返回 null */
  snapshotRead(path: string, id: string): Promise<string | null>

  /** 外部修改确认（脏标签收到外部变更时弹）：'reload' 重载 | 'keep' 保留我的版本 */
  confirmReload(name: string): Promise<'reload' | 'keep'>
  /** 当前打开的全部文档路径（壳侧据此注册外部变更监听） */
  openTabs(paths: string[]): void
  onFileChangedExternal(fn: (path: string) => void): () => void
  /** ---- 拖拽落盘（契约 v6）----
   * Finder 拖图片进窗口：壳已把图复制到 <docDir>/assets/，渲染层只收到相对路径，
   * 在当前光标处插入 ![名](assets/…)。 */
  onImageDropped(fn: (relPath: string) => void): () => void

  /** ---- 主题（契约 v3）----
   * 渲染层切主题后同步原生外观：标题栏、红绿灯、NSAlert、NSOpenPanel 都吃这个。
   * 不同步的话切一半很违和 —— 正文暗了，系统面板还是亮的。
   * 'system' = 交还给系统（NSApp.appearance = nil）。 */
  setAppearance(mode: AppearanceMode): void

  /** ---- 标题栏放行区段（契约 v26）----
   * 原生拖拽条整条盖在 webview 上，落在它下面的东西默认一个点击都收不到；
   * 这里报的是「这一条上哪几段不归拖拽」（CSS px 的 `[左, 右]`，壳按 pageZoom 换算）。
   * 正文的标签顶到最上面之后段数与位置跟着标签数 / 窗口宽度 / 面板显隐一起变，
   * 壳里再写死区间就对不上了 —— 量在渲染层，壳照做。空数组 = 整条都归拖拽。
   * 算法与合帧去重在 `ui/drag-holes.ts`。 */
  setTitlebarHoles(holes: [number, number][]): void

  /** ---- P3-2 跨文件搜索（契约 v11）----
   * `searchFiles` 立刻返回，结果经 `onSearchHits` 分批推回、`onSearchDone` 收尾。
   * 同一时刻只跑一个搜索：新的一次会自动取消上一次（壳侧 OperationQueue 串行）。 */
  searchFiles(token: number, root: string, query: string, opts: SearchOptions): void
  cancelSearch(token: number): void
  onSearchHits(fn: (batch: SearchBatch) => void): () => void
  onSearchDone(fn: (done: SearchDone) => void): () => void

  /** ---- P3-4 自定义主题（契约 v12）----
   * 扫 `~/Library/Application Support/cursive/themes/*.css`，整份 CSS 一起回来
   * （皮肤文件就几 KB，不值得为它再开一条读文件通道） */
  userThemes(): Promise<UserTheme[]>

  /** ---- P4-1 导出 HTML（契约 v15）----
   * 正文由**渲染层**渲染（与实时预览同一棵语法树，见 `renderer/export/`），
   * 壳只管两件事：保存面板（顺带一颗「嵌入图片」复选框）、把 `<img data-abs>` 指着的
   * 本地图片读盘转成 data: URI。**图片字节不过 IPC 桥**（判断 3）——
   * 渲染层只在属性里写清楚去哪儿取。取消或写入失败返回 null。 */
  exportHtml(html: string, defaultName: string): Promise<{ path: string } | null>

  /** ---- P3-7 多窗口（契约 v13）----
   * 开一个新窗口。窗口之间除了 localStorage 与**偏好广播**（契约 v17）全无共享状态 ——
   * localStorage 是共享的**存储**，不是共享的**通知**：各窗口在启动时各读一份进内存，
   * 之后谁改了谁自己知道，所以要有 v17 那条广播。 */
  /** 契约 v14：带路径就让新窗口直接落在那个文件 / 文件夹上（不带 = 空白新窗口） */
  newWindow(path?: string): void

  /** ---- 视图开关勾选态（契约 v8，P3-3）----
   * 侧边栏/大纲/格式栏/源代码模式/专注/打字机的开关状态全在渲染层（localStorage），
   * 壳的菜单自己不知道 —— 每次切换推一次，菜单项才打得出勾。 */
  setViewFlags(flags: ViewFlags): void

  /** ---- 界面语言（契约 v16）----
   * 渲染层 localStorage（`cursive.prefs.lang`）是真相源，壳不持久化：启动时被推一次、
   * 用户切换时再推一次。壳收到后重建菜单栏（`buildMenu()` 可重入），原生菜单与
   * NSAlert/NSOpenPanel 等对话框文案随 `uiLang` 走。 */
  setLanguage(lang: UiLang): void

  /** ---- 跨窗口偏好同步（契约 v17）----
   * 偏好的真相是渲染层的 localStorage，而**每个窗口在启动时各读一份进内存** ——
   * 于是 A 窗改完主题/语言/字号，B 窗的内存副本还是旧的，要等下次重开才对得上。
   * 更糟的是原生那半是 **app 级**的（`setAppearance` 设的 `NSApp.appearance` 一次管所有窗口），
   * B 窗于是停在「标题栏已经深色、正文还是浅色」这种自相矛盾的状态上。
   *
   * `syncPrefs` 把整份偏好交给壳，壳**不读内容、不持久化**，只原样转给
   * 除发起者以外的窗口（`onPrefsChanged`）。收的那一侧 `Prefs.adopt()` 重新上色但
   * **不落盘、不回广播** —— 发起窗口已经写过了，回广播则是直接转圈。 */
  syncPrefs(values: PrefValues): void
  onPrefsChanged(fn: (values: PrefValues) => void): () => void

  /** ---- 0.3.0 T2 检查更新（契约 v27）----
   * **只在用户点那一下联网**：不开机检查、不后台轮询、不记住谁点过 ——
   * 一个不联网的人用这个 app，应该一个字节都不多背（这条同时写在 README 里）。
   *
   * 为什么联网的是壳而不是页面：页面的 CSP 是 `default-src 'self'`，`fetch` 根本出不去，
   * 而为一颗按钮把整张网页的出网口开开，代价远大于这条通道。壳这一侧只做
   * 「取一次 + 摘一个 tag」，比版本、措辞、要不要开浏览器全在渲染层。
   *
   * 连不上 / 超时 / 限流 / 响应里没有 tag，一律 `null` —— 失败的原因对用户
   * 是同一件事（没问着），而渲染层照 `warn` 那条路说一句。 */
  checkUpdate(): Promise<UpdateInfo | null>
}

/** `sepia` = 护眼（暖纸色），算在浅色一侧：`setAppearance` 给壳的是 `.aqua` */
export type AppearanceMode = 'system' | 'light' | 'dark' | 'sepia'

export type DiscardChoice = 'save' | 'discard' | 'cancel'
