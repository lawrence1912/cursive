import './themes/base.css'
import './themes/live-preview.css'

import { openSearchPanel } from '@codemirror/search'
import type { Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { basename, dirname } from '../shared/path'
import type { DocPayload, MenuAction } from '../shared/types'
import { DEFAULT_FINGERPRINT, type FileFingerprint } from '../shared/textfile'
import { count } from '../shared/wordcount'
import { livePreview } from './editor/live-preview'
import { createState, livePreviewConf } from './editor/setup'
import { Sidebar } from './ui/sidebar'

const host = document.getElementById('editor-host')!
const elFile = document.getElementById('status-file')!
const elCount = document.getElementById('status-count')!
const elMode = document.getElementById('status-mode')!

let docPath: string | null = null
/** 原文件的换行/BOM 风格，保存时原样还原 */
let fingerprint: FileFingerprint = DEFAULT_FINGERPRINT
/** 最后一次落盘时的文档内容，脏判定的基准 */
let savedDoc: Text
let sourceMode = false

const listener = EditorView.updateListener.of((u) => {
  if (u.docChanged) {
    syncStatus()
    scheduleCount()
  }
})

const view = new EditorView({ parent: host, state: createState('', listener) })
savedDoc = view.state.doc

const sidebar = new Sidebar((path) => void openPath(path))
document.getElementById('workspace')!.insertBefore(sidebar.el, host)

// ---------- 状态栏与脏标记 ----------

let lastDirty: boolean | null = null

function isDirty(): boolean {
  return !view.state.doc.eq(savedDoc)
}

function syncStatus(force = false): void {
  const dirty = isDirty()
  const name = docPath ? basename(docPath) : '未命名'
  elFile.textContent = `${dirty ? '• ' : ''}${name}`
  elFile.title = docPath ?? ''
  if (force || dirty !== lastDirty) {
    lastDirty = dirty
    window.api.setDocState({ path: docPath, dirty })
  }
}

let countTimer: number | undefined
function scheduleCount(): void {
  clearTimeout(countTimer)
  countTimer = window.setTimeout(() => {
    const { words, chars } = count(view.state.doc.toString())
    elCount.textContent = `${words} 词 · ${chars} 字符`
  }, 200)
}

function syncMode(): void {
  view.dispatch({
    effects: livePreviewConf.reconfigure(sourceMode ? [] : livePreview())
  })
  view.dom.classList.toggle('typmd-source', sourceMode)
  elMode.textContent = sourceMode ? '源代码' : '预览'
}

// ---------- 文档生命周期 ----------

function load(content: string, path: string | null, fp: FileFingerprint): void {
  view.setState(createState(content, listener, { dir: path ? dirname(path) : null, sourceMode }))
  docPath = path
  fingerprint = fp
  savedDoc = view.state.doc
  syncMode()
  syncStatus(true)
  scheduleCount()
  void sidebar.setActive(path)
  view.focus()
}

/** 从侧边栏点开一个文件 */
async function openPath(path: string): Promise<void> {
  if (path === docPath) return
  if (!(await guardDirty())) return
  const doc = await window.api.read(path)
  load(doc.content, doc.path, doc.fingerprint)
}

async function save(): Promise<boolean> {
  const res = await window.api.save(docPath, view.state.doc.toString(), fingerprint)
  if (!res) return false
  docPath = res.path
  savedDoc = view.state.doc
  syncStatus(true)
  return true
}

async function saveAs(): Promise<boolean> {
  const res = await window.api.saveAs(docPath, view.state.doc.toString(), fingerprint)
  if (!res) return false
  docPath = res.path
  savedDoc = view.state.doc
  syncStatus(true)
  return true
}

/** 丢弃当前修改前的确认；返回 true 表示可以继续 */
async function guardDirty(): Promise<boolean> {
  if (!isDirty()) return true
  const choice = await window.api.confirmDiscard(docPath ? basename(docPath) : '未命名文档')
  if (choice === 'cancel') return false
  if (choice === 'discard') return true
  return save()
}

async function handleMenu(action: MenuAction): Promise<void> {
  switch (action) {
    case 'file:new':
      if (await guardDirty()) load('', null, DEFAULT_FINGERPRINT)
      break
    case 'file:open': {
      if (!(await guardDirty())) break
      const doc = await window.api.openDialog()
      if (doc) load(doc.content, doc.path, doc.fingerprint)
      break
    }
    case 'file:save':
      await save()
      break
    case 'file:save-as':
      await saveAs()
      break
    case 'file:save-and-close':
      if (await save()) window.api.confirmClose()
      break
    case 'file:open-folder':
      await sidebar.pick()
      break
    case 'view:toggle-sidebar':
      sidebar.toggle()
      break
    case 'edit:find':
      openSearchPanel(view)
      break
    case 'view:toggle-source':
      sourceMode = !sourceMode
      syncMode()
      break
  }
}

window.api.onMenu((action) => void handleMenu(action))

// 主进程推来的文档（最近文件 / Finder 双击）
window.api.onFileOpened((doc: DocPayload) => {
  void guardDirty().then((ok) => {
    if (ok) load(doc.content, doc.path, doc.fingerprint)
  })
})

// 命令行 / Finder 传来的是目录时，在侧边栏里打开它
window.api.onFolderOpened((dir) => void sidebar.open(dir))

// 暴露给冒烟脚本和开发者控制台，方便在没法手点界面时驱动编辑器
;(window as unknown as { __typmd: { view: EditorView; sidebar: Sidebar } }).__typmd = {
  view,
  sidebar
}

void sidebar.restore()
syncMode()
syncStatus(true)
scheduleCount()
view.focus()
