import { getSearchQuery, searchPanelOpen } from '@codemirror/search'
import type { EditorState } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { searchIndex } from './search-index'

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

interface Layout {
  top: number
  height: number
  /** 有命中的像素行，挨着的连成一段：`[第一排, 最后一排]` */
  runs: [number, number][]
}

/** 查询签名：面板关着就是空串（= 不画）。文本或三个开关一变就重扫 */
function signature(state: EditorState): string {
  if (!searchPanelOpen(state)) return ''
  const q = getSearchQuery(state)
  if (!q.search || !q.valid) return ''
  return `${q.search}\u0000${q.caseSensitive}\u0000${q.regexp}\u0000${q.wholeWord}`
}

/**
 * 命中落在滚动条的哪几排像素上：每处按它那一行的顶边折算（`topOf`），同一排的合成一处，
 * 挨着的几排连成一段。刻度本来就是 2px 高、一排一条，挨着的画出来就是一整条，
 * 合成一段只是少建几个节点 —— 有几排、在哪几排，与一排一条画出来的一模一样。
 *
 * 从前这里**最多画 400 条**（「再多也只是叠在同一排像素上」）：那句话只在滚动条不到
 * 400px 高时成立。一万行、四千处命中、650px 的滚动条，第 400 条刻度落在六成高度上，
 * 下面那四成的命中一条都没画 —— 正好把「命中都在哪儿」答错了一半。
 * 现在不设上限：按排合并之后，段数天然不超过滚动条的像素高度。
 */
export function markRuns(starts: readonly number[], topOf: (pos: number) => number,
                         total: number, height: number): [number, number][] {
  const runs: [number, number][] = []
  let last: [number, number] | undefined
  for (const from of starts) {
    const y = Math.round((topOf(from) / total) * height)
    // 命中是升序来的，所以只比上一段就够
    if (last && y <= last[1] + 1) last[1] = Math.max(last[1], y)
    else runs.push((last = [y, y]))
  }
  return runs
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

  // 命中位置与查找计数共用一份（`search-index.ts`，跟着事务增量更新，最多 CAP 处）——
  // 从前这里自己再扫一遍全文，每打一个字就在测量阶段多花十几毫秒
  const found = searchIndex(view.state)
  // 正则在这一刻跑不起来（边打边搜时必然路过）：这次不画，下一次再说
  if (!found) return null
  const runs = markRuns(found.starts, (pos) => view.lineBlockAt(pos).top, total, height)
  return runs.length ? { top: scroller.offsetTop, height, runs } : null
}

/** 与上一次画的一样就不动 DOM：打一个字通常一排刻度都不变 */
function sameLayout(a: Layout | null, b: Layout | null): boolean {
  if (!a || !b) return a === b
  return a.top === b.top && a.height === b.height && a.runs.length === b.runs.length &&
    a.runs.every((r, i) => r[0] === b.runs[i]![0] && r[1] === b.runs[i]![1])
}

export const scrollMarks = ViewPlugin.fromClass(
  class {
    private readonly dom: HTMLElement
    private sig: string
    /** 上一次真的画上去的那一份（`paint` 拿它比，一样就不动 DOM） */
    private painted: Layout | null = null

    constructor(private readonly view: EditorView) {
      this.dom = document.createElement('div')
      this.dom.className = 'cm-scroll-marks'
      // 读屏没必要念它：它说的事查找框里那个计数已经念过了
      this.dom.setAttribute('aria-hidden', 'true')
      // 与 `painted = null`（什么都没画）对上：头一次量出来也是 null 时，paint 直接跳过
      this.dom.hidden = true
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
      if (sameLayout(layout, this.painted)) return
      this.painted = layout
      if (!layout) {
        if (this.dom.childElementCount) this.dom.replaceChildren()
        this.dom.hidden = true
        return
      }
      this.dom.hidden = false
      this.dom.style.top = `${layout.top}px`
      this.dom.style.height = `${layout.height}px`
      const frag = document.createDocumentFragment()
      for (const [first, lastRow] of layout.runs) {
        const el = document.createElement('div')
        el.className = 'cm-scroll-mark'
        el.style.top = `${first}px`
        // 一排一条是 2px（CSS 里的默认高）；连成一段的拉长到盖住最后一排那 2px
        if (lastRow > first) el.style.height = `${lastRow - first + 2}px`
        frag.appendChild(el)
      }
      this.dom.replaceChildren(frag)
    }
  }
)
