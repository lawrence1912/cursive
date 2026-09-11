import './themes/base.css'
import './themes/live-preview.css'

import { openSearchPanel } from '@codemirror/search'
import { EditorView, type EditorState } from '@codemirror/view'
import type { Text } from '@codemirror/state'
import { basename, dirname } from '../shared/path'
import type { DocPayload, MenuAction } from '../shared/types'
import { DEFAULT_FINGERPRINT, type FileFingerprint } from '../shared/textfile'
import { count } from '../shared/wordcount'
import { livePreview } from './editor/live-preview'
import { createState, livePreviewConf } from './editor/setup'
import { Sidebar } from './ui/sidebar'
import { TabBar } from './ui/tabbar'

const host = document.getElementById('editor-host')!
const elFile = document.getElementById('status-file')!
const elCount = document.getElementById('status-count')!
const elMode = document.getElementById('status-mode')!

let sourceMode = false

const listener = EditorView.updateListener.of((u) => {
  if (u.docChanged) {
    syncStatus()
    scheduleCount()
  }
})

const view = new EditorView({ parent: host, state: createState('', listener) })

const sidebar = new Sidebar((path) => void openPath(path))
document.getElementById('workspace')!.insertBefore(sidebar.el, host)

// ---------- 标签页 ----------
// 每个标签持有独立的完整 EditorState：切走时冻结，切回 setState 原样恢复
// （装饰、撤销历史、光标都在 state 里）。shell 仍只感知「活动标签」的
// path/dirty —— dirty 聚合为「任意标签脏」，关窗保存语义不变。

interface Tab {
  id: number
  path: string | null
  fp: FileFingerprint
  state: EditorState
  savedDoc: Text
  scroll: number
  sourceMode: boolean
}

let tabs: Tab[] = []
let activeId = 0
let nextId = 1

let docPath: string | null = null
/** 原文件的换行/BOM 风格，保存时原样还原（活动标签的） */
let fingerprint: FileFingerprint = DEFAULT_FINGERPRINT

function activeTab(): Tab | undefined {
  return tabs.find((t) => t.id === activeId)
}

function tabTitle(t: Tab): string {
  return t.path ? basename(t.path).replace(/\.(md|markdown)$/i, '') : '未命名'
}

function isTabDirty(t: Tab): boolean {
  const doc = t.id === activeId ? view.state.doc : t.state.doc
  return !doc.eq(t.savedDoc)
}

function anyDirty(): boolean {
  return tabs.some((t) => isTabDirty(t))
}

const tabbar = new TabBar(
  (id) => {
    if (id !== activeId) activate(id)
  },
  (id) => void closeTab(id)
)
document.getElementById('drag-strip')!.after(tabbar.el)

function newUntitledTab(): void {
  spawnTab(createState('', listener), null, DEFAULT_FINGERPRINT)
}

function spawnTab(state: EditorState, path: string | null, fp: FileFingerprint): void {
  tabs.push({ id: nextId++, path, fp, state, savedDoc: state.doc, scroll: 0, sourceMode })
  activate(tabs[tabs.length - 1]!.id)
}

function activate(id: number): void {
  const cur = tabs.find((t) => t.id === activeId)
  if (cur && cur.id !== id) {
    cur.state = view.state
    cur.scroll = view.scrollDOM.scrollTop
    cur.sourceMode = sourceMode
  }
  const t = tabs.find((x) => x.id === id)
  if (!t) return
  activeId = id
  docPath = t.path
  fingerprint = t.fp
  sourceMode = t.sourceMode
  view.setState(t.state)
  requestAnimationFrame(() => {
    view.scrollDOM.scrollTop = t.scroll
  })
  syncMode()
  syncStatus(true)
  scheduleCount()
  void sidebar.setActive(t.path)
  view.focus()
}

async function closeTab(id: number): Promise<void> {
  const t = tabs.find((x) => x.id === id)
  if (!t) return
  if (t.id === activeId) t.state = view.state

  if (isTabDirty(t)) {
    const choice = await window.api.confirmDiscard(tabTitle(t))
    if (choice === 'cancel') return
    if (choice === 'save') {
      if (t.id === activeId) {
        if (!(await save())) return
      } else {
        const res = await window.api.save(t.path, t.state.doc.toString(), t.fp)
        if (!res) return
      }
    }
  }

  const idx = tabs.findIndex((x) => x.id === id)
  tabs = tabs.filter((x) => x.id !== id)
  if (tabs.length === 0) {
    newUntitledTab()
    return
  }
  if (id === activeId) activate(tabs[Math.min(idx, tabs.length - 1)]!.id)
  else syncStatus(true)
}

// ---------- 状态栏与脏标记 ----------

let lastDirty: boolean | null = null

/** 窗口级脏标记 = 任意标签脏（shell 的关闭拦截靠它） */
function isDirty(): boolean {
  return anyDirty()
}

function syncStatus(force = false): void {
  const dirty = isDirty()
  const t = activeTab()
  const name = t?.path ? basename(t.path) : '未命名'
  elFile.textContent = `${dirty ? '• ' : ''}${name}`
  elFile.title = t?.path ?? ''
  if (force || dirty !== lastDirty) {
    lastDirty = dirty
    window.api.setDocState({ path: docPath, dirty })
  }
  tabbar.render(
    tabs.map((x) => ({ id: x.id, title: tabTitle(x), dirty: isTabDirty(x) })),
    activeId
  )
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

/** 打开到新标签页；同一文件已开着则原地替换内容并激活 */
function openTab(content: string, path: string | null, fp: FileFingerprint): void {
  const existing = path ? tabs.find((t) => t.path === path) : undefined
  if (existing) {
    existing.state = createState(content, listener, {
      dir: path ? dirname(path) : null,
      sourceMode: existing.sourceMode
    })
    existing.savedDoc = existing.state.doc
    existing.fp = fp
    activate(existing.id)
    return
  }
  spawnTab(
    createState(content, listener, { dir: path ? dirname(path) : null, sourceMode }),
    path,
    fp
  )
}

/** 从侧边栏点开一个文件（开新标签，不碰现有标签） */
async function openPath(path: string): Promise<void> {
  if (path === docPath) return
  const doc = await window.api.read(path)
  openTab(doc.content, doc.path, doc.fingerprint)
}

async function save(): Promise<boolean> {
  const res = await window.api.save(docPath, view.state.doc.toString(), fingerprint)
  if (!res) return false
  docPath = res.path
  const t = activeTab()
  if (t) {
    t.path = res.path
    t.savedDoc = view.state.doc
  }
  syncStatus(true)
  return true
}

async function saveAs(): Promise<boolean> {
  const res = await window.api.saveAs(docPath, view.state.doc.toString(), fingerprint)
  if (!res) return false
  docPath = res.path
  const t = activeTab()
  if (t) {
    t.path = res.path
    t.savedDoc = view.state.doc
  }
  syncStatus(true)
  return true
}

async function handleMenu(action: MenuAction): Promise<void> {
  switch (action) {
    case 'file:new':
      newUntitledTab()
      break
    case 'file:open': {
      const doc = await window.api.openDialog()
      if (doc) openTab(doc.content, doc.path, doc.fingerprint)
      break
    }
    case 'file:save':
      await save()
      break
    case 'file:save-as':
      await saveAs()
      break
    case 'file:save-and-close': {
      // 关窗语义：所有脏标签都落盘；任何一个被取消就中止关闭
      const cur = activeTab()
      if (cur) cur.state = view.state
      for (const t of tabs.filter((x) => isTabDirty(x))) {
        const res = await window.api.save(t.path, t.state.doc.toString(), t.fp)
        if (!res) return
        t.savedDoc = t.state.doc
      }
      window.api.confirmClose()
      break
    }
    case 'file:open-folder':
      await sidebar.pick()
      break
    case 'edit:find':
      openSearchPanel(view)
      break
    case 'view:toggle-sidebar':
      sidebar.toggle()
      break
    case 'view:toggle-source': {
      sourceMode = !sourceMode
      const cur = activeTab()
      if (cur) cur.sourceMode = sourceMode
      syncMode()
      break
    }
  }
}

window.api.onMenu((action) => void handleMenu(action))

// 主进程推来的文档（最近文件 / Finder 双击 / 命令行）
window.api.onFileOpened((doc: DocPayload) => {
  openTab(doc.content, doc.path, doc.fingerprint)
})

// 命令行 / Finder 传来的是目录时，在侧边栏里打开它
window.api.onFolderOpened((dir) => void sidebar.open(dir))

// 暴露给冒烟脚本和开发者控制台，方便在没法手点界面时驱动编辑器
;(window as unknown as { __typmd: { view: EditorView; sidebar: Sidebar } }).__typmd = {
  view,
  sidebar
}

void sidebar.restore()
spawnTab(view.state, null, DEFAULT_FINGERPRINT)
syncMode()
syncStatus(true)
scheduleCount()
view.focus()
