import type { FileFingerprint } from './textfile.js'

export type MenuAction =
  | 'file:new'
  | 'file:open'
  | 'file:save'
  | 'file:save-as'
  | 'file:save-and-close'
  | 'file:open-folder'
  | 'edit:find'
  | 'view:toggle-source'
  | 'view:toggle-sidebar'
  | 'view:toggle-outline'

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

/** preload 通过 contextBridge 暴露给渲染进程的接口 */
export interface TypmdApi {
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
}

export type DiscardChoice = 'save' | 'discard' | 'cancel'
