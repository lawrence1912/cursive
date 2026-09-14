import { syntaxTree } from '@codemirror/language'
import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import { setTableEdit } from './live-preview'

/**
 * P2-2 Markdown 输入规则。
 *
 * 标题 / 引用 / 列表 / 分隔线的「所见即所得」由 live-preview 装饰器负责，
 * Enter 续行与退格删标记由 `markdownKeymap`（insertNewlineContinueMarkup /
 * deleteMarkupBackward）负责 —— 这里只补两件它们不做的：
 *
 *   1. 表格骨架：行尾是 `| a | b |` 时按回车 → 自动补分隔行 + 空数据行
 *   2. 围栏骨架：` ```ts ` 回车 → 自动补一个空行和闭合围栏，光标停在中间
 *
 * 两者都只在「行首触发的独立构造」上生效，正文里的 `|` 不会被误伤；
 * 结果是一次事务 → ⌘Z 一步撤销回触发前。
 */

/** 表格头行 → 骨架 spec；不匹配返回 null */
export function expandTableOnEnter(state: EditorState): TransactionSpec | null {
  const sel = state.selection.main
  if (!sel.empty) return null
  const line = state.doc.lineAt(sel.head)
  if (sel.head !== line.to) return null // 只在行尾回车
  const text = line.text.trim()
  if (!/^\|.*\|$/.test(text)) return null
  const cells = text.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
  if (cells.length < 2) return null
  // 已是分隔行（|---|---|）→ 不再补
  if (cells.every((c) => /^:?-+:?$/.test(c))) return null
  const delim = `| ${cells.map(() => '---').join(' | ')} |`
  const empty = `| ${cells.map(() => '   ').join(' | ')} |`
  const insert = `\n${delim}\n${empty}`
  // 光标落到空数据行的第一格
  const cursor = line.to + 1 + delim.length + 1 + 2
  return {
    changes: { from: line.to, insert },
    selection: EditorSelection.cursor(cursor),
    // 骨架一补出来就直接进就地编辑态：新表格以渲染态出现、光标已经在第一个空格子里。
    // 源代码模式下没有这个字段，CM 会原样忽略该 effect
    effects: setTableEdit.of(line.from),
    userEvent: 'input.complete'
  }
}

/** 未闭合的围栏起始行 → 补空行 + 闭合围栏 spec；不匹配返回 null */
export function expandFenceOnEnter(state: EditorState): TransactionSpec | null {
  const sel = state.selection.main
  if (!sel.empty) return null
  const line = state.doc.lineAt(sel.head)
  if (sel.head !== line.to) return null
  if (!/^(`{3,}|~{3,})[ \t]*\w*$/.test(line.text)) return null

  // 用语法树确认这是「刚打开的围栏」：FencedCode 覆盖到文档尾且没有闭围栏
  let fence: { from: number; to: number } | null = null
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(sel.head, -1); n; n = n.parent) {
    if (n.name === 'FencedCode') {
      fence = { from: n.from, to: n.to }
      break
    }
  }
  if (!fence) return null
  const body = state.doc.sliceString(fence.from, fence.to)
  const fenceLine = line.text.trim()
  const char = fenceLine[0]!
  // m 标志必需：闭围栏在后续行，没有 m 时 ^ 只匹配串首，永远数不到第二个
  const marks = new RegExp(`^\\${char}{3,}`, 'gm')
  // 出现两行围栏（开+闭）说明已闭合
  if ((body.match(marks) ?? []).length >= 2) return null

  const insert = `\n\n${fenceLine.replace(/[ \t]*\w*$/, '')}`
  return {
    changes: { from: line.to, insert },
    // 光标停在开围栏与闭围栏之间的空行
    selection: EditorSelection.cursor(line.to + 1),
    userEvent: 'input.complete'
  }
}

/** Enter 统一入口：先试表格/围栏骨架，都不匹配返回 null 交给 markdownKeymap */
export function expandOnEnter(state: EditorState): TransactionSpec | null {
  return expandTableOnEnter(state) ?? expandFenceOnEnter(state)
}
