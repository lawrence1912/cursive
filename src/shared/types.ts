import type { FileFingerprint } from './textfile.js'

export type MenuAction =
  | 'file:new'
  | 'file:open'
  | 'file:save'
  | 'file:save-as'
  | 'file:save-and-close'
  | 'file:open-folder'
  // ---- P4-1 导出 HTML ----
  | 'file:export-html'
  | 'edit:find'
  | 'edit:replace'
  | 'edit:find-next'
  | 'edit:find-prev'
  | 'edit:paste-plain'
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
  | 'view:toggle-dark'
  | 'app:preferences'
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

/** 一份从磁盘读到的文档 */
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

/** scratch 自动保存文件里的一条未命名文档 */
export interface ScratchDoc {
  id: string
  content: string
  fp: FileFingerprint
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
  openExternal(url: string): Promise<void>
  pickFolder(): Promise<string | null>
  readDir(path: string): Promise<DirEntry[]>
  lastFolder(): Promise<string | null>
  /** ---- P3-1 文件树读写（契约 v7）----
   * 新建的名字由**壳**弹原生输入框问（渲染层不碰原生 UI），取消或重名冲突返回 null；
   * 删除一律进废纸篓（`NSFileManager.trashItem`，可在 Finder 里找回），壳侧先弹确认。
   * 三个通道都过壳侧的 `safeTarget` 防穿越：消解 `..`，且必须落在当前树根之下 */
  createFile(dir: string): Promise<{ path: string } | null>
  createFolder(dir: string): Promise<{ path: string } | null>
  trashItem(path: string): Promise<boolean>
  /** ---- P3-1 收尾（契约 v10）----
   * `renameItem` 的新名字同样由壳弹原生输入框问（预填旧名），取消/同名返回 null；
   * `moveItem` 是文件树内拖拽，目标必须是目录，重名自动加 `-2`；
   * `revealInFinder` 走 `NSWorkspace.activateFileViewerSelecting`。三者都过 `safeTarget` */
  renameItem(path: string): Promise<{ path: string } | null>
  moveItem(src: string, destDir: string): Promise<{ path: string } | null>
  revealInFinder(path: string): void
  /** 读系统剪贴板的纯文本（⇧⌥⌘V 粘贴为纯文本用；剪贴板由壳侧读，渲染层不碰原生） */
  readClipboardText(): Promise<string>
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
}

/** `sepia` = 护眼（暖纸色），算在浅色一侧：`setAppearance` 给壳的是 `.aqua` */
export type AppearanceMode = 'system' | 'light' | 'dark' | 'sepia'

export type DiscardChoice = 'save' | 'discard' | 'cancel'
