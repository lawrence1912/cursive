import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import { parsedTree } from './syntax'

/**
 * ⌥↑ / ⌥↓ 搬动一个**块**（0.2.x）。
 *
 * 在这之前这两个键绑的是 `defaultKeymap` 的 `moveLineUp/Down` —— 按**源码行**搬。
 * 在一个所见即所得的编辑器里，「行」几乎从来不是屏幕上那个单位：光标停在一张
 * mermaid、一段表格、一个三行的段落上时，搬走一行等于把围栏内部抽掉一行（图当场碎掉）、
 * 把表格的分隔行挪到表头上面、或者把一句话从它所在的段落里拽出来。
 *
 * 于是改成：**光标在哪个块里，搬的就是哪个块**。
 *   · 列表项里 → 那一项（连同它的子项与续行），与**同级**的上/下一项换位；
 *   · 其余 → 光标所在的顶层块（段落 / 标题 / 围栏 / 表格 / 引用 / 告示块 / 整份列表…），
 *     与相邻的顶层块换位。
 *
 * 三条边界写在这儿，省得下次再猜：
 * - **换位按整行来**，两块之间的空行原样留在中间 —— 段落之间那一个空行是 Markdown
 *   的语法，跟着某一块走的话，搬两次就会把两段粘成一段。
 * - **有序列表要重编号**：文字换了位，编号不能跟着走，否则搬一次就变成 `2.` `1.`。
 * - **多光标不接**（返回 null，调用方回退到按行搬）：两个光标落在不同块里时，
 *   「搬的是哪个块」没有说得通的答案。
 */

/** 一个可搬动的单位：整行范围 + 它在树上的那个节点 */
interface Unit {
  node: SyntaxNode
  /** 整行范围（行首到行尾，不含行尾换行） */
  from: number
  to: number
}

export function moveBlock(state: EditorState, dir: 1 | -1): TransactionSpec | null {
  // 多光标：哪个块该动没有说得通的答案，整条路让开
  if (state.selection.ranges.length !== 1) return null
  const range = state.selection.main
  const tree = parsedTree(state)
  // **两侧都要问一遍**：`resolveInner` 在边界上只朝一个方向看，而光标最常停的
  // 两个位置恰恰都是边界 —— 行尾（块的 `to`，朝右看就跨到下一块外面去了）
  // 和行首（块的 `from`，朝左看会落到上一块）。谁**占着光标这一行**谁就是答案
  const line = state.doc.lineAt(range.from)
  const unit =
    owning(unitAt(state, tree.resolveInner(range.from, -1)), line.from) ??
    owning(unitAt(state, tree.resolveInner(range.from, 1)), line.from)
  // 选区跨出了这个块（比如整段全选再往外拖了一点）：同样让开
  if (!unit || range.to > unit.to || range.from < unit.from) return null

  const sibling = siblingUnit(state, unit, dir)
  // 已经在头/尾：**吃掉这一下**（返回一个空事务），不要退回按行搬 ——
  // 「到顶了」的正确表现是原地不动，而不是把这一块的第一行单独抽出去
  if (!sibling) return { userEvent: 'move.block' }

  const [first, second] = dir === -1 ? [sibling, unit] : [unit, sibling]
  const doc = state.doc
  const firstText = doc.sliceString(first.from, first.to)
  const secondText = doc.sliceString(second.from, second.to)
  // 两块之间原样保留：可能是一个空行、两个空行，也可能一个都没有（紧挨着的列表项）
  const gap = doc.sliceString(first.to, second.from)
  const swapped = renumber(secondText, firstText, orderedPair(state, first, second))
  const insert = `${swapped.first}${gap}${swapped.second}`
  // 光标跟着它那一块走：整块位移是定值，块内的相对位置一个字都不变
  const delta = dir === -1 ? sibling.from - unit.from : sibling.to - unit.to
  return {
    changes: { from: first.from, to: second.to, insert },
    selection: EditorSelection.range(range.anchor + delta, range.head + delta),
    scrollIntoView: true,
    userEvent: 'move.block'
  }
}

/**
 * 光标那一点属于哪个单位。
 *
 * 先看有没有列表项 —— 从最里面往外走，**碰到的第一个 `ListItem` 就是最内层那个**，
 * 嵌套列表因此天然对：搬的是「这一层」的那一项，而不是整棵外层列表。
 * 没有的话取**最外面那个非 Document 的祖先** —— 注意有 front matter 时树是
 * `Document(外) > [Frontmatter, Document(内) > 各个块]` 两层，只判「父亲是 Document」
 * 会停在内层 Document 上，于是整篇文档变成一个块。
 */
function unitAt(state: EditorState, at: SyntaxNode): Unit | null {
  let top: SyntaxNode | null = null
  for (let cur: SyntaxNode | null = at; cur; cur = cur.parent) {
    if (cur.name === 'ListItem') return lines(state, cur)
    if (cur.name !== 'Document') top = cur
  }
  // front matter 不是「一块内容」，是这份文件的头 —— 它只在最顶上才成立
  if (!top || top.name === 'Frontmatter') return null
  return lines(state, top)
}

/** 同级的上/下一个。列表项之间可能夹着别的节点（`ListMark` 只在项里面），所以按名字筛 */
function siblingUnit(state: EditorState, unit: Unit, dir: 1 | -1): Unit | null {
  const want = unit.node.name === 'ListItem' ? 'ListItem' : null
  for (
    let n = dir === -1 ? unit.node.prevSibling : unit.node.nextSibling;
    n;
    n = dir === -1 ? n.prevSibling : n.nextSibling
  ) {
    if (n.name === 'Frontmatter') return null
    if (!want || n.name === want) return lines(state, n)
  }
  return null
}

/** 节点 → 它占的整行范围。`to` 落在下一行行首时要退回来（front matter 那种带尾换行的节点） */
function lines(state: EditorState, node: SyntaxNode): Unit {
  const doc = state.doc
  const head = doc.lineAt(node.from)
  const tailAt = Math.min(Math.max(node.to, node.from), doc.length)
  const tail = doc.lineAt(tailAt > node.from && doc.lineAt(tailAt).from === tailAt ? tailAt - 1 : tailAt)
  return { node, from: head.from, to: tail.to }
}

/** 两块的首行编号（都是有序列表项才有）。换位之后编号要留在原地，不能跟着文字走 */
function orderedPair(state: EditorState, first: Unit, second: Unit): [string, string] | null {
  if (first.node.name !== 'ListItem' || second.node.name !== 'ListItem') return null
  const a = MARKER.exec(state.doc.lineAt(first.from).text)
  const b = MARKER.exec(state.doc.lineAt(second.from).text)
  return a && b ? [a[2]!, b[2]!] : null
}

const MARKER = /^(\s*)(\d+)([.)])/

/**
 * 换位之后把编号摆回原位。
 *
 * 不重编整份列表 —— 只有这两项调了位置，其余那些的号码本来就还是对的；
 * 而整份重编会把「从 3 开始」这种写法悄悄改掉，那不是用户按 ⌥↑ 要的。
 */
function renumber(
  first: string,
  second: string,
  nums: [string, string] | null
): { first: string; second: string } {
  if (!nums) return { first, second }
  return { first: withNumber(first, nums[0]), second: withNumber(second, nums[1]) }
}

function withNumber(text: string, n: string): string {
  return text.replace(MARKER, (_, pad: string, __: string, delim: string) => `${pad}${n}${delim}`)
}

/** 这一块占着光标那一行吗。光标停在两块之间的空行上时两边都不占 —— 那就让开 */
function owning(unit: Unit | null, lineFrom: number): Unit | null {
  return unit && unit.from <= lineFrom && lineFrom <= unit.to ? unit : null
}
