import { pointerSelection } from '../pointer-selection'
import { Facet, type EditorState } from '@codemirror/state'
import { parsedTree } from '../syntax'

/**
 * 光标「碰到」多大范围就回显原始标记，直接决定手感：
 * - node  只露出光标所在的那个行内元素。最贴近纯所见即所得，但每动一次光标就重排一次。
 * - line  光标所在整行露出源码。默认值：抖动降到「每换一行一次」，稳得多。
 * - block 整个段落/块露出。最稳，但离所见即所得最远。
 */
export type RevealScope = 'node' | 'line' | 'block'

export const revealScope = Facet.define<RevealScope, RevealScope>({
  combine: (values) => values[0] ?? 'line'
})

export interface Span {
  from: number
  to: number
}

/** 把选区按 scope 展开成若干「露出源码」的区间，并判断某节点是否落在其中 */
export class Reveal {
  private readonly spans: Span[]

  constructor(state: EditorState, scope: RevealScope) {
    const raw: Span[] = []
    // 第八节 5 只读：**渲染效果钉住**，光标走到哪儿都不翻回源码 —— 回显源码是为了改，
    // 而只读的时候不改。选区、复制、查找照样落在源码坐标上，只是看的那一面一直是渲染态
    if (state.readOnly) {
      this.spans = []
      return
    }
    const selection = state.field(pointerSelection, false) ?? state.selection
    for (const range of selection.ranges) {
      raw.push(expand(state, range.from, range.to, scope))
    }
    raw.sort((a, b) => a.from - b.from)

    // 合并重叠区间，多光标时避免重复判断
    this.spans = []
    for (const span of raw) {
      const last = this.spans[this.spans.length - 1]
      if (last && span.from <= last.to) last.to = Math.max(last.to, span.to)
      else this.spans.push({ ...span })
    }
  }

  /**
   * 展开并合并之后的露出区间（按 from 升序）。
   * 选区一动，会翻面的块级装饰只可能与「动前」「动后」这些区间相交 ——
   * `live-preview` 的增量重建按这个算脏区（见那边的 `patchBlocks`）。
   */
  get ranges(): readonly Span[] {
    return this.spans
  }

  /** 节点与任一露出区间有交集就回显源码 */
  touches(from: number, to: number): boolean {
    for (const span of this.spans) {
      if (span.from > to) break
      if (span.to >= from) return true
    }
    return false
  }
}

function expand(state: EditorState, from: number, to: number, scope: RevealScope): Span {
  if (scope === 'node') return { from, to }

  if (scope === 'line') {
    return { from: state.doc.lineAt(from).from, to: state.doc.lineAt(to).to }
  }

  // block：往上找到 Document 的直接子节点，也就是所在的顶层块。
  // 树要盖住光标那一点（`parsedTree`，不是裸快照）：正文没解析到的那一段落在外层
  // front matter 语法的 `Body` 上，往上撑就是从 front matter 之后到文末的整篇 ——
  // 一次没解析完的整篇替换之后，整篇文档会一齐翻回源码（见 syntax.ts 的 `parsedExtent`）
  let node = parsedTree(state, Math.min(from + 1, state.doc.length)).resolveInner(from, 1)
  while (node.parent && node.parent.name !== 'Document') node = node.parent
  return {
    from: Math.min(node.from, from),
    to: Math.max(node.to, to)
  }
}
