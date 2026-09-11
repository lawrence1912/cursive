import type { FileFingerprint } from './textfile.js'

export type MenuAction =
  | 'file:new'
  | 'file:open'
  | 'file:save'
  | 'file:save-as'
  | 'file:save-and-close'
  | 'file:open-folder'
  | 'edit:find'
  | 'edit:find-next'
  | 'edit:find-prev'
  | 'edit:paste-plain'
  | 'view:toggle-source'
  | 'view:toggle-sidebar'
  | 'view:toggle-outline'
  | 'view:theme-system'
  | 'view:theme-light'
  | 'view:theme-dark'
  | 'app:preferences'
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
  /** 读系统剪贴板的纯文本（⇧⌥⌘V 粘贴为纯文本用；剪贴板由壳侧读，渲染层不碰原生） */
  readClipboardText(): Promise<string>
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
}

export type AppearanceMode = 'system' | 'light' | 'dark'

export type DiscardChoice = 'save' | 'discard' | 'cancel'
