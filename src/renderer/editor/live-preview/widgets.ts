import katex from 'katex'
import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'

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
/** mermaid 约 1MB，动态 import 让 Vite 切成独立 chunk，打开普通文档不背这个成本 */
function loadMermaid() {
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

/** 从 FencedCode 的源码文本里拆出语言与代码体（闭围栏存在则去掉） */
export function extractFence(text: string): { lang: string; src: string } | null {
  const nl = text.indexOf('\n')
  if (nl < 0) return null
  const open = /^(`{3,}|~{3,})[ \t]*(.*)$/.exec(text.slice(0, nl))
  if (!open) return null
  const lang = (open[2] ?? '').trim().split(/\s+/)[0] ?? ''
  const lines = text.slice(nl + 1).split('\n')
  const last = lines[lines.length - 1]
  if (last !== undefined && /^\s*(`{3,}|~{3,})\s*$/.test(last)) lines.pop()
  return { lang, src: lines.join('\n') }
}

// ---------- 方言补齐（P1-3）：脚注 / emoji / TOC ----------

export interface TocEntry {
  level: number
  text: string
  pos: number
}

/** 收集全文 ATX 标题（调前需保证语法树已就绪，blockField 已全文 ensure） */
export function collectHeadings(state: EditorState): TocEntry[] {
  const out: TocEntry[] = []
  syntaxTree(state).iterate({
    enter(n) {
      const m = /^ATXHeading([1-6])$/.exec(n.name)
      if (!m) return
      out.push({
        level: Number(m[1]),
        text: state.doc.sliceString(n.from, n.to).replace(/^#+\s*/, ''),
        pos: n.from
      })
    }
  })
  return out
}

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
    head.textContent = '目录'
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

/** `![alt](src)` → 真图片，加载失败退回显示 alt */
export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string
  ) {
    super()
  }
  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-lp-image'
    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt
    img.addEventListener('error', () => {
      wrap.classList.add('is-broken')
      wrap.textContent = this.alt || '图片加载失败'
    })
    wrap.appendChild(img)
    return wrap
  }
}

// ---------- GFM 表格 ----------
// 光标碰到时回显管道符源码（decorate.ts 的 .cm-lp-table），
// 否则整个块替换成真表格。块级装饰必须由 StateField 提供（见 index.ts 的 tableField）。

export interface TableData {
  aligns: ('left' | 'center' | 'right')[]
  header: string[]
  rows: string[][]
}

/** 单元格里的 `\|` 转义先换成占位符再切列，避免被当成边界 */
const ESC = '\u0000'

function splitRow(line: string): string[] {
  const body = line
    .trim()
    .replace(/\\\|/g, ESC)
    .replace(/^\|/, '')
    .replace(/\|$/, '')
  return body.split('|').map((c) => c.trim().split(ESC).join('|'))
}

/**
 * 行内第 index 格「文字」的区间（相对行首），给「点单元格 → 光标落进对应源码」定位。
 * 切列规则与 splitRow 对齐：先 trim，再吃掉首尾各一根管道符，中间按 | 切。
 * `\|` 先换成两个占位符（同样两个字符，偏移不变），免得被当成列边界。
 */
export function cellSpan(line: string, index: number): { from: number; to: number } | null {
  const masked = line.replace(/\\\|/g, ESC + ESC)
  let start = 0
  let end = masked.length
  while (start < end && /\s/.test(masked[start]!)) start++
  while (end > start && /\s/.test(masked[end - 1]!)) end--
  if (masked[start] === '|') start++
  if (end > start && masked[end - 1] === '|') end--

  let from = start
  let seen = 0
  for (let i = start; i <= end; i++) {
    if (i < end && masked[i] !== '|') continue
    if (seen === index) {
      let f = from
      let t = i
      while (f < t && /\s/.test(masked[f]!)) f++
      while (t > f && /\s/.test(masked[t - 1]!)) t--
      return { from: f, to: t }
    }
    seen++
    from = i + 1
  }
  return null
}

/** 解析 GFM 管道表格；结构不合法（少于 2 行 / 分隔行不合规）返回 null */
export function parseTable(text: string): TableData | null {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  if (lines.length < 2) return null
  const delimCells = splitRow(lines[1])
  if (delimCells.length === 0 || !delimCells.every((c) => /^:?-+:?$/.test(c))) return null
  const aligns = delimCells.map((c) => {
    const left = c.startsWith(':')
    const right = c.endsWith(':')
    if (left && right) return 'center' as const
    if (right) return 'right' as const
    return 'left' as const
  })
  const header = splitRow(lines[0])
  if (header.length === 0) return null
  const rows = lines.slice(2).map((l) => splitRow(l))
  return { aligns, header, rows }
}

export class TableWidget extends WidgetType {
  constructor(readonly data: TableData) {
    super()
  }
  eq(other: TableWidget): boolean {
    return JSON.stringify(other.data) === JSON.stringify(this.data)
  }
  /**
   * 默认实现返回 true = widget 里发生的事件编辑器一概不管，于是「点进表格改一个字」
   * 根本做不到（CM 的 eventBelongsToEditor 会直接判定事件不属于编辑器）。
   * 只放行 mousedown：index.ts 的 editTableOnClick 接住它，把光标送进对应的源码格；
   * 其余事件继续忽略 —— 放行 DOM 变更/选区同步会让 widget 内容被当成编辑输入写回文档。
   */
  override ignoreEvent(event: Event): boolean {
    return event.type !== 'mousedown'
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-lp-tableview'
    const table = document.createElement('table')

    const thead = table.createTHead()
    const hr = thead.insertRow()
    this.data.header.forEach((cell, i) => {
      const th = document.createElement('th')
      th.textContent = cell
      th.style.textAlign = this.data.aligns[i] ?? 'left'
      hr.appendChild(th)
    })

    const tbody = table.createTBody()
    for (const row of this.data.rows) {
      const tr = tbody.insertRow()
      this.data.header.forEach((_, i) => {
        const td = tr.insertCell()
        td.style.textAlign = this.data.aligns[i] ?? 'left'
        td.textContent = row[i] ?? ''
      })
    }

    wrap.appendChild(table)
    return wrap
  }
}
