import { syntaxTree } from '@codemirror/language'
import { toggleFoldAt } from '../fold'
import type { EditorState } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { icon, type IconName } from '../../ui/icons'
import { t } from '../../i18n'
import { toggleCalloutFold } from '../callout'
import { jumpTo } from '../navigation'
import { focusKeepScroll } from '../focus'
import {
  browserStorage,
  heightsForLayout,
  loadHeightStore,
  packHeightStore,
  saveHeightStore,
  type HeightStore
} from './height-store'
import type { Heading } from '../headings'
import { FOOTNOTE_DEF, withImageSize } from '../markdown-lang'
import { parsedTree } from '../syntax'

/**
 * 每个 widget 都必须实现 eq()：CodeMirror 靠它判断能否复用 DOM。
 * 不实现的话每次按键都会把所有 widget 重建一遍（图片重新解码、图表重画）。
 */

/** 先拦住 mousedown 的默认选区，再由 click 精确进入这个 widget 的源码。 */
function sourceControl(view: EditorView, dom: HTMLElement, control = dom): void {
  control.tabIndex = 0
  control.setAttribute('role', 'button')
  control.setAttribute('aria-label', t('w.editSource'))
  control.title = t('w.editSource')
  control.classList.add('cm-lp-source-control')
  const edit = (pointer = false) => {
    const from = view.posAtDOM(dom)
    view.dispatch({
      selection: { anchor: Math.min(from + 1, view.state.doc.length) },
      scrollIntoView: true,
      userEvent: pointer ? 'select.pointer' : 'select'
    })
    focusKeepScroll(view)
  }
  control.addEventListener('mousedown', (e) => {
    if (e.button === 0) e.preventDefault()
  })
  control.addEventListener('click', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    edit(true)
  })
  control.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    e.stopPropagation()
    edit()
  })
}

function zoomControl(open: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'cm-lp-zoom'
  button.title = t('w.zoom')
  button.setAttribute('aria-label', t('w.zoom'))
  button.innerHTML = icon('search')
  button.addEventListener('mousedown', (e) => e.preventDefault())
  button.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    open()
  })
  return button
}

// ---------- 数学公式（KaTeX） ----------

type Katex = (typeof import('./katex'))['default']

let katexMod: Katex | null = null
let katexPromise: Promise<Katex> | null = null

/**
 * P4-6②：katex 261 KB，从静态 import 改成动态 —— 首屏不再替没有公式的文档背这一份。
 * 与 `loadMermaid()` 同一个形状；导出（`export/index.ts` 要拿它出 MathML）走同一个
 * promise，一份实例加载一次。
 */
export function loadKatex(): Promise<Katex> {
  katexPromise ??= import('./katex').then((m) => (katexMod = m.default))
  return katexPromise
}

/**
 * 已经到手的 katex 实例，没到手是 null。给「自己不能变成异步」的调用方用 ——
 * 导出（`export/render.ts` 是一整棵同步递归）先 `await loadKatex()` 再进来，
 * 这里就总是拿得到。
 */
export function katexNow(): Katex | null {
  return katexMod
}

/**
 * KaTeX 渲染成 HTML。throwOnError: false = 语法错误不抛异常，
 * 而是把原始 TeX 套在 .katex-error 里（katex.css 给它红色）——
 * 公式写错只会难看，不能把编辑器搞崩。
 *
 * **katex 还没加载完时返回 null**（顺手把加载踢起来）：调用方要么先放源码占位、
 * 回头再补（`fillMath`），要么先 `await loadKatex()` 再调（导出那条路）。
 */
export function renderMath(tex: string, display: boolean): string | null {
  if (!katexMod) {
    void loadKatex()
    return null
  }
  return katexMod.renderToString(tex, {
    displayMode: display,
    throwOnError: false,
    strict: false,
    output: 'html'
  })
}

/**
 * 把公式填进 `el`：katex 在手就同步填（不闪），不在手就先摆源码、加载完再换掉。
 * 正文里的 `MathWidget` 和表格格子里的行内公式共用这一条 —— 两处的占位与补渲染
 * 必须是同一套，否则「公式在表格里不显示」这种毛病只会在其中一边出现。
 */
export function fillMath(
  el: HTMLElement,
  tex: string,
  display: boolean,
  view?: EditorView
): void {
  const html = renderMath(tex, display)
  if (html !== null) {
    el.innerHTML = html
    return
  }
  const delim = display ? '$$' : '$'
  el.textContent = `${delim}${tex}${delim}`
  void loadKatex().then(() => {
    // 等待期间这一格可能已经被重画掉（DOM 换了新的）——往死节点里写没意义
    if (!el.isConnected) return
    const done = renderMath(tex, display)
    if (done !== null) el.innerHTML = done
    // 内容是**量完之后**才换进来的：不说一声，CM 的行高表就一直停在占位那一版，
    // 点击定位、滚动锚定全按旧高度算 —— 鼠标点一处、光标落在另一处就是这么来的
    view?.requestMeasure()
  })
}

/** 行内 `$x^2$`（display=false，挂 .cm-lp-math-inline）与块级 `$$…$$`（display=true，挂 .cm-lp-mathview） */
export class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean
  ) {
    super()
  }
  eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.display === this.display
  }
  override get estimatedHeight(): number {
    // 只有块级（$$…$$）需要报：行内公式不进高度图
    return this.display ? heightMemo.get(`math:${this.tex}`) ?? 84 : -1
  }
  override destroy(dom: HTMLElement): void {
    unwatchHeight(dom)
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement(this.display ? 'div' : 'span')
    el.className = this.display ? 'cm-lp-mathview' : 'cm-lp-math-inline'
    fillMath(el, this.tex, this.display, view)
    sourceControl(view, el)
    watchHeight(view, el, this.display ? `math:${this.tex}` : null)
    return el
  }
}

// ---------- mermaid 图表 ----------

export type ThemeName = 'light' | 'dark'

/** 当前解析后的主题（data-theme 由 ui/prefs.ts 钉成确定的 light/dark，不含 system） */
export function currentTheme(): ThemeName {
  return document.documentElement.dataset['theme'] === 'dark' ? 'dark' : 'light'
}

let mermaidPromise: Promise<(typeof import('mermaid'))['default']> | null = null
/**
 * mermaid 约 1MB，动态 import 让 Vite 切成独立 chunk，打开普通文档不背这个成本。
 * 导出（`export/index.ts` 把图烘成静态 SVG）走同一个 promise —— 一份实例，加载一次。
 */
export function loadMermaid() {
  mermaidPromise ??= import('mermaid').then((m) => m.default)
  return mermaidPromise
}

let renderSeq = 0
const cancelRender = new WeakMap<HTMLElement, () => void>()

let sandbox: HTMLElement | null = null

/**
 * 给 mermaid 的屏幕外画布。图必须**真进 DOM** 才量得出文字（getBBox），
 * 而 mermaid 不给容器时是直接往 `<body>` 末尾挂临时节点的 —— body 是 flex 列，
 * 那节点就成了状态栏后面的又一个 flex item：渲染的那几十毫秒里，窗口底部会闪出
 * 一块默认配色的图（快速滚动时 widget 反复重建，闪的就是连成串的）。所以自带一块地方。
 * 另外 mermaid 在 draw 抛错那条路上不删临时节点，挂在 body 上的话那块就永远留在底下了。
 * 不能 display:none / visibility:hidden —— 那样量出来的尺寸是 0，只能挪到屏幕外。
 * 宽度取 100vw：和挂在 body 上时一样宽（gantt 的宽度取自父元素）。
 */
function mermaidCanvas(): HTMLElement {
  if (!sandbox?.isConnected) {
    sandbox = document.createElement('div')
    sandbox.setAttribute('aria-hidden', 'true')
    sandbox.style.cssText = 'position:fixed;top:0;left:-10000px;width:100vw;pointer-events:none'
    document.body.appendChild(sandbox)
  }
  return sandbox
}

/**
 * 渲染一张图，返回 SVG 源码。每次渲染各用各的容器 ——
 * mermaid 拿到容器的第一件事是 `innerHTML = ''`，共用一个的话同屏几张图会互相清掉。
 */
export async function renderMermaid(
  m: Awaited<ReturnType<typeof loadMermaid>>,
  id: string,
  src: string
): Promise<string> {
  const host = document.createElement('div')
  mermaidCanvas().appendChild(host)
  try {
    return (await m.render(id, src, host)).svg
  } finally {
    host.remove()
  }
}

/**
 * 渲染结果缓存（LRU，按 主题+源码 存）。widget 一滚出视口就被销毁，滚回来 `toDOM()`
 * 会重跑一遍完整渲染 —— 没有缓存的话，上下拉一趟一路都是「空占位 →（几十毫秒）→ 图」，
 * 每张图上屏时块高度还要跳一下。命中就同步填好，滚回来的那张是现成的。
 */
const svgCache = new Map<string, { id: string; svg: string }>()
const CACHE_MAX = 32

function cacheKey(src: string, theme: ThemeName): string {
  return `${theme}:${src}`
}

/** 取一份能直接塞进 DOM 的 SVG：临用临换一身 id —— 同一张图可能同屏出现两次，id 不能撞 */
function cachedSvg(key: string): string | null {
  const hit = svgCache.get(key)
  if (!hit) return null
  svgCache.delete(key) // 重新插到队尾 = 最近用过
  svgCache.set(key, hit)
  return hit.svg.split(hit.id).join(`cursive-mmd-${renderSeq++}`)
}

function cacheSvg(key: string, id: string, svg: string): void {
  svgCache.set(key, { id, svg })
  if (svgCache.size > CACHE_MAX) {
    const oldest = svgCache.keys().next()
    if (!oldest.done) svgCache.delete(oldest.value)
  }
}

/**
 * 块级 widget 的高度记忆。
 *
 * CM 只渲染视口附近那一段，视口之外的块按 `WidgetType.estimatedHeight` 估高度 ——
 * 默认是 -1，意思是「不知道」，CM 于是按**一行**算。一张 300px 的图、一张 20 行的表
 * 都被当成一行的话，高度表就是错的：滚动条长度不对、跳转落点差出一整屏、
 * 点击定位落在别的行上，而且每次真渲染到那一块，高度一换、上下文就跟着跳一下。
 *
 * 所以渲染过一次就把实测高度记下来，下次同一张图/同一张表再进估算时就有谱了。
 * 记在模块级：同一份文档滚上滚下，widget 反复销毁重建，这份记忆得活得比它们长。
 *
 * 这份记忆还要**活过进程**：应用每次重开都得重新量一遍的话，那就不是「第一次有点抖」，
 * 而是「每次开都抖」。落盘那一半在 `height-store.ts`（带排版条件校验，条件变了整份丢）。
 */
const heightMemo = new Map<string, number>()
const HEIGHT_MEMO_MAX = 256

/**
 * 与 `.cm-lp-image img { max-height: 60vh }` 同一个上限（live-preview.css）。
 * 只用来**截估值** —— 实测高度是量出来的，不必也不该走这里。
 * node 单测没有 window，退回不截（`Math.min(x, Infinity) === x`）。
 */
function cssMaxHeight(): number {
  return typeof window === 'undefined' ? Infinity : window.innerHeight * 0.6
}

// 排版条件变化后不能沿用旧的像素高度；缓存有上限，避免编辑过程无限积累源码。
let heightLayout = ''
const heightObservers = new WeakMap<HTMLElement, ResizeObserver>()

/**
 * 落盘那份读到手就一直拿着（`??=` 遇到 null 会重试，所以「上次没读到」不会被钉死）。
 * 读的时机是第一次 `adoptLayout` —— 要么预热（文档进来之前），要么第一次量高。
 */
let diskStore: HeightStore | null | undefined

/** 第一次写立刻落盘（「量到了」这件事最重要，别卡在节流窗口里），连续变化则合并成一次 */
let heightSavedAt = 0
let heightSaveTimer: ReturnType<typeof setTimeout> | null = null
const HEIGHT_SAVE_GAP = 400

function persistHeights(): void {
  if (!heightLayout) return
  const store = packHeightStore(heightLayout, heightMemo)
  const wait = heightSavedAt + HEIGHT_SAVE_GAP - Date.now()
  if (wait <= 0) {
    heightSavedAt = Date.now()
    saveHeightStore(browserStorage(), store)
    return
  }
  if (heightSaveTimer !== null) clearTimeout(heightSaveTimer)
  heightSaveTimer = setTimeout(() => {
    heightSaveTimer = null
    heightSavedAt = Date.now()
    saveHeightStore(browserStorage(), packHeightStore(heightLayout, heightMemo))
  }, wait)
}

/**
 * 排版条件指纹。**只有这一处算它** —— 预热（`primeHeights`）与实测（`watchHeight`）
 * 各写一份的话，两边差一个字段就等于「预热进来的高度永远对不上、下一发实测立刻清空」。
 * 是一次强制重排（读 clientWidth + getComputedStyle），只在 measure 阶段或用户动作里调。
 */
function layoutKey(view: EditorView): string {
  const style = getComputedStyle(view.contentDOM)
  return `${view.contentDOM.clientWidth}:${style.fontFamily}:${style.fontSize}:${style.lineHeight}:${view.scrollDOM.clientHeight}`
}

/** 换了排版条件：内存里那份按旧像素算的高度一个都不能留，改从落盘那份里捞这套条件下的 */
function adoptLayout(layout: string): void {
  if (heightLayout === layout) return
  heightMemo.clear()
  heightLayout = layout
  diskStore ??= loadHeightStore(browserStorage())
  // 上次落盘那份正好是这套排版条件 → 接着用；不是 → 旧像素高度一个都不认
  for (const [k, v] of Object.entries(heightsForLayout(diskStore, layout))) heightMemo.set(k, v)
}

/**
 * 把落盘那份**提前**捞进内存 —— 在文档进编辑器之前调（`main.ts` 的 `openTab`）。
 *
 * 不提前捞的话，落盘那一半会晚一步：CM 的顺序是**先查 `estimatedHeight` 进高度表、
 * 再 `toDOM`**，而读盘原先挂在 `watchHeight` 的 write 里（要等第一个 widget 画出来、
 * ResizeObserver 首发）。于是每次冷启动，第一个块级 widget 的估高必然拿不到磁盘那份，
 * 照样跳一下 —— 明明它的高度就在盘上。
 *
 * 调用点必须在「chrome 与偏好都已生效、文档还没进来」那一刻：早了（比如 view 刚建出来、
 * `prefs.apply()` 还没跑）算出来的指纹是过期的，等于拿另一套排版下的像素高度去排这一份。
 */
export function primeHeights(view: EditorView): void {
  // 还没上屏（宽度为 0）时算出来的指纹没有意义，留给 watchHeight 的实测那条路
  if (!view.contentDOM.clientWidth) return
  adoptLayout(layoutKey(view))
}

function watchHeight(
  view: EditorView,
  dom: HTMLElement,
  key: string | null,
  observed: HTMLElement = dom
): void {
  const observer = new ResizeObserver(() => {
    if (!dom.isConnected) return
    view.requestMeasure({
      key: dom,
      read: () => {
        if (!dom.isConnected) return null
        // 量的是 **dom**（widget 自己那个盒子），不是 observed。observed 只是「谁的尺寸
        // 变了要通知我」（图片是内层 <img>，它解码完才知道多高），而 CM 要的是整个
        // widget 占多高 —— 两者在小图上差一个行盒的高度
        return { height: Math.ceil(dom.getBoundingClientRect().height), layout: layoutKey(view) }
      },
      write: (size) => {
        if (!size || !dom.isConnected || key === null) return
        adoptLayout(size.layout)
        if (size.height <= 0) return
        if (heightMemo.get(key) === size.height) return
        heightMemo.delete(key)
        heightMemo.set(key, size.height)
        if (heightMemo.size > HEIGHT_MEMO_MAX) heightMemo.delete(heightMemo.keys().next().value!)
        persistHeights()
      }
    })
  })
  observer.observe(observed)
  heightObservers.set(dom, observer)
}

function unwatchHeight(dom: HTMLElement): void {
  heightObservers.get(dom)?.disconnect()
  heightObservers.delete(dom)
}

/**
 * ```mermaid 代码块 → 图。异步渲染三件套：
 * 先占位、拿到 SVG 再填充；eq() 按源码+主题比较（改一个字符只重绘那一张）；
 * destroy() 取消未完成的渲染（widget 被滚动出视口/删掉时别再往死 DOM 里写）。
 * 页面 CSP 是 script-src 'self'：mindmap/cytoscape 系依赖 new Function 会被拦，
 * 常用的 flowchart/sequence/gantt/class/state 都不碰它。
 */
export class MermaidWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly theme: ThemeName
  ) {
    super()
  }
  eq(other: MermaidWidget): boolean {
    return other.src === this.src && other.theme === this.theme
  }
  override destroy(dom: HTMLElement): void {
    unwatchHeight(dom)
    cancelRender.get(dom)?.()
    cancelRender.delete(dom)
  }
  override get estimatedHeight(): number {
    return heightMemo.get(cacheKey(this.src, this.theme)) ?? 260
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('div')
    el.className = 'cm-lp-mermaid'
    const content = document.createElement('div')
    content.className = 'cm-lp-mermaid-content'
    sourceControl(view, el, content)
    const zoom = zoomControl(() => {
      const svg = content.querySelector('svg')
      if (svg) openPreview(svg.cloneNode(true) as SVGElement, t('cd.mermaid'))
    })
    zoom.hidden = true
    el.append(content, zoom)
    const key = cacheKey(this.src, this.theme)
    watchHeight(view, el, key)
    const ready = cachedSvg(key)
    if (ready !== null) {
      // 缓存命中就是同步填好的，高度当场正确，不必惊动 measure
      content.innerHTML = ready
      zoom.hidden = false
      return el
    }
    let cancelled = false
    cancelRender.set(el, () => {
      cancelled = true
    })
    void loadMermaid()
      .then(async (m) => {
        if (cancelled) return
        m.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: this.theme === 'dark' ? 'dark' : 'default'
        })
        // render 对语法错误不抛异常，而是把错误信息嵌进 SVG 返回 ——
        // 要走「保留源码 + 错误提示」就必须用 parse() 显式预校验
        await m.parse(this.src)
        const id = `cursive-mmd-${renderSeq++}`
        const svg = await renderMermaid(m, id, this.src)
        // 先存再看取消：快速滚动时这一张多半是「画完人已经走了」，
        // 存下来下一趟正好用得上
        cacheSvg(key, id, svg)
        if (cancelled) return
        content.innerHTML = svg
        zoom.hidden = false
        // 图是异步长出来的，高度从一行占位变成几百像素 —— 不重新量，
        // 下面所有行的坐标在 CM 眼里都还是旧的
        view.requestMeasure()
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // 渲染失败：保留源码 + 错误信息，不白屏
        el.classList.add('is-error')
        content.textContent = `${this.src}\n\n${err instanceof Error ? err.message : String(err)}`
        view.requestMeasure()
      })
    return el
  }
}

// ---------- 方言补齐（P1-3）：脚注 / emoji / TOC ----------

/** 目录条目 = 大纲条目：取数在 `editor/headings.ts`，两处共用同一份（见那里的注释） */
export type TocEntry = Heading
export { collectHeadings } from '../headings'

/** 在全文找脚注定义 [^label]: 的位置与内容 */
export function findFootnoteDef(state: EditorState, label: string): { pos: number; text: string } | null {
  const needle = `[^${label}]:`
  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i)
    if (line.text.startsWith(needle))
      return { pos: line.from, text: line.text.slice(needle.length).trim() }
  }
  return null
}

/**
 * 全文定义过的脚注标签（形状走 `markdown-lang.ts` 那份 `FOOTNOTE_DEF`）——
 * 一次性知道「哪些引用是悬空的」，一条条 `findFootnoteDef` 是 O(引用×行数)。
 *
 * **按 state 记一次**：装饰层是每次按键、每次挪光标都要重算的，而视口里每一个脚注
 * 引用都要问一次「这条有定义吗」。不记的话就是**每个引用各扫一遍全文** ——
 * 12040 行、定义摆在文末的那种长文实测：`findFootnoteDef` 一次 1.49ms，视口里
 * 12 个引用就是 18ms/次重算，正好吃掉一整帧；而整张表建出来只要 1.61ms。
 * state 不可变，所以记一次就够；**别改返回的 Set**，它是共享的。
 */
const footnoteCache = new WeakMap<EditorState, Set<string>>()

export function footnoteLabels(state: EditorState): Set<string> {
  const hit = footnoteCache.get(state)
  if (hit) return hit
  const out = new Set<string>()
  for (let i = 1; i <= state.doc.lines; i++) {
    const m = FOOTNOTE_DEF.exec(state.doc.line(i).text)
    if (m) out.add(m[1]!)
  }
  footnoteCache.set(state, out)
  return out
}

/** 脚注引用 [^label] → 上标角标，悬停显示定义、点击跳到定义处 */
export class FootnoteRefWidget extends WidgetType {
  constructor(readonly label: string) {
    super()
  }
  eq(other: FootnoteRefWidget): boolean {
    return other.label === this.label
  }
  override ignoreEvent(): boolean {
    return false
  }
  toDOM(view: EditorView): HTMLElement {
    const sup = document.createElement('sup')
    sup.className = 'cm-lp-footnote-ref'
    sup.textContent = this.label
    const def = findFootnoteDef(view.state, this.label)
    if (def?.text) sup.title = def.text
    sup.addEventListener('mousedown', (e) => {
      e.preventDefault()
      // 位置在编辑后会漂移，点击时现查（同 CheckboxWidget 的做法）
      const now = findFootnoteDef(view.state, this.label)
      if (!now) return
      view.dispatch({
        selection: { anchor: now.pos },
        effects: EditorView.scrollIntoView(now.pos, { y: 'center' })
      })
    })
    return sup
  }
}

/** 脚注定义区折叠成一行（块级，blockField 出）；光标进入回落源码可编辑 */
export class FootnoteDefWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly text: string
  ) {
    super()
  }
  eq(other: FootnoteDefWidget): boolean {
    return other.label === this.label && other.text === this.text
  }
  toDOM(view: EditorView): HTMLElement {
    // 根节点只负责上下留白（CM 量的就是它，margin 量不到 —— 见 themes/live-preview.css
    // 开头「块级 widget 的上下留白」），灰底那只盒子是里层
    const wrap = document.createElement('div')
    wrap.className = 'cm-lp-blockgap is-tight'
    const el = document.createElement('div')
    el.className = 'cm-lp-footnote-def'
    wrap.appendChild(el)
    // 落点认的是根节点（`posAtDOM`），留白那一圈点了也算进源码 —— 它本来就是这条脚注的地盘
    sourceControl(view, wrap)
    const label = document.createElement('span')
    label.className = 'cm-lp-footnote-def-label'
    label.textContent = `^${this.label}`
    el.appendChild(label)
    el.appendChild(document.createTextNode(this.text.split('\n')[0] ?? ''))
    return wrap
  }
}

/** :smile: → emoji 字符 */
export class EmojiWidget extends WidgetType {
  constructor(readonly char: string) {
    super()
  }
  eq(other: EmojiWidget): boolean {
    return other.char === this.char
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-lp-emoji'
    el.textContent = this.char
    return el
  }
}

/** [TOC] → 可点击目录。点击条目跳到对应标题 */
export class TocWidget extends WidgetType {
  override destroy(dom: HTMLElement): void {
    unwatchHeight(dom)
  }
  constructor(readonly entries: TocEntry[]) {
    super()
  }
  eq(other: TocWidget): boolean {
    return JSON.stringify(other.entries) === JSON.stringify(this.entries)
  }
  override ignoreEvent(): boolean {
    return false
  }
  override get estimatedHeight(): number {
    // 未渲染时按条数估算（44 = 标题 + 盒子内边距，20 = 外壳那圈留白）；
    // 实测缓存区分完整目录内容。
    return heightMemo.get(`toc:${JSON.stringify(this.entries)}`) ?? 64 + this.entries.length * 28
  }
  toDOM(view: EditorView): HTMLElement {
    // 同脚注定义：有边框有底色的那只盒子留在里层，根节点只负责上下留白 ——
    // **量的也必须是根节点**（`destroy` 拿到的就是它），不然记进盘里的高度少一圈留白
    const wrap = document.createElement('div')
    wrap.className = 'cm-lp-blockgap'
    watchHeight(view, wrap, `toc:${JSON.stringify(this.entries)}`)
    const nav = document.createElement('nav')
    nav.className = 'cm-lp-toc'
    wrap.appendChild(nav)
    const head = document.createElement('div')
    head.className = 'cm-lp-toc-title'
    head.textContent = t('w.toc')
    nav.appendChild(head)
    const list = document.createElement('ul')
    nav.appendChild(list)
    for (const entry of this.entries) {
      const li = document.createElement('li')
      li.textContent = entry.text
      // 层级缩进（不嵌套 DOM，避免空标题层级时列表抖动）
      li.style.paddingLeft = `${(entry.level - 1) * 14 + 6}px`
      li.addEventListener('mousedown', (e) => {
        e.preventDefault()
        jumpTo(view, entry.pos)
      })
      list.appendChild(li)
    }
    return wrap
  }
}

/** 无序列表的 `-` `*` `+` → 圆点 */
export class BulletWidget extends WidgetType {
  constructor(readonly depth: number) {
    super()
  }
  eq(other: BulletWidget): boolean {
    return other.depth === this.depth
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-lp-bullet'
    // 按层级换符号，和主流编辑器一致
    el.textContent = ['•', '◦', '▪'][this.depth % 3] ?? '•'
    return el
  }
}

/** 任务列表的 `[ ]` / `[x]` → 真复选框，点击直接改源码 */
export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-lp-checkbox'
    box.checked = this.checked
    box.addEventListener('mousedown', (e) => {
      e.preventDefault()
      // 位置在文档变化后会漂移，所以点击时现查，不存构造时的位置
      const pos = view.posAtDOM(box)
      const line = view.state.doc.lineAt(pos)
      const at = line.text.indexOf(this.checked ? '[x]' : '[ ]')
      if (at < 0) return
      view.dispatch({
        changes: {
          from: line.from + at + 1,
          to: line.from + at + 2,
          insert: this.checked ? ' ' : 'x'
        }
      })
    })
    return box
  }
  ignoreEvent(): boolean {
    return false
  }
}

/** `---` → 真正的分隔线 */
export class RuleWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'cm-lp-rule'
    el.appendChild(document.createElement('hr'))
    return el
  }
}

/**
 * 点击放大预览的灯箱（body 级全屏遮罩）。
 * 复刻 Prefs 面板的叠层思路：backdrop 点击 / Escape 关闭。
 */
let viewer: HTMLElement | null = null
let viewerFocus: HTMLElement | null = null

export function closeImageView(): void {
  viewer?.remove()
  viewer = null
  if (viewerFocus?.isConnected) viewerFocus.focus({ preventScroll: true })
  viewerFocus = null
}

function openImageView(src: string, alt: string): void {
  const img = document.createElement('img')
  img.src = src
  img.alt = alt
  openPreview(img, alt)
}

function openPreview(content: HTMLElement | SVGElement, caption: string): void {
  closeImageView()
  viewerFocus = document.activeElement as HTMLElement | null
  const viewerEl = document.createElement('div')
  viewerEl.id = 'image-viewer'
  viewerEl.setAttribute('role', 'dialog')
  viewerEl.setAttribute('aria-modal', 'true')
  viewerEl.setAttribute('aria-label', caption || t('w.zoom'))
  const backdrop = document.createElement('div')
  backdrop.className = 'img-viewer-backdrop'
  backdrop.addEventListener('click', closeImageView)
  const panel = document.createElement('div')
  panel.className = 'img-viewer-panel'
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'img-viewer-close'
  close.setAttribute('aria-label', t('w.closePreview'))
  close.innerHTML = icon('close')
  close.addEventListener('click', closeImageView)
  const cap = document.createElement('div')
  cap.className = 'img-viewer-caption'
  cap.textContent = caption
  panel.append(content, cap)
  viewerEl.append(backdrop, panel, close)
  viewerEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeImageView()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      close.focus()
    }
  })
  document.body.appendChild(viewerEl)
  viewer = viewerEl
  close.focus({ preventScroll: true })
}

// 灯箱开着时 Escape 关闭（常驻监听，开着才有效果）。
// node 测试环境没 document，跳过（只有浏览器挂监听）
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeImageView()
  })
}

/** 复制文本：优先 Clipboard API，失败退 textarea + execCommand('copy')（WKWebView 非安全上下文） */
export function copyText(text: string): void {
  const done = () => {}
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(fallbackCopy)
    done()
    return
  }
  fallbackCopy()
  function fallbackCopy() {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
    } catch {
      /* 复制失败就算了 */
    }
    ta.remove()
  }
}

/** `![alt](src)` → 真图片：点击编辑，独立按钮放大；支持 `=宽x高` 尺寸语法。 */
/** 拖不动到比这更小 —— 再小就点不中手柄自己了 */
const MIN_IMG = 48

/**
 * 右下角那只拖尺寸的手柄（0.2.x）。
 *
 * 尺寸语法 `![图](a.png =600x400)` 在 P1 就通了，但此前**只能手写数字** ——
 * 在一个所见即所得的编辑器里，改图片大小于是成了最后一件还得回源码去做的常见操作。
 *
 * 三个决定：
 * - **松手才写文档**：拖的过程只改 DOM 上的宽高（不碰文档 = 不触发解析、不进撤销栈），
 *   松手一次写回，于是整段拖拽在历史里是**一步** —— ⌘Z 一下回到原来的尺寸。
 * - **锁纵横比**：图片被拉变形几乎从来不是本意；真要变形的人可以去源码里写死两个数。
 *   比例取 `naturalWidth/Height`（拿不到就用当下这个盒子），于是拖完还是原来那张图。
 * - **拖的是屏幕上那个宽度**：`.cm-lp-image img` 上有 `max-width:100%` 与 `max-height:60vh`
 *   压着，量渲染后的盒子才是所见即所得；写回文档的也正是这个数。
 */
function sizeHandle(
  view: EditorView,
  wrap: HTMLElement,
  img: HTMLImageElement
): { handle: HTMLElement; tip: HTMLElement } {
  const handle = document.createElement('span')
  handle.className = 'cm-lp-img-handle'
  handle.title = t('w.imgResize')
  const tip = document.createElement('span')
  tip.className = 'cm-lp-img-tip'
  tip.hidden = true

  handle.addEventListener('mousedown', (down) => {
    if (down.button !== 0) return
    // 不挡的话按下这一下会先被当成一次正文选区（widget 外面还有 CM 的 mousedown）
    down.preventDefault()
    down.stopPropagation()
    const box = img.getBoundingClientRect()
    const ratio =
      img.naturalWidth && img.naturalHeight
        ? img.naturalWidth / img.naturalHeight
        : box.width / Math.max(box.height, 1)
    // 上界是正文宽：再宽也会被 `max-width:100%` 压回来，写进文档只会是个对不上的数
    const max = Math.max(MIN_IMG, view.contentDOM.clientWidth)
    let w = Math.round(box.width)
    let h = Math.round(box.height)

    const move = (e: MouseEvent): void => {
      w = Math.round(Math.min(Math.max(box.width + (e.clientX - down.clientX), MIN_IMG), max))
      h = Math.max(1, Math.round(w / (ratio || 1)))
      img.style.width = `${w}px`
      img.style.height = `${h}px`
      tip.textContent = `${w} × ${h}`
      tip.hidden = false
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      tip.hidden = true
      writeImageSize(view, wrap, w, h)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  })
  // **两件都交回去让 toDOM 按顺序挂**：这个盒子的第 0 个孩子必须一直是正文那层
  // （量高、裂图替换、`test/widget-height.test.ts` 都按这个位置找），
  // 在这儿顺手 append 会把 tip 插到它前面
  return { handle, tip }
}

/**
 * 把拖出来的尺寸写回源码。**一次普通编辑**（与表格就地编辑、告示块折叠同一条路）：
 * 撤销、装饰重算、自动保存全都白拿。
 *
 * 位置现查（`posAtDOM` + 树上找回那个 `Image` 节点）而不是记在 widget 里：
 * widget 是可复用的，它的位置随时在漂 —— 同 `CheckboxWidget` / `toggleCalloutAt` 那条。
 */
function writeImageSize(view: EditorView, dom: HTMLElement, width: number, height: number): void {
  const doc = view.state.doc
  const from = view.posAtDOM(dom)
  let node: SyntaxNode | null = parsedTree(view.state).resolveInner(
    Math.min(from + 1, doc.length),
    1
  )
  while (node && node.name !== 'Image') node = node.parent
  if (!node) return
  const text = view.state.sliceDoc(node.from, node.to)
  const next = withImageSize(text, width, height)
  // null = 这条源码不接受尺寸（带标题那种，见 withImageSize）：什么都不做，
  // 下一次重画会把图恢复成文档里写的样子
  if (!next || next === text) return
  view.dispatch({
    changes: { from: node.from, to: node.to, insert: next },
    userEvent: 'input.resize'
  })
}

export class ImageWidget extends WidgetType {
  override destroy(dom: HTMLElement): void {
    unwatchHeight(dom)
  }
  private get heightKey(): string {
    return `img:${JSON.stringify([this.src, this.width, this.height])}`
  }
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly width?: number,
    readonly height?: number
  ) {
    super()
  }
  eq(other: ImageWidget): boolean {
    return (
      other.src === this.src && other.alt === this.alt && other.width === this.width && other.height === this.height
    )
  }
  override ignoreEvent(): boolean {
    return true
  }
  override get estimatedHeight(): number {
    const known = heightMemo.get(this.heightKey)
    if (known !== undefined) return known
    // 文档里写的高度只是**请求**：CSS 还有 `max-height: 60vh`（live-preview.css）压着。
    // 不截的话，`=4000x3000` 这种首帧按 3000px 排版、量完塌回 400px，整篇跟着跳一次
    return Math.min(this.height ?? 240, cssMaxHeight())
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-lp-image'
    const content = document.createElement('span')
    sourceControl(view, wrap, content)
    const img = document.createElement('img')
    const zoom = zoomControl(() => openImageView(this.src, this.alt))
    zoom.hidden = true
    // 图片的高度要等解码完才知道（没写死 width/height 的话）。CM 量高是在插进 DOM
    // 的那一帧，那会儿 <img> 还是 0 高 —— 不补这一次 requestMeasure，整篇的行坐标
    // 就一直按「图片没有高度」算：点一下光标落在别处，滚动位置也会自己漂
    const { handle, tip } = sizeHandle(view, wrap, img)
    handle.hidden = true
    img.addEventListener('load', () => {
      if (!wrap.isConnected) return
      zoom.hidden = false
      // 手柄要等解码完才露面：在那之前既没有纵横比、也没有可拖的盒子
      handle.hidden = false
      view.requestMeasure()
    })
    img.alt = this.alt
    if (this.width) {
      img.width = this.width
      img.style.width = `${this.width}px`
    }
    if (this.height) {
      img.height = this.height
      img.style.height = `${this.height}px`
    }
    img.addEventListener('error', () => {
      if (!wrap.isConnected) return
      // 失败时显示解析后的完整路径（不是只给 alt —— alt 排查不了是路径错还是文件缺）
      wrap.classList.add('is-broken')
      let path = this.src
      try {
        path = decodeURI(this.src).replace(/^safe-file:\/\/local/, '')
      } catch {
        /* 保底原样 */
      }
      // 先摘掉观察者再换内容：`is-broken` 的盒子是**另一个东西**（虚线框 + 两行小字），
      // 让它写进这张图的 key 的话，下次文件补回来了，估高还是裂图那个矮盒子
      unwatchHeight(wrap)
      content.textContent = `${path}\n(${this.alt || t('w.imgBroken')})`
      zoom.hidden = true
      handle.hidden = true
      view.requestMeasure()
    })
    content.appendChild(img)
    wrap.append(content, zoom, handle, tip)
    watchHeight(view, wrap, this.heightKey, img)
    img.src = this.src
    return wrap
  }
}

// ---------- 告示块 Callout（P1-6） ----------

/** 从 widget 所在位置往上找它所属的告示块起点（位置会漂移，点击时现查，同 CheckboxWidget） */
function toggleCalloutAt(view: EditorView, el: HTMLElement): void {
  const pos = view.posAtDOM(el)
  for (let n: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name !== 'Blockquote') continue
    view.dispatch({ effects: toggleCalloutFold.of(n.from) })
    return
  }
}

/**
 * 告示块首行的图标（+ 没写标题时补的类型名 + 可折叠时的三角）。
 * 它替换掉 `[!danger]` 那段源码本身 —— 一个替换装饰同时办了「藏起标记」和
 * 「插入图标」两件事，不用再叠一个 pushHide。
 */
export class CalloutHeadWidget extends WidgetType {
  constructor(
    readonly icon: IconName,
    /** 空串 = 文档里写了自定义标题，不补类型名 */
    readonly label: string,
    readonly foldable: boolean,
    readonly folded: boolean
  ) {
    super()
  }
  eq(other: CalloutHeadWidget): boolean {
    return (
      other.icon === this.icon &&
      other.label === this.label &&
      other.foldable === this.foldable &&
      other.folded === this.folded
    )
  }
  override ignoreEvent(): boolean {
    return false
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-lp-callout-mark'
    const ic = document.createElement('span')
    ic.className = 'cm-lp-callout-icon'
    ic.innerHTML = icon(this.icon)
    el.appendChild(ic)
    if (this.label) {
      const name = document.createElement('span')
      name.className = 'cm-lp-callout-name'
      name.textContent = this.label
      el.appendChild(name)
    }
    if (this.foldable) {
      const fold = document.createElement('button')
      fold.type = 'button'
      fold.className = 'cm-lp-callout-fold'
      fold.setAttribute('aria-label', this.folded ? t('w.calloutExpand') : t('w.calloutCollapse'))
      fold.innerHTML = icon(this.folded ? 'chevron' : 'chevron-down')
      fold.addEventListener('mousedown', (e) => {
        e.preventDefault() // 不让焦点离开编辑器，否则选区没了
        toggleCalloutAt(view, fold)
      })
      el.appendChild(fold)
    }
    return el
  }
}

/**
 * 标题行右边那颗折叠把手（0.4.0 F1）。**不加 gutter** —— 加一条要占掉一列版面，
 * 而且与「屏幕上就是成稿的样子」直接冲突。平时淡着，鼠标扫到这一行才显形；
 * 折着的时候一直亮着（否则那一节看起来就只是「后面没写」）。
 */
export class FoldHandleWidget extends WidgetType {
  constructor(readonly folded: boolean) {
    super()
  }
  eq(other: FoldHandleWidget): boolean {
    return other.folded === this.folded
  }
  override ignoreEvent(): boolean {
    return false
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-lp-fold' + (this.folded ? ' is-folded' : '')
    const label = t(this.folded ? 'w.unfoldSection' : 'w.foldSection')
    el.setAttribute('aria-label', label)
    el.title = label
    el.innerHTML = icon('chevron')
    el.addEventListener('mousedown', (e) => {
      e.preventDefault() // 不让焦点离开编辑器，否则选区没了（同告示块那颗三角）
      toggleFoldAt(view, view.posAtDOM(el))
    })
    return el
  }
}

/**
 * 折起来的一节 → 标题后面一颗药丸（blockField 出的跨行替换），点一下展开。
 * 上面写着藏了多少行 —— 「这里还有东西」与「这一节就这么短」得看得出区别。
 */
export class SectionFoldWidget extends WidgetType {
  constructor(readonly lines: number) {
    super()
  }
  eq(other: SectionFoldWidget): boolean {
    return other.lines === this.lines
  }
  override ignoreEvent(): boolean {
    return false
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-lp-section-more'
    el.setAttribute('aria-label', t('w.unfoldSection'))
    el.title = t('w.unfoldSection')
    el.textContent = t('w.foldedLines', { n: this.lines })
    el.addEventListener('mousedown', (e) => {
      e.preventDefault()
      toggleFoldAt(view, view.posAtDOM(el))
    })
    return el
  }
}

/** 折起来的正文 → 一颗省略号药丸（blockField 出的跨行替换），点一下展开 */
export class CalloutFoldWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  override ignoreEvent(): boolean {
    return false
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-lp-callout-more'
    el.setAttribute('aria-label', t('w.calloutExpand'))
    el.innerHTML = icon('dots')
    el.addEventListener('mousedown', (e) => {
      e.preventDefault()
      toggleCalloutAt(view, el)
    })
    return el
  }
}
