import katex from 'katex'
import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { icon, type IconName } from '../../ui/icons'
import { t } from '../../i18n'
import { toggleCalloutFold } from '../callout'
import type { Heading } from '../headings'

/**
 * 每个 widget 都必须实现 eq()：CodeMirror 靠它判断能否复用 DOM。
 * 不实现的话每次按键都会把所有 widget 重建一遍（图片重新解码、图表重画）。
 */

// ---------- 数学公式（KaTeX） ----------

/**
 * KaTeX 渲染成 HTML。throwOnError: false = 语法错误不抛异常，
 * 而是把原始 TeX 套在 .katex-error 里（katex.css 给它红色）——
 * 公式写错只会难看，不能把编辑器搞崩。
 * renderToString 是同步的，widget 的 toDOM 才能直接用（mermaid 那套异步占位模式不需要）。
 */
export function renderMath(tex: string, display: boolean): string {
  return katex.renderToString(tex, {
    displayMode: display,
    throwOnError: false,
    strict: false,
    output: 'html'
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
  toDOM(): HTMLElement {
    const el = document.createElement(this.display ? 'div' : 'span')
    el.className = this.display ? 'cm-lp-mathview' : 'cm-lp-math-inline'
    el.innerHTML = renderMath(this.tex, this.display)
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
    cancelRender.get(dom)?.()
    cancelRender.delete(dom)
  }
  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'cm-lp-mermaid'
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
        const { svg } = await m.render(`cursive-mmd-${renderSeq++}`, this.src)
        if (cancelled) return
        el.innerHTML = svg
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // 渲染失败：保留源码 + 错误信息，不白屏
        el.classList.add('is-error')
        el.textContent = `${this.src}\n\n${err instanceof Error ? err.message : String(err)}`
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
  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'cm-lp-footnote-def'
    const label = document.createElement('span')
    label.className = 'cm-lp-footnote-def-label'
    label.textContent = `^${this.label}`
    el.appendChild(label)
    el.appendChild(document.createTextNode(this.text.split('\n')[0] ?? ''))
    return el
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
  constructor(readonly entries: TocEntry[]) {
    super()
  }
  eq(other: TocWidget): boolean {
    return JSON.stringify(other.entries) === JSON.stringify(this.entries)
  }
  override ignoreEvent(): boolean {
    return false
  }
  toDOM(view: EditorView): HTMLElement {
    const nav = document.createElement('nav')
    nav.className = 'cm-lp-toc'
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
        view.dispatch({
          selection: { anchor: entry.pos },
          effects: EditorView.scrollIntoView(entry.pos, { y: 'start', yMargin: 12 })
        })
      })
      list.appendChild(li)
    }
    return nav
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
    // 按层级换符号，和 Typora 一致
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

export function closeImageView(): void {
  viewer?.remove()
  viewer = null
}

function openImageView(src: string, alt: string): void {
  closeImageView()
  const viewerEl = document.createElement('div')
  viewerEl.id = 'image-viewer'
  const backdrop = document.createElement('div')
  backdrop.className = 'img-viewer-backdrop'
  backdrop.addEventListener('click', closeImageView)
  const panel = document.createElement('div')
  panel.className = 'img-viewer-panel'
  const img = document.createElement('img')
  img.src = src
  const cap = document.createElement('div')
  cap.className = 'img-viewer-caption'
  cap.textContent = alt || ''
  panel.append(img, cap)
  viewerEl.append(backdrop, panel)
  document.body.appendChild(viewerEl)
  viewer = viewerEl
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

/** `![alt](src)` → 真图片：点击放大预览；失败显示解析后的完整路径；支持 `=宽x高` 尺寸语法 */
export class ImageWidget extends WidgetType {
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
    return false
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-lp-image'
    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt
    if (this.width) img.style.width = `${this.width}px`
    if (this.height) img.style.height = `${this.height}px`
    img.addEventListener('click', (e) => {
      e.preventDefault()
      openImageView(this.src, this.alt)
    })
    img.addEventListener('error', () => {
      // 失败时显示解析后的完整路径（不是只给 alt —— alt 排查不了是路径错还是文件缺）
      wrap.classList.add('is-broken')
      let path = this.src
      try {
        path = decodeURI(this.src).replace(/^safe-file:\/\/local/, '')
      } catch {
        /* 保底原样 */
      }
      wrap.textContent = `${path}\n(${this.alt || t('w.imgBroken')})`
    })
    wrap.appendChild(img)
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
