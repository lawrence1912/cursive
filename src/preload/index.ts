import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DocPayload, DocState, MenuAction, TypmdApi } from '../shared/types.js'

function subscribe<T>(channel: string, fn: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => fn(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.off(channel, listener)
}

const api: TypmdApi = {
  openDialog: () => ipcRenderer.invoke('file:open-dialog'),
  read: (path) => ipcRenderer.invoke('file:read', path),
  save: (path, content, fingerprint) => ipcRenderer.invoke('file:save', path, content, fingerprint),
  saveAs: (current, content, fingerprint) =>
    ipcRenderer.invoke('file:save-as', current, content, fingerprint),

  onMenu: (fn) => subscribe<MenuAction>('menu', fn),
  onFileOpened: (fn) => subscribe<DocPayload>('file:opened', fn),
  onFolderOpened: (fn) => subscribe<string>('folder:opened', fn),

  setDocState: (state: DocState) => ipcRenderer.send('doc:state', state),
  confirmClose: () => ipcRenderer.send('win:confirm-close'),
  confirmDiscard: (name) => ipcRenderer.invoke('dialog:confirm-discard', name),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  pickFolder: () => ipcRenderer.invoke('dir:open-dialog'),
  readDir: (path) => ipcRenderer.invoke('dir:read', path),
  lastFolder: () => ipcRenderer.invoke('dir:last')
}

contextBridge.exposeInMainWorld('api', api)
