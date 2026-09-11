import './themes/base.css'
import './themes/live-preview.css'
import 'katex/dist/katex.min.css'

import { openSearchPanel } from '@codemirror/search'
import { EditorView } from '@codemirror/view'
import type { EditorState, Text } from '@codemirror/state'
import { basename, dirname } from '../shared/path'
import type { DocPayload, MenuAction } from '../shared/types'
import { DEFAULT_FINGERPRINT, encode, type FileFingerprint } from '../shared/textfile'
import { count } from '../shared/wordcount'
import { syntaxTree } from '@codemirror/language'
import { livePreview, themeEffect } from './editor/live-preview'
import { currentTheme } from './editor/live-preview/widgets'
import { createState, livePreviewConf } from './editor/setup'
import { applyFormat } from './editor/fmt'
import { Sidebar } from './ui/sidebar'
import { TabBar } from './ui/tabbar'
import { Outline, type OutlineItem } from './ui/outline'
import { icon } from './ui/icons'
import { Prefs } from './ui/prefs'

// 改名 typmd → cursive：老 localStorage key 一次性搬过来，搬完就删（下个大版本可以拿掉这一段）
for (const k of ['outlineVisible', 'sidebarWidth', 'prefs']) {
  const old = localStorage.getItem(`typmd.${k}`)
  if (old === null) continue
  if (localStorage.getItem(`cursive.${k}`) === null) localStorage.setItem(`cursive.${k}`, old)
  localStorage.removeItem(`typmd.${k}`)
}

const host = document.getElementById('editor-host')!
const elFile = document.getElementById('status-file')!
const elCount = document.getElementById('status-count')!
const elMode = document.getElementById('status-mode')!
const elSaved = document.getElementById('status-saved')!

let sourceMode = false

const listener = EditorView.updateListener.of((u) => {
  if (u.docChanged) {
    syncStatus()
    scheduleCount()
    scheduleAutosave()
  }
})

const view = new EditorView({ parent: host, state: createState('', listener) })

// 主题 + 排版偏好。字号/行距一变，CodeMirror 缓存的字符尺寸就过期了，必须重量
const prefs = new Prefs(() => view.requestMeasure())
prefs.apply()

const sidebar = new Sidebar((path) => void openPath(path))
const center = document.getElementById('center')!
document.getElementById('main')!.insertBefore(sidebar.el, center)

const outline = new Outline((pos) => {
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 12 })
  })
  view.focus()
})
document.getElementById('main')!.appendChild(outline.el)
outline.el.classList.toggle('is-hidden', localStorage.getItem('cursive.outlineVisible') === '0')
view.scrollDOM.addEventListener('scroll', () => {
  outline.setActive(activeHeadingPos())
})

// ---------- 标题栏按钮 ----------
// 两个面板开关从面板头部搬到拖拽条的左右两端（红绿灯右边 / 最右）：面板藏起来之后
// 开关还在，不用去翻菜单，也不会像旧的「唤回浮标」那样压住第一个标签。
// ⚠️ 位置与 shell-swift 的 `DragStripView.hitTest` 挖洞区强耦合 —— 原生拖拽条整条盖在
// webview 上，不挖洞这两个按钮根本收不到点击（改 CSS 的 padding/尺寸记得同步壳）。
const tbSidebar = titlebarButton('tb-sidebar', 'panel-left', '文件树', '⌘\\')
const tbOutline = titlebarButton('tb-outline', 'panel-right', '大纲', '⌘⇧T')
const tbSpacer = document.createElement('span')
tbSpacer.className = 'tb-spacer'
document.getElementById('drag-strip')!.append(tbSidebar, tbSpacer, tbOutline)
tbSidebar.addEventListener('click', toggleSidebar)
tbOutline.addEventListener('click', toggleOutline)
syncTitlebar()

function titlebarButton(id: string, name: 'panel-left' | 'panel-right', label: string, key: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.id = id
  b.className = 'tb-btn'
  b.innerHTML = icon(name)
  b.title = `显示/隐藏${label} (${key})`
  b.setAttribute('aria-label', `显示/隐藏${label}`)
  return b
}

function toggleSidebar(): void {
  sidebar.toggle()
  syncTitlebar()
}

function toggleOutline(): void {
  outline.toggle()
  localStorage.setItem('cursive.outlineVisible', outline.visible ? '1' : '0')
  if (outline.visible) updateOutline()
  syncTitlebar()
}

/** 按钮亮=面板开着。aria-pressed 让读屏也拿得到这个状态 */
function syncTitlebar(): void {
  for (const [b, on] of [[tbSidebar, sidebar.visible], [tbOutline, outline.visible]] as const) {
    b.classList.toggle('is-on', on)
    b.setAttribute('aria-pressed', String(on))
  }
}

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
  /** 无路径文档的 scratch 快照 id（自动保存用） */
  scratchId?: string
  /** 磁盘文件被外部修改且本标签有未保存改动 */
  stale?: boolean
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
center.prepend(tabbar.el)

function newUntitledTab(): void {
  spawnTab(createState('', listener), null, DEFAULT_FINGERPRINT)
}

function spawnTab(state: EditorState, path: string | null, fp: FileFingerprint): Tab {
  // 启动时的空白首标签直接复用，避免「打开一个文件却多出一个空标签」
  const pristine = tabs.find(
    (t) => !t.path && !isTabDirty(t) && t.state.doc.length === 0
  )
  if (pristine) {
    pristine.state = state
    pristine.path = path
    pristine.fp = fp
    pristine.savedDoc = state.doc
    activate(pristine.id)
    return pristine
  }
  const t: Tab = { id: nextId++, path, fp, state, savedDoc: state.doc, scroll: 0, sourceMode }
  tabs.push(t)
  activate(t.id)
  return t
}

function activate(id: number): void {
  const cur = tabs.find((t) => t.id === activeId)
  if (cur && cur.id !== id) {
    cur.state = view.state
    cur.scroll = view.scrollDOM.scrollTop
    cur.sourceMode = sourceMode
    void flushTabAutosave(cur)
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
  updateOutline()
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
    tabs.map((x) => ({
      id: x.id,
      title: tabTitle(x),
      dirty: isTabDirty(x),
      stale: x.stale === true,
      path: x.path
    })),
    activeId
  )
  window.api.openTabs(tabs.map((x) => x.path).filter((p): p is string => p !== null))
}

let countTimer: number | undefined
function scheduleCount(): void {
  clearTimeout(countTimer)
  countTimer = window.setTimeout(() => {
    const { words, chars } = count(view.state.doc.toString())
    elCount.textContent = `${words} 词 · ${chars} 字符`
    scheduleOutline()
  }, 200)
}

// ---------- 大纲视图 ----------

let outlineTimer: number | undefined
function scheduleOutline(): void {
  clearTimeout(outlineTimer)
  outlineTimer = window.setTimeout(updateOutline, 250)
}

function updateOutline(): void {
  const items: OutlineItem[] = []
  syntaxTree(view.state).iterate({
    from: 0,
    to: view.state.doc.length,
    enter: (node) => {
      const m = /^(?:ATXHeading|SetextHeading)([1-6])$/.exec(node.name)
      if (!m) return
      const level = Number(m[1])
      const text = view.state.doc
        .sliceString(node.from, node.to)
        .replace(/^#{1,6}\s+/, '')
        .replace(/\s+#+\s*$/, '')
        .trim()
      items.push({ level, text: text || '（空标题）', pos: node.from })
    }
  })
  outline.setItems(items)
  outline.setActive(activeHeadingPos())
}

/** 视口顶部所在行 → 它之前最近的一个标题位置（滚动跟随高亮） */
function activeHeadingPos(): number | null {
  const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop)
  let pos: number | null = null
  syntaxTree(view.state).iterate({
    from: 0,
    to: Math.min(block.from + 1, view.state.doc.length),
    enter: (node) => {
      if (/^(?:ATXHeading|SetextHeading)[1-6]$/.test(node.name)) pos = node.from
    }
  })
  return pos
}

function syncMode(): void {
  view.dispatch({
    effects: livePreviewConf.reconfigure(sourceMode ? [] : livePreview())
  })
  view.dom.classList.toggle('cursive-source', sourceMode)
  elMode.textContent = sourceMode ? '源代码' : '预览'
}

// ---------- 文档生命周期 ----------

/** 打开到新标签页；同一文件已开着则原地替换内容并激活 */
function openTab(content: string, path: string | null, fp: FileFingerprint): Tab {
  const existing = path ? tabs.find((t) => t.path === path) : undefined
  if (existing) {
    existing.state = createState(content, listener, {
      dir: path ? dirname(path) : null,
      sourceMode: existing.sourceMode
    })
    existing.savedDoc = existing.state.doc
    existing.fp = fp
    activate(existing.id)
    return existing
  }
  return spawnTab(
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
    if (t.scratchId) {
      void window.api.scratchClear(t.scratchId)
      t.scratchId = undefined
    }
  }
  markSaved()
  syncStatus(true)
  return true
}

function markSaved(): void {
  const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  elSaved.textContent = `已保存 ${time}`
}

async function saveAs(): Promise<boolean> {
  const res = await window.api.saveAs(docPath, view.state.doc.toString(), fingerprint)
  if (!res) return false
  docPath = res.path
  const t = activeTab()
  if (t) {
    t.path = res.path
    t.savedDoc = view.state.doc
    if (t.scratchId) {
      void window.api.scratchClear(t.scratchId)
      t.scratchId = undefined
    }
  }
  markSaved()
  syncStatus(true)
  return true
}

// ---------- P0-2 自动保存（2s 防抖 / 切标签 / 失焦即时落盘） ----------

let autosaveTimer: number | undefined
function scheduleAutosave(): void {
  clearTimeout(autosaveTimer)
  autosaveTimer = window.setTimeout(() => void flushAutosave(), 2000)
}

/** 静默落盘一个标签：有路径走 save，无路径进 scratch */
async function flushTabAutosave(t: Tab): Promise<void> {
  if (t.id === activeId) t.state = view.state
  if (!isTabDirty(t)) return
  if (t.path) {
    const res = await window.api.save(t.path, t.state.doc.toString(), t.fp)
    if (res) {
      t.savedDoc = t.state.doc
      markSaved()
    }
  } else {
    t.scratchId ??= `tab-${Date.now()}-${t.id}`
    await window.api.scratchSave(t.scratchId, t.state.doc.toString(), t.fp)
  }
}

async function flushAutosave(): Promise<void> {
  const t = activeTab()
  if (t) await flushTabAutosave(t)
}

window.addEventListener('blur', () => {
  for (const t of [...tabs]) void flushTabAutosave(t)
})

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
      toggleSidebar()
      break
    case 'view:toggle-outline':
      toggleOutline()
      break
    case 'view:theme-system':
      prefs.setTheme('system')
      break
    case 'view:theme-light':
      prefs.setTheme('light')
      break
    case 'view:theme-dark':
      prefs.setTheme('dark')
      break
    case 'app:preferences':
      prefs.toggle()
      break
    case 'view:toggle-source': {
      sourceMode = !sourceMode
      const cur = activeTab()
      if (cur) cur.sourceMode = sourceMode
      syncMode()
      break
    }
    default:
      // P2-1 格式化命令：fmt:* 前缀统一走 fmt.ts 引擎
      if (action.startsWith('fmt:')) applyFormat(view, action)
      break
  }
}

window.api.onMenu((action) => void handleMenu(action))

// 主进程推来的文档（最近文件 / Finder 双击 / 命令行）
window.api.onFileOpened((doc: DocPayload) => {
  openTab(doc.content, doc.path, doc.fingerprint)
})

// 命令行 / Finder 传来的是目录时，在侧边栏里打开它
window.api.onFolderOpened((dir) => void sidebar.open(dir))

// ---------- P0-3 外部变更 ----------
window.api.onFileChangedExternal((path) => void handleExternalChange(path))

async function handleExternalChange(path: string): Promise<void> {
  const t = tabs.find((x) => x.path === path)
  if (!t) return
  let disk: DocPayload
  try {
    disk = await window.api.read(path)
  } catch {
    t.stale = true
    syncStatus(true)
    return
  }
  const curText = t.id === activeId ? view.state.doc.toString() : t.state.doc.toString()
  // 与磁盘一致 → 是我们自己的自动保存触发的监听事件，忽略
  if (encode(curText, t.fp) === encode(disk.content, disk.fingerprint)) return

  if (t.id === activeId) {
    if (!isTabDirty(t)) {
      // 干净：静默重载，保留滚动与光标
      const scroll = view.scrollDOM.scrollTop
      const sel = view.state.selection
      t.state = createState(disk.content, listener, { dir: dirname(path), sourceMode })
      t.savedDoc = t.state.doc
      t.fp = disk.fingerprint
      fingerprint = disk.fingerprint
      view.setState(t.state)
      view.dispatch({ selection: sel })
      requestAnimationFrame(() => {
        view.scrollDOM.scrollTop = scroll
      })
      syncMode()
      syncStatus(true)
      updateOutline()
      return
    }
    const choice = await window.api.confirmReload(tabTitle(t))
    if (choice === 'reload') {
      const scroll = view.scrollDOM.scrollTop
      const sel = view.state.selection
      t.state = createState(disk.content, listener, { dir: dirname(path), sourceMode })
      t.savedDoc = t.state.doc
      t.fp = disk.fingerprint
      fingerprint = disk.fingerprint
      view.setState(t.state)
      view.dispatch({ selection: sel })
      requestAnimationFrame(() => {
        view.scrollDOM.scrollTop = scroll
      })
      syncMode()
      syncStatus(true)
      updateOutline()
    }
    // 'keep'：保留编辑器版本，不做任何事（后续自动保存会覆盖外部改动）
    return
  }

  // 非活动标签：干净就静默换内容，脏则标记失效
  if (!isTabDirty(t)) {
    t.state = createState(disk.content, listener, {
      dir: dirname(path),
      sourceMode: t.sourceMode
    })
    t.savedDoc = t.state.doc
    t.fp = disk.fingerprint
    syncStatus(true)
  } else {
    t.stale = true
    syncStatus(true)
  }
}

// 暴露给冒烟脚本和开发者控制台，方便在没法手点界面时驱动编辑器
;(window as unknown as { __cursive: { view: EditorView; sidebar: Sidebar } }).__cursive = {
  view,
  sidebar
}

void sidebar.restore()
spawnTab(view.state, null, DEFAULT_FINGERPRINT)
syncMode()
syncStatus(true)
scheduleCount()
view.focus()

// 主题 → 块级 widget：mermaid 的配色烘在 SVG 里，切主题必须重渲染。
// data-theme 由 ui/prefs.ts 钉成确定的 light/dark，这里监听它：活动标签实时
// 重渲染；冻结标签把 state 重建一遍 —— widget DOM 会被 CM 按 eq() 缓存，
// 不重建 state 的话切回标签还是旧配色的图
function syncThemeToTabs(): void {
  const theme = currentTheme()
  for (const t of tabs) {
    if (t.id === activeId) view.dispatch({ effects: themeEffect.of(theme) })
    // 冻结标签：state.update 返回 Transaction，新 state 在 .state 上
    else t.state = t.state.update({ effects: themeEffect.of(theme) }).state
  }
}
new MutationObserver(syncThemeToTabs).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-theme']
})

// P0-2 崩溃恢复：上次留下的 scratch 未命名文档，替换启动空白标签。
// 整段是异步的，而 argv/Finder 那份文件是壳轮询 __cursive 就绪后推过来的 ——
// 两边谁先到都有可能，所以这里必须假设「等 scratchList 的工夫文件已经开好了」
void (async () => {
  const list = await window.api.scratchList()
  if (!list.length) return
  // 恢复出来的草稿是背景内容，不能把用户刚点开的那份挤下去（spawnTab 会自动激活新标签）
  const keep = activeTab()?.path ? activeId : null
  tabs = tabs.filter((t) => !(t.path === null && !isTabDirty(t)))
  // 被过滤掉的往往正是活动标签（启动空白页）。activeId 悬空的话，接下来的 activate()
  // 既不会冻结旧 state，也不会更新 docPath —— 状态栏会一直显示那个已经不存在的文件名
  if (!tabs.some((t) => t.id === activeId)) activeId = 0
  for (const s of list) {
    const t = spawnTab(createState(s.content, listener, { sourceMode }), null, s.fp)
    t.scratchId = s.id
  }
  if (keep !== null) activate(keep)
})()
