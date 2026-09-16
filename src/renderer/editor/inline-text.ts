import type { EditorState } from '@codemirror/state'
import { EMOJI } from './emoji'
import { parsedTree } from './syntax'

/**
 * 纯语法标记节点：渲染成人看的文字时一律藏掉，只留内容。
 *
 * 这份表是**唯一真相**，表格格内片段（`live-preview/table.ts` 的 `cellTokens`）与
 * 大纲/TOC 的标题文本（`headings.ts`）共用它 —— 两处各留一份的话，加一种行内语法
 * 就会出现「表格认得、大纲不认」的漂移。
 */
export const INLINE_MARKS = new Set([
  'EmphasisMark',
  'CodeMark',
  'StrikethroughMark',
  'HighlightMark',
  'SuperscriptMark',
  'SubscriptMark',
  'LinkMark',
  'LinkTitle',
  // 引用式链接 `[文字][id]` 里的 `[id]`。定义那一行 `[id]: 地址` 整行不会走到这儿
  // （标题和表格格子里放不下一条定义），所以不必再按父节点分情况
  'LinkLabel',
  'MathMark',
  // 尺寸图片的 ` =600x400` 那一段（markdown-lang.ts 的 SizedImage）
  'SizeMark',
  // 标题的 `##` 与 setext 的 `=====` 都是它。表格格里出现不了，放进公共表无副作用
  'HeaderMark'
])

/**
 * 行内语法标记、以及链接/图片的目的地：渲染成人看的文字时一律藏掉，只留内容。
 *
 * 表格格内（`live-preview/table.ts` 的 `cellTokens`）与标题取词（下面的 `plainInline`）
 * 共用这一条判断 —— 各写一份的话，加一种行内语法就会出现「表格认得、大纲不认」的漂移。
 *
 * 图片的 URL 也要藏：`## ![图](a.png)` 剪出来的标题文字只该是 `图`，
 * 把 `a.png` 一起带出来的话，大纲和 TOC 里会挂着一条文件路径。
 */
export function isHiddenInline(name: string, parent?: string): boolean {
  return INLINE_MARKS.has(name) || (name === 'URL' && (parent === 'Link' || parent === 'Image'))
}

/**
 * 把 [from,to) 这段源码摘成纯文本：语法标记去掉，链接只留文字，
 * `:smile:` 换成字符，`\*` 只脱反斜杠。**读的是文档自己的语法树**，
 * 与正文同一套方言（roadmap 反复强调的「别另写小解析器」）。
 *
 * 取树走 `parsedTree`：调用方即使已经全文 ensure 过，`syntaxTree(state)` 那份快照
 * 也可能还是旧的（见 `editor/syntax.ts`），首开时深处的标题会摘成裸源码。
 */
export function plainInline(state: EditorState, from: number, to: number): string {
  let out = ''
  let pos = from

  const flush = (end: number): void => {
    if (end > pos) out += state.doc.sliceString(pos, end)
    pos = Math.max(pos, end)
  }

  parsedTree(state).iterate({
    from,
    to,
    enter: (node) => {
      // 祖先（Document / Paragraph / ATXHeading…）只管往下走，不产出文字
      if (node.from < from || node.to > to) return
      const name = node.name
      if (isHiddenInline(name, node.node.parent?.name)) {
        flush(node.from)
        pos = Math.max(pos, node.to)
        return false
      }
      if (name === 'Escape') {
        flush(node.from)
        pos = node.from + 1 // 只脱反斜杠，被转义的字符照常出现
        return false
      }
      if (name === 'Emoji') {
        const char = EMOJI[state.doc.sliceString(node.from + 1, node.to - 1)]
        if (!char) return false
        flush(node.from)
        out += char
        pos = node.to
        return false
      }
      return
    }
  })
  flush(to)
  return out
}
