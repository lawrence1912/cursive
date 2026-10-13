import './themes/base.css'
import './themes/live-preview.css'
// katex 的 CSS 不在这里 —— 它跟着 JS 一起躺在懒加载的 editor/live-preview/katex.ts 里（P4-6②）

import { redo, selectAll, undo } from '@codemirror/commands'
import { findNext, findPrevious, openSearchPanel, selectNextOccurrence } from '@codemirror/search'
import { EditorView } from '@codemirror/view'
import { EditorState, type Text, type TransactionSpec } from '@codemirror/state'
import { basename, dirname } from '../shared/path'
import type {
  DiskExpectation,
  DocPayload,
  MenuAction,
  ReplaceTarget,
  SearchHit
} from '../shared/types'
import { DEFAULT_FINGERPRINT, encode, type FileFingerprint } from '../shared/textfile'
import { group, readLabel } from '../shared/wordcount'
import { applyI18n, detectLang, getLang, localeOf, onLangChange, setLang, t, type Key } from './i18n'
import {
  collectHeadings,
  headingBefore,
  headingsSettled,
  levelChangeSpec,
  moveSectionSpec,
  newSiblingSpec,
  sections,
  slugs,
  type Section
} from './editor/headings'
import { forgetRowHeight, livePreview, themeEffect } from './editor/live-preview'
import { currentTheme, loadKatex, primeHeights } from './editor/live-preview/widgets'
import {
  bottomOverlay,
  createState,
  dirEffect,
  hintConf,
  hintsNow,
  livePreviewConf,
  spellConf,
  spellcheckExt,
  spellNow,
  writingConf,
  writingNow
} from './editor/setup'
import { cursiveMarkdown } from './editor/markdown-lang'
import { blankHint, blankHintHost } from './editor/blank-hint'
import { warmLazyModules } from './editor/warmup'
import { anchorPos, destLiteral, isDocPath, linkHost } from './editor/link'
import { docDir } from './editor/doc-dir'
import { brokenBy, checkRefs, type RefHost, type RefProblem } from './editor/ref-check'
import { jumpHost, jumpTo, revisit } from './editor/navigation'
import { readOnlyConf, readOnlyExt, readOnlyHost } from './editor/read-only'
import { setTableEdit } from './editor/live-preview/table'
import { writingModes } from './editor/writing-modes'
import { applyFormat, formatStateAt } from './editor/fmt'
import { latexFormatSpec } from './editor/latex-format'
import { focusKeepScroll } from './editor/focus'
import { insertText } from './editor/paste'
import { exportHtmlDocument, type HtmlExport, type Typography } from './export'
import { openReplace, searchStat } from './editor/search-panel'
import { relativeDir, relativePath } from './ui/file-search'
import { Sidebar } from './ui/sidebar'
import {
  browserStorage,
  loadSession,
  packSession,
  planRestore,
  restoreFocus,
  saveSession,
  type SessionTab
} from './ui/session'
import { createHoleReporter } from './ui/drag-holes'
import { parseGoto } from './ui/goto'
import type { ConflictChoice } from './ui/conflict'
import { note } from './ui/note'
import { isStaleWrite, readFailKind, readFailPath, readFailSticky } from './ui/read-error'
import { newSaveStatus, SAVING_AFTER, saveLabel, type SaveStatus } from './ui/save-state'
import { reorderIds, TabBar } from './ui/tabbar'
import { checkForUpdate } from './ui/update'
import { ClosedTabs } from './ui/closed-tabs'
import { NavHistory, type NavDoc, type NavSpot } from './ui/nav-history'
import { Zoom } from './ui/zoom'
import { toggleFoldAt } from './editor/fold'
import { tagHost } from './editor/frontmatter'
import { Outline } from './ui/outline'
import { FormatBar, FORMAT_BAR_SPACE, FORMAT_BAR_COLLAPSED_SPACE } from './ui/format-bar'
import { icon, type IconName } from './ui/icons'
import { saveDirtyTabs } from './ui/closing'
import { commandItems, selectAllScope } from './ui/commands'
import { openMenu, type MenuItem } from './ui/menu'
import { Palette, type PaletteItem, type PaletteQuery } from './ui/palette'
import { Prefs } from './ui/prefs'
import { withKey } from './ui/shortcuts'
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
const elZoom = document.getElementById('status-zoom')!

let sourceMode = false

/**
 * 文档被改过多少次（0.4.1 修）。**只增不减**，谁也抹不平它 —— 会话恢复靠它判断
 * 「这段时间里人打过字没有」。从前那个判断是拿 `tab.state.doc` 与视图里那份一比，
 * 可自动保存（停手 2s）与切标签都会把 `tab.state` 同步成视图那份，一比又相等了，
 * 人打过的字于是不算数。计数没有这个毛病：发生过就是发生过
 */
let docEdits = 0

/**
 * 标签被激活过多少次（0.4.1 修）。同样**只增不减** —— 会话恢复靠它判断
 * 「这段时间里人自己切过标签没有」。**不能拿「活动标签是不是还是那个」比对**：
 * 切走再切回来（A → B → A）身份一模一样，痕迹却抹掉了，而人明明动过手
 */
let activations = 0

/**
 * 第八节 6 后退 / 前进的那串记录、第八节 7 最近关掉的那几个标签。都只在内存里，一个窗口一份。
 * **排在 updateListener 之前**：改文档时要把记录里的位置跟着挪（下面那句 `nav.map`），
 * 模块级 const 在声明之前被碰到就是 TDZ（会话恢复那段踩过同一类坑）
 */
const nav = new NavHistory()
const closedTabs = new ClosedTabs()
/**
 * 三条命令此刻亮不亮（契约 v38 的 `canBack` / `canForward` / `canReopen`）。单独存一份、
 * 由 `refreshNav()` 算，而不是在 `syncViewFlags` 里现算：那个函数启动时就会被调到
 * （`syncTitlebar`），比标签表的声明还早，现算就得去碰还没初始化的 `tabs`
 */
const navFlags = { canBack: false, canForward: false, canReopen: false }

const listener = EditorView.updateListener.of((u) => {
  if (u.docChanged) {
    docEdits += 1
    // 后退 / 前进记下的位置跟着改动挪（第八节 6）：在落点前面插一段字，回来时不该差那一段
    if (viewTabId !== null) nav.map(viewTabId, u.changes)
    // 预览一改就转正：改过的东西不能被下一次单击顶掉
    keepTab(viewTabId)
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
  syncHints()
})
prefs.apply()

// 第八节 14：空白文档那颗「不再显示」。关的是整个「操作提示」（设置面板里那一行），
// 回执里给一颗撤销 —— 手滑点到的人不必去翻设置
blankHintHost.dismiss = () => {
  prefs.setHints(false)
  note(t('note.hintsOff'), { action: { label: t('note.undo'), run: () => prefs.setHints(true) } })
}

/**
 * 正文缩放（0.4.1）。⌘+ / ⌘− / ⌥⌘0 与捏合都落到这里 —— 壳那边只把动作转过来，
 * 不再碰 `pageZoom`（见 `ui/zoom.ts`：那是整个界面一起放大）。
 * 与偏好里的字号是两件事：字号是「我平时看多大」，缩放是「这一阵凑近看看」。
 */
const zoom = new Zoom(() => {
  // 与偏好那份同一个理由：正文字号变了，表格学到的行高、CM 缓存的字符尺寸都过期了
  forgetRowHeight()
  view.requestMeasure()
  syncZoom()
}, !selfCheck)
zoom.apply()

/** 状态栏右下那格。**100% 时留空**（CSS 里 `:empty` 整格不占位） */
function syncZoom(): void {
  elZoom.textContent = zoom.zoomed ? zoom.label : ''
}

// 点一下回到 100%（同字数条：mousedown 要 preventDefault，否则焦点与选区一起丢）
elZoom.addEventListener('mousedown', (e) => e.preventDefault())
elZoom.addEventListener('click', () => zoom.reset())
elZoom.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    zoom.reset()
  }
})

const sidebar = new Sidebar({
  // 文件树点开一个文件是一次明确的跳转（第八节 6），记下来后退得回来。
  // 单击开成预览、双击开成普通标签（见 `Tab.preview`）
  openFile: (path, preview) => void navigation(() => openPath(path, undefined, preview)),
  // 文件进了废纸篓：它开着的标签也得关掉，否则标签指着一个不存在的文件
  trashed: (path, trashed) => {
    for (const tab of tabs.filter((x) => x.path === path)) void closeTab(tab.id, true)
    // 关着的那份也别再「重新打开」它（第八节 7）：回来的只会是一句「找不到文件」
    closedTabs.forget(path)
    refreshNav()
    // 0.2.x：删除是这个应用里唯一「点一下就没了」的动作，而它此前唯一的反悔路径
    // 是自己去废纸篓里翻。状态栏给一条 8 秒的回执，带一颗撤销（契约 v25）
    note(t('note.trashed', { name: basename(path) }), {
      action: trashed
        ? { label: t('note.undo'), run: () => void undoTrash(trashed, path) }
        : undefined
    })
  },
  // P3-1 收尾：重命名 / 拖走之后路径变了。开着的标签要跟着改，否则下一次保存
  // 会按旧路径写回去 —— 等于凭空复活一个已经不在那儿的文件
  moved: (from, to) => {
    retargetTabs(from, to)
    // 第八节 10：父目录变了才是真的挪了地方（原地改名，文档自己的相对路径不受影响）——
    // 查一下这一挪弄坏了哪几条引用
    if (dirname(from) !== dirname(to)) void checkMoved(from, to, 'move')
  },
  openHit: (hit) => void navigation(() => openHit(hit)),
  replaceInFiles: (targets, replacement) => replaceInFiles(targets, replacement),
  pickFolder: () => openFolder()
})
/**
 * 0.4.0 F2 跨文件替换的回执那一半（契约 v30）。
 *
 * 改盘的事全在壳里（指纹、快照、逐字校验），这里只管**说清楚发生了什么**：
 * 改了几个文件几处、有没有整份跳过的（那说明文件在搜完之后变过）、
 * 以及那颗 8 秒撤销。这是整个应用里改动面最大的一个动作，回执不能含糊。
 */
async function replaceInFiles(targets: ReplaceTarget[], replacement: string): Promise<void> {
  const out = await window.api.replaceInFiles(targets, replacement)
  if (!out.files) {
    note(t('note.replacedNone'), { warn: true })
    return
  }
  const skipped = out.skipped.length ? t('note.replaceSkipped', { n: out.skipped.length }) : ''
  note(t('note.replaced', { files: out.files, hits: out.hits }) + skipped, {
    warn: out.skipped.length > 0,
    action: {
      label: t('note.undo'),
      run: () => {
        void window.api.undoReplaceInFiles(out.token).then((n) => {
          note(n ? t('note.replaceUndone', { n }) : t('note.restoreFailed'), { warn: n === 0 })
        })
      }
    }
  })
}

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
  // 只读（第八节 5）：按钮置灰。收着、关着也照样设 —— 理由同上面那条「收起时也照算高亮」
  formatBar.setReadOnly(view.state.readOnly)
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
  },
  // 只读（第八节 5）：右键里改文档的三条置灰、拖拽重排不起手
  readOnly: () => view.state.readOnly
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
const tbSidebar = titlebarButton('tb-sidebar', 'panel-left', t('tb.sidebar'), 'view:toggle-sidebar')
const tbTheme = titlebarButton('tb-theme', 'moon', t('tb.theme'), 'view:toggle-dark')
const tbColumn = titlebarButton('tb-column', 'column', t('tb.column'))
const tbOutline = titlebarButton('tb-outline', 'panel-right', t('tb.outline'), 'view:toggle-outline')
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

/**
 * 标题栏的挖洞区（契约 v26，算法在 `ui/drag-holes.ts`）。
 *
 * 原生拖拽条整条盖在窗口顶边那 38px 上，两颗面板开关、右上那三颗、**以及正文的标签**
 * 全坐在它底下 —— 不把这几段报上去，它们一个点击都收不到。量的是真实 rect，
 * 所以改 base.css 的内边距 / 按钮尺寸不必再回头同步 Swift（壳里那份写死的区间只剩兜底）。
 *
 * `collect` 里 `tabbar` 是后面才建的，但这里只是个闭包 —— 真正取值要等到 rAF 里，
 * 那时整个模块早就跑完了（模块级 let 的启动顺序坑见 CONTEXT）。
 */
const holes = createHoleReporter({
  collect: () => [
    tbSidebar.getBoundingClientRect(),
    tbGroup.getBoundingClientRect(),
    ...[...tabbar.el.querySelectorAll('.tab-item')].map((el) => el.getBoundingClientRect())
  ],
  strip: () => ({
    width: window.innerWidth,
    // 高度只有 base.css 那一处说了算（`--drag-strip`），壳侧的条高也钉在同一个数上
    height:
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--drag-strip')) || 38
  }),
  send: (list) => window.api.setTitlebarHoles(list)
})
// 窗口宽度变了就得重量一遍（0.4.1 起缩放只动正文，不再改 CSS 视口，与这条无关）
window.addEventListener('resize', () => holes.schedule())

syncTitlebar()

/** `same` = 与哪条菜单命令是同一件事：悬停说明里的快捷键照它取（`ui/shortcuts.ts`，第八节 14） */
function titlebarButton(id: string, name: IconName, label: string, same?: MenuAction): HTMLButtonElement {
  const b = document.createElement('button')
  b.id = id
  b.className = 'tb-btn'
  b.innerHTML = icon(name)
  b.title = same ? withKey(label, same) : label
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

/**
 * 按钮亮=面板开着。aria-pressed 让读屏也拿得到这个状态。
 *
 * 顺带管顶栏两侧的留白：面板一藏，中间列就顶到窗口边上，标签会撞上红绿灯（左）
 * 或右上那三颗（右）。**面板显隐只在这里汇合**，留白挂在别处迟早有一条路忘了改。
 */
function syncTitlebar(): void {
  for (const [b, on] of [[tbSidebar, sidebar.visible], [tbOutline, outline.visible]] as const) {
    b.classList.toggle('is-on', on)
    b.setAttribute('aria-pressed', String(on))
  }
  const topbar = document.getElementById('topbar')!
  topbar.classList.toggle('is-inset-left', !sidebar.visible)
  topbar.classList.toggle('is-inset-right', !outline.visible)
  holes.schedule()
  syncThemeButton()
  syncViewFlags()
}

/** 月亮=现在是浅色（按下去会变深）；太阳=现在是深色。图标说的是**按下去会发生什么** */
function syncThemeButton(): void {
  const dark = prefs.resolved === 'dark'
  tbTheme.innerHTML = icon(dark ? 'sun' : 'moon')
  tbTheme.title = withKey(dark ? t('tb.toLight') : t('tb.toDark'), 'view:toggle-dark')
  tbTheme.setAttribute('aria-label', dark ? t('tb.toLight') : t('tb.toDark'))
  tbTheme.classList.toggle('is-on', dark)
}

/** 语言切换后标题栏按钮的 title/aria 重拼（带快捷键后缀，走不了 data-i18n） */
function syncTitlebarLabels(): void {
  const setBtn = (b: HTMLButtonElement, label: string, same?: MenuAction): void => {
    b.title = same ? withKey(label, same) : label
    b.setAttribute('aria-label', label)
  }
  setBtn(tbSidebar, t('tb.sidebar'), 'view:toggle-sidebar')
  setBtn(tbColumn, t('tb.column'))
  setBtn(tbOutline, t('tb.outline'), 'view:toggle-outline')
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
    typewriter: writingNow.typewriter,
    customOff: prefs.values.customOff,
    // 契约 v38：活动标签的只读（按标签的态，勾跟着切标签走）与三条导航命令亮不亮
    readOnly: view.state.readOnly,
    ...navFlags
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
  /**
   * 未决的外部修改冲突（第八节 2）：磁盘上那一份**记在这儿**，等人处理。
   *
   * 它挂着的时候，这个文件的**自动保存是停的**（`writeOnce` 那道闸）—— 这是整条
   * 改动里唯一会真丢东西的地方：从前非活动标签只挂一个 ⚠，两秒后的自动保存照样
   * 把外部改动一声不响地盖掉。记的是**当时读到的那份字节**而不是「去重新读一次」：
   * 人看见的差异与最后决定要不要丢掉的，必须是同一份
   */
  conflict?: { content: string; fingerprint: FileFingerprint }
  /**
   * **我们以为盘上此刻躺着的那些字节**（2026-09-22）—— 注意是**原始字节**
   * （`encode(正文, 指纹)` 的结果），不是正文。两处都要它：
   *
   * ① 认出「这次文件变了是我自己干的」。光比「盘上那份与当前文档一不一样」不够：
   *    自动保存落盘到监听事件到达之间只隔 300ms，人在这中间又敲了几个字，那条就不
   *    成立了 —— 于是报出一次假冲突，而假冲突会把这个文件的自动保存整个停下来。
   * ② 写盘前交给壳去比（契约 v36 的 compare-and-swap）。
   *
   * **正文与指纹要一起记**：正文是剥了 BOM、换行归一成 LF 之后的样子 —— 外面的工具
   * 把 LF 换成 CRLF 时正文一个字都不变，只比正文的话这种改动两处都看不见，接着按旧
   * 指纹写回去，人家的转换就被我们悄悄撤销了（红线一：保存零损耗）。
   *
   * 而**不能记原始字节**：混合换行符的文件 `encode(decode(raw)) !== raw`，
   * 拿字节去比会让那种文件的自动保存整个停摆（真踩过，E2E 当场红）
   */
  lastSeen?: { text: string; fp: FileFingerprint }
  /** 盘上那个文件读不到了（删了 / 改名了 / 外接盘拔了）。挂着时自动保存停下，见 `writeOnce` */
  missing?: true
  /**
   * **预览标签**：单击文件树开出来的那一格（VS Code 同款，标题斜体）。整个窗口至多一个，
   * 下一次单击别的文件时新的那份坐进这一格、把它顶掉（见 `spawnTab`）。
   *
   * 只会转正、不会变回来（`keepTab`）：双击 / 回车打开、从别处（快速打开、链接、Finder…）
   * 再开它一次、双击标签、右键「保持打开」、改了内容、拖着挪了位置、设为只读、另存为。
   * 「改了内容就转正」是要害 —— 有未保存改动的标签绝不能被一次单击顶掉
   */
  preview?: true
  /**
   * 这个标签自己的保存状态（第八节 1）。**归标签不归窗口** —— 从前那句
   * 「已保存 10:23」是一个全局变量，后台标签的自动保存会把它刷成此刻，
   * 于是正在编辑的这一份挂着一句它从来没发生过的回执（见 `ui/save-state.ts`）
   */
  save: SaveStatus
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

/**
 * 视图里此刻装的是**哪个标签**的 state（0.4.1 修）。
 *
 * 从前这件事是「推」出来的：凡是 `t.id === activeId` 就假定视图里装的是它。
 * 那个假定破过一次，代价是一整份文件 —— 会话恢复用 `spawnTab(focus=false)`
 * 接管启动那个空白标签时只换了标签的 state/path，**视图还停在空白文档上**，
 * 而 `activeId` 一直指着它；随后 `activate(别的标签)` 那句 `cur.state = view.state`
 * 就把空白文档当成了这份文件的内容，静默落盘写成 0 字节
 * （2026-09-22 真丢了文件：会话里排第一、又不是活动标签的那一份）。
 *
 * 现在它是**记下来的**：只有这三处 `view.setState` 能改它，凡是要拿视图当某个
 * 标签的内容，一律先问它。`activeId` 管的是「哪个标签是当前的」，与「视图里装着谁」
 * 是两件事 —— 绝大多数时候相同，而出事的正是不同的那一瞬。
 */
let viewTabId: number | null = null

function isTabDirty(t: Tab): boolean {
  const doc = t.id === viewTabId ? view.state.doc : t.state.doc
  return !doc.eq(t.savedDoc)
}

function anyDirty(): boolean {
  return tabs.some((t) => isTabDirty(t))
}

/**
 * 预览转正（见 `Tab.preview`）：从此它就是个普通标签，下一次单击别的文件不会再顶掉它。
 * 不是预览就什么都不做 —— 调用方不必先问
 */
function keepTab(id: number | null): void {
  const tab = tabs.find((x) => x.id === id)
  if (!tab?.preview) return
  delete tab.preview
  syncStatus()
  scheduleSession()
}

const tabbar = new TabBar(
  (id) => {
    if (id !== activeId) activate(id)
    else focusKeepScroll(view)
  },
  (id) => void closeTab(id),
  (id, e) => openTabMenu(id, e),
  (id, before) => reorderTab(id, before),
  (id) => keepTab(id)
)

/**
 * 撤销删除（0.2.x，契约 v25）。
 *
 * 失败就**明说**，不假装成功：位置被新建的同名文件占了、废纸篓被清空了，都是真的
 * 撤不回来 —— 而这时候用户还有一条路（自己去废纸篓里翻），前提是他知道这一下没成。
 */
async function undoTrash(trashed: string, back: string): Promise<void> {
  if (await window.api.restoreItem(trashed, back)) {
    await sidebar.refresh(back)
    note(t('note.restored', { name: basename(back) }))
  } else {
    note(t('note.restoreFailed'), { warn: true })
  }
}

/**
 * ⌃Tab / ⌃⇧Tab 循环（0.2.x）。**按 `tabs` 的顺序走**，也就是眼睛看到的那个顺序
 * （拖拽重排之后同样成立）。到头折回：最后一个的下一个是第一个 —— 循环里
 * 「到头就不动了」比折回更让人困惑，而这两个键本来就是用来快速来回翻的。
 */
function cycleTab(step: 1 | -1): void {
  if (tabs.length < 2) return
  const at = tabs.findIndex((x) => x.id === activeId)
  if (at < 0) return
  const next = tabs[(at + step + tabs.length) % tabs.length]!
  activate(next.id)
}

/**
 * 拖拽重排（0.2.x）。
 *
 * **挪的是 `tabs` 数组本身**，标签栏只是照着重画一遍 —— 顺序在别处也有意义：
 * 会话按它记（`currentSession`）、「关闭左边/右边」按它算（`closeTabs`）、
 * ⌃Tab 循环按它走。只在标签栏里挪 DOM 的话，那三处会立刻和眼睛看到的对不上。
 */
function reorderTab(id: number, before: number | null): void {
  const now = tabs.map((x) => x.id)
  const next = reorderIds(now, id, before)
  if (next.join() === now.join()) return
  tabs = next.map((x) => tabs.find((tab) => tab.id === x)!)
  // 特意给它挪了个位置，就是要留着它（VS Code 同款）
  keepTab(id)
  syncStatus()
  scheduleSession()
}
// 标签栏坐进顶栏 —— 中间列最上面那一条，与原生拖拽条同高、同一片地方（见 base.css 的 #topbar）
document.getElementById('topbar')!.appendChild(tabbar.el)
// 标签栏横向滚动时可见的那一段跟着变，得重报一次挖洞区
tabbar.el.addEventListener('scroll', () => holes.schedule(), { passive: true })

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
  focus = true,
  /**
   * 开成预览（见 `Tab.preview`）。预览只有一格：已经有一个的话，新的这份**坐进它那一格**、
   * 把它顶掉。被顶掉的不是人关的，不进「重新打开关闭的标签」那一栈（VS Code 同款）。
   *
   * **只有开在前台的（`focus`）才顶**：开在背景里的是会话恢复，那会儿占着预览那一格的
   * 只可能是人刚单击开的东西 —— 背景行为不许动它（恢复那边因此不会再要一个预览）。
   * 顺带保证了被顶掉的哪怕是活动标签，下面那次 activate 也一定会发生
   */
  preview = false,
  /**
   * 恢复出来的滚动位置。**必须在这儿给**：接管空白页那一次 `activate` 就在下面几行，
   * 而调用方拿到返回值才写得上 `tab.scroll` —— 晚一步，那次 activate 把视图滚到 0
   */
  scroll = 0
): Tab {
  let slot = preview && focus ? tabs.find((t) => t.preview) : undefined
  // 按理预览一改就转正了，到不了这儿。真脏着就让它转正留下 —— 宁可多一格，不替人丢东西
  if (slot && isTabDirty(slot)) {
    delete slot.preview
    slot = undefined
  }
  // 启动时的空白首标签直接复用，避免「打开一个文件却多出一个空标签」
  const pristine = tabs.find(
    (t) => !t.path && !isTabDirty(t) && t.state.doc.length === 0
  )
  if (pristine) {
    pristine.state = state
    pristine.path = path
    pristine.fp = fp
    pristine.savedDoc = state.doc
    pristine.scroll = scroll
    // 换了一份文档 = 换了一段身世：上一份的「已保存 10:23」不能跟着新文件走
    pristine.save = newSaveStatus()
    if (preview) pristine.preview = true
    // 空白标签与旧预览同时在时，接管空白标签那一格（不留一个空标签挂着），旧预览照样顶掉
    if (slot) tabs = tabs.filter((x) => x !== slot)
    // **背景接管也要走 activate**（0.4.1 修）：`focus=false` 是为了省掉会话恢复里
    // 那 N-1 次白做的 `view.setState`，但被接管的要是**当前这个空白标签**，
    // 不换视图就等于让 `activeId` 指着新文件、视图里却还是那份空白文档 ——
    // 接下来任何一次落盘都会把空白当成它的内容写进去（见 `viewTabId` 那段）。
    // 这一次 activate 至多发生一次（空白标签只有一个），省下的那 N-1 次还在
    if (focus || pristine.id === activeId) activate(pristine.id)
    return pristine
  }
  const t: Tab = {
    id: nextId++,
    path,
    fp,
    state,
    savedDoc: state.doc,
    scroll,
    sourceMode,
    save: newSaveStatus(),
    ...(preview ? { preview: true as const } : {})
  }
  // **新开一个 id 而不是复用旧预览那个标签对象**：后退 / 前进按 id 认标签（`sameDoc`），
  // 同一个 id 换了一份文档，「回到刚才那份的第 30 行」就会落在这一份的第 30 行上
  if (slot) tabs.splice(tabs.indexOf(slot), 1, t)
  else tabs.push(t)
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
    // 只有视图里装的确实是它，才能拿视图当它的内容（见 `viewTabId`）
    if (cur.id === viewTabId) cur.state = view.state
    if (cur.id === viewTabId) cur.scroll = view.scrollDOM.scrollTop
    cur.sourceMode = sourceMode
    void flushTabAutosave(cur)
  }
  // 局部变量不能再叫 t —— 会遮住 i18n 的 t()，下面那句 `t('app.untitled')` 就成了「调用一个 Tab」
  const tab = tabs.find((x) => x.id === id)
  if (!tab) return
  activations += 1
  activeId = id
  docPath = tab.path
  fingerprint = tab.fp
  sourceMode = tab.sourceMode
  view.setState(tab.state)
  viewTabId = tab.id
  // 换了一份文档，后退 / 前进亮不亮跟着变（人自己切的标签不记，见 ui/nav-history.ts）；
  // 只算不发 —— 下面那句 syncMode() 会把整份视图标志一起推给壳
  computeNavFlags()
  requestAnimationFrame(() => {
    view.scrollDOM.scrollTop = tab.scroll
  })
  syncMode()
  syncWriting()
  syncSpell()
  syncHints()
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
  if (t.id === viewTabId) t.state = view.state

  if (!discard && isTabDirty(t)) {
    const choice = await window.api.confirmDiscard(tabTitle(t))
    if (choice === 'cancel') return false
    // 活动与非活动走同一条路（`writeTab` 认的是标签不是「当前那个」）：
    // 从前非活动那一支自己发 `window.api.save`，于是那个标签的保存状态、
    // scratch 清理与版本快照三件全漏了
    if (choice === 'save' && !(await writeTab(t))) return false
  }

  // 第八节 7：有路径的记进关闭栈，带着光标、滚动与只读（进了废纸篓的那条是 `discard`，
  // 文件已经不在了，不记）。第八节 6：无路径的草稿关掉就再也回不去，导航记录里落在它
  // 身上的那几格一并删掉
  if (t.path && !discard) {
    closedTabs.push({
      path: t.path,
      cursor: t.state.selection.main.head,
      scroll: t.id === viewTabId ? view.scrollDOM.scrollTop : t.scroll,
      readOnly: t.state.readOnly
    })
  } else if (!t.path) nav.forgetTab(t.id)

  const idx = tabs.findIndex((x) => x.id === id)
  tabs = tabs.filter((x) => x.id !== id)
  if (tabs.length === 0) {
    newUntitledTab()
    refreshNav()
    return true
  }
  if (id === activeId) activate(tabs[Math.min(idx, tabs.length - 1)]!.id)
  else syncStatus(true)
  scheduleSession() // 关掉的那个不该在下次启动时又冒出来
  refreshNav()
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
  const preview = tabs[idx]!.preview === true
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
    { label: t('tab.closeAll'), run: () => void closeTabs(id, 'all') },
    // 预览标签才有这一条（VS Code 同款「保持打开」）：双击标签是同一件事，只是这儿看得见
    ...(preview ? [{ label: t('tab.keep'), separated: true, run: () => keepTab(id) }] : []),
    // 第八节 5：只读按标签，右键的就是这个标签 —— 不必先切过去
    {
      label: t(tabReadOnly(tabs[idx]!) ? 'tab.roOff' : 'tab.roOn'),
      separated: !preview,
      run: () => setReadOnly(id, !tabReadOnly(tabs.find((x) => x.id === id)!))
    },
    // 第八节 7：与浏览器同一个位置
    { label: t('tab.reopen'), disabled: closedTabs.size === 0, run: () => void reopenClosedTab() }
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
      readOnly: tabReadOnly(x),
      preview: x.preview === true,
      path: x.path
    })),
    activeId
  )
  window.api.openTabs(tabs.map((x) => x.path).filter((p): p is string => p !== null))
  // 「存没存」跟着脏状态走：每敲一个字它都可能从「已保存 10:23」翻成「未保存」
  renderSave()
  // 标签重画了：段数、宽度都可能变，挖洞区跟着重报（合帧 + 没变就不发，见 drag-holes.ts）
  holes.schedule()
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
  // 这一份是在半截树上取的（ensure 超了预算：机器正忙、或者文档大到一次解析不完）——
  // 标题表只有前半截，甚至一个都没有，而下一次刷新要等文档再变。过一会儿自己再取一次，
  // 直到盖住全文：每一次 ensure 都接着上一次的进度往下解析，不会原地打转（第八节 16）
  if (!headingsSettled(view.state)) scheduleOutline()
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

/**
 * 第八节 14：偏好里的「操作提示」推到活动 view 上（空白文档那两行，`editor/blank-hint.ts`）。
 * 与 `syncSpell` 同构，只多一句「已经是这样就不发」—— 拖字号滑杆时 onApply 是连发的
 */
function syncHints(): void {
  hintsNow.on = prefs.values.hints
  const want = blankHint(hintsNow.on)
  if (hintConf.get(view.state) !== want) view.dispatch({ effects: hintConf.reconfigure(want) })
}

function syncMode(): void {
  view.dispatch({
    effects: livePreviewConf.reconfigure(sourceMode ? [] : livePreview())
  })
  view.dom.classList.toggle('cursive-source', sourceMode)
  elMode.textContent = sourceMode ? t('status.source') : t('status.preview')
  syncReadOnlyChip()
  syncViewFlags()
}

// ---------- 第八节 5：只读阅读模式（按标签）----------

/** 状态栏那一格：只读时一把锁 +「只读」，点一下退出；不只读时为空（`:empty` 不露面） */
const elRo = document.getElementById('status-ro')!

function syncReadOnlyChip(): void {
  const on = view.state.readOnly
  // 空就是空：留一个空格都会让 `:empty` 失效，白占一格（同缩放那格）
  elRo.innerHTML = on ? `${icon('lock')}<span>${t('status.ro')}</span>` : ''
}

elRo.addEventListener('mousedown', (e) => e.preventDefault())
elRo.addEventListener('click', () => setReadOnly(activeId, false))
elRo.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    setReadOnly(activeId, false)
  }
})

/** 这个标签是不是只读。态在它自己的 state 里；视图里装着它时以视图为准（见 `viewTabId`） */
function tabReadOnly(t: Tab): boolean {
  return (t.id === viewTabId ? view.state : t.state).readOnly
}

/**
 * 切一个标签的只读。视图里装着它就对视图 reconfigure，否则改它冻结的那份 state ——
 * 右键一个后台标签「设为只读」不必先切过去。
 *
 * 表格的就地编辑态一并退出：只读时格子不再是可编辑的孤岛（`TableWidget` 的 `readOnly`），
 * 留着编辑态会把光标那一格摆成源码。
 */
function setReadOnly(id: number, on: boolean): void {
  const tab = tabs.find((x) => x.id === id)
  if (!tab || tabReadOnly(tab) === on) return
  // 对一个预览定下「只读」，就是要留着它读：被下一次单击顶掉的话，这把锁跟着一起没了
  keepTab(id)
  const spec = {
    effects: [readOnlyConf.reconfigure(readOnlyExt(on)), ...(on ? [setTableEdit.of(null)] : [])]
  }
  if (tab.id === viewTabId) {
    view.dispatch(spec)
    syncReadOnlyChip()
    syncFormatBar()
    syncViewFlags()
    focusKeepScroll(view)
  } else {
    tab.state = tab.state.update(spec).state
  }
  syncStatus(true)
  scheduleSession()
  note(t(on ? 'ro.on' : 'ro.off'))
}

/**
 * 编辑被只读挡下的那一下（`editor/read-only.ts` 的闸）：说一句 + 一颗「退出只读」。
 * 连着按十个键只说一次 —— 同一句话刷十遍是噪音。挪到下一拍再说：闸是在事务**构造**
 * 期间调过来的，那会儿碰 DOM 不要紧，但别在那一刻做任何可能回头派事务的事
 */
let roNotedAt = 0
readOnlyHost.blocked = () => {
  const now = Date.now()
  if (now - roNotedAt < 2500) return
  roNotedAt = now
  setTimeout(() => {
    note(t('ro.blocked'), { action: { label: t('ro.exit'), run: () => setReadOnly(activeId, false) } })
  }, 0)
}

// ---------- 第八节 6：后退 / 前进 ----------

/**
 * 此刻在哪儿：哪个标签、光标、视口顶上那一行。顶上那一行按**文档位置**记
 * （`lineBlockAtHeight`，扣掉正文上边距）—— 像素会被晚到的图片推走，文档位置不会
 */
function here(): NavSpot {
  const top = view.lineBlockAtHeight(Math.max(0, view.scrollDOM.scrollTop - view.documentPadding.top)).from
  return { tabId: activeId, path: docPath, pos: view.state.selection.main.head, top }
}

/** 三条命令此刻亮不亮。只算不发，变了返回 true（`activate` 里只算 —— 那边随后整份推给壳） */
function computeNavFlags(): boolean {
  const doc: NavDoc = { tabId: activeId, path: docPath }
  const next = {
    canBack: nav.canBack(doc),
    canForward: nav.canForward(doc),
    canReopen: closedTabs.size > 0
  }
  const changed =
    next.canBack !== navFlags.canBack ||
    next.canForward !== navFlags.canForward ||
    next.canReopen !== navFlags.canReopen
  Object.assign(navFlags, next)
  return changed
}

function refreshNav(): void {
  if (computeNavFlags()) syncViewFlags()
}

/**
 * 正在记的那一趟跳转有几层。跨文档的那几条（开标签再跳到锚点）**由最外层整趟记一格**：
 * 从这一份的此刻，到那一份的落点 —— 里面那一下 jumpTo 不另记（否则后退一步只退到
 * 「刚打开那份文档的文首」）。
 */
let navDepth = 0

/** 落点那一格：视口顶上就摆光标那一行（跳转都是把目标摆到顶上，见 `jumpTo`） */
function landing(): NavSpot {
  const spot = here()
  return { ...spot, top: spot.pos }
}

/** 一次明确的跳转（异步那几条：开文件、搜索命中、链接、快速打开） */
async function navigation(run: () => void | Promise<void>): Promise<void> {
  if (navDepth > 0) {
    await run()
    return
  }
  const from = here()
  navDepth += 1
  try {
    await run()
  } finally {
    navDepth -= 1
  }
  nav.record(from, landing())
  refreshNav()
}

// 文档里的跳转（大纲、[TOC]、锚点链接、跳到行）全走 jumpTo，在那儿挂这一个钩子
jumpHost.around = (v, run) => {
  if (v !== view || navDepth > 0) {
    run()
    return
  }
  const from = here()
  run()
  nav.record(from, landing())
  refreshNav()
}

async function goBack(): Promise<void> {
  const spot = nav.back(here())
  if (!spot) note(t('nav.noBack'))
  else await travel(spot)
  refreshNav()
}

async function goForward(): Promise<void> {
  const spot = nav.forward(here())
  if (!spot) note(t('nav.noForward'))
  else await travel(spot)
  refreshNav()
}

/**
 * 回到记下来的一个位置。标签还开着就切过去；关了但有路径就重新打开（与文件树同一条路）；
 * 无路径的草稿关了的那几格早被 `forgetTab` 删掉了，这里不会遇到。
 *
 * **换了标签就晚一帧再摆位置**：`activate` 会在下一帧把视图滚回那个标签自己记着的
 * 滚动位置，同一帧里先摆的会被它盖掉
 */
async function travel(spot: NavSpot): Promise<void> {
  let tab = tabs.find((x) => x.id === spot.tabId) ?? (spot.path ? tabs.find((x) => x.path === spot.path) : undefined)
  if (!tab && spot.path) {
    let doc: DocPayload
    try {
      doc = await window.api.read(spot.path)
    } catch (e) {
      openFailed(spot.path, e, () => void travel(spot))
      return
    }
    // 开成预览：单击预览过一串文件再一路后退，退过的每一份都该轮流坐那一格，
    // 而不是在标签栏里攒成一排没人要留的标签（VS Code 同款）
    tab = openTab(doc.content, doc.path, doc.fingerprint, { preview: true })
  }
  if (!tab) return
  const switched = tab.id !== activeId
  if (switched) activate(tab.id)
  const place = (): void => {
    const len = view.state.doc.length
    revisit(view, Math.min(spot.pos, len), Math.min(spot.top, len))
    view.focus()
  }
  if (switched) requestAnimationFrame(place)
  else place()
}

// ---------- 第八节 7：重新打开关闭的标签 ----------

/**
 * 弹最近关掉的那一个，按路径重新读盘，带着光标、滚动与只读回来。读不到（删了、搬走了）
 * 就说为什么、给下一步（与文件树点开一个打不开的文件同一句话），这一格不再留着。
 * 已经开着的不会在栈里（`openTab` 一开就 `forget`），所以不会开出第二份。
 */
async function reopenClosedTab(): Promise<void> {
  const entry = closedTabs.pop()
  refreshNav()
  if (!entry) {
    note(t('note.reopenNone'))
    return
  }
  const open = tabs.find((x) => x.path === entry.path)
  if (open) {
    activate(open.id)
    return
  }
  let doc: DocPayload
  try {
    doc = await window.api.read(entry.path)
  } catch (e) {
    openFailed(entry.path, e)
    return
  }
  openTab(doc.content, doc.path, doc.fingerprint, {
    cursor: entry.cursor,
    scroll: entry.scroll,
    readOnly: entry.readOnly
  })
}

// ---------- 文档生命周期 ----------

/** 打开到新标签页；同一文件已开着则激活原标签，避免覆盖未保存内容 */
/** 预热计时器：切标签切得快时只留最后那一份 */
let warmTimer: number | undefined

function openTab(
  content: string,
  path: string | null,
  fp: FileFingerprint,
  opts: {
    /** 重新打开关闭的标签（第八节 7）带回来的位置与只读；别的路都不传 */
    cursor?: number
    scroll?: number
    readOnly?: boolean
    /**
     * 开成预览（单击文件树、后退 / 前进回到一份已经关掉的文档）。别的路都是「真要打开它」——
     * 那份文件此刻正开在预览里的话，顺手把它转正
     */
    preview?: boolean
  } = {}
): Tab {
  // 文档进编辑器**之前**把落盘的 widget 高度捞进内存：CM 先查 `estimatedHeight` 进高度表、
  // 再 `toDOM`，晚一步的话这份文档的第一个图/公式/图表照样跳一下（见 widgets.ts 那边的注释）
  primeHeights(view)
  // 首帧之后在空闲里热一遍这份文档用得上的懒加载模块（见 `editor/warmup.ts`）：
  // 切标签切得快时只留最后那一份
  clearTimeout(warmTimer)
  warmTimer = warmLazyModules(content)
  const existing = path ? tabs.find((t) => t.path === path) : undefined
  if (existing) {
    if (!opts.preview) keepTab(existing.id)
    // **已经是当前这一份就别再 activate**：那会拿它切走时冻结的旧 state 盖掉视图里
    // 正在编辑的这份，滚动也跳回旧位置（见 `openDocLink` 那段）。调用方在 await 读盘
    // 之前各自挡过一次，挡不住的是**两次打开同时在路上**：双击的两下各读一次盘，
    // 第二次读回来时第一次已经把它开好了
    if (existing.id !== activeId) activate(existing.id)
    else focusKeepScroll(view)
    return existing
  }
  const tab = spawnTab(
    createState(content, listener, {
      dir: path ? dirname(path) : null,
      sourceMode,
      ...(opts.cursor === undefined ? {} : { cursor: opts.cursor }),
      ...(opts.readOnly ? { readOnly: true } : {})
    }),
    path,
    fp,
    true,
    opts.preview === true && path !== null,
    opts.scroll ?? 0
  )
  // **刚从盘上读进来的这一份，就是「我们以为盘上是什么」**（契约 v36 的 expect）。
  // 不在这儿记的话，第一次自动保存发不出比对依据 —— 而「打开、编辑、两秒后自动保存」
  // 正是最常走的那条路，也正是那条竞态最容易咬到的地方
  if (path) {
    tab.lastSeen = { text: content, fp: { ...fp } }
    // 又开着了：关闭栈里不再算它（第八节 7，不出第二份）；导航记录里按路径认的那几格
    // 认这个新标签，之后改文档时位置才跟得上（第八节 6）
    closedTabs.forget(path)
    nav.rebind(path, tab.id)
    refreshNav()
  }
  return tab
}

/**
 * P3-1 收尾：文件被重命名或拖到别处之后，开着它的标签要改指向新路径。
 * **目录也要认**：改名一个目录，它底下每个开着的文件路径都失效了，按前缀整体重写。
 */
function retargetTabs(from: string, to: string): void {
  // 关着的那几个与导航记录里的路径一样要跟着改（第八节 6 / 7）—— 不跟的话，
  // 后退 / 重新打开会去一个已经不在那儿的路径上读盘
  nav.retarget(from, to)
  closedTabs.retarget(from, to)
  let touched = false
  for (const t of tabs) {
    if (t.path === from) t.path = to
    else if (t.path?.startsWith(`${from}/`)) t.path = to + t.path.slice(from.length)
    else continue
    touched = true
    syncTabDir(t)
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
    let doc: DocPayload
    try {
      doc = await window.api.read(hit.path)
    } catch (e) {
      // 搜到那一刻还在，点的时候没了（或者本来就读不动）—— 同文件树那条路
      openFailed(hit.path, e, () => void openHit(hit))
      return
    }
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

/**
 * **一份文件打不开了**（第八节 4）。四类各说各的话、各给各的下一步：
 *
 * · 不是 UTF-8 / 没权限 —— **不会自己好**，所以那句话不自散（人多半得离开这个窗口
 *   去换个程序转码、去改权限，回来时它还得在），给一颗「在 Finder 中显示」把人送到门口；
 * · 找不到 —— 十有八九是树里那一行过期了（别处删了 / 改名了），给一颗「刷新文件树」，
 *   刷的只是它所在那一级（同 kqueue 那条路）；
 * · 其余 IO —— 给「重试」，这一类真的可能下一次就好。
 *
 * 从前这四种在渲染层长得一模一样（壳回的都是「读不到文件：<路径>」），而且文件树
 * 与搜索结果那两条路**压根没接住它** —— 点开一个 GBK 编码的 .md，屏幕上什么都不会发生。
 */
function openFailed(path: string, e: unknown, retry?: () => void): void {
  const kind = readFailKind(e)
  const name = basename(path)
  const key = (
    { notUtf8: 'open.notUtf8', notFound: 'open.notFound', denied: 'open.denied', io: 'open.io' } as const
  )[kind]
  let action: { label: string; run: () => void } | undefined
  if (kind === 'io' && retry) action = { label: t('status.retry'), run: retry }
  else if (kind === 'notFound') {
    // 刷的只是它所在那一级（同 kqueue 那条路）；树没开着、或者路径就在根上时不给这颗
    const dir = dirname(path)
    if (sidebar.treeRoot && dir) {
      action = { label: t('note.refreshTree'), run: () => sidebar.onDirChanged(dir) }
    }
  } else action = { label: t('note.reveal'), run: () => window.api.revealInFinder(path) }
  note(t(key, { name }), {
    warn: true,
    sticky: readFailSticky(kind),
    ...(action ? { action } : {})
  })
}

/**
 * 从侧边栏点开一个文件（开新标签，不碰现有标签）。
 * `line` 是 0.2.x「跳到行」那条路带进来的：`⌘T` 里打 `readme:120`；
 * `preview` 是文件树的单击（见 `Tab.preview`）
 */
async function openPath(path: string, line?: number, preview = false): Promise<void> {
  if (path === docPath) {
    // 已经是当前这份：标签一个字都不用动，但行还是要跳。不是预览（双击 / 回车）就转正，
    // 焦点也还给编辑器 —— 双击的第二下按在树上，焦点这会儿被树拿走了
    if (!preview) {
      keepTab(activeId)
      focusKeepScroll(view)
    }
    if (line) gotoLine(line)
    return
  }
  let doc: DocPayload
  try {
    doc = await window.api.read(path)
  } catch (e) {
    // 文件树 / 快速打开点一下打不开的东西：从前这儿一个 catch 都没有 ——
    // 屏幕上什么都不发生，控制台里多一条没人看的 unhandled rejection
    openFailed(path, e, () => void openPath(path, line, preview))
    return
  }
  openTab(doc.content, doc.path, doc.fingerprint, { preview })
  if (line) gotoLine(line)
}

/**
 * 跳到第 `n` 行（1 起，越界夹到首尾）。
 *
 * 走 `jumpTo` 而不是自己 dispatch —— 大纲 / `[TOC]` / ⌘+点击锚点走的都是它，
 * 于是「落点那一行先亮 550ms」这件事白拿，四条路的手感也不会各是各的
 */
function gotoLine(n: number): void {
  const doc = view.state.doc
  const line = doc.line(Math.min(Math.max(Math.trunc(n), 1), doc.lines))
  jumpTo(view, line.from)
  view.focus()
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
    } catch (e) {
      // 链接写错、文件被挪走、大小写对不上都落在这儿 —— 而「它在，只是不是 UTF-8」
      // 也落在这儿，从前一律报「找不到文件」，等于把一句说得清的话换成了一句错的
      openFailed(path, e, () => void openDocLink(path, slug))
      return
    }
    openTab(doc.content, doc.path, doc.fingerprint)
  }
  if (!slug) return
  // 锚点要在**目标文档**里找，所以必须等标签切过去之后再算
  const pos = anchorPos(view.state, slug)
  if (pos === null) {
    note(t('link.noAnchor', { slug }), { warn: true })
    return
  }
  jumpTo(view, pos)
}

// 编辑器扩展只知道「这条链接通向一份本地文档」，开标签与报错都得回到窗口这一层来做
// 顺着链接去另一份文档是一次明确的跳转（第八节 6）。整趟包起来记：从这一份的此刻，
// 到那一份的锚点 —— 里面那一下 jumpTo 由 `navDepth` 挡着，不另记一格
linkHost.openDoc = (path, slug) => void navigation(() => openDocLink(path, slug))
linkHost.note = note
// 0.4.1：⌘+点击 front matter 里的标签 = 拿它去搜整个工作区。**不建索引**，
// 走的就是 ⇧⌘F 那条路（见 editor/frontmatter.ts 里为什么只做到这一步）
tagHost.search = (tag, query) => {
  // 侧栏藏着的时候也得看得见结果（0.4.1 修）：搜索面板占的就是侧栏那块地方，
  // 不请回来的话面板开在一个 `display:none` 的子树里 —— 人点了一颗标签，
  // 除了状态栏那一句回执之外什么都没发生。**必须在 searchFor 之前**：
  // 它会给搜索框上焦点，而 display:none 的东西聚不上。
  // 没有工作区时不请（那时 searchFor 回 false）—— 不为一次落空的搜索弹侧栏
  if (sidebar.treeRoot && !sidebar.visible) toggleSidebar()
  // `regex` 开、`wholeWord` **明确关**：那条式子自带前后界（`(?<=[\[,\s])…`），
  // 而整词是在整条式子外面裹一对 `\b` —— 裹上之后 `c++`、`C#` 这类以非词字符
  // 收尾的标签一条都匹配不到（尾巴上的 `\b` 落在 `+` 与 `,` 之间，两边都不是词字符）。
  // 两个开关都是**这一次**的，不进他存着的偏好（见 `ui/file-search.ts` 的 `once`）
  if (sidebar.searchFor(query, { regex: true, wholeWord: false })) note(t('note.tagSearch', { tag }))
  else note(t('note.tagNoFolder'))
}

// ---------- 落盘（第八节 1：一条路 + 一份状态）----------

/**
 * 同一个标签的写盘**排队**，不并发。两种撞法都真会发生：连按两下 ⌘S，
 * 以及自动保存那一发正好压在人按的 ⌘S 上。两发同时冲向同一个路径时，
 * 后回来的那一发会拿**它自己那份字节**去认领 `savedDoc` —— 顺序一反，
 * 「已保存」就指到了旧内容上。串起来最省事，代价是零：写盘本来就是毫秒级的
 */
const writeQueue = new Map<number, Promise<void>>()

interface WriteOpts {
  /** 走另存为面板（总是要跑，哪怕文档此刻不脏） */
  as?: boolean
  /** 自动保存：不脏就不写，**上一次失败了也不写**（见 `writeOnce` 里那段） */
  auto?: boolean
  /** 冲突已经当面处理过了，别再拦（只有 `resolveConflict` 传它，见第八节 2） */
  force?: boolean
  /**
   * 越过那道闸之后**仍然要比的那一份**（契约 v36）。「保留我的」覆盖的是
   * **人在面板上看见的那一份磁盘内容** —— 从点下按钮到真写下去中间还有一句 await
   * （留版本历史），外面在这中间又改了一次的话，那一次谁都没看见过。
   * 不给 = 不比（另存为、重新创建一个已经不在的文件）
   */
  expect?: DiskExpectation | null
}

/** `Tab.lastSeen` → 发给壳的那一份（契约 v36）。没见过就回 null = 不比 */
function expectOf(seen: { text: string; fp: FileFingerprint } | undefined): DiskExpectation | null {
  return seen ? { text: seen.text, eol: seen.fp.eol, bom: seen.fp.bom } : null
}

/** 盘上这一份与「我们以为的那一份」一模一样吗（正文 + 指纹） */
function sameAsSeen(t: Tab, disk: DocPayload): boolean {
  const seen = t.lastSeen
  return (
    seen !== undefined &&
    seen.text === disk.content &&
    seen.fp.eol === disk.fingerprint.eol &&
    seen.fp.bom === disk.fingerprint.bom
  )
}

/**
 * 把一个标签写进盘里 —— **所有落盘路径的唯一入口**（⌘S · 另存为 · 自动保存 ·
 * 失败之后那颗「重试」）。
 *
 * **拿的是标签而不是「当前那个」**（第八节 1 的「异步边界」）：从前 `save()` 在
 * `await` **之后**才去问 `activeTab()`，而那一句 await 里可以发生任何事 ——
 * 另存为面板是模态的，人在面板开着的时候切了标签，回来那几句
 * `t.path = res.path` / `t.savedDoc = …` 就全落在**另一个标签**身上：
 * 它凭空拿到了别人的路径，而真正被写进盘的那一份还显示着「有修改」。
 */
function writeTab(t: Tab, opts: WriteOpts = {}): Promise<boolean> {
  const run = (writeQueue.get(t.id) ?? Promise.resolve()).then(() => writeOnce(t, opts))
  // 队列只管**排队**，不传播结果也不传播异常（否则一次失败会毒死这个标签后面每一次保存）
  writeQueue.set(
    t.id,
    run.then(
      () => undefined,
      () => undefined
    )
  )
  return run
}

async function writeOnce(t: Tab, opts: WriteOpts): Promise<boolean> {
  if (t.id === viewTabId) t.state = view.state
  // **冲突未决就不许覆盖**（第八节 2）。自动保存直接停下；人自己按的 ⌘S 不是一句
  // 「不行」就完了 —— 把差异摆出来，他真正想要的三条路都在那块面板上（其中「保留我的」
  // 会接着把这一次写下去）。从前没有这道闸：外面改了文件，两秒后的自动保存就盖掉了
  if (t.conflict && !opts.force) {
    if (!opts.auto) void openConflict(t)
    return false
  }
  // **盘上那个文件已经不在了**（别处删了 / 改名了 / 外接盘拔了）：自动保存这时候要是
  // 照写不误，`write(atomically:)` 会把它**原地复活** —— 人在 Finder 里删掉的东西
  // 两秒后自己回来了，而同步工具那边看到的是「又新建了一份」。人自己按的 ⌘S 照做
  //（那是一次明确的「我要把它写回去」），写成了就把这个状态摘掉
  if (t.missing && opts.auto) return false
  if (opts.auto) {
    if (!isTabDirty(t)) return true
    // **失败之后自动保存就停下**：磁盘满了、外接盘拔了这类毛病不会因为多试几次就好，
    // 而每两秒重试一次的唯一效果是把那句「保存失败」不停地重置一遍。停在这儿，
    // 状态栏上那颗「重试」就是唯一的出口 —— 人按一下，或者另存到别处去
    if (t.save.failure !== null) return false
  }
  // **这一次要写的是这一份**。下面 await 里人还能接着打字，那些字属于下一次 ——
  // 认领 `savedDoc` 时必须认这一份，认「此刻视图里那份」等于把没落盘的内容说成已保存
  const doc = t.state.doc
  const content = doc.toString()
  t.save.savingSince = Date.now()
  // **先记下来再清**：这一发要是被取消（另存为面板上点了「取消」），上一次那个失败
  // 还没解决，得原样挂回去 —— 不然「保存失败 · 重试 · 另存为…」会在人按了另存为、
  // 又改主意的那一下**整条消失**，退回一句轻飘飘的「未保存」
  const hadFailure = t.save.failure
  t.save.failure = null
  clearTimeout(savingTimer)
  savingTimer = window.setTimeout(renderSave, SAVING_AFTER)
  renderSave()
  let res: { path: string } | null = null
  try {
    // **写之前让壳自己比一次**（契约 v36）：`expect` 是我们以为盘上此刻的样子。
    // 另存为不比（目标是人现挑的），人在冲突面板上当面选过的那一次也不比（`force`）
    // 三条路：另存为不比（目标是人现挑的）；当面处理过冲突的那一次比**人看见的那一份**；
    // 其余一律比「我们以为盘上是什么」
    res = opts.as
      ? await window.api.saveAs(t.path, content, t.fp)
      : await window.api.save(
          t.path,
          content,
          t.fp,
          opts.force ? (opts.expect ?? null) : expectOf(t.lastSeen)
        )
  } catch (e) {
    // 盘上那份已经不是我们以为的那份了：**一个字节都没写**。走和外部变更完全同一条路
    // —— 读盘、比对、摆差异让人自己选。这是那条「监听有 300ms 合并窗、自动保存是 2 秒」
    // 的竞态唯一真正堵得住的地方（那时事件还没到，光等监听等不出冲突来）
    if (isStaleWrite(e) && t.path) {
      t.save.savingSince = null
      t.save.failure = hadFailure
      endWrite()
      await handleExternalChange(t.path)
      return false
    }
    // 壳侧 reject（写入失败：磁盘满 / 外接盘拔了 / 权限没了）。**记在标签上**，
    // 状态栏那一格会一直挂着它直到人处理 —— 一条 4 秒自散的回执配不上「文件没写进去」
    t.save.failure = e instanceof Error ? e.message : String(e)
    t.save.savingSince = null
    endWrite()
    return false
  }
  t.save.savingSince = null
  // 保存面板上点了取消：**不是失败**，但也不许把上一次那个未解决的失败擦掉
  if (!res) {
    t.save.failure = hadFailure
    endWrite()
    return false
  }
  const was = t.path
  t.path = res.path
  syncTabDir(t)
  // 第八节 10：另存到了别的目录 —— 相对路径跟着文档走，查一下这一挪弄坏了哪几条
  if (opts.as && was && dirname(was) !== dirname(res.path)) void checkMoved(was, res.path, 'saveAs')
  t.savedDoc = doc
  t.lastSeen = { text: content, fp: { ...t.fp } }
  // 写成了：`missing` 与那颗 ⚠ 一起摘掉 —— 「重新创建」之后标签上还挂着
  // 「此标签的未保存改动已过期」是一句过期的话
  delete t.missing
  t.stale = false
  if (t.scratchId) {
    void window.api.scratchClear(t.scratchId)
    t.scratchId = undefined
  }
  t.save.savedAt = Date.now()
  // 活动标签刚在面板里拿到路径的话，`docPath` 也得跟上（状态栏与壳侧的标题读它）。
  // **要现问一次 activeId** —— 面板开着的那段时间里人可能已经切走了
  if (t.id === activeId) docPath = t.path
  // 另存为是一个明确的决定：存成了一份新文件就是要接着用它，预览就此转正
  if (opts.as) keepTab(t.id)
  endWrite()
  syncStatus(true)
  void keepSnapshot(res.path, content)
  return true
}

/** 一次写盘收尾：把那句「正在保存…」的延时闸撤掉，再照新状态重画一次 */
function endWrite(): void {
  clearTimeout(savingTimer)
  renderSave()
}

/**
 * 0.2.0 版本历史：每次**写进真实路径**之后留一份快照（契约 v22）。
 *
 * 去重、留存上限、目录管理全在壳侧 —— 这里只发一次请求，失败了也不打扰用户：
 * 历史是安全网，不是保存的一部分，它出问题不该让「刚才那次保存成功了吗」变得可疑。
 */
async function keepSnapshot(path: string, content: string): Promise<boolean> {
  try {
    // 回的是「真写了一份没有」：内容与最新那份一样时壳会去重（回 false），
    // 那也算留住了 —— 那一份就在历史里。只有**写坏了**才该让调用方知道
    await window.api.snapshotSave(path, content)
    return true
  } catch {
    /* 历史写不下：保存本身已经成功，平时不打扰用户（见下面冲突那条路的例外） */
    return false
  }
}

/** 「正在保存…」那句话的延时闸（见 `save-state.ts` 的 SAVING_AFTER）。多数时候它一次都不响 */
let savingTimer: number | undefined

/** 上一次画出去的那句话的指纹（标签 + 状态 + 时刻/原因）。一样就不重画 */
let lastSaveSig = ''

/**
 * 状态栏右下角那一格（第八节 1）。**读的是活动标签自己那份状态** ——
 * 切一下标签就换一句话，因为「存没存」本来就是每份文档各自的事。
 *
 * 四种说法：没修改也没落过盘 → 一个字都不说（`:empty` 整格让出去，同缩放那格的规矩）；
 * 有修改 → 「未保存」；慢过门槛的写盘 → 「正在保存…」；失败 → 黄色的「保存失败」
 * **外加两颗按钮，而且不会自己消失**。语言切换时也走这儿（时刻记着，文案现取）。
 */
function renderSave(): void {
  const cur = activeTab()
  const lab = saveLabel(
    cur?.save ?? newSaveStatus(),
    cur ? isTabDirty(cur) : false,
    Date.now(),
    cur?.conflict ? 'conflict' : cur?.missing ? 'missing' : undefined
  )
  // **没变就一个字节都不动**：这条挂在 `syncStatus` 上，于是每敲一个键都会来一次，
  // 而九成九的相邻两次说的是同一句话。语言切换那条路自己会先把它作废（见 onLangChange）
  const sig = `${cur?.id ?? -1}|${lab.kind}|${'at' in lab ? lab.at : ''}|${'reason' in lab ? lab.reason : ''}`
  if (sig === lastSaveSig) return
  lastSaveSig = sig
  elSaved.classList.toggle(
    'is-warn',
    lab.kind === 'failed' || lab.kind === 'conflict' || lab.kind === 'missing'
  )
  elSaved.title = ''
  switch (lab.kind) {
    case 'none':
      elSaved.replaceChildren()
      break
    case 'dirty':
      elSaved.textContent = t('status.unsaved')
      break
    case 'missing': {
      // 文件没了：自动保存已经停下（不然它会把人家刚删掉的东西原地复活）。
      // 两个出口 —— 「另存为…」把手上这份挪到别处，「重新创建」明确把它写回原路径
      const tab = cur!
      elSaved.replaceChildren(
        document.createTextNode(t('status.missing')),
        ' ',
        saveAct(t('cmd.saveAs'), () => void writeTab(tab, { as: true })),
        ' ',
        // **带 force**：文件不在了，比对必然不过（契约 v36 收紧之后「不在」也算对不上）
        // —— 而这一下正是人明确说「我要把它写回去」
        saveAct(t('status.recreate'), () => void writeTab(tab, { force: true }))
      )
      break
    }
    case 'conflict': {
      // 冲突挂着 = 这个文件一个字节都没在往下写。那颗「查看差异」是唯一的出口，
      // 所以它**不自己消失**（同「保存失败」那一格）—— 关掉面板不等于解决
      const tab = cur!
      elSaved.replaceChildren(
        document.createTextNode(t('status.conflict')),
        ' ',
        saveAct(t('status.viewDiff'), () => void openConflict(tab))
      )
      break
    }
    case 'saving':
      elSaved.textContent = t('status.saving')
      break
    case 'saved': {
      const time = new Date(lab.at).toLocaleTimeString(localeOf(), {
        hour: '2-digit',
        minute: '2-digit'
      })
      elSaved.textContent = t('status.saved', { time })
      break
    }
    case 'failed': {
      // 原因（壳侧那句「写入失败：…」）挂在 title 上：状态栏只有一行，把系统那句
      // 长错误摊在这儿会把右边整排读数挤出窗口，而它对人的第一价值是「出事了」，
      // 第二才是「为什么」
      elSaved.title = lab.reason
      const tab = cur!
      elSaved.replaceChildren(
        document.createTextNode(t('status.saveFailed')),
        ' ',
        saveAct(t('status.retry'), () => void writeTab(tab)),
        ' ',
        saveAct(t('cmd.saveAs'), () => void writeTab(tab, { as: true }))
      )
      break
    }
  }
}

/** 「保存失败」后面那两颗按钮。长得与状态栏回执上那颗一样（`.note-act`，像链接不像按钮） */
function saveAct(label: string, run: () => void): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'note-act'
  btn.textContent = label
  btn.addEventListener('click', run)
  return btn
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
    const state = t.id === activeId ? view.state : t.state
    out.push({
      path: t.path,
      scroll: t.id === activeId ? view.scrollDOM.scrollTop : t.scroll,
      cursor: state.selection.main.head,
      // 只读跟着会话走（第八节 5）：关掉再开，参考文档还该是锁着的
      ...(state.readOnly ? { readOnly: true as const } : {}),
      // 预览也跟着走：关掉再开，那一格还是那一格，下一次单击照样顶掉它
      ...(t.preview ? { preview: true as const } : {})
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
  // **基线在第一个 await 之前就记下**：下面问工作区根是一趟 IPC 往返，读会话是一次
  // localStorage —— 这段时间编辑器已经装着文档、也已经有焦点了，人完全可能正在打字。
  // 记晚一步，那几个字就被算进基线里，末尾照样把他拽走（0.4.1 修的第三版）
  const editsBefore = docEdits
  const actsBefore = activations
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
  /**
   * 恢复**自己**激活过几次。接管启动空白页那一次会当场 `activate`，至多发生一次
   * （空白标签只有一个）—— 末尾拿总数减掉它，剩下的就是人自己切的
   */
  let selfActs = 0
  for (const path of plan.open) {
    const doc = await window.api.read(path).catch(() => null)
    if (!doc) continue // 文件没了（改名 / 删了 / 外接盘没挂）就跳过这一条
    const st = where.get(path)
    const tab = spawnTab(
      createState(doc.content, listener, {
        dir: dirname(doc.path),
        sourceMode,
        // 光标要在**建 state 的时候**就给：建完再 update 一次的话，「光标落在表里」
        // 这件事已经错过了 adoptTableAtCursor，那张表会以管道符源码的样子开门。
        // 光标夹回文档里由 createState 做：磁盘上这份文件可能在上次之后被别的程序改短了
        cursor: st?.cursor,
        readOnly: st?.readOnly === true
      }),
      doc.path,
      doc.fingerprint,
      false,
      // 恢复期间人可能已经单击开了一个预览：那一格归他，恢复出来的这份就当普通标签 ——
      // 一个窗口只有一格预览，背景行为也不许顶掉人刚点开的东西（同 `restoreFocus` 的规矩）
      st?.preview === true && !tabs.some((x) => x.preview),
      // 滚动位置也在这儿给：第一份文件会就地接管启动那个空白标签并**当场**进视图，
      // 返回之后再写 `tab.scroll` 就晚了一步（那次 activate 已经把视图滚到 0）
      st?.scroll ?? 0
    )
    // 恢复出来的这些同样要记下「盘上是什么」（契约 v36），否则它们第一次自动保存不比对
    tab.lastSeen = { text: doc.content, fp: { ...doc.fingerprint } }
    // 接管空白页那一次会当场 activate；别的都开在背景里，不动活动标签
    if (tab.id === activeId) selfActs += 1
  }
  // 落点：启动那份文档优先，其次是会话里的活动标签，再不行就手上还剩的最后一个
  const target = plan.focus ? tabs.find((t) => t.path === plan.focus)?.id : undefined
  const focus = keep ?? target ?? (tabs.length ? tabs[tabs.length - 1]!.id : null)
  // **这段时间里人可能已经动过手了**（0.4.1 修）：读文件是异步的，每读一个让出一次
  // 事件循环，而第一份文件在第一轮就接管了空白标签、进了视图。要不要切、切到哪儿归
  // `restoreFocus` 判断（三种错法都写在它那儿）。这里只负责把两个**抹不平**的信号
  // 交给它：打过字（计数只增不减）、换过标签（活动标签已经不是恢复摆的那个了）。
  // 拿「`tab.state` 与视图里那份一不一样」当信号是不行的 —— 自动保存与切标签都会
  // 把两者重新同步，人打过的字于是不算数
  const next = restoreFocus({
    focus: focus !== null && tabs.some((t) => t.id === focus) ? focus : null,
    active: activeId,
    typed: docEdits !== editsBefore,
    // 总激活次数减掉恢复自己那次 —— 多出来的每一次都是人自己点的
    moved: activations - actsBefore > selfActs
  })
  if (next !== null) activate(next)
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

/**
 * 静默落盘一个标签：有路径走 `writeTab`（与 ⌘S 同一条路，于是状态与失败处理只有一份），
 * 无路径进 scratch。
 *
 * **scratch 写坏了也要说话**（第八节 1）：从前那句 `await` 裸着，磁盘满的时候只是在
 * 控制台留一条没人看的 unhandled rejection —— 而对一份还没落过盘的草稿来说，
 * scratch 就是它此刻**唯一**的副本。同样记成一次保存失败，状态栏那颗「另存为…」
 * 正是这时候该按的那一颗。
 */
async function flushTabAutosave(t: Tab): Promise<void> {
  if (t.id === viewTabId) t.state = view.state
  if (!isTabDirty(t)) return
  if (t.path) {
    await writeTab(t, { auto: true })
    return
  }
  if (t.save.failure !== null) return
  t.scratchId ??= `tab-${Date.now()}-${t.id}`
  try {
    await window.api.scratchSave(t.scratchId, t.state.doc.toString(), t.fp)
  } catch (e) {
    t.save.failure = e instanceof Error ? e.message : String(e)
    renderSave()
  }
}

async function flushAutosave(): Promise<void> {
  const t = activeTab()
  if (t) await flushTabAutosave(t)
}

// 菜单是整个应用一份，勾与亮灭却是**每个窗口**各自的（侧栏开没开、活动标签只不只读、
// 有没有可后退的）。窗口一拿到焦点就把自己那份推过去，否则菜单上挂着的是上一个窗口的状态
window.addEventListener('focus', () => syncViewFlags())

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
  return (await exportHtmlDoc()).html
}

/** 整份导出 HTML，连同画不出来的那几张图表（导出前体检要报它们，第八节 12） */
function exportHtmlDoc(): Promise<HtmlExport> {
  const t = activeTab()
  return exportHtmlDocument(
    view.state,
    {
      dir: t?.path ? dirname(t.path) : null,
      title: exportStem()
    },
    // 排版跟随此刻的设置（0.2.x）。在这之前设置面板里的字号/行距/字族/栏宽只写进
    // 编辑器的 `--body-*`，导出这条路一直用钉死的默认值 —— 屏幕上 18px 无衬线、
    // 导出物 16px 衬线，是「所见即所得」最后漏掉的一处。
    // **只有导出 HTML / PDF 两条路跟**，复制为富文本不跟（见 `copyAsHtml`）
    prefs.values
  )
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
 * 「有选区就只出选区」那条判断的**唯一一份**（复制为富文本 0.2.0 / 导出长图 0.3.0 共用）。
 *
 * 选区那半把选中的 Markdown 现造一个 EditorState 再渲染 —— 导出那条路本来就只认 state，
 * 于是「整份」与「一段」共用同一个渲染器，没有第二套局部渲染
 * （P4-1 那条「根本不写第二个解析器」的原则在这里同样成立）。
 *
 * `type` 传不传是两条路各自的取舍：**导出物跟随排版设置，剪贴板不跟**
 * （见 `copyAsHtml` 的注释）。
 */
async function exportSelectionOrAll(type?: Typography): Promise<{
  html: string
  md: string
  /** 拿去渲染的那份 state：整份就是视图里那份，选区是现造的（从 0 起） */
  state: EditorState
  /** 那份 state 的 0 在正文里的位置（体检的结果要挪回正文里才跳得过去） */
  offset: number
  /** 画不出来的图表（位置在 `state` 里） */
  failed: number[]
}> {
  const sel = view.state.selection.main
  const tab = activeTab()
  const dir = tab?.path ? dirname(tab.path) : null
  const md = sel.empty ? view.state.doc.toString() : view.state.sliceDoc(sel.from, sel.to)
  const state = sel.empty
    ? view.state
    : EditorState.create({ doc: md, extensions: [cursiveMarkdown()] })
  const doc = await exportHtmlDocument(state, { dir, title: exportStem() }, type)
  return { html: doc.html, md, state, offset: sel.empty ? 0 : sel.from, failed: doc.failed }
}

/**
 * 导出前体检（第八节 12，契约 v40）：缺失的本地图片 + 画不出来的 mermaid 图表。
 * 回一排「选中就跳到源码」的条目（导出就此作罢）；`offset` 把选区那份现造 state 里的位置挪回正文
 */
async function exportProblems(state: EditorState, offset: number, failed: number[]): Promise<PaletteItem[]> {
  const tab = activeTab()
  // 选区那份 state 是现造的、不带 `docDir`：目录一律取视图里这份文档的
  const report = await checkRefs(state, view.state.facet(docDir), tab?.path ?? null, refHost)
  const rows: { label: string; why: string; from: number; to: number }[] = report.problems
    .filter((p) => p.kind === 'image')
    .map((p) => ({ label: p.dest, why: t(refReason(p)), from: p.from + offset, to: p.to + offset }))
  for (const at of failed) {
    const line = view.state.doc.lineAt(at + offset)
    rows.push({ label: line.text.trim() || 'mermaid', why: t('export.why.diagram'), from: line.from, to: line.to })
  }
  rows.sort((a, b) => a.from - b.from)
  const doc = view.state.doc
  return rows.map((r) => ({
    label: r.label,
    hint: t('refs.where', { line: doc.lineAt(r.from).number, why: r.why }),
    key: `${r.label} ${r.why}`,
    run: () => {
      if (view.state.doc !== doc) return
      view.focus()
      jumpTo(view, r.from, r.to)
    }
  }))
}

/**
 * 弹保存面板之前问一句（第八节 12）：`lead` 是几条出路（照样导出 / 分成几张……），
 * 下面跟着 `problems`。回人选的那条出路的 `id`；选了某一处问题（去看看）、Esc、点遮罩都是 null
 */
function askBeforeExport(
  lead: { id: string; label: string }[],
  problems: PaletteItem[],
  placeholder: string
): Promise<string | null> {
  return new Promise((resolve) => {
    const items: PaletteItem[] = [
      ...lead.map((l) => ({ label: l.label, run: () => resolve(l.id) })),
      ...problems.map((p) => ({
        ...p,
        run: (q: string) => {
          resolve(null)
          return p.run(q)
        }
      }))
    ]
    palette.open(items, placeholder, 'refs.noMatch', undefined, () => resolve(null))
  })
}

/** 体检一遍：没问题直接放行；有问题就问一句，人选了「照样导出」才放行 */
async function passCheck(state: EditorState, offset: number, failed: number[]): Promise<boolean> {
  const problems = await exportProblems(state, offset, failed)
  if (!problems.length) return true
  const pick = await askBeforeExport([{ id: 'go', label: t('export.anyway') }], problems,
    t('export.issues', { n: problems.length }))
  return pick === 'go'
}

/**
 * 0.3.0 T3 导出为长图（契约 v28）。
 *
 * 进壳的是**同一份导出 HTML**（三条导出的长相必须永远一致），壳那边离屏渲染 + 快门。
 * 宽度 = 正文栏宽：导出 CSS 的 `--column` 是 rem，而导出物的根字号就是浏览器默认的
 * 16px —— 这条耦合有 E2E 守着（成图宽度必须正好是它的 2 倍）。
 */
/** 长图的上限与倍率（与壳侧 `PNG_MAX_HEIGHT_PX` / `PNG_SCALE` 同一组数） */
const PNG_MAX_PX = 32768
const PNG_SCALE = 2

/**
 * 导出在**渲染层这一侧**断了（第八节 4）。壳那一侧的失败自己会弹 NSAlert（写不进去、
 * 没权限、打印任务没出文件），这里管的是它够不到的那一半：正文还没交出去就抛了。
 *
 * 不自散 + 一颗「重试」：导出的东西十有八九是要马上发给别人的，
 * 一条 4 秒的提示与「什么都没发生」在人走开倒杯水之后是同一件事。
 */
function exportFailed(e: unknown, retry: () => void): void {
  note(t('note.exportFailed', { reason: e instanceof Error ? e.message : String(e) }), {
    warn: true,
    sticky: true,
    action: { label: t('status.retry'), run: retry }
  })
}

async function exportPng(): Promise<void> {
  const { html, state, offset, failed } = await exportSelectionOrAll(prefs.values)
  const width = Math.round(prefs.values.column * 16)
  // 第八节 12：**弹保存面板之前**就知道会不会超过上限（壳离屏排一遍量出来），
  // 而不是截完了才说「这张图是残的」
  const [problems, size] = await Promise.all([
    exportProblems(state, offset, failed),
    window.api.measurePng(html, width)
  ])
  const tall = size.height * PNG_SCALE > PNG_MAX_PX
  let split = false
  if (tall || problems.length) {
    const lead = tall
      ? [
          { id: 'split', label: t('export.split', { n: size.parts }) },
          { id: 'narrow', label: t('export.narrow') },
          { id: 'go', label: t('export.clip') }
        ]
      : [{ id: 'go', label: t('export.anyway') }]
    const placeholder = tall
      ? t('export.tooTall', { h: Math.round(size.height * PNG_SCALE) })
      : t('export.issues', { n: problems.length })
    const pick = await askBeforeExport(lead, problems, placeholder)
    if (pick === 'narrow') note(t('export.narrowHint'))
    if (pick !== 'go' && pick !== 'split') return
    split = pick === 'split'
  }
  const out = await window.api.exportPng(html, `${exportStem()}.png`, width, split)
  if (!out) return   // 保存面板点了取消
  if (out.parts) {
    note(t('note.exportedPngParts', { n: out.parts.length, name: basename(out.path) }), {
      action: { label: t('note.reveal'), run: () => window.api.revealInFinder(out.path) }
    })
    return
  }
  const name = basename(out.path)
  const [w, h] = out.pixels
  // 截断了要说清楚**这张图是残的**：一张「看起来完整」的残图比一条报错难发现得多
  note(
    out.clipped ? t('note.pngClipped', { name, h }) : t('note.exportedPng', { name, w, h }),
    {
      warn: out.clipped,
      action: { label: t('note.reveal'), run: () => window.api.revealInFinder(out.path) }
    }
  )
}

/**
 * 0.2.0 复制为富文本（契约 v20）。
 *
 * **有选区就只复制选区**：把选中的那段 Markdown 现造一个 EditorState 渲染 ——
 * 导出那条路本来就只认 state，于是「整份」和「一段」共用同一个渲染器，
 * 没有第二套局部渲染逻辑（P4-1 那条「根本不写第二个解析器」的原则在这里同样成立）。
 *
 * 剪贴板上放两种风味：`.html` 给邮件 / 飞书 / Notion，纯文本给终端 / 代码框。
 *
 * **排版有意不跟当前设置**（导出 HTML / PDF 那两条路跟，见 `exportHtmlSource`）：
 * 粘贴的目的地有它自己的正文样式，带一个 20px 过去，粘进邮件正文里就是一段
 * 比周围都大的字。字族/字号这种「我这台机器上看着舒服」的设定不该跟着剪贴板走。
 */
async function copyAsHtml(): Promise<void> {
  const { html, md } = await exportSelectionOrAll()
  await window.api.copyHtml(html, md)
  // 剪贴板这条路**看不见任何变化**：不说一句的话，「刚才那下到底复制上了没有」
  // 只能靠去别处粘一下才知道
  note(t('note.copiedHtml'))
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
    // 只读（第八节 5）：回滚是一次整份替换，落不进文档 —— 先说清楚，别接着报「已回到这个版本」
    if (view.state.readOnly) {
      readOnlyHost.blocked?.()
      return
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      userEvent: 'input.restore'
    })
    view.focus()
    // 整份文档刚被换掉，而这是一次**普通编辑** —— 把「⌘Z 能撤回」这件事说出来，
    // 否则回滚看起来像一条单行道
    note(t('note.rolledBack'))
  })
  await historyPanel.open(activeTab()?.path ?? null, view.state.doc.toString())
}

/**
 * 第八节 8：检查引用。只查活动标签这一份（检查器本身见 `editor/ref-check.ts`），
 * 找不到的借命令面板那个浮层列出来 —— 输入筛选、上下选、Esc 关、焦点归还都是现成的 ——
 * 回车跳到源码并选中那段地址。
 *
 * 查是异步的（问壳、读被链接的文档）。查完发现换了标签、或者文档已经变了，清单上的位置
 * 就对不上了：作废，说一句请人再查一次，而不是跳到错的地方去。
 */
async function checkReferences(): Promise<void> {
  const tab = activeTab()
  const state = view.state
  const report = await checkRefs(state, state.facet(docDir), tab?.path ?? null, refHost)
  if (activeTab() !== tab || view.state.doc !== state.doc) {
    note(t('refs.stale'), { warn: true })
    return
  }
  const tail = report.unsaved ? t('refs.unsaved', { n: report.unsaved }) : ''
  if (!report.problems.length) {
    note((report.checked ? t('refs.allGood', { n: report.checked }) : t('refs.none')) + tail)
    return
  }
  const items: PaletteItem[] = report.problems.map((p) => {
    const why = t(refReason(p))
    return {
      label: p.dest,
      hint: t('refs.where', { line: p.line, why }),
      // 「为什么」也参与筛选：打「图片」就只剩图片那几条
      key: `${p.dest} ${why}`,
      run: () => {
        if (view.state.doc !== state.doc) {
          note(t('refs.stale'), { warn: true })
          return
        }
        // 面板关掉时焦点还给开它之前的那个元素 —— 从文件树里开的话那是文件树，
        // 而选中那段地址要编辑器拿着焦点才看得见
        view.focus()
        jumpTo(view, p.from, p.to)
      }
    }
  })
  palette.open(items, t('refs.placeholder', { n: report.problems.length }) + tail, 'refs.noMatch')
}

function refReason(p: RefProblem): Key {
  if (p.reason === 'noAnchor') return 'refs.why.anchor'
  if (p.reason === 'folder') return 'refs.why.folder'
  if (p.reason === 'unreadable') return 'refs.why.unreadable'
  return p.kind === 'image' ? 'refs.why.image' : p.kind === 'doc' ? 'refs.why.doc' : 'refs.why.file'
}

/**
 * 一份本地文档此刻的正文：开着标签的用标签里那份（可能还没存，人看见的是它），
 * 否则读盘；读不出来（不在、不是 UTF-8、没权限）回 null
 */
async function liveText(path: string): Promise<string | null> {
  const open = tabs.find((x) => x.path === path)
  if (open) return (open.id === viewTabId ? view.state : open.state).doc.toString()
  try {
    return (await window.api.read(path)).content
  } catch {
    return null
  }
}

/** 检查器问壳的那两件事 */
const refHost: RefHost = {
  stat: (paths) => window.api.statPaths(paths),
  text: liveText
}

/**
 * 标签的路径变了（另存为、文件树里改名 / 拖走），它那份 state 里的 `docDir` 跟着换
 * （第八节 10，见 `editor/setup.ts` 的 `dirConf`）。视图里装着它就对视图派，否则改它冻结的那份
 */
function syncTabDir(t: Tab): void {
  const dir = t.path ? dirname(t.path) ?? '/' : null
  if (t.id === viewTabId) {
    if (view.state.facet(docDir) !== dir) view.dispatch({ effects: dirEffect(dir) })
  } else if (t.state.facet(docDir) !== dir) {
    t.state = t.state.update({ effects: dirEffect(dir) }).state
  }
}

/**
 * 第八节 10：文档换了位置之后，这一挪弄坏了哪几条引用（`brokenBy`：同一份正文按旧位置、
 * 新位置各查一次）。挪的可能是一份文档，也可能是整个文件夹 —— 后者只查**开着的**那几份：
 * 夹里没开的文档要一份份读盘，那是「维护全工作区引用」的形状，有意不做。
 * 坏了就在状态栏说一句、给一颗「查看」；**不复制资源、不改链接**，那是人看过清单之后的事。
 * 这句话**不自己消失**：引用坏了不会自己好，人多半正看着文件树，回头时它还得在
 */
async function checkMoved(from: string, to: string, via: 'move' | 'saveAs'): Promise<void> {
  const docs: { before: string; after: string; state: EditorState }[] = []
  for (const x of tabs) {
    if (!x.path || (x.path !== to && !x.path.startsWith(`${to}/`))) continue
    docs.push({
      before: from + x.path.slice(to.length),
      after: x.path,
      state: x.id === viewTabId ? view.state : x.state
    })
  }
  if (!docs.some((d) => d.after === to) && isDocPath(to)) {
    const text = await liveText(to)
    if (text !== null) {
      docs.push({ before: from, after: to, state: EditorState.create({ doc: text, extensions: [cursiveMarkdown()] }) })
    }
  }
  let total = 0
  const hit: string[] = []
  for (const d of docs) {
    const broke = await brokenBy(
      d.state,
      { dir: dirname(d.before) ?? '/', path: d.before },
      { dir: dirname(d.after) ?? '/', path: d.after },
      refHost
    )
    if (!broke.length) continue
    total += broke.length
    hit.push(d.after)
  }
  const first = hit[0]
  if (!first) return
  const message =
    via === 'saveAs'
      ? t('refs.savedAs', { n: total })
      : hit.length > 1
        ? t('refs.movedMany', { docs: hit.length, n: total })
        : t('refs.moved', { name: basename(first).replace(/\.(md|markdown)$/i, ''), n: total })
  note(message, { warn: true, sticky: true, action: { label: t('refs.view'), run: () => void showRefsOf(first) } })
}

/** 「查看」：那份文档不是当前这份就先开过来，再把清单摆出来 */
async function showRefsOf(path: string): Promise<void> {
  if (docPath !== path) await navigation(() => openPath(path))
  if (docPath === path) await checkReferences()
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
      // `query` 是选中那一刻输入框里的原串：`readme:120` 的 `:120` 在这儿兑现
      run: (query) => void navigation(() => openPath(path, parseGoto(query)?.line))
    }
  })
  palette.open(items, t('pl.filePlaceholder'), 'pl.noFile', quickOpenQuery)
}

/**
 * ⌘T 的查询预处理（0.2.x「跳到行」）。
 *
 * - `readme:120` —— `:120` 摘掉不参与匹配（没有哪个文件名里有它，一打冒号整排结果就空），
 *   行号由被选中的那条文件条目自己从原串里取；
 * - `:120` —— 没写文件名 = 在**当前文档**里跳，于是只列这一条：底下再跟一整排文件只会碍事。
 */
function quickOpenQuery(raw: string): PaletteQuery {
  const goto = parseGoto(raw)
  if (!goto) return { query: raw }
  if (goto.name) return { query: goto.name }
  const here = activeTab()
  return {
    query: '',
    only: true,
    items: [
      {
        label: t('pl.gotoLine', { n: goto.line }),
        hint: here?.path ? basename(here.path) : t('app.untitled'),
        run: () => gotoLine(goto.line)
      }
    ]
  }
}

async function handleMenu(action: MenuAction): Promise<void> {
  switch (action) {
    case 'fmt:latex-format': {
      // 只读（第八节 5）说一声：这条命令不经过那道 changeFilter 就先自己退了（latexFormatSpec
      // 认 readOnly），不说的话就是「点了没反应」
      if (view.state.readOnly) {
        readOnlyHost.blocked?.()
        break
      }
      if (view.composing) break
      const state = view.state
      const tabId = activeId
      const katex = await loadKatex()
      if (activeId !== tabId || !view.state.doc.eq(state.doc)
        || !view.state.selection.eq(state.selection) || view.composing || view.state.readOnly) {
        note(t('latex.changed'))
        break
      }
      const result = latexFormatSpec(view.state, katex)
      if (result.spec) {
        view.dispatch(result.spec)
        focusKeepScroll(view)
      }
      note(result.skipped ? t('latex.skipped', { n: result.changed, skipped: result.skipped })
        : result.changed ? t('latex.done', { n: result.changed })
        : t(result.found ? 'latex.unchanged' : 'latex.empty'), { warn: result.skipped > 0 })
      break
    }
    case 'file:new':
      newUntitledTab()
      break
    case 'file:open': {
      // 契约 v36：**取消与打不开不是一回事**。从前两条都回 null，于是从菜单选一个
      // GBK 文件、或者一个没权限的文件，屏幕上什么都不会发生
      let doc: DocPayload | null
      try {
        doc = await window.api.openDialog()
      } catch (e) {
        // 路径只有那句话里有（文件是人在原生面板里挑的）—— 有它才给得出「重试」
        const p = readFailPath(e)
        openFailed(p, e, p ? () => void openPath(p) : undefined)
        break
      }
      if (doc) openTab(doc.content, doc.path, doc.fingerprint)
      break
    }
    case 'file:save': {
      // **先把标签拿在手上**：底下那句 await 里人可以切标签、可以接着打字
      const cur = activeTab()
      if (cur) await writeTab(cur)
      break
    }
    case 'file:save-as': {
      const cur = activeTab()
      if (cur) await writeTab(cur, { as: true })
      break
    }
    case 'file:close-tab':
      await closeTab(activeId)
      break
    case 'file:reopen-closed-tab':
      await reopenClosedTab()
      break
    case 'go:back':
      await goBack()
      break
    case 'go:forward':
      await goForward()
      break
    case 'view:toggle-read-only':
      setReadOnly(activeId, !view.state.readOnly)
      break
    case 'file:next-tab':
      cycleTab(1)
      break
    case 'file:prev-tab':
      cycleTab(-1)
      break
    case 'file:save-and-close': {
      // 关窗语义：所有脏标签都落盘；任何一个被取消就中止关闭。
      // 循环本身在 `ui/closing.ts`（提出去是为了能测那三件时序上的事）
      const cur = activeTab()
      if (cur && cur.id === viewTabId) cur.state = view.state
      // **关窗这条路同样不许绕过冲突闸**（2026-09-22 修）：它走的是 `saveDirtyTabs`
      // → `window.api.save`，不经过 `writeOnce` 里那道闸 —— 于是「冲突选了稍后再说 →
      // 关窗 → 保存」会把外面那份**一声不响地**盖掉，而人从头到尾没见过差异。
      // 有未决冲突就先把它摆出来，这一次关窗到此为止（同「任何一个被取消就中止整批」）
      const blocked = tabs.find((x) => x.conflict && isTabDirty(x))
      if (blocked) {
        if (blocked.id !== activeId) activate(blocked.id)
        await openConflict(blocked)
        syncStatus(true)
        return
      }
      let done = false
      /**
       * 这一次交给壳去写的**是哪一份字节**（第八节 1）。从前 `onSaved` 里那句
       * `tb.savedDoc = tb.state.doc` 读的是 await **之后**的文档 —— 无标题标签的
       * 保存面板是模态的，在它开着的时候人还能回到别的标签接着打字，那些字于是
       * 被算进了「已经写进盘里的那一份」。认下面这份就不会：它是发出去的那一份
       */
      const written = new Map<number, Text>()
      /** 正在写的是谁：壳侧 reject 时异常里没有这个信息，而失败要记在标签上 */
      let inFlight: Tab | null = null
      try {
        done = await saveDirtyTabs(
          tabs.filter((x) => isTabDirty(x)),
          {
            // 这条路同样比一次（契约 v36）：关窗前那一刻外面改了文件，照写就是覆盖。
            // 上面那道闸挡的是**已经知道**的冲突，这一句挡的是**刚刚才发生**的
            save: (p, content, fp) =>
              window.api.save(p, content, fp, expectOf(tabs.find((x) => x.path === p)?.lastSeen)),
            scratchClear: (id) => void window.api.scratchClear(id)
          },
          (tb) => {
            inFlight = tb
            written.set(tb.id, tb.state.doc)
            return tb.state.doc.toString()
          },
          (tb, path) => {
            inFlight = null
            const doc = written.get(tb.id) ?? tb.state.doc
            tb.savedDoc = doc
            tb.lastSeen = { text: doc.toString(), fp: { ...tb.fp } }
            tb.save.savedAt = Date.now()
            tb.save.failure = null
            // 活动标签要是刚在保存面板里拿到路径，`docPath` 也得跟上 ——
            // 下一句 syncStatus 报的就是它
            if (tb.id === activeId) docPath = path
            // 写进真实路径就留一份快照（契约 v22，同 `writeTab` 与自动保存那两条路）
            void keepSnapshot(path, doc.toString())
          }
        )
      } catch (e) {
        const tb = inFlight as Tab | null
        // **拒写不是写坏了**（契约 v36）：外面刚刚改了这个文件，壳一个字节都没写。
        // 上面那道闸挡的是**已经知道**的冲突，这儿接住的是**刚刚才发生**的那一种 ——
        // 当成「保存失败」就等于把差异藏起来，而人正要关窗，这是最后一次看见它的机会
        if (isStaleWrite(e) && tb?.path) {
          await handleExternalChange(tb.path)
          return // done 还是 false：窗口留着，那条 finally 会把脏状态同步回去
        }
        // 真写坏了：**记在那一个标签上**，状态栏挂着「保存失败 · 重试 · 另存为…」
        // 不自己消失。异常照旧往上抛（不吞）
        if (tb) tb.save.failure = e instanceof Error ? e.message : String(e)
        throw e
      } finally {
        // **没存完就一定要重新同步脏状态**：壳侧那个 dirty 是一个全局位，前面几次
        // 成功保存已经把它清零了（`main.swift` 的 save 分支）—— 不同步的话，下一次
        // 关窗 `windowShouldClose` 直接放行，剩下那几个标签的改动一声不响地没了。
        // **走 finally 而不是 `if (!done)`**：取消（`save` 回 null）只是两条路里的一条，
        // 另一条是**写盘失败**（壳侧 reject：磁盘满、外接盘拔了、权限没了）——
        // 那时 `await` 直接抛出去，`if` 那一支根本执行不到，而壳那边已经是「干净」了。
        // 异常照旧往上抛（不吞），控制台要看得见是哪一份写坏了。
        // 「已保存 HH:MM」现在归标签自己管（`tb.save.savedAt` 在 onSaved 里记），
        // 所以这儿只要把脏状态同步回去 —— 没存成的那几个照旧显示「未保存」
        if (!done) syncStatus(true)
      }
      if (!done) return
      window.api.confirmClose()
      break
    }
    case 'file:open-folder':
      await openFolder()
      break
    case 'file:export-html': {
      // 壳那一侧的失败（写不进去、没权限）自己会弹 NSAlert；**渲染层这一侧断了的话
      // 从前一个字都没有** —— 正文渲染里抛一次（mermaid、KaTeX、一条坏图）就是
      // 「点了导出，什么都没发生」。第八节 4：说清楚，并且给一颗重试
      let out: { path: string } | null
      try {
        // 第八节 12：先体检（缺失的图、画不出来的图表），人放行了再弹保存面板。
        // 体检用的就是这一份 HTML，不为它再渲一遍
        const doc = await exportHtmlDoc()
        if (!(await passCheck(view.state, 0, doc.failed))) break
        out = await window.api.exportHtml(doc.html, `${exportStem()}.html`)
      } catch (e) {
        exportFailed(e, () => void handleMenu(action))
        break
      }
      // 0.2.x：导出完只有保存面板关掉那一下，此前看不出到底写成功了没有。
      // PDF 那条路是 NSAlert（模态），这条给状态栏一句 + 一颗「在 Finder 中显示」——
      // 导出的东西十有八九是要马上发给别人的
      if (out) {
        note(t('note.exported', { name: basename(out.path) }), {
          action: { label: t('note.reveal'), run: () => window.api.revealInFinder(out.path) }
        })
      }
      break
    }
    case 'file:export-png':
      try {
        await exportPng()
      } catch (e) {
        exportFailed(e, () => void handleMenu(action))
      }
      break
    case 'file:export-pdf':
      // 第八节 12（契约 v40）：从前是壳直接接手的 `#selector`，渲染层插不上话。
      // 现在先体检，再把渲好的 HTML 交给壳（选项、保存面板、打印、书签都还在壳侧）
      try {
        const doc = await exportHtmlDoc()
        if (!(await passCheck(view.state, 0, doc.failed))) break
        await window.api.exportPdf(doc.html)
      } catch (e) {
        exportFailed(e, () => void handleMenu(action))
      }
      break
    case 'edit:undo':
    case 'edit:redo': {
      // 为什么撤销也得走菜单这条路，见 `MenuAction` 里 'edit:undo' 那段。
      // 壳自己的输入框（搜索、重命名、设置…）里该撤的是那一行字，不是文档 ——
      // 下放给浏览器，它撤自己那个 <input> 的编辑栈
      const el = document.activeElement
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        document.execCommand(action === 'edit:undo' ? 'undo' : 'redo')
        break
      }
      // **不 view.focus()**：光标可能正在表格格子里（那是一座 contenteditable 孤岛），
      // 抢焦点会把整块表当场换回管道符源码。撤销本来也不需要焦点，
      // 事务自带 scrollIntoView，改到哪儿看得见
      ;(action === 'edit:undo' ? undo : redo)(view)
      break
    }
    case 'edit:select-all': {
      // 为什么全选也得走菜单这条路，见 `MenuAction` 里 'edit:select-all' 那段；
      // 「落到哪儿」的判断在 `selectAllScope`（提成纯函数是为了不开窗口就能测）
      const el = document.activeElement
      switch (selectAllScope(el, view.contentDOM)) {
        case 'field':
          ;(el as HTMLInputElement | HTMLTextAreaElement).select()
          break
        case 'island':
          // 表格格子那座 contenteditable 孤岛：交还给浏览器选这一格，**别抢焦点** ——
          // 焦点一走，那块表当场换回管道符源码
          document.execCommand('selectAll')
          break
        default:
          selectAll(view)
          // **这一支要抢焦点**（0.4.1 修）：选区是状态、焦点不是 —— 撤销那条因此
          // 不抢。可 ⌘C / ⌘X 走的是原生 `copy:` / `cut:`（沿响应链落进 WebKit，
          // 根本不经渲染层），而 CodeMirror **只在自己是 activeElement 时**才把选区
          // 写进 DOM。焦点留在文件树 / 大纲 / 状态栏上的话，⌘A 之后那一下复制
          // 拿到的是空的，而人明明看见整篇都选中了。
          // 上面那条「抢焦点会掀翻表格」只对孤岛成立，它已经提前走掉了
          view.focus()
      }
      break
    }
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
    case 'file:check-refs':
      await checkReferences()
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
      // P2-4：⌥⇧⌘V 粘贴为纯文本
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
    case 'view:zoom-in':
      zoom.step(1)
      break
    case 'view:zoom-out':
      zoom.step(-1)
      break
    case 'view:zoom-reset':
      zoom.reset()
      break
    case 'view:toggle-fold':
      // 0.4.0 F1。源代码模式下这套装饰整个撤掉了，说清楚是哪一种「没反应」
      if (sourceMode) note(t('note.foldSource'))
      else if (!toggleFoldAt(view, view.state.selection.main.head)) note(t('note.foldNone'))
      break
    case 'view:disable-custom-theme': {
      // 0.3.0 T4 安全出口。**回执必须说清楚现在是哪一头** —— 这条菜单项是
      // 「皮肤把界面弄花了」时唯一还按得到的东西，按完什么都不说的话，
      // 人分不清是「停用了」还是「这一下也没反应」
      const off = prefs.toggleCustomOff()
      syncViewFlags()
      note(t(off ? 'note.customOff' : 'note.customOn'), { warn: off && !prefs.hasCustom })
      break
    }
    case 'app:check-update':
      // 0.3.0 T2：联网的是壳（页面的 CSP 出不去），这一侧只管比版本与说那句话
      await checkForUpdate()
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
  // 落盘位置要说一句：图片是**被复制进了 assets/**，而不是链到原处 —— 不说的话，
  // 用户会以为文档引的还是 Finder 里那张，把原图删了才发现不是
  note(t('note.imageSaved', { path: relPath }))
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
// 文件树自动刷新（契约 v32）：壳按目录报，侧栏只重读那一级。
// 与上面那条各管各的 —— 那条管的是**文档内容**变了，这条管的是**某一级里有什么**变了
window.api.onDirChanged((path) => sidebar.onDirChanged(path))

async function handleExternalChange(path: string): Promise<void> {
  const t = tabs.find((x) => x.path === path)
  if (!t) return
  let disk: DocPayload
  try {
    disk = await window.api.read(path)
  } catch {
    // 读不到了：别处删了 / 改名了 / 外接盘拔了。**记成 missing** —— 不记的话
    // 两秒后的自动保存会把它原地复活（见 `writeOnce` 里那道闸）
    t.stale = true
    t.missing = true
    syncStatus(true)
    return
  }
  delete t.missing
  const curText = t.id === viewTabId ? view.state.doc.toString() : t.state.doc.toString()
  // 两条都是「这一下是我们自己干的」：① 盘上那份与当前文档一致；
  // ② 盘上那份**正是我们自己最后写下去的那一份** —— 第二条不能省：自动保存落盘之后
  // 到监听事件到达之间只隔 300ms，人在这中间又敲了两个字的话第一条就不成立了，
  // 于是报出一次假冲突，而假冲突会把这个文件的自动保存整个停下来（比没有冲突更坏）
  if (
    encode(curText, t.fp) === encode(disk.content, disk.fingerprint) ||
    // **正文与指纹一起比**：只比正文的话，「把 LF 换成 CRLF」这种改动正文一个字不变，
    // 会被当成我们自己写的而忽略掉 —— 下一次保存再按旧指纹写回去，人家的转换就没了
    sameAsSeen(t, disk)
  ) {
    t.stale = false
    syncStatus(true)
    return
  }

  // 干净 → 静默换成磁盘那份（活动标签保留滚动与光标）。这一条与活动不活动无关：
  // 手上没有未保存的改动，就没有任何东西会丢
  if (!isTabDirty(t)) {
    adoptDisk(t, disk)
    return
  }

  // **脏 = 一次真正的冲突**（第八节 2）。两份内容都有人要，所以这里一个字节都不动，
  // 只把磁盘那份记在标签上 —— 记下来之后三件事同时成立：那个文件的自动保存停了
  // （`writeOnce` 的闸）、标签上挂起 ⚠、状态栏那一格换成「外部已修改 · 查看差异」。
  // **从前这儿是一个原生两按钮弹窗**（重新载入 / 保留我的版本），两处不对：人看不见
  // 自己按下去会失去什么，而且没有「两份都留着」那条路。更糟的是非活动标签这一支 ——
  // 从前只标一个 ⚠ 就完了，两秒后的自动保存照样把外部改动**一声不响地**盖掉
  t.conflict = { content: disk.content, fingerprint: disk.fingerprint }
  t.stale = true
  syncStatus(true)
  // 正看着的那一份就当场把差异摆出来；别的标签留给 ⚠ 与状态栏，不打断手上的活
  if (t.id === activeId) await openConflict(t)
}

/**
 * 把磁盘上那一份换进标签里（0.2.0 就有的那条「静默重载」，第八节 2 收成一处）。
 *
 * 光标**走 `createState` 的 `cursor` 而不是建完再 dispatch 一次选区**：磁盘上那份
 * 可能比手上这份短，`cursor` 那条路会把位置夹回文档里；而且「文档刚出现的那一刻」
 * 正是 `adoptTableAtCursor` 认表格的时刻（见 `editor/setup.ts`），晚一步整张表就以
 * 管道符源码开门。
 */
function adoptDisk(tab: Tab, disk: DocPayload): void {
  const live = tab.id === viewTabId
  const scroll = live ? view.scrollDOM.scrollTop : tab.scroll
  const head = live ? view.state.selection.main.head : undefined
  tab.state = createState(disk.content, listener, {
    dir: dirname(disk.path),
    sourceMode: live ? sourceMode : tab.sourceMode,
    // 换的是整份 state，只读这一位得原样带过去（第八节 5）—— 别人改了文件，
    // 我这边的「只读」不该因此被悄悄撤掉
    readOnly: (live ? view.state : tab.state).readOnly,
    ...(head === undefined ? {} : { cursor: head })
  })
  tab.savedDoc = tab.state.doc
  tab.fp = disk.fingerprint
  tab.stale = false
  // 换进来的这份就是盘上那份：接下来那一发监听事件（换内容本身不写盘，但别人
  // 可能接着又改）认得出「这不是我写的」。**指纹要一起换** —— 只换正文的话，
  // 下一次自写识别拿的是上一次写盘时那个旧指纹
  tab.lastSeen = { text: disk.content, fp: { ...disk.fingerprint } }
  delete tab.conflict
  if (!live) {
    syncStatus(true)
    return
  }
  fingerprint = disk.fingerprint
  view.setState(tab.state)
  viewTabId = tab.id
  requestAnimationFrame(() => {
    view.scrollDOM.scrollTop = scroll
  })
  syncMode()
  syncStatus(true)
  updateOutline()
}

/**
 * 冲突面板（第八节 2）。**动态 import**，同版本历史 —— 两块面板共用那份 diff
 * 版面，谁先开谁把它带进来。
 */
let conflictPanel: import('./ui/conflict').Conflict | null = null

async function openConflict(tab: Tab): Promise<void> {
  const c = tab.conflict
  if (!c) return
  const { Conflict } = await import('./ui/conflict')
  conflictPanel ??= new Conflict()
  // 打开的这一刻现取「我手上这份」：从记下冲突到人点开它，中间可能过了很久
  const mine = (tab.id === viewTabId ? view.state.doc : tab.state.doc).toString()
  // 正文一模一样、只差换行符 / BOM 的那一种：面板里什么都看不见，得由这句话说清楚
  const fpDiff = c.fingerprint.eol !== tab.fp.eol || c.fingerprint.bom !== tab.fp.bom
  conflictPanel.open({
    name: tabTitle(tab),
    disk: c.content,
    mine,
    ...(fpDiff
      ? { fpNote: t('cf.fpOnly', { disk: fpName(c.fingerprint), mine: fpName(tab.fp) }) }
      : {}),
    pick: (choice) => void resolveConflict(tab, choice)
  })
}

/** 指纹说人话：`CRLF + BOM` / `LF`。只在冲突面板那句话里用 */
function fpName(fp: FileFingerprint): string {
  const eol = fp.eol === '\r\n' ? 'CRLF' : fp.eol === '\r' ? 'CR' : 'LF'
  return fp.bom ? `${eol} + BOM` : eol
}

/**
 * 三条出路，各自丢掉一样东西 —— 而**每一样都有一份后备**：
 *
 * · `reload` 丢的是我的改动 —— 可我的改动此前每两秒就落过一次盘，版本历史里有；
 * · `keep` 丢的是磁盘那份 —— 所以覆盖**之前先把它存进版本历史**（契约 v22），
 *   那是这条路上唯一一份会凭空消失的内容，两行代码换一条退路；
 * · `saveAs` 谁都不丢：我的落到新路径上，原文件留给外面那位改。
 *
 * 三条都要**先把 `conflict` 摘掉再去写盘** —— `writeOnce` 那道闸认的就是它，
 * 不摘的话人点一下按钮，面板又弹回来（而人刚刚已经做过决定了）。
 */
async function resolveConflict(tab: Tab, choice: ConflictChoice): Promise<void> {
  const c = tab.conflict
  if (!c) return
  if (choice === 'reload') {
    adoptDisk(tab, { path: tab.path!, content: c.content, fingerprint: c.fingerprint })
    return
  }
  // 另外两条都要真的写一次盘，所以带 `force` 越过那道闸（人刚刚就是在面板上做的决定）。
  // **冲突到写成了才算解决**：另存为的面板上点了取消、或者那一发写盘坏了，
  // 它就得原样挂回去 —— 提前摘掉的话，下一次自动保存会直接盖掉磁盘上那份
  if (choice === 'keep') {
    // 覆盖之前把磁盘那份留进版本历史（契约 v22）：它是这条路上唯一一份会凭空消失的内容。
    // **写没写成要说实话**：历史目录不可写的时候（只读盘、权限没了），从前照样回一句
    // 「随时找得回来」—— 那是这条路上最不该说的一句假话，因为紧接着就把它覆盖了
    const kept = tab.path ? await keepSnapshot(tab.path, c.content) : false
    // **比的是人在面板上看见的那一份**（不是裸 `force`）：上面那句留历史是一次 await，
    // 外面在这中间又改了一次的话，盘上那份已经没人看过了 —— 比不过就一个字节都不写，
    // 拒写那一下会把新的差异重新摆出来（`writeOnce` 的 stale 那一支）
    if (!(await writeTab(tab, { force: true, expect: expectOf({ text: c.content, fp: c.fingerprint }) }))) return
    if (kept) note(t('cf.kept'))
    // 人已经明确选了「保留我的」，所以照覆盖 —— 但得让他知道那份没有备份了。
    // 不自散：这句话比「已存进历史」重要得多
    else note(t('cf.noBackup'), { warn: true, sticky: true })
  } else if (!(await writeTab(tab, { as: true, force: true }))) return
  // **只摘掉自己处理的那一个**：上面两句 await 之间，外面可能又改了一次文件，
  // 于是 `handleExternalChange` 往这儿放了一个**更新的**冲突。无条件 delete 会把它
  // 一起抹掉 —— 人以为刚才那一下把事情解决了，其实盘上还压着一份没人看过的改动
  if (tab.conflict !== c) {
    syncStatus(true)
    return
  }
  delete tab.conflict
  tab.stale = false
  syncStatus(true)
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
).__cursive = {
  view, sidebar, exportHtml, exportHtmlSource, outlineSource,
  ...(selfCheck ? {
    // 探针清理也走保存队列，同时更新 savedDoc / lastSeen，避免只写盘留下脏状态。
    saveCurrent: (path: string) => {
      const tab = activeTab()
      if (tab?.path !== path) throw new Error(`probe save target mismatch: ${tab?.path} != ${path}`)
      return writeTab(tab)
    },
    diagnostics: () => ({
      activeId, viewTabId,
      navFlags: { ...navFlags },
      closedTabs: closedTabs.size,
      tabs: tabs.map((tab) => ({
        id: tab.id, path: tab.path, dirty: isTabDirty(tab), preview: tab.preview === true,
        save: { ...tab.save }, stale: tab.stale, conflict: !!tab.conflict,
        length: (tab.id === viewTabId ? view.state : tab.state).doc.length,
        savedLength: tab.savedDoc.length,
        draft: tab.path ? undefined : (tab.id === viewTabId ? view.state : tab.state).doc.toString()
      }))
    })
  } : {})
}

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
  // 状态那一格的文案要重取：指纹只认状态，不认语言，得先把它作废
  lastSaveSig = ''
  renderSave()
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
