import { getSearchQuery, searchPanelOpen } from '@codemirror/search'
import type { EditorState } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

/**
 * 查找命中画在滚动条上（0.2.x）。
 *
 * 在这之前，「这份文档里还有几处、都在哪儿」只有查找框里一个计数 —— 一万行的稿子里
 * 想知道命中是集中在开头还是散在全篇，只能一路按 ⌘G 数过去。这条刻度把答案直接
 * 摆在滚动条上（VS Code 的 overview ruler、Sublime 的 minimap 标记是同一个东西）。
 *
 * 三个分寸：
 * - **只在查找面板开着时画**。查询串会在 state 里留着，面板一关就不该再有刻度 ——
 *   那是「我正在找」的信号，不是文档的属性。
 * - **不用滚就不画**：内容没超过一屏时，滚动条本身都不存在，刻度无处可去也无处可去。
 * - **按高度不按行号**：一张图、一张表在屏幕上占的高度远不止一行，按行号折算的刻度
 *   会和滚动条上的实际位置差出半屏。`lineBlockAt().top / contentHeight` 才是它在
 *   这根轴上真正的位置（高度还没量准的那些用的是 CM 的估值，随后 `geometryChanged` 会重画）。
 */

/** 画出来的刻度上限：再多也只是叠在同一排像素上 */
const MAX_MARKS = 400
/** 扫描上限（同 `search-panel.ts` 的 CAP 精神）：别为一个 `.` 把整篇数一遍 */
const SCAN_CAP = 5000

interface Layout {
  top: number
  height: number
  marks: number[]
}

/** 查询签名：面板关着就是空串（= 不画）。文本或三个开关一变就重扫 */
function signature(state: EditorState): string {
  if (!searchPanelOpen(state)) return ''
  const q = getSearchQuery(state)
  if (!q.search || !q.valid) return ''
  return `${q.search}\u0000${q.caseSensitive}\u0000${q.regexp}\u0000${q.wholeWord}`
}

/**
 * 命中落在这根轴上的哪些像素行。**在 measure 的 read 阶段调**（要读 `contentHeight`
 * 与 `clientHeight`）。返回 null = 这次什么都不该画。
 */
export function collectMarks(view: EditorView): Layout | null {
  if (!signature(view.state)) return null
  const scroller = view.scrollDOM
  const height = scroller.clientHeight
  const total = view.contentHeight
  // 不用滚 = 整篇都在眼前，没有「在哪儿」这回事
  if (height <= 0 || total <= height + 1) return null

  const marks: number[] = []
  let last = -1
  try {
    const cursor = getSearchQuery(view.state).getCursor(view.state)
    let scanned = 0
    for (let r = cursor.next(); !r.done && scanned < SCAN_CAP; r = cursor.next()) {
      scanned++
      const y = Math.round((view.lineBlockAt(r.value.from).top / total) * height)
      // 命中是升序来的，所以只比上一条就够：同一排像素上的几处合成一条
      if (y === last) continue
      last = y
      marks.push(y)
      if (marks.length >= MAX_MARKS) break
    }
  } catch {
    // 正则在这一刻不合法（边打边搜时必然路过）：这次不画，下一次再说
    return null
  }
  return marks.length ? { top: scroller.offsetTop, height, marks } : null
}

export const scrollMarks = ViewPlugin.fromClass(
  class {
    private readonly dom: HTMLElement
    private sig: string

    constructor(private readonly view: EditorView) {
      this.dom = document.createElement('div')
      this.dom.className = 'cm-scroll-marks'
      // 读屏没必要念它：它说的事查找框里那个计数已经念过了
      this.dom.setAttribute('aria-hidden', 'true')
      view.dom.appendChild(this.dom)
      this.sig = signature(view.state)
      this.schedule()
    }

    update(u: ViewUpdate): void {
      const sig = signature(u.state)
      const changed = sig !== this.sig
      this.sig = sig
      // 滚动**不用**重画：这根刻度画的是整份文档，与视口在哪儿无关
      if (changed || u.docChanged || u.geometryChanged) this.schedule()
    }

    destroy(): void {
      this.dom.remove()
    }

    /** 读几何 → 写 DOM 分两段走 CM 的测量周期，别在 update 里现读现写 */
    private schedule(): void {
      this.view.requestMeasure({
        key: this,
        read: (view) => collectMarks(view),
        write: (layout) => this.paint(layout)
      })
    }

    private paint(layout: Layout | null): void {
      if (!layout) {
        if (this.dom.childElementCount) this.dom.replaceChildren()
        this.dom.hidden = true
        return
      }
      this.dom.hidden = false
      this.dom.style.top = `${layout.top}px`
      this.dom.style.height = `${layout.height}px`
      const frag = document.createDocumentFragment()
      for (const y of layout.marks) {
        const el = document.createElement('div')
        el.className = 'cm-scroll-mark'
        el.style.top = `${y}px`
        frag.appendChild(el)
      }
      this.dom.replaceChildren(frag)
    }
  }
)
