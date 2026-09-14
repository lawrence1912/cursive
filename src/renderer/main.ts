import './themes/base.css'
import './themes/live-preview.css'
import 'katex/dist/katex.min.css'

import { findNext, findPrevious, openSearchPanel } from '@codemirror/search'
import { EditorView } from '@codemirror/view'
import type { EditorState, Text, TransactionSpec } from '@codemirror/state'
import { basename, dirname } from '../shared/path'
import type { DocPayload, MenuAction, SearchHit } from '../shared/types'
import { DEFAULT_FINGERPRINT, encode, type FileFingerprint } from '../shared/textfile'
import { group, readLabel } from '../shared/wordcount'
import { applyI18n, detectLang, getLang, localeOf, onLangChange, setLang, t } from './i18n'
import {
  collectHeadings,
  headingBefore,
  levelChangeSpec,
  moveSectionSpec,
  newSiblingSpec,
  sections,
  slugs,
  type Section
} from './editor/headings'
import { livePreview, themeEffect } from './editor/live-preview'
import { currentTheme } from './editor/live-preview/widgets'
import { bottomOverlay, createState, livePreviewConf, writingConf, writingNow } from './editor/setup'
import { writingModes } from './editor/writing-modes'
import { applyFormat, formatStateAt } from './editor/fmt'
import { focusKeepScroll } from './editor/focus'
import { insertText } from './editor/paste'
import { exportHtmlDocument } from './export'
import { openReplace, searchStat } from './editor/search-panel'
import { Sidebar } from './ui/sidebar'
import { TabBar } from './ui/tabbar'
import { Outline } from './ui/outline'
import { FormatBar, FORMAT_BAR_SPACE } from './ui/format-bar'
import { icon, type IconName } from './ui/icons'
import { Prefs } from './ui/prefs'
import { cursorLabel, measure, selectedText, StatsPanel, type Stat } from './ui/stats'

// 改名 typmd → cursive：老 localStorage key 一次性搬过来，搬完就删（下个大版本可以拿掉这一段）
for (const k of ['outlineVisible', 'sidebarWidth', 'prefs']) {
  const old = localStorage.getItem(`typmd.${k}`)
  if (old === null) continue
  if (localStorage.getItem(`cursive.${k}`) === null) localStorage.setItem(`cursive.${k}`, old)
  localStorage.removeItem(`typmd.${k}`)
}

// 界面语言必须在**建任何组件之前**定下来 —— chrome 一出生就得是对的。
// 真相源在 cursive.prefs.lang（ui/prefs.ts），这里先用同一套规则解出初始值；
// 静态文案（index.html 上的 title 等）跟着翻一遍；语言也推给壳（契约 v16），
// 让原生菜单/对话框与渲染层一致
setLang(detectLang())
applyI18n()
window.api.setLanguage(getLang())

const host = document.getElementById('editor-host')!
const elFile = document.getElementById('status-file')!
const elCount = document.getElementById('status-count')!
const elPos = document.getElementById('status-pos')!
const elMode = document.getElementById('status-mode')!
const elSaved = document.getElementById('status-saved')!
const elMatch = document.getElementById('status-match')!

let sourceMode = false

const listener = EditorView.updateListener.of((u) => {
  if (u.docChanged) {
    syncStatus()
    scheduleCount()
    scheduleAutosave()
  }
  if (u.docChanged || u.selectionSet) {
    syncFormatBar()
    syncCursor()
    scheduleSelCount()
  }
  // 查找输入改的是 state effect（不是 doc/selection），所以每次 update 都刷计数
  syncSearchCount()
})

/**
 * 状态栏的「第 n 处 / 共 N 处」。计数本身算在 `editor/search-panel.ts`
 * （面板里那个 `3/12` 是同一份，按 EditorState 缓存，一次 update 只数一遍）。
 * 面板里的是给手用的、这条是给眼睛扫的，措辞各按各的场合来。
 */
function syncSearchCount(): void {
  const stat = searchStat(view.state)
  elMatch.textContent = stat.empty
    ? ''
    : stat.invalid
      ? t('status.regexInvalid')
      : stat.total === 0
        ? t('status.noMatch')
        : t('status.match', {
            index: stat.index || stat.total,
            total: stat.total,
            cap: stat.capped ? '+' : ''
          })
}

// P3-3 写作模式：必须在建第一个 EditorState 之前读出来（createState 拿 writingNow 当种子）
try {
  const saved = JSON.parse(localStorage.getItem('cursive.writing') ?? '{}') as Record<string, unknown>
  writingNow.focus = saved['focus'] === true
  writingNow.typewriter = saved['typewriter'] === true
} catch {
  /* 隐私模式 / 存储被禁：两个模式都按关处理 */
}

const view = new EditorView({ parent: host, state: createState('', listener) })

// 主题 + 排版偏好。字号/行距一变，CodeMirror 缓存的字符尺寸就过期了，必须重量
const prefs = new Prefs(() => view.requestMeasure())
prefs.apply()

const sidebar = new Sidebar({
  openFile: (path) => void openPath(path),
  // 文件进了废纸篓：它开着的标签也得关掉，否则标签指着一个不存在的文件
  trashed: (path) => {
    for (const t of tabs.filter((x) => x.path === path)) void closeTab(t.id, true)
  },
  // P3-1 收尾：重命名 / 拖走之后路径变了。开着的标签要跟着改，否则下一次保存
  // 会按旧路径写回去 —— 等于凭空复活一个已经不在那儿的文件
  moved: (from, to) => retargetTabs(from, to),
  openHit: (hit) => void openHit(hit),
  pickFolder: () => openFolder()
})
/**
 * 「打开文件夹」= **开一个新窗口**（一个窗口 = 一个工作区，与 Finder 打开文件夹同一条规矩）。
 * 唯一的例外是当前窗口还干净得像刚开出来 —— 一个空白标签、没改过东西 ——
 * 那就地挂上，否则「新建窗口 → 打开文件夹」会白白留下一个空窗口在那儿。
 */
async function openFolder(): Promise<void> {
  const dir = await window.api.pickFolder()
  if (!dir) return
  const fresh = tabs.length <= 1 && !tabs[0]?.path && !(tabs[0] && isTabDirty(tabs[0]))
  if (fresh) await sidebar.open(dir)
  else window.api.newWindow(dir)
}

const center = document.getElementById('center')!
document.getElementById('main')!.insertBefore(sidebar.el, center)

// P2-8：底部悬浮格式栏。挂在 #center 里（不是 body）—— 侧边栏/大纲一开一关，
// 它要跟着编辑区一起居中，而不是相对整个窗口
const formatBar = new FormatBar((action) => {
  applyFormat(view, action)
  view.focus()
})
center.appendChild(formatBar.el)
formatBar.setVisible(localStorage.getItem('cursive.formatBar') !== '0')
syncFormatBar()

function toggleFormatBar(): void {
  formatBar.toggle()
  localStorage.setItem('cursive.formatBar', formatBar.visible ? '1' : '0')
  syncFormatBar()
  syncViewFlags()
}

/** 显示状态一变，编辑器的滚动下边距要跟着改，否则光标会躲到条子后面 */
function syncFormatBar(): void {
  bottomOverlay.height = formatBar.visible ? FORMAT_BAR_SPACE : 0
  if (formatBar.visible) formatBar.setState(formatStateAt(view.state))
}

/** 当前文档的标题表：updateOutline 重建，滚动跟随与大纲的几个命令都读它 */
let headings: Section[] = []

/**
 * 大纲的五个动作。**会改文档的三个（搬节 / 升降级 / 新建同级）都是
 * `editor/headings.ts` 里的纯函数算出一次 dispatch** —— 一步撤销、
 * 「保存零损耗」的判定也只需要盯那一处
 */
const outline = new Outline({
  jump: (pos) => {
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 12 })
    })
    view.focus()
  },
  move: (fromPos, beforePos) => {
    const spec = moveSectionSpec(view.state, headings, fromPos, beforePos)
    if (spec) applyOutlineEdit(spec)
  },
  setLevel: (pos, level) => {
    const h = headings.find((x) => x.pos === pos)
    const spec = h ? levelChangeSpec(view.state, h, level) : null
    if (spec) applyOutlineEdit(spec)
  },
  newSibling: (pos) => {
    const h = headings.find((x) => x.pos === pos)
    if (!h) return
    applyOutlineEdit(newSiblingSpec(view.state, h))
    view.focus()
  },
  copyAnchor: (pos) => {
    const i = headings.findIndex((x) => x.pos === pos)
    // 锚点按全文算重名后缀，所以整份一起算再取第 i 个
    if (i >= 0) window.api.writeClipboardText(`#${slugs(headings)[i]}`)
  }
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
const tbSidebar = titlebarButton('tb-sidebar', 'panel-left', t('tb.sidebar'), '⌘\\')
const tbTheme = titlebarButton('tb-theme', 'moon', t('tb.theme'), '⌃⌘D')
const tbColumn = titlebarButton('tb-column', 'column', t('tb.column'))
const tbOutline = titlebarButton('tb-outline', 'panel-right', t('tb.outline'), '⌘⇧T')
const tbSpacer = document.createElement('span')
tbSpacer.className = 'tb-spacer'
// 右上角这一块是一个整体（深色 / 栏宽 / 大纲）：三颗按钮共用一个容器，
// ⚠️ 它的总宽与 shell-swift `DragStripView.hitTest` 的右侧挖洞区强耦合 ——
// 原生拖拽条整条盖在 webview 上，不挖洞这几颗按钮根本收不到点击
const tbGroup = document.createElement('div')
tbGroup.className = 'tb-group'
tbGroup.append(tbTheme, tbColumn, tbOutline)
document.getElementById('drag-strip')!.append(tbSidebar, tbSpacer, tbGroup)
tbSidebar.addEventListener('click', toggleSidebar)
tbOutline.addEventListener('click', toggleOutline)
tbTheme.addEventListener('click', () => prefs.toggleDark())
tbColumn.addEventListener('click', () => prefs.toggleColumn(tbColumn))
syncTitlebar()

function titlebarButton(id: string, name: IconName, label: string, key = ''): HTMLButtonElement {
  const b = document.createElement('button')
  b.id = id
  b.className = 'tb-btn'
  b.innerHTML = icon(name)
  b.title = key ? `${label} (${key})` : label
  b.setAttribute('aria-label', label)
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
  syncThemeButton()
  syncViewFlags()
}

/** 月亮=现在是浅色（按下去会变深）；太阳=现在是深色。图标说的是**按下去会发生什么** */
function syncThemeButton(): void {
  const dark = prefs.resolved === 'dark'
  tbTheme.innerHTML = icon(dark ? 'sun' : 'moon')
  tbTheme.title = `${dark ? t('tb.toLight') : t('tb.toDark')} (⌃⌘D)`
  tbTheme.setAttribute('aria-label', dark ? t('tb.toLight') : t('tb.toDark'))
  tbTheme.classList.toggle('is-on', dark)
}

/** 语言切换后标题栏按钮的 title/aria 重拼（带快捷键后缀，走不了 data-i18n） */
function syncTitlebarLabels(): void {
  const setBtn = (b: HTMLButtonElement, label: string, key = ''): void => {
    b.title = key ? `${label} (${key})` : label
    b.setAttribute('aria-label', label)
  }
  setBtn(tbSidebar, t('tb.sidebar'), '⌘\\')
  setBtn(tbColumn, t('tb.column'))
  setBtn(tbOutline, t('tb.outline'), '⌘⇧T')
  syncThemeButton()
}

// ---------- P3-3 写作模式（专注 / 打字机）----------

/**
 * 把当前模式落到活动 view 上。**切标签之后也要跑一次** —— 两个模式是全局的，
 * 而每个标签冻结的 EditorState 里带的是它被冻结那一刻的配置（源代码模式同款）。
 */
function syncWriting(): void {
  view.dispatch({ effects: writingConf.reconfigure(writingModes(writingNow)) })
}

function toggleWriting(key: 'focus' | 'typewriter'): void {
  writingNow[key] = !writingNow[key]
  try {
    localStorage.setItem('cursive.writing', JSON.stringify(writingNow))
  } catch {
    /* 存不下就算了，模式本身照样生效 */
  }
  syncWriting()
  syncViewFlags()
  // 焦点这会儿多半在查找框里（⌘F 开着面板再去菜单切模式）。直接 view.focus()
  // 会被 WebKit 顺手滚到旧 DOM 选区上，见 editor/focus.ts
  focusKeepScroll(view)
}

/** 视图菜单那几个勾：状态全在渲染层，壳只负责画出来（契约 v8） */
function syncViewFlags(): void {
  window.api.setViewFlags({
    sidebar: sidebar.visible,
    outline: outline.visible,
    formatBar: formatBar.visible,
    source: sourceMode,
    focus: writingNow.focus,
    typewriter: writingNow.typewriter
  })
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

function tabTitle(tab: Tab): string {
  return tab.path ? basename(tab.path).replace(/\.(md|markdown)$/i, '') : t('app.untitled')
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
  // 局部变量不能再叫 t —— 会遮住 i18n 的 t()，下面那句 `t('app.untitled')` 就成了「调用一个 Tab」
  const tab = tabs.find((x) => x.id === id)
  if (!tab) return
  activeId = id
  docPath = tab.path
  fingerprint = tab.fp
  sourceMode = tab.sourceMode
  view.setState(tab.state)
  requestAnimationFrame(() => {
    view.scrollDOM.scrollTop = tab.scroll
  })
  syncMode()
  syncWriting()
  outline.setDoc(tab.path ?? `${t('app.untitled')}-${tab.id}`)
  syncStatus(true)
  scheduleCount()
  syncCursor()
  syncFormatBar()
  updateOutline()
  void sidebar.setActive(tab.path)
  view.focus()
}

/** discard：文件已经不在了（进了废纸篓），别再问「是否保存」—— 一保存就把它复活了 */
async function closeTab(id: number, discard = false): Promise<void> {
  const t = tabs.find((x) => x.id === id)
  if (!t) return
  if (t.id === activeId) t.state = view.state

  if (!discard && isTabDirty(t)) {
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
  const cur = activeTab()
  const name = cur?.path ? basename(cur.path) : t('app.untitled')
  elFile.textContent = `${dirty ? '• ' : ''}${name}`
  elFile.title = cur?.path ?? ''
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

// ---------- P3-8 字数 / 光标位置 / 详细统计 ----------

const stats = new StatsPanel()
/** 全文统计缓存：只在文档变了才重算，挪个光标不该把 50 万字重数一遍 */
let docStat: Stat = measure('')

let countTimer: number | undefined
function scheduleCount(): void {
  clearTimeout(countTimer)
  countTimer = window.setTimeout(() => {
    docStat = measure(view.state.doc.toString())
    syncCounts()
    scheduleOutline()
  }, 200)
}

/** 选区变了只需要重数选中那一段（全文那份是缓存的），防抖比文档那条短一档 */
let selTimer: number | undefined
function scheduleSelCount(): void {
  clearTimeout(selTimer)
  selTimer = window.setTimeout(syncCounts, 120)
}

function selStat(): Stat | null {
  const text = selectedText(view.state)
  return text === null ? null : measure(text)
}

function syncCounts(): void {
  const sel = selStat()
  if (sel) {
    elCount.textContent = t('status.selected', { words: group(sel.words), chars: group(sel.chars) })
  } else {
    const read = readLabel(docStat)
    elCount.textContent =
      t('status.count', { words: group(docStat.words), chars: group(docStat.chars) }) +
      (read ? ` · ${read}` : '')
  }
  elCount.classList.toggle('is-sel', sel !== null)
  stats.render(docStat, sel)
}

/** 光标行列是 O(1)，不防抖 —— 跟着方向键走才不会慢半拍 */
function syncCursor(): void {
  elPos.textContent = cursorLabel(view.state)
}

// 条子上 mousedown 要 preventDefault，否则焦点离开编辑器、选区没了，
// 面板里的「选中」一列就永远是空的（同 P2-8 格式栏的坑 ①）
elCount.addEventListener('mousedown', (e) => e.preventDefault())
elCount.addEventListener('click', () => stats.toggle(elCount, () => [docStat, selStat()]))
elCount.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    stats.toggle(elCount, () => [docStat, selStat()])
  }
})

// ---------- 大纲视图 ----------

let outlineTimer: number | undefined
function scheduleOutline(): void {
  clearTimeout(outlineTimer)
  outlineTimer = window.setTimeout(updateOutline, 250)
}

/**
 * 大纲里那三个会改文档的命令。**改完立刻重建大纲，不等那 450ms 防抖** ——
 * 每行携带的 `pos` 是渲染那一刻的位置，改完还用旧的那份去算下一次操作，
 * 搬走的就会是错的一段（连点两下拖拽/降级必中）。防抖是给连续打字用的，
 * 这几个是离散命令，改完马上刷才对。
 */
function applyOutlineEdit(spec: TransactionSpec): void {
  view.dispatch(spec)
  updateOutline()
}

function updateOutline(): void {
  // 取数与 `[TOC]` 组件共用（editor/headings.ts）：`#`、setext 下划线、
  // 行内语法都已经剥干净，两个目录也不会再对不上
  headings = sections(view.state, collectHeadings(view.state))
  outline.setItems(headings)
  outline.setActive(activeHeadingPos())
}

/** 视口顶部所在行 → 它之前最近的一个标题位置（滚动跟随高亮） */
function activeHeadingPos(): number | null {
  const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop)
  return headingBefore(headings, block.from)
}

function syncMode(): void {
  view.dispatch({
    effects: livePreviewConf.reconfigure(sourceMode ? [] : livePreview())
  })
  view.dom.classList.toggle('cursive-source', sourceMode)
  elMode.textContent = sourceMode ? t('status.source') : t('status.preview')
  syncViewFlags()
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

/**
 * P3-1 收尾：文件被重命名或拖到别处之后，开着它的标签要改指向新路径。
 * **目录也要认**：改名一个目录，它底下每个开着的文件路径都失效了，按前缀整体重写。
 */
function retargetTabs(from: string, to: string): void {
  let touched = false
  for (const t of tabs) {
    if (t.path === from) t.path = to
    else if (t.path?.startsWith(`${from}/`)) t.path = to + t.path.slice(from.length)
    else continue
    touched = true
    if (t.id === activeId) docPath = t.path
  }
  if (!touched) return
  syncStatus(true)
  void sidebar.setActive(docPath)
}

/**
 * P3-2：点搜索结果里的一处命中 —— 打开文件并把那一处**选中**。
 * 光跳到行首不够：一行里可能有好几处，选中才知道是哪一处。
 */
async function openHit(hit: SearchHit): Promise<void> {
  if (hit.path !== docPath) {
    const doc = await window.api.read(hit.path)
    openTab(doc.content, doc.path, doc.fingerprint)
  }
  const doc = view.state.doc
  if (hit.line > doc.lines) return
  const line = doc.line(hit.line)
  // 壳侧按码元数列，CM 的偏移也是码元 —— 直接相加即可；越界一律夹回行内
  const from = Math.min(line.from + hit.col, line.to)
  const to = Math.min(from + hit.length, line.to)
  view.dispatch({
    selection: { anchor: from, head: to },
    effects: EditorView.scrollIntoView(from, { y: 'center' })
  })
  view.focus()
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

let savedAt: Date | null = null
function markSaved(): void {
  savedAt = new Date()
  renderSaved()
}

/** 语言切换时也要能重刷这条（savedAt 记下时刻，文案现取） */
function renderSaved(): void {
  if (!savedAt) return
  const time = savedAt.toLocaleTimeString(localeOf(), { hour: '2-digit', minute: '2-digit' })
  elSaved.textContent = t('status.saved', { time })
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

/**
 * P4-1 导出 HTML。
 *
 * 正文在渲染层渲染（`export/` 与实时预览共用同一棵语法树，见那里的注释）；
 * 壳只负责保存面板和「嵌入图片」那颗勾 —— 图片字节不过 IPC 桥（判断 3）。
 * 导出的是**当前标签**，含还没保存的修改（和 PDF 导出同一个口径）。
 */
async function exportHtmlSource(): Promise<string> {
  const t = activeTab()
  const doc = await exportHtmlDocument(view.state, {
    dir: t?.path ? dirname(t.path) : null,
    title: exportStem()
  })
  return doc.html
}

/** 导出的默认文件名（不含扩展名） */
function exportStem(): string {
  const tab = activeTab()
  return tab?.path ? basename(tab.path).replace(/\.[^.]*$/, '') : t('app.untitled')
}

async function exportHtml(): Promise<{ path: string } | null> {
  return window.api.exportHtml(await exportHtmlSource(), `${exportStem()}.html`)
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
      await openFolder()
      break
    case 'file:export-html':
      await exportHtml()
      break
    case 'edit:find':
      openSearchPanel(view)
      break
    case 'edit:replace':
      openReplace(view)
      break
    case 'edit:find-in-files':
      // P3-2：面板占的是侧边栏那块地方，所以侧边栏藏着的话先把它请回来
      if (!sidebar.visible) toggleSidebar()
      sidebar.openSearch()
      break
    case 'edit:find-next':
      findNext(view)
      break
    case 'edit:find-prev':
      findPrevious(view)
      break
    case 'edit:paste-plain': {
      // P2-4：⇧⌥⌘V 粘贴为纯文本
      const text = await window.api.readClipboardText()
      if (text) insertText(view, text)
      break
    }
    case 'view:toggle-sidebar':
      toggleSidebar()
      break
    case 'view:toggle-outline':
      toggleOutline()
      break
    case 'view:toggle-format-bar':
      toggleFormatBar()
      break
    case 'view:toggle-focus':
      toggleWriting('focus')
      break
    case 'view:toggle-typewriter':
      toggleWriting('typewriter')
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
    case 'view:theme-sepia':
      prefs.setTheme('sepia')
      break
    case 'view:toggle-dark':
      prefs.toggleDark()
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

// P2-5：Finder 拖图片进窗口 → 壳落盘后推相对路径 → 光标处插链接
window.api.onImageDropped((relPath) => {
  const alt = relPath.replace(/^assets\//, '').replace(/\.[^.]+$/, '')
  insertText(view, `![${alt}](${relPath})`)
})

// 主进程推来的文档（最近文件 / Finder 双击 / 命令行）
window.api.onFileOpened((doc: DocPayload) => {
  openTab(doc.content, doc.path, doc.fingerprint)
})

// 命令行 / Finder 传来的是目录时，在侧边栏里打开它
window.api.onFolderOpened((dir) => void sidebar.open(dir))

// 别的窗口改了偏好（契约 v17）。主题/字号/栏宽/皮肤/语言整份跟过来 ——
// `NSApp.appearance` 是 app 级的，发起窗口一推，**这个**窗口的标题栏就已经跟着翻了，
// 不接这条的话正文会留在旧主题上，一个窗口里两套配色
window.api.onPrefsChanged((values) => prefs.adopt(values))

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

// 暴露给冒烟脚本和开发者控制台，方便在没法手点界面时驱动编辑器。
// 两个导出入口在这儿各有理由：`exportHtml` 是 E2E 要等它的结果（派一个菜单动作
// 看不见异步的收尾）；`exportHtmlSource` 是**壳导出 PDF 时要拿这份 HTML 去打印**
// —— 真分页 PDF 就是打印 P4-1 的导出产物（P4-2），壳不再自己渲染一遍编辑器
;(
  window as unknown as {
    __cursive: {
      view: EditorView
      sidebar: Sidebar
      exportHtml: () => Promise<{ path: string } | null>
      exportHtmlSource: () => Promise<string>
    }
  }
).__cursive = { view, sidebar, exportHtml, exportHtmlSource }

// P3-4：用户皮肤要等一趟 IPC，起步时发一次就好（加皮肤本来就是「放文件再重开」的动作）
void prefs.loadUserThemes()
void sidebar.restore()
spawnTab(view.state, null, DEFAULT_FINGERPRINT)
syncMode()
syncStatus(true)
scheduleCount()
syncCursor()
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
new MutationObserver(() => {
  syncThemeToTabs()
  syncThemeButton()
}).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-theme']
})

// 语言切换（ui/prefs.ts 的 setLang 触发）：静态 chrome 已由 i18n 的 applyI18n 全局重翻，
// 这里只管**动态**的那批 —— 状态栏各行、标签栏重渲、大纲重渲、统计面板、标题栏按钮、
// 以及 syncMode() 顺手把活动标签的装饰（TOC 标题/表格工具栏/代码语言条）整体重建。
// 冻结标签不用管：重新激活时 activate() → syncMode() 会按当前语言重建。
//
// 判断「这里还漏了谁」的口径：凡是**文案由某个事件顺手刷出来**的地方都要点名。
// syncCursor / syncFormatBar 就栽在这上面 —— 它们挂在 updateListener 的
// `docChanged || selectionSet` 分支里，而 syncMode() 派的是一次 reconfigure（两者都为假），
// 于是「行 12 · 列 8」和格式栏上的块类型名会一直留着旧语言，直到用户碰一下光标
onLangChange(() => {
  syncSearchCount()
  syncCounts()
  syncCursor()
  syncStatus(true)
  syncMode()
  syncFormatBar()
  outline.refresh()
  stats.render(docStat, selStat())
  syncTitlebarLabels()
  renderSaved()
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
