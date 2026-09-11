import { syntaxTree } from '@codemirror/language'
import { Facet, type EditorState } from '@codemirror/state'

/**
 * 光标「碰到」多大范围就回显原始标记，直接决定手感：
 * - node  只露出光标所在的那个行内元素。最贴近 Typora，但每动一次光标就重排一次。
 * - line  光标所在整行露出源码。默认值：抖动降到「每换一行一次」，稳得多。
 * - block 整个段落/块露出。最稳，但离 Typora 最远。
 */
export type RevealScope = 'node' | 'line' | 'block'

export const revealScope = Facet.define<RevealScope, RevealScope>({
  combine: (values) => values[0] ?? 'line'
})

interface Span {
  from: number
  to: number
}

/** 把选区按 scope 展开成若干「露出源码」的区间，并判断某节点是否落在其中 */
export class Reveal {
  private readonly spans: Span[]

  constructor(state: EditorState, scope: RevealScope) {
    const raw: Span[] = []
    for (const range of state.selection.ranges) {
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

  // block：往上找到 Document 的直接子节点，也就是所在的顶层块
  let node = syntaxTree(state).resolveInner(from, 1)
  while (node.parent && node.parent.name !== 'Document') node = node.parent
  return {
    from: Math.min(node.from, from),
    to: Math.max(node.to, to)
  }
}
