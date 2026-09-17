import './themes/base.css'
import './themes/live-preview.css'
// katex 的 CSS 不在这里 —— 它跟着 JS 一起躺在懒加载的 editor/live-preview/katex.ts 里（P4-6②）

import { findNext, findPrevious, openSearchPanel, selectNextOccurrence } from '@codemirror/search'
import { EditorView } from '@codemirror/view'
import { EditorState, type Text, type TransactionSpec } from '@codemirror/state'
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
import { forgetRowHeight, livePreview, themeEffect } from './editor/live-preview'
import { currentTheme, primeHeights } from './editor/live-preview/widgets'
import {
  bottomOverlay,
  createState,
  livePreviewConf,
  spellConf,
  spellcheckExt,
  spellNow,
  writingConf,
  writingNow
} from './editor/setup'
import { cursiveMarkdown } from './editor/markdown-lang'
import { warmLazyModules } from './editor/warmup'
import { anchorPos, destLiteral, linkHost } from './editor/link'
import { jumpTo } from './editor/navigation'
import { writingModes } from './editor/writing-modes'
import { applyFormat, formatStateAt } from './editor/fmt'
import { focusKeepScroll } from './editor/focus'
import { insertText } from './editor/paste'
import { exportHtmlDocument } from './export'
import { openReplace, searchStat } from './editor/search-panel'
import { relativeDir, relativePath } from './ui/file-search'
import { Sidebar } from './ui/sidebar'
import {
  browserStorage,
  loadSession,
  packSession,
  planRestore,
  saveSession,
  type SessionTab
} from './ui/session'
import { TabBar } from './ui/tabbar'
import { Outline } from './ui/outline'
import { FormatBar, FORMAT_BAR_SPACE, FORMAT_BAR_COLLAPSED_SPACE } from './ui/format-bar'
import { icon, type IconName } from './ui/icons'
import { commandItems } from './ui/commands'
import { openMenu, type MenuItem } from './ui/menu'
import { Palette, type PaletteItem } from './ui/palette'
import { Prefs } from './ui/prefs'
import { cursorLabel, measure, selectedText, StatsPanel, type Stat } from './ui/stats'

// 计时探针的第一格：模块开始跑 = 取回 + 解析 + 编译首屏 JS 花掉的时间。
// P4-6② 砍的就是这一格；它到「文档进编辑器」之间那段才是 P4-6① 的地盘。
// 平时 __cursiveMark 根本不存在（壳只在 CURSIVE_TIMING=1 下注入），这一句直接短路
window.__cursiveMark?.(`模块开跑（页面内 ${Math.round(performance.now())}ms）`)

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
const elNote = document.getElementById('status-note')!

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

/**
 * P4-6①：argv / Finder 那份文档，壳在 `atDocumentStart` 就注进来了（`__cursiveInitialDoc`），
 * 启动末尾直接 `openTab` 开它 —— 省掉「等就绪 → 一趟 IPC → file:opened」那一圈。
 * 没有（新建窗口 / 双击 app 图标）就是 null，照旧从空文档起步。
 *
 * **文档不在这儿灌进编辑器**：第一个 EditorView 照旧拿空文档建。它建好之后还有
 * 一长串会碰到视图的初始化 —— `prefs.apply()` 改字号行距栏宽、格式栏改滚动边距、
 * 主题落 data-theme、末尾那次 `syncMode()` 整份重建装饰 —— 空文档时这些全是免费的，
 * 带着一份长文档就每一次都要重排一遍。所以**整条启动路径的形状一个字都没改**：
 * chrome 先搭完，最后才把文档放进去（见下面 `openTab` 处），省掉的只是
 * 「等就绪 → 一趟 IPC → file:opened」那一圈以及它带来的竞态。
 */
const initialDoc = window.__cursiveInitialDoc ?? null

/**
 * 契约 v24：自检标记。**自检下不做任何「把上次的样子恢复出来」的事**（现在是会话恢复）——
 * 探针要的是确定的起点，而恢复出来的标签会让「开了几个标签 / 大纲几行 / 快速打开列几个
 * 文件」这类断言跟着上一轮的残留飘；探针还会改文档，恢复出来的那几份会被一并改写。
 */
const selfCheck = window.__cursiveSelfCheck === true

const view = new EditorView({ parent: host, state: createState('', listener) })

// 主题 + 排版偏好。字号/行距一变，CodeMirror 缓存的字符尺寸就过期了，必须重量
const prefs = new Prefs(() => {
  // 字号/行距/栏宽一变，表格学到的行高就不作数了（见 live-preview/table.ts）
  forgetRowHeight()
  view.requestMeasure()
  syncSpell()
})
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
const formatBar = new FormatBar(
  (action) => {
    applyFormat(view, action)
    view.focus()
  },
  // 条子右端那颗折角 / 收起后那颗手柄：只改「摊开还是收起」，不动菜单里那个开关
  () => {
    localStorage.setItem('cursive.formatBarFold', formatBar.collapsed ? '1' : '0')
    syncFormatBar()
    view.focus()
  }
)
center.appendChild(formatBar.el)
formatBar.setVisible(localStorage.getItem('cursive.formatBar') !== '0')
formatBar.setCollapsed(localStorage.getItem('cursive.formatBarFold') === '1')
syncFormatBar()

function toggleFormatBar(): void {
  formatBar.toggle()
  localStorage.setItem('cursive.formatBar', formatBar.visible ? '1' : '0')
  syncFormatBar()
  syncViewFlags()
}

/**
 * 显示状态一变，编辑器的滚动下边距要跟着改，否则光标会躲到条子后面。
 * 三态：关掉 = 0、收起 = 一颗手柄那么高、摊开 = 整条那么高。
 *
 * **收起时也照算高亮**：省这一下只省得到二十次 classList.toggle（条子 display:none，
 * 没有布局也没有绘制），换来的却是「屏幕上的状态」与「DOM 里的状态」分家 ——
 * E2E 读的就是 `.is-on` 这个类，跳过一次，用户上回把条子收起来就能让整条用例变红
 */
function syncFormatBar(): void {
  bottomOverlay.height = !formatBar.visible
    ? 0
    : formatBar.collapsed
      ? FORMAT_BAR_COLLAPSED_SPACE
      : FORMAT_BAR_SPACE
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
    jumpTo(view, pos)
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
  (id) => void closeTab(id),
  (id, e) => openTabMenu(id, e)
)
center.prepend(tabbar.el)

function newUntitledTab(): void {
  spawnTab(createState('', listener), null, DEFAULT_FINGERPRINT)
}

/**
 * `focus=false` = **开在背景里**：不激活、不刷 chrome。会话恢复要一次接回好几个标签
 * （见下面 `restoreSession`），一个个激活等于把 `view.setState` + 大纲重建 + 一趟 IPC
 * 各做 N 遍，而其中 N-1 遍的结果立刻就被下一个覆盖掉。
 */
function spawnTab(
  state: EditorState,
  path: string | null,
  fp: FileFingerprint,
  focus = true
): Tab {
  // 启动时的空白首标签直接复用，避免「打开一个文件却多出一个空标签」
  const pristine = tabs.find(
    (t) => !t.path && !isTabDirty(t) && t.state.doc.length === 0
  )
  if (pristine) {
    pristine.state = state
    pristine.path = path
    pristine.fp = fp
    pristine.savedDoc = state.doc
    if (focus) activate(pristine.id)
    return pristine
  }
  const t: Tab = { id: nextId++, path, fp, state, savedDoc: state.doc, scroll: 0, sourceMode }
  tabs.push(t)
  if (focus) activate(t.id)
  return t
}

/**
 * 启动耗时的最后一格：**文档的字真的画到屏幕上了**。壳侧的 mark() 全都停在
 * 「推给渲染层」之前，而「双击文件 → 看见字」的终点只有页面自己知道。
 *
 * 挂在 activate() 上而不是启动流程末尾，是为了让两条路径量的是同一件事：
 * 文档随页面注入时（P4-6①）第一次 activate 就带着内容；走 file:opened 那条时
 * 启动末尾手上还是个空编辑器，量到的会是「空编辑器画完了」—— 那不是用户等的东西。
 * 两层 rAF = 这一帧的布局与绘制都交完了。CURSIVE_TIMING=1 时壳会打印它。
 */
let firstPaintMarked = false
function markFirstPaint(): void {
  if (firstPaintMarked || view.state.doc.length === 0) return
  firstPaintMarked = true
  const mark = window.__cursiveMark
  if (!mark) return
  // 同步的这一发是**主指标**：文档进了编辑器、版也排了（activate 末尾），
  // 剩下的只是把帧交出去。rAF 那一发才是真正的上屏，但它在窗口不是最前面时会被
  // 系统降频甚至不回调（P4-2 在离屏窗口里踩过同一个坑），当指标会把噪声当成结论
  mark(`文档进编辑器（页面内 ${Math.round(performance.now())}ms）`)
  requestAnimationFrame(() =>
    requestAnimationFrame(() => mark(`文档已上屏（页面内 ${Math.round(performance.now())}ms）`))
  )
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
  syncSpell()
  outline.setDoc(tab.path ?? `${t('app.untitled')}-${tab.id}`)
  syncStatus(true)
  scheduleCount()
  syncCursor()
  syncFormatBar()
  updateOutline()
  void sidebar.setActive(tab.path)
  view.focus()
  scheduleSession()
  markFirstPaint()
}

/**
 * discard：文件已经不在了（进了废纸篓），别再问「是否保存」—— 一保存就把它复活了。
 *
 * **返回值是给批量关闭用的**：false = 这一次没关成（用户在「是否保存」里点了取消，
 * 或者保存本身失败/被取消）。右键菜单那几条批量命令靠它决定要不要停下来 ——
 * 一个都没救回来就把剩下的全关掉，是最容易让人丢东西的做法。
 */
async function closeTab(id: number, discard = false): Promise<boolean> {
  const t = tabs.find((x) => x.id === id)
  if (!t) return false
  if (t.id === activeId) t.state = view.state

  if (!discard && isTabDirty(t)) {
    const choice = await window.api.confirmDiscard(tabTitle(t))
    if (choice === 'cancel') return false
    if (choice === 'save') {
      if (t.id === activeId) {
        if (!(await save())) return false
      } else {
        const res = await window.api.save(t.path, t.state.doc.toString(), t.fp)
        if (!res) return false
      }
    }
  }

  const idx = tabs.findIndex((x) => x.id === id)
  tabs = tabs.filter((x) => x.id !== id)
  if (tabs.length === 0) {
    newUntitledTab()
    return true
  }
  if (id === activeId) activate(tabs[Math.min(idx, tabs.length - 1)]!.id)
  else syncStatus(true)
  scheduleSession() // 关掉的那个不该在下次启动时又冒出来
  return true
}

/** 右键菜单里那四条批量关闭，相对**右键点中的那个标签**而言 */
type CloseScope = 'left' | 'others' | 'right' | 'all'

/**
 * 批量关标签。
 *
 * 三条决定：
 * ① **按标签栏里看到的顺序从左往右关** —— 脏标签的「是否保存」于是也按这个顺序一个个弹，
 *    和眼睛看到的对得上；先关非活动的那种优化会让弹窗顺序显得随机；
 * ② **任何一次取消就整批停下**（`closeTab` 的返回值），剩下的原样留着。
 *    继续关下去等于「用户说了不要关这个，那就把别的都关了吧」，没有道理；
 * ③ **留下来的那个先激活**（`all` 除外，它没有幸存者）。这样被关的全是非活动标签，
 *    `closeTab` 里那条 `activate(邻居)` 一次都不会走 —— 否则关五个标签就要
 *    `setState` + `focus` 五遍，画面一路闪过去，最后还未必停在该停的地方。
 */
async function closeTabs(targetId: number, scope: CloseScope): Promise<void> {
  const idx = tabs.findIndex((x) => x.id === targetId)
  if (idx < 0) return
  const victims = tabs
    .filter((x, i) => {
      if (scope === 'all') return true
      if (scope === 'left') return i < idx
      if (scope === 'right') return i > idx
      return x.id !== targetId
    })
    .map((x) => x.id)
  if (!victims.length) return
  if (scope !== 'all' && targetId !== activeId) activate(targetId)
  for (const id of victims) {
    // 关的过程中它可能已经没了（外部删文件会顺手关掉对应标签）——
    // 那不是「用户取消」，别把整批停在这儿
    if (!tabs.some((x) => x.id === id)) continue
    if (!(await closeTab(id))) break
  }
}

/** 标签右键菜单。与文件树、大纲共用 `ui/menu.ts` 那一份浮层 */
function openTabMenu(id: number, e: MouseEvent): void {
  const idx = tabs.findIndex((x) => x.id === id)
  if (idx < 0) return
  const items: MenuItem[] = [
    { label: t('tab.menuClose'), run: () => void closeTab(id) },
    {
      label: t('tab.closeLeft'),
      separated: true,
      disabled: idx === 0,
      run: () => void closeTabs(id, 'left')
    },
    {
      label: t('tab.closeOthers'),
      disabled: tabs.length <= 1,
      run: () => void closeTabs(id, 'others')
    },
    {
      label: t('tab.closeRight'),
      disabled: idx === tabs.length - 1,
      run: () => void closeTabs(id, 'right')
    },
    { label: t('tab.closeAll'), run: () => void closeTabs(id, 'all') }
  ]
  tabbar.markContext(id)
  openMenu(e.clientX, e.clientY, items, {
    onClose: () => tabbar.markContext(null),
    // 标签多到挤不下时标签栏会横向滚动，滚一下菜单就该收起（同文件树/大纲）
    scrollHost: tabbar.el
  })
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

/**
 * 状态栏左边那句**一次性反馈**：链接打不开、没有这个锚点这类「点了之后没能如愿」。
 * 4 秒后自己消失，不需要任何人去关它。
 *
 * 为什么不弹原生对话框：点错一条链接是小事，拦下整个界面要人按一下「好」是大事。
 * 为什么也不能什么都不说：「点了没反应」是最糟的失败方式 —— 用户分不清是
 * 链接写错了、文件没了，还是这个编辑器压根不支持跳转。
 */
let noteTimer: number | undefined
function note(message: string): void {
  elNote.textContent = message
  clearTimeout(noteTimer)
  noteTimer = window.setTimeout(() => {
    elNote.textContent = ''
  }, 4000)
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

/**
 * 0.2.0 拼写检查：把偏好推到活动 view 上。
 *
 * 与写作模式同构 —— `spellNow` 是新建 state 的种子，这一发管的是**已经存在的**那份
 * （偏好面板里改、或别的窗口广播过来）。`activate()` 里也要叫一次：
 * 冻结的标签是按它当时的 `spellNow` 建的，切回来时可能已经过期了
 */
function syncSpell(): void {
  spellNow.on = prefs.values.spellcheck
  view.dispatch({ effects: spellConf.reconfigure(spellcheckExt(spellNow.on)) })
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

/** 打开到新标签页；同一文件已开着则激活原标签，避免覆盖未保存内容 */
/** 预热计时器：切标签切得快时只留最后那一份 */
let warmTimer: number | undefined

function openTab(content: string, path: string | null, fp: FileFingerprint): Tab {
  // 文档进编辑器**之前**把落盘的 widget 高度捞进内存：CM 先查 `estimatedHeight` 进高度表、
  // 再 `toDOM`，晚一步的话这份文档的第一个图/公式/图表照样跳一下（见 widgets.ts 那边的注释）
  primeHeights(view)
  // 首帧之后在空闲里热一遍这份文档用得上的懒加载模块（见 `editor/warmup.ts`）：
  // 切标签切得快时只留最后那一份
  clearTimeout(warmTimer)
  warmTimer = warmLazyModules(content)
  const existing = path ? tabs.find((t) => t.path === path) : undefined
  if (existing) {
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

/**
 * 跟着一条链接落到本地文档（`editor/link.ts` 判出来的 `doc` 去处）。
 * 与文件树点一个文件、快速打开选一条是同一条路：**在这个窗口**开一个标签，
 * 已经开着就激活它（`openTab` 自己会找）。不开新窗口 —— 一个窗口 = 一个工作区，
 * 而顺着链接读下去是同一个工作区里的事。
 *
 * 「已经是当前这份」必须先挡住：`activate()` 只在**切换**时把 view 的 state 存回标签，
 * 对当前标签再调一次就是拿上一次存下的旧 state 覆盖掉正在编辑的这份（`openPath`
 * 开头那句 return 挡的也是这件事）。
 */
async function openDocLink(path: string, slug: string | null): Promise<void> {
  if (path !== docPath) {
    let doc: DocPayload
    try {
      doc = await window.api.read(path)
    } catch {
      // 链接写错、文件被挪走、大小写对不上都落在这儿
      note(t('link.missing', { name: basename(path) }))
      return
    }
    openTab(doc.content, doc.path, doc.fingerprint)
  }
  if (!slug) return
  // 锚点要在**目标文档**里找，所以必须等标签切过去之后再算
  const pos = anchorPos(view.state, slug)
  if (pos === null) {
    note(t('link.noAnchor', { slug }))
    return
  }
  jumpTo(view, pos)
}

// 编辑器扩展只知道「这条链接通向一份本地文档」，开标签与报错都得回到窗口这一层来做
linkHost.openDoc = (path, slug) => void openDocLink(path, slug)
linkHost.note = note

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
  void keepSnapshot(res.path, view.state.doc.toString())
  return true
}

/**
 * 0.2.0 版本历史：每次**写进真实路径**之后留一份快照（契约 v22）。
 *
 * 去重、留存上限、目录管理全在壳侧 —— 这里只发一次请求，失败了也不打扰用户：
 * 历史是安全网，不是保存的一部分，它出问题不该让「刚才那次保存成功了吗」变得可疑。
 */
async function keepSnapshot(path: string, content: string): Promise<void> {
  try {
    await window.api.snapshotSave(path, content)
  } catch {
    /* 历史写不下就算了，保存本身已经成功 */
  }
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
  void keepSnapshot(res.path, view.state.doc.toString())
  return true
}

// ---------- 0.2.x 会话恢复：关掉再开，回到上次那几个标签 ----------

/**
 * **这一段必须排在启动序列之前**：`activate()` 里会调 `scheduleSession()`，而启动
 * 时的第一次 `spawnTab` 就会 activate 一次 —— 下面那个 `let sessionRoot` 要是排在
 * 启动序列后面，那一下读到的就是一个还没初始化的绑定（TDZ），整条启动路径当场抛
 * `ReferenceError`。**自检下反而看不出来**：`selfCheck` 为真时 `||` 短路，压根不读它。
 * （真踩过：单测全绿、探针全绿，普通启动一开就是一片空白。）
 */

/**
 * 这个窗口的工作区根（契约 v19）。会话按它分组 —— 一个窗口 = 一个工作区，
 * A 文件夹的标签不该在 B 窗口里冒出来。拿不到根（空手开出来的窗口）就整条不记。
 */
let sessionRoot: string | null = null
const sessionStore = browserStorage()

/** 现在这一屏的样子。活动标签的滚动/光标要从 `view` 上现取 —— 冻结的那份还停在切走那一刻 */
function currentSession(): { tabs: SessionTab[]; active: number } {
  const out: SessionTab[] = []
  let active = 0
  for (const t of tabs) {
    if (!t.path) continue // 无路径的草稿归 scratch 管，两边都记会开出两份
    if (t.id === activeId) active = out.length
    out.push({
      path: t.path,
      scroll: t.id === activeId ? view.scrollDOM.scrollTop : t.scroll,
      cursor: (t.id === activeId ? view.state : t.state).selection.main.head
    })
  }
  return { tabs: out, active }
}

let sessionTimer: number | undefined
/**
 * 攒一下再写：切标签、滚动、开关标签都会触发，而 localStorage 的写是同步的。
 * 800ms 是「一串连续动作结束」的档位，与自动保存那 2s 各管各的。
 */
function scheduleSession(): void {
  if (selfCheck || !sessionRoot) return
  clearTimeout(sessionTimer)
  sessionTimer = window.setTimeout(flushSession, 800)
}

function flushSession(): void {
  if (selfCheck || !sessionRoot) return
  clearTimeout(sessionTimer)
  const now = currentSession()
  saveSession(sessionStore, sessionRoot, packSession(now.tabs, now.active))
}

/**
 * 启动时把上次那几个标签接回来。
 *
 * **顺序上的三条规矩**（前两条与崩溃恢复同源，那边已经踩过）：
 * ① 恢复出来的是**背景内容**，不能把用户刚双击打开的那份挤下去 —— 先记住 `keep`，
 *   开完再 `activate` 回去；② 每个标签都 `focus=false` 开，最后只激活一次；
 * ③ 文件不在了（改名 / 删了 / 外接盘没挂）就**跳过那一条**，绝不摆一个空壳标签出来
 *   —— 读不到时壳只是 reject，不弹框，所以这里静默跳过是安全的。
 */
async function restoreSession(): Promise<void> {
  if (selfCheck) return
  sessionRoot = await window.api.workspaceRoot()
  if (!sessionRoot) return
  const saved = loadSession(sessionStore, sessionRoot)
  if (!saved) return
  const keep = activeTab()?.path ? activeId : null
  const plan = planRestore(
    saved,
    tabs.map((t) => t.path).filter((p): p is string => p !== null),
    keep !== null
  )
  const where = new Map(saved.tabs.map((t) => [t.path, t]))
  for (const path of plan.open) {
    const doc = await window.api.read(path).catch(() => null)
    if (!doc) continue // 文件没了（改名 / 删了 / 外接盘没挂）就跳过这一条
    const tab = spawnTab(
      createState(doc.content, listener, { dir: dirname(doc.path), sourceMode }),
      doc.path,
      doc.fingerprint,
      false
    )
    const st = where.get(path)
    if (!st) continue
    tab.scroll = st.scroll
    // 光标夹回文档里：磁盘上这份文件可能在上次之后被别的程序改短了
    if (st.cursor) {
      const at = Math.min(st.cursor, tab.state.doc.length)
      tab.state = tab.state.update({ selection: { anchor: at } }).state
    }
  }
  // 落点：启动那份文档优先，其次是会话里的活动标签，再不行就手上还剩的最后一个
  const target = plan.focus ? tabs.find((t) => t.path === plan.focus)?.id : undefined
  const focus = keep ?? target ?? (tabs.length ? tabs[tabs.length - 1]!.id : null)
  if (focus !== null && tabs.some((t) => t.id === focus)) activate(focus)
  else syncStatus(true)
}

// 滚动位置是会话里最容易过期的一项：不听滚动的话，恢复出来永远停在切走那一刻
view.scrollDOM.addEventListener('scroll', scheduleSession, { passive: true })

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
    const content = t.state.doc.toString()
    const res = await window.api.save(t.path, content, t.fp)
    if (res) {
      t.savedDoc = t.state.doc
      markSaved()
      syncStatus(true)
      // 自动保存也留快照。壳侧会去重，所以「停手两秒」触发的那一串同样内容
      // 只会落下一份（契约 v22）
      void keepSnapshot(t.path, content)
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
  // 会话不等那 800ms：失焦之后下一步很可能就是关窗
  flushSession()
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

/**
 * 0.2.0 复制为富文本（契约 v20）。
 *
 * **有选区就只复制选区**：把选中的那段 Markdown 现造一个 EditorState 渲染 ——
 * 导出那条路本来就只认 state，于是「整份」和「一段」共用同一个渲染器，
 * 没有第二套局部渲染逻辑（P4-1 那条「根本不写第二个解析器」的原则在这里同样成立）。
 *
 * 剪贴板上放两种风味：`.html` 给邮件 / 飞书 / Notion，纯文本给终端 / 代码框。
 */
async function copyAsHtml(): Promise<void> {
  const sel = view.state.selection.main
  const tab = activeTab()
  const dir = tab?.path ? dirname(tab.path) : null
  const md = sel.empty ? view.state.doc.toString() : view.state.sliceDoc(sel.from, sel.to)
  const state = sel.empty
    ? view.state
    : EditorState.create({ doc: md, extensions: [cursiveMarkdown()] })
  const doc = await exportHtmlDocument(state, { dir, title: exportStem() })
  await window.api.copyHtml(doc.html, md)
}

/** 0.2.0 命令面板 / 快速打开（同一个组件，见 ui/palette.ts） */
const palette = new Palette()

/**
 * 0.2.0 版本历史。**动态 import**（同 P4-6② 的 katex / turndown）：
 * 面板加上自写的行级 diff 有十几 KB，而它是「偶尔打开一次」的东西 ——
 * 首屏没有理由背着它。第一次开多花一次本地 chunk 加载，之后一直在手。
 *
 * 恢复走**一次普通编辑** —— 整份替换进 EditorView，于是 ⌘Z 能撤回、装饰器照常重算，
 * 而「保存零损耗」那条红线一点没碰：文档变成什么样是用户主动要求的，
 * 不是编辑器自作主张改写的
 */
let historyPanel: import('./ui/history').History | null = null

async function openHistory(): Promise<void> {
  const { History } = await import('./ui/history')
  historyPanel ??= new History((content) => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      userEvent: 'input.restore'
    })
    view.focus()
  })
  await historyPanel.open(activeTab()?.path ?? null, view.state.doc.toString())
}

/**
 * 快速打开（⌘T）。
 *
 * 索引**每次现要**而不是缓存：一次 `listFiles` 就是壳侧一趟目录遍历（几十毫秒），
 * 而缓存要跟着新建 / 改名 / 拖动 / 删除 / 外部变更一起失效 —— 那是五个订阅点
 * 和一条「什么时候会脏」的不变量，换来的只是省掉那几十毫秒。不值。
 */
async function openQuickOpen(): Promise<void> {
  const root = sidebar.treeRoot
  if (!root) {
    // 没有工作区就没有索引。与其弹一个空面板，不如把话说清楚
    palette.open([], t('pl.filePlaceholder'), 'pl.noFolder')
    return
  }
  const paths = await window.api.listFiles(root)
  const items: PaletteItem[] = paths.map((path) => {
    // 相对段落走 `ui/file-search.ts` 那两个现成的函数，**不要自己 `slice` 一遍** ——
    // 它们各挡着一个坑：`/tmp` 在 macOS 上是 `/private/tmp` 的软链（树根与路径可能
    // 一边带一边不带，直接 startsWith 会把整条绝对路径当成相对段落），
    // 以及目录太长时从**左边**截（尾巴才有信息量）
    const rel = relativePath(path, root)
    const cut = rel.lastIndexOf('/')
    return {
      label: cut < 0 ? rel : rel.slice(cut + 1),
      hint: relativeDir(path, root) || undefined,
      // 匹配拿**没截断**的整条相对路径（`ui/fu` 也该找得到 `ui/fuzzy.ts`），
      // 但打分偏向文件名那一段（fuzzyPath），高亮再按 labelAt 挪回文件名上
      key: rel,
      path: true,
      labelAt: cut + 1,
      run: () => void openPath(path)
    }
  })
  palette.open(items, t('pl.filePlaceholder'), 'pl.noFile')
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
    case 'file:close-tab':
      await closeTab(activeId)
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
    case 'file:quick-open':
      await openQuickOpen()
      break
    case 'file:history':
      await openHistory()
      break
    case 'view:command-palette':
      // 面板执行的就是**这个函数自己** —— 命令面板与原生菜单从此不可能说两套话
      palette.open(
        commandItems((a) => void handleMenu(a)),
        t('pl.cmdPlaceholder'),
        'pl.noMatch'
      )
      break
    case 'edit:select-next':
      // 0.2.0 多光标。`allowMultipleSelections` 与 `rectangularSelection` 早就挂在
      // setup.ts 里了，缺的只是一个按得到的入口 —— ⌘D 被菜单系统吞掉（判断 1），
      // 所以走菜单这条路，而不是去赌键能不能落回 CodeMirror
      selectNextOccurrence(view)
      view.focus()
      break
    case 'edit:copy-html':
      await copyAsHtml()
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
  // 文件名带空格时括进 <…>：Cursive 自己认得裸空格（方言放宽），但写出去的文档
  // 还要在别处打开 —— app 生成的东西必须是标准形状（destLiteral）
  insertText(view, `![${alt}](${destLiteral(relPath)})`)
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
  if (encode(curText, t.fp) === encode(disk.content, disk.fingerprint)) {
    t.stale = false
    syncStatus(true)
    return
  }

  if (t.id === activeId) {
    if (!isTabDirty(t)) {
      // 干净：静默重载，保留滚动与光标
      const scroll = view.scrollDOM.scrollTop
      const sel = view.state.selection
      t.state = createState(disk.content, listener, { dir: dirname(path), sourceMode })
      t.savedDoc = t.state.doc
      t.fp = disk.fingerprint
      t.stale = false
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
      t.stale = false
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
    t.stale = false
    syncStatus(true)
  } else {
    t.stale = true
    syncStatus(true)
  }
}

/**
 * 0.2.0 PDF 书签：导出的目录层级。
 *
 * 取的是 `collectHeadings` —— 大纲面板、`[TOC]`、锚点补全、导出 HTML 的 id
 * 用的都是它。壳侧据此给 PDF 装 outline（`PDFDocument.outlineRoot`），
 * 于是「预览」侧栏里的目录和编辑器大纲里看到的是同一棵树。
 */
function outlineSource(): { level: number; text: string }[] {
  return collectHeadings(view.state).map((h) => ({ level: h.level, text: h.text }))
}

// 暴露给冒烟脚本和开发者控制台，方便在没法手点界面时驱动编辑器。
// 三个入口各有理由：`exportHtml` 是 E2E 要等它的结果（派一个菜单动作看不见异步的收尾）；
// `exportHtmlSource` 是**壳导出 PDF 时要拿这份 HTML 去打印** —— 真分页 PDF 就是打印
// P4-1 的导出产物（P4-2），壳不再自己渲染一遍编辑器；`outlineSource` 是同一次导出里
// 给 PDF 装书签用的那份目录（0.2.0）
;(
  window as unknown as {
    __cursive: {
      view: EditorView
      sidebar: Sidebar
      exportHtml: () => Promise<{ path: string } | null>
      exportHtmlSource: () => Promise<string>
      outlineSource: () => { level: number; text: string }[]
    }
  }
).__cursive = { view, sidebar, exportHtml, exportHtmlSource, outlineSource }

// P3-4：用户皮肤要等一趟 IPC，起步时发一次就好（加皮肤本来就是「放文件再重开」的动作）
void prefs.loadUserThemes()
void sidebar.restore()
spawnTab(view.state, null, DEFAULT_FINGERPRINT)
syncMode()
syncStatus(true)
scheduleCount()
syncCursor()
view.focus()

// P4-6①：注入的那份文档放在**最后**开 —— 走的是与 `file:opened` 完全相同的
// `openTab`（连启动空白标签的复用都一样），只是不必等那一趟 IPC。
//
// **位置是特意排在这一串收尾之后的**：上面的 `syncMode()` 派的是一次 reconfigure，
// 会把活动标签的装饰整份重建；`syncStatus` / `scheduleCount` / `syncCursor` 也都要读
// 当前文档。提到前面去，这一串就得拿着一份完整文档再跑一遍，空文档时它们才是免费的。
// 换句话说：**整条启动路径的形状与 P4-6① 之前一模一样**，只是不必等 IPC —— 这样也就
// 不必重新论证「这一串在有文档的情况下还对不对」。
if (initialDoc) openTab(initialDoc.content, initialDoc.path, initialDoc.fingerprint)

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
// 整段是异步的，而文档不一定已经在了 —— argv/Finder 那份现在随页面注入（P4-6①，
// 这里跑到时它已经是活动标签），但「已经开着的窗口被要求再开一个文件」仍走 file:opened，
// 照样可能插在等 scratchList 的这段时间里。所以下面的「别把用户刚点开的那份挤下去」
// 不能省
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
})().finally(() => {
  // **排在崩溃恢复之后**：那边会把「启动空白标签」过滤掉并校正 activeId，
  // 先跑会话恢复的话，它开出来的标签会连同空白页一起被那个过滤扫一遍
  void restoreSession()
})
