import { redo, undo } from '@codemirror/commands'
import {
  StateEffect,
  StateField,
  Transaction,
  type EditorState,
  type Line,
  type TransactionSpec
} from '@codemirror/state'
import { EditorView, WidgetType, type KeyBinding } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { t, type Key } from '../../i18n'
import { docDir } from '../doc-dir'
import { EMOJI } from '../emoji'
import { openTarget, resolveLink } from '../link'
import { isHiddenInline } from '../inline-text'
import { clipboardMarkdown } from '../paste'
import { note } from '../../ui/note'
import { parsedTree } from '../syntax'
import { Reveal, revealScope } from './reveal'
import { fillMath } from './widgets'

/**
 * GFM 表格：块级渲染成真表格，并且**就地可编辑** —— 点进单元格不再把整块换回管道符源码。
 * 完整设计与 CM6 侧的依据见 docs/table-editing.md，这里只留「改代码时必须知道」的注释。
 *
 * 三条地基（都在 @codemirror/view 6.43 里核过）：
 *   1. widget 里的 DOM 变更 CM 一律不读（readMutation 命中 widget tile 直接 return null），
 *      所以格子可以开 contenteditable 让浏览器随便改；
 *   2. 焦点在格子里（activeElement != contentDOM）时 CM 既不读选区也不写选区，
 *      于是 reveal 判定不会被触发，表格稳稳留在渲染态；
 *   3. updateDOM 返回 true 就复用 DOM —— 每次 dispatch 后 DOM 不重建，焦点和光标才不会丢。
 *
 * 代价：ignoreEvent 全忽略之后，格子里的按键**不进 CM keymap**（Tab 不缩进、回车不插行），
 * 所有键都得自己接；⌘Z/⌘⇧Z 也必须显式转发给 history。
 */

// ---------- 解析 ----------

export type Align = 'left' | 'center' | 'right'

export interface TableData {
  aligns: Align[]
  header: string[]
  rows: string[][]
  /**
   * 格内行内语法的渲染片段，`rich[row][col]`（row 0 = 表头）。
   * 纯文本格子是 null —— 绝大多数格子都走这条，不为它们分配任何东西。
   * 由 `tableDataAt()` 从**文档的语法树**上采（不是另写一个小解析器），
   * 所以格里的 `**粗体**` 和正文里的 `**粗体**` 永远是同一套方言。
   */
  rich?: (CellToken[] | null)[][]
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
 * 行内第 index 格「文字」的区间（相对行首），给「单元格 ↔ 源码」双向定位。
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

/**
 * 行内各格的「槽位」：两根列分隔符之间的**整段**（含 padding，不含分隔符本身）。
 * cellSpan 给的是槽位里 trim 过的文字，增删列要动的却是整个槽位，所以另开一个。
 * 切法与 splitRow / cellSpan 完全一致，三者必须同进同退。
 */
function slots(line: string): { from: number; to: number }[] {
  const masked = line.replace(/\\\|/g, ESC + ESC)
  let start = 0
  let end = masked.length
  while (start < end && /\s/.test(masked[start]!)) start++
  while (end > start && /\s/.test(masked[end - 1]!)) end--
  if (masked[start] === '|') start++
  if (end > start && masked[end - 1] === '|') end--

  const out: { from: number; to: number }[] = []
  let from = start
  for (let i = start; i <= end; i++) {
    if (i < end && masked[i] !== '|') continue
    out.push({ from, to: i })
    from = i + 1
  }
  return out
}

/** 等宽字体下的显示宽度：CJK / 全角算 2 列。「整理对齐」要靠它，中英混排才能真的对齐 */
export function displayWidth(text: string): number {
  let w = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    const wide =
      c >= 0x1100 &&
      (c <= 0x115f ||
        c === 0x2329 ||
        c === 0x232a ||
        (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
        (c >= 0xac00 && c <= 0xd7a3) ||
        (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0xfe30 && c <= 0xfe6f) ||
        (c >= 0xff00 && c <= 0xff60) ||
        (c >= 0xffe0 && c <= 0xffe6) ||
        (c >= 0x20000 && c <= 0x3fffd))
    w += wide ? 2 : 1
  }
  return w
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

// ---------- 编辑态（CM 选区 = 「在编辑哪一格」的唯一真相） ----------

/** 进入/退出就地编辑；值 = 表格块起点 */
export const setTableEdit = StateEffect.define<number | null>({
  map: (v, ch) => (v == null ? null : ch.mapPos(v))
})

function isHistory(tr: Transaction): boolean {
  const ue = tr.annotation(Transaction.userEvent)
  return ue === 'undo' || ue === 'redo' || ue === 'select.undo' || ue === 'select.redo'
}

/**
 * 正在就地编辑的表格块起点。
 * 规则：带 setTableEdit 就照它走；否则**任何改文档/改选区的事务都清空它** ——
 * widget 自己发的每一笔都必须重新带上 effect，换来的是「切标签回来、外部重载、
 * 点到别处」这些路径上的编辑态自动失效，不留悬空。
 * 唯一的例外是 ⌘Z/⌘⇧Z：那是从格子里转发出去的，不算离开表格。
 */
export const tableEditField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setTableEdit)) return e.value
    if (value == null) return null
    if (isHistory(tr)) return tr.changes.mapPos(value)
    if (!tr.docChanged && !tr.selection) return value
    // **光标还在这张表里就留着编辑态**（0.4.0 修）。
    //
    // 从前这儿是「文档变了或选区动了一律清掉」，于是 `/table` 插完的那张新表
    // （靠 `setTableEdit` 才以渲染态出现、焦点就在第一格里）**撑不过下一个事务**：
    // 滚动、聚焦、随便按一下键都带着选区，编辑态当场没了，而光标还在表里 ——
    // 表格于是回落成源码。症状就是「/table 输出的表格显示源码」。
    //
    // 现在只在**光标真的离开这张表**时才退出。格间移动、插完那一下、
    // 在格子里打字（`writeCell` 本来就会再发一次效应）全都留在渲染态。
    const at = tr.docChanged ? tr.changes.mapPos(value, 1) : value
    return editStillLive(tr.state, at) ? at : null
  }
})

/** 那张表还在原地、而且光标还落在它里面 */
function editStillLive(state: EditorState, from: number): boolean {
  if (from < 0 || from >= state.doc.length) return false
  const head = state.selection.main.head
  for (
    let n: SyntaxNode | null = parsedTree(state).resolveInner(Math.min(from + 1, state.doc.length), 1);
    n;
    n = n.parent
  ) {
    if (n.name !== 'Table') continue
    return n.from === from && head >= n.from && head <= n.to
  }
  return false
}

/** 取字段必须允许缺失：源代码模式撤掉了整套扩展，单测也只装了 markdown 语言包 */
export function tableEditAt(state: EditorState): number | null {
  return state.field(tableEditField, false) ?? null
}

/** 表格此刻是否以渲染态存在（widget 在、没回落源码） */
export function tableRendered(
  state: EditorState,
  reveal: Reveal,
  from: number,
  to: number
): boolean {
  return tableEditAt(state) === from || !reveal.touches(from, to)
}

// ---------- 源码定位与改写 ----------

/** DOM 行号（0 = 表头，1.. = 正文）→ 表内源码行下标；源码第 2 行是分隔行，DOM 里没有它 */
function lineOfRow(row: number): number {
  return row === 0 ? 0 : row + 1
}

function rowLine(state: EditorState, tableFrom: number, row: number) {
  const no = state.doc.lineAt(tableFrom).number + lineOfRow(row)
  return no <= state.doc.lines ? state.doc.line(no) : null
}

/** 分隔行 = 源码第 2 行（它不在 DOM 里，也就没有对应的 row 号）；GFM 的列数以它为准 */
function delimLine(state: EditorState, tableFrom: number) {
  const no = state.doc.lineAt(tableFrom).number + 1
  return no <= state.doc.lines ? state.doc.line(no) : null
}

/** 第 row 行第 col 格文字在文档里的区间；该行压根没有这一格时返回 null */
export function cellPos(
  state: EditorState,
  tableFrom: number,
  row: number,
  col: number
): { from: number; to: number } | null {
  const line = rowLine(state, tableFrom, row)
  if (!line) return null
  const span = cellSpan(line.text, col)
  return span ? { from: line.from + span.from, to: line.from + span.to } : null
}

/**
 * 粘进格子的那段文本（0.4.0 还的第二条账）。
 *
 * **表格行就是一行，格子里放不下换行** —— 多行并成空格分隔的一行，并把行数报出来，
 * 让调用方说一句。从前是默默压扁（`escapeCell` 里那条 `[\r\n]+ → ' '`），
 * 人只会觉得「怎么少了两行」。空行直接丢：从网页复制的段落之间常夹着空行。
 */
export function cellPasteText(md: string): { text: string; lines: number } {
  const lines = md.split(/\r\n?|\n/).filter((l) => l.trim() !== '')
  return { text: lines.join(' ').trim(), lines: lines.length }
}

/** 写进单元格的文本：`|` 要转义、换行压成空格（粘贴多行时全靠这条兜） */
export function escapeCell(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').trim()
}

/**
 * 改一格 = 只替换那一格文字的区间，行里其余字节（padding、竖线）一个不动。
 * 「保存零损耗」的表格版：nomo 那种 AST 往返会把整张表重排，这里不会。
 * caret = 光标在新文本里的偏移，用来把 CM 选区钉在同一个地方。
 */
export function writeCell(
  state: EditorState,
  tableFrom: number,
  row: number,
  col: number,
  text: string,
  caret = -1
): TransactionSpec | null {
  const line = rowLine(state, tableFrom, row)
  if (!line) return null
  const insert = escapeCell(text)
  const edit = cellEdit(line, col, insert)
  if (!edit) return null
  const at = caret < 0 ? insert.length : Math.min(caret, insert.length)
  return {
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: { anchor: edit.from + edit.textAt + at },
    effects: setTableEdit.of(tableFrom),
    // 连打归并成一条撤销记录，别一个字符一步
    userEvent: 'input.type'
  }
}

interface CellEdit {
  from: number
  to: number
  insert: string
  /** 单元格文字在 insert 里的起点，用来把光标钉回原位 */
  textAt: number
}

function cellEdit(line: Line, col: number, text: string): CellEdit | null {
  const span = cellSpan(line.text, col)
  if (!span) return padCell(line, col, text)
  if (span.from < span.to || !text) {
    return { from: line.from + span.from, to: line.from + span.to, insert: text, textAt: 0 }
  }
  // 空格子：cellSpan 给的是竖线之间那段空白收缩成的零长区间，直接往里塞会写成
  // `|   x|`。把整段空白一起换掉，落到源码里才是 `| x |`
  let f = span.from
  let t = span.to
  while (f > 0 && line.text[f - 1] === ' ') f--
  while (t < line.text.length && line.text[t] === ' ') t++
  return { from: line.from + f, to: line.from + t, insert: ` ${text} `, textAt: 1 }
}

/** 破行（GFM 允许 `| a |` 出现在三列表里）：先把竖线补够再写那一格 */
function padCell(line: Line, col: number, text: string): CellEdit | null {
  const have = splitRow(line.text).length
  if (col < have) return null
  const missing = col - have + 1
  if (/\|\s*$/.test(line.text)) {
    const at = line.text.lastIndexOf('|')
    const lead = '|  '.repeat(missing - 1) + '| '
    return {
      from: line.from + at,
      to: line.from + at,
      insert: `${lead}${text} `,
      textAt: lead.length
    }
  }
  const lead = ' | '.repeat(missing - 1) + ' | '
  const end = line.from + line.text.length
  return { from: end, to: end, insert: lead + text, textAt: lead.length }
}

/** 在第 row 行后面插一行空格子，首尾竖线风格照抄它自己那一行；光标落到第 col 格 */
export function insertRowAfter(
  state: EditorState,
  tableFrom: number,
  row: number,
  col = 0
): TransactionSpec | null {
  const model = rowLine(state, tableFrom, row)
  const delim = delimLine(state, tableFrom)
  // 表头后面那一行是分隔行，新行得落在它之后 —— 插进表头和分隔行中间会把表拆散
  const after = row === 0 ? delim : model
  if (!model || !delim || !after) return null
  const cols = splitRow(delim.text).length
  const lead = /^\s*\|/.test(model.text) ? '|' : ''
  const trail = /\|\s*$/.test(model.text) ? '|' : ''
  const text = lead + Array.from({ length: cols }, () => '   ').join('|') + trail
  const span = cellSpan(text, Math.min(col, cols - 1))
  return {
    changes: { from: after.to, insert: `\n${text}` },
    selection: { anchor: after.to + 1 + (span ? span.from : 0) },
    effects: setTableEdit.of(tableFrom),
    userEvent: 'input'
  }
}

// ---------- 结构改写（工具栏 / 手柄用；全是纯函数，单测不碰 DOM） ----------

/**
 * 表格块占的行号区间。
 * 有语法树就直接问它；单测里只建了裸 EditorState（`syntaxTree` 是空树），
 * 退化成「往下吃连续的、非空且含竖线的行」—— 模块其余部分（rowLine / delimLine）
 * 本来也只认 doc，不认树。
 */
function tableLines(state: EditorState, tableFrom: number): { first: number; last: number } {
  const doc = state.doc
  const first = doc.lineAt(tableFrom).number
  const node = tableNodeAt(state, tableFrom)
  if (node) return { first, last: doc.lineAt(node.to).number }
  let last = first
  while (last < doc.lines) {
    const text = doc.line(last + 1).text
    if (!text.trim() || !text.includes('|')) break
    last++
  }
  return { first, last }
}

/** 整块表格的源码（工具栏要现算一份 TableData，不吃 widget 实例里的旧数据） */
export function tableAt(state: EditorState, tableFrom: number): TableData | null {
  const { first, last } = tableLines(state, tableFrom)
  return parseTable(state.doc.sliceString(state.doc.line(first).from, state.doc.line(last).to))
}

/** 删掉第 row 行（row 0 是表头，删不得）。连着行末换行一起删，别留空行 */
export function deleteRow(
  state: EditorState,
  tableFrom: number,
  row: number
): TransactionSpec | null {
  if (row <= 0) return null
  const line = rowLine(state, tableFrom, row)
  if (!line) return null
  const tail = line.to < state.doc.length
  return {
    changes: tail ? { from: line.from, to: line.to + 1 } : { from: line.from - 1, to: line.to },
    effects: setTableEdit.of(tableFrom),
    userEvent: 'delete'
  }
}

/**
 * 在第 at 列**之前**插一列（at = 列数则追加到末尾）；光标落进 row 行的新格子。
 * 每行只发一条「在槽位边界插入」的 change —— 其余列的 padding 一个字节不动。
 */
export function insertColAt(
  state: EditorState,
  tableFrom: number,
  at: number,
  row = 0
): TransactionSpec | null {
  const { first, last } = tableLines(state, tableFrom)
  if (last < first + 1) return null
  const target = first + lineOfRow(row)
  const changes: { from: number; insert: string }[] = []
  let anchor = -1
  let delta = 0

  for (let no = first; no <= last; no++) {
    const line = state.doc.line(no)
    const body = no === first + 1 ? ' --- ' : '   '
    const sl = slots(line.text)
    const rel = line.text.replace(/\s+$/, '').length
    let pos: number
    let insert: string
    if (at < sl.length) {
      pos = sl[at]!.from
      insert = `${body}|`
    } else {
      // 追加到行尾：原来的尾边界竖线顺势变成新格的左分隔符，再补一根新尾边界。
      // 没有尾边界的写法（`a | b`）必须补上一根，否则空的末格根本不可表达
      // —— splitRow 会把结尾那根竖线当边界吃掉，格数根本不涨。
      pos = rel
      insert = /\|$/.test(line.text.slice(0, rel)) ? `${body}|` : ` |${body}|`
    }
    changes.push({ from: line.from + pos, insert })
    if (no === target) {
      const text = line.text.slice(0, pos) + insert + line.text.slice(pos)
      anchor = line.from + delta + (cellSpan(text, at)?.from ?? pos)
    }
    delta += insert.length
  }

  return {
    changes,
    ...(anchor >= 0 ? { selection: { anchor } } : {}),
    effects: setTableEdit.of(tableFrom),
    userEvent: 'input'
  }
}

/** 删掉第 col 列（含它的分隔符）；只剩一列时拒绝 —— 那就不是表格了 */
export function deleteCol(
  state: EditorState,
  tableFrom: number,
  col: number
): TransactionSpec | null {
  const { first, last } = tableLines(state, tableFrom)
  const delim = delimLine(state, tableFrom)
  if (!delim || slots(delim.text).length <= 1) return null
  const changes: { from: number; to: number }[] = []
  for (let no = first; no <= last; no++) {
    const line = state.doc.line(no)
    const sl = slots(line.text)
    // 破行（格子不够）原样放过：它本来就没有这一列可删
    if (col >= sl.length || sl.length <= 1) continue
    // 删中间列连它右边的分隔符一起走；删末列则连它左边的
    const lastCol = col === sl.length - 1
    const from = lastCol ? sl[col - 1]!.to : sl[col]!.from
    const to = lastCol ? sl[col]!.to : sl[col + 1]!.from
    changes.push({ from: line.from + from, to: line.from + to })
  }
  if (!changes.length) return null
  return { changes, effects: setTableEdit.of(tableFrom), userEvent: 'delete' }
}

/**
 * 整列对齐：只改分隔行那一格，`---` → `:--` / `:-:` / `--:`。
 * 冒号是从破折号里**换**出来的，格子宽度不变 —— 否则每点一次对齐，源码就宽一格。
 */
export function setAlign(
  state: EditorState,
  tableFrom: number,
  col: number,
  align: Align
): TransactionSpec | null {
  const line = delimLine(state, tableFrom)
  if (!line) return null
  const span = cellSpan(line.text, col)
  if (!span) return null
  const left = align === 'left' || align === 'center'
  const right = align === 'right' || align === 'center'
  const bars = Math.max(1, span.to - span.from - (left ? 1 : 0) - (right ? 1 : 0))
  const insert = `${left ? ':' : ''}${'-'.repeat(bars)}${right ? ':' : ''}`
  if (insert === line.text.slice(span.from, span.to)) return null
  return {
    changes: { from: line.from + span.from, to: line.from + span.to, insert },
    effects: setTableEdit.of(tableFrom),
    userEvent: 'input'
  }
}

/**
 * 「整理对齐」：把源码里参差的列宽补齐成等宽。**显式命令，永不自动跑** ——
 * 就地编辑只改一格正是为了不碰别的字节（保存零损耗），整理是用户自己要的那次重排。
 * 幂等：整理过的表再整理一次算出来的文本一模一样，返回 null（不发空事务）。
 */
export function tidyTable(
  state: EditorState,
  tableFrom: number,
  row = 0,
  col = 0
): TransactionSpec | null {
  const doc = state.doc
  const { first, last } = tableLines(state, tableFrom)
  if (last < first + 1) return null

  const src: string[][] = []
  for (let no = first; no <= last; no++) src.push(splitRow(doc.line(no).text))
  const delim = src[1]!
  // 列数以「最宽的那一行」为准：GFM 会无视超出表头的格子，但整理不能顺手把内容吞了
  const cols = Math.max(...src.map((r) => r.length))
  const marks = Array.from({ length: cols }, (_, c) => {
    const d = delim[c] ?? ''
    return { left: d.startsWith(':'), right: d.endsWith(':') }
  })
  const width = Array.from({ length: cols }, (_, c) =>
    src.reduce((w, cells, i) => (i === 1 ? w : Math.max(w, displayWidth(cells[c] ?? ''))), 3)
  )

  const head = doc.line(first).text
  const lead = /^\s*\|/.test(head) ? '|' : ''
  const trail = /\|\s*$/.test(head) ? '|' : ''
  const out = src.map((cells, i) => {
    const parts = Array.from({ length: cols }, (_, c) => {
      if (i === 1) {
        // 分隔行也留两边的空格，跟数据行一样宽 —— 源码看起来才是一张对齐的表
        const m = marks[c]!
        const bars = Math.max(1, width[c]! - (m.left ? 1 : 0) - (m.right ? 1 : 0))
        return ` ${m.left ? ':' : ''}${'-'.repeat(bars)}${m.right ? ':' : ''} `
      }
      const text = cells[c] ?? ''
      return ` ${text}${' '.repeat(width[c]! - displayWidth(text) + 1)}`
    })
    let line = lead + parts.join('|') + trail
    if (!lead) line = line.replace(/^ +/, '')
    if (!trail) line = line.replace(/ +$/, '')
    return line
  })

  const from = doc.line(first).from
  const to = doc.line(last).to
  const insert = out.join('\n')
  if (insert === doc.sliceString(from, to)) return null

  const idx = Math.min(lineOfRow(row), out.length - 1)
  let off = 0
  for (let i = 0; i < idx; i++) off += out[i]!.length + 1
  return {
    changes: { from, to, insert },
    selection: { anchor: from + off + (cellSpan(out[idx]!, col)?.from ?? 0) },
    effects: setTableEdit.of(tableFrom),
    userEvent: 'input'
  }
}

/** 删掉整张表格（连同它那一行换行），退出编辑态 */
export function deleteTable(state: EditorState, tableFrom: number): TransactionSpec {
  const doc = state.doc
  const { first, last } = tableLines(state, tableFrom)
  const from = doc.line(first).from
  const end = doc.line(last).to
  const tail = end < doc.length
  const range = tail ? { from, to: end + 1 } : { from: Math.max(0, from - 1), to: end }
  return {
    changes: range,
    selection: { anchor: range.from },
    effects: setTableEdit.of(null),
    userEvent: 'delete'
  }
}

/** 选区 head 落在表格里的哪一格（含格内偏移）；落在分隔行上算表头 */
export function activeCellAt(
  state: EditorState,
  tableFrom: number,
  data: TableData
): ActiveCell | null {
  const head = state.selection.main.head
  if (head < tableFrom) return null
  const first = state.doc.lineAt(tableFrom).number
  const idx = state.doc.lineAt(head).number - first
  if (idx < 0) return null
  const row = Math.min(idx <= 1 ? 0 : idx - 1, data.rows.length)
  const line = state.doc.lineAt(head)
  const rel = head - line.from
  for (let col = 0; col < data.header.length; col++) {
    const span = cellSpan(line.text, col)
    if (!span) continue
    if (rel <= span.to) return { row, col, offset: Math.max(0, rel - span.from) }
  }
  return { row, col: Math.max(0, data.header.length - 1), offset: 0 }
}

// ---------- 语法树上的表格 ----------

function tableNodeAt(state: EditorState, pos: number, side: -1 | 1 = 1): SyntaxNode | null {
  // `parsedTree` 而不是 `syntaxTree`：点进格子这条路走在任何事务之前，快照可能
  // 还停在打开文件时那 3000 字上 —— 表格下半截的格子会查不到自己属于哪张表
  for (let n: SyntaxNode | null = parsedTree(state).resolveInner(pos, side); n; n = n.parent) {
    if (n.name === 'Table') return n
  }
  return null
}

/** widget 子节点的 posAtDOM = 被替换区间的起点，再回语法树拿到表格块起点 */
function tableFromDOM(view: EditorView, el: Node): number {
  const node = tableNodeAt(view.state, view.posAtDOM(el))
  return node ? node.from : -1
}

// ---------- 格内行内语法（`**粗体**` 在渲染态里就是粗体） ----------

/** 格内的一段行内内容；tags 从外到内嵌套（`**a *b* c**` 的中段是 ['strong','em']） */
export interface CellToken {
  text: string
  /** 相对单元格源码起点的偏移：点进渲染态的格子时靠它把光标放回源码同一处 */
  at: number
  tags: string[]
  href?: string
  /**
   * 公式源码（此时 text 为空）。**存源码不存渲染结果**：katex 是懒加载的（P4-6②），
   * 采片段这一刻多半还没到手；渲染交给 `fillMath` 在 DOM 那一步做。
   * 导出也正好要它 —— 那边按自己的输出格式（MathML）再渲染一遍。
   */
  tex?: string
}

const CELL_TAG: Record<string, string> = {
  StrongEmphasis: 'strong',
  Emphasis: 'em',
  InlineCode: 'code',
  Strikethrough: 'del',
  Highlight: 'mark',
  Superscript: 'sup',
  Subscript: 'sub',
  Link: 'a'
}

/** 可能带行内语法的字符。绝大多数格子一个都不含，直接按纯文本走，连树都不用遍历 */
const RICH_RE = /[*_`~=^$[\\:!]/

/**
 * 把 [from,to) 这一格的源码切成渲染片段。**读的是文档自己的语法树** ——
 * 格里的方言与正文永远一致，不会出现「正文认得、格子不认」的漂移。
 * 取树走 `parsedTree`（不是 `syntaxTree`）的理由见 `editor/syntax.ts`。
 */
export function cellTokens(state: EditorState, from: number, to: number): CellToken[] {
  const out: CellToken[] = []
  const tags: string[] = []
  let href: string | undefined
  let pos = from

  const flush = (end: number): void => {
    if (end <= pos) return
    out.push({
      text: state.doc.sliceString(pos, end),
      at: pos - from,
      tags: [...tags],
      ...(href ? { href } : {})
    })
    pos = end
  }

  parsedTree(state).iterate({
    from,
    to,
    enter: (node) => {
      // 祖先（Document / Table / TableRow / TableCell）只管往下走，不产出片段
      if (node.from < from || node.to > to) return
      const name = node.name
      if (isHiddenInline(name, node.node.parent?.name)) {
        flush(node.from)
        pos = Math.max(pos, node.to)
        return false
      }
      if (name === 'Escape') {
        flush(node.from)
        pos = node.from + 1 // 只藏反斜杠，被转义的字符照常显示
        return false
      }
      if (name === 'Emoji') {
        const char = EMOJI[state.doc.sliceString(node.from + 1, node.to - 1)]
        if (!char) return false
        flush(node.from)
        out.push({ text: char, at: node.from - from, tags: [...tags] })
        pos = node.to
        return false
      }
      if (name === 'InlineMath') {
        const text = state.doc.sliceString(node.from, node.to)
        const delim = text.startsWith('$$') ? 2 : 1
        const tex = text.slice(delim, Math.max(delim, text.length - delim))
        if (!tex.trim()) return false
        flush(node.from)
        out.push({ text: '', at: node.from - from, tags: [...tags], tex })
        pos = node.to
        return false
      }
      const tag = CELL_TAG[name]
      if (!tag) return
      flush(node.from)
      tags.push(tag)
      if (tag === 'a') {
        const url = node.node.getChild('URL')
        href = url ? state.doc.sliceString(url.from, url.to) : undefined
      }
      return
    },
    leave: (node) => {
      if (!CELL_TAG[node.name] || node.from < from || node.to > to) return
      flush(node.to)
      tags.pop()
      if (CELL_TAG[node.name] === 'a') href = undefined
    }
  })
  flush(to)
  return out
}

/** 片段与源码一模一样（格里压根没有语法）→ 不值得存，DOM 直接用 textContent */
function plainTokens(tokens: CellToken[], text: string): boolean {
  const one = tokens[0]
  return (
    tokens.length === 0 ||
    (tokens.length === 1 && !one!.tags.length && !one!.tex && one!.text === text)
  )
}

/** 解析表格并顺手采好每一格的行内片段。blockField 走这条，单测可以只用 parseTable */
export function tableDataAt(state: EditorState, from: number, to: number): TableData | null {
  const data = parseTable(state.doc.sliceString(from, to))
  if (!data) return null
  data.rich = [data.header, ...data.rows].map((cells, row) =>
    cells.map((text, col) => {
      if (!RICH_RE.test(text)) return null
      const pos = cellPos(state, from, row, col)
      if (!pos) return null
      const tokens = cellTokens(state, pos.from, pos.to)
      return plainTokens(tokens, text) ? null : tokens
    })
  )
  return data
}

// ---------- widget ----------

export interface ActiveCell {
  row: number
  col: number
  offset: number
}

function sameCell(a: ActiveCell | null, b: ActiveCell | null): boolean {
  if (!a || !b) return a === b
  return a.row === b.row && a.col === b.col && a.offset === b.offset
}

function cellOf(target: EventTarget | null): HTMLTableCellElement | null {
  const el = target as HTMLElement | null
  const cell = el?.closest?.('td, th') as HTMLTableCellElement | null
  return cell?.closest('.cm-lp-tableview') ? cell : null
}

/** 粘贴会在格子里留下 <br>/<div>，textContent 把换行吞掉会粘成一坨 —— 有子元素时走 innerText */
function cellText(cell: HTMLElement): string {
  return cell.children.length ? cell.innerText : (cell.textContent ?? '')
}

function caretOffset(cell: HTMLElement): number {
  const sel = cell.ownerDocument.defaultView?.getSelection()
  const node = sel?.focusNode
  if (!node || !cell.contains(node)) return 0
  const within = node.nodeType === 3 ? sel!.focusOffset : 0
  // 渲染态的格子里 DOM 文字 ≠ 源码（标记藏了、公式成了图），
  // 片段外层的 data-at 把它折回源码偏移 —— 点 `**粗体**` 的「体」才会落在「体」上
  const el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement)
  const host = el?.closest('[data-at]') as HTMLElement | null
  return host ? Number(host.dataset['at']) + within : within
}

/**
 * 程序性聚焦。focusin 会跟着来一发，但那不是「用户点进了别的格子」——
 * 不挡住的话它会拿刚聚焦、还没放光标的位置（偏移 0）反过来改选区，
 * ⇧Tab 想停在格尾就永远停不住。
 */
let syncing = false
function focusCell(cell: HTMLElement, offset: number): void {
  syncing = true
  try {
    cell.focus()
    placeCaret(cell, offset)
  } finally {
    syncing = false
  }
}

function placeCaret(cell: HTMLElement, offset: number): void {
  const doc = cell.ownerDocument
  const sel = doc.defaultView?.getSelection()
  if (!sel) return
  const range = doc.createRange()
  const node = cell.firstChild
  if (node && node.nodeType === 3) {
    range.setStart(node, Math.min(offset, node.nodeValue?.length ?? 0))
  } else {
    range.setStart(cell, 0)
  }
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
}

/** 行内片段的样式沿用正文那几个类，不另起一套 */
const CELL_CLASS: Record<string, string> = {
  code: 'cm-lp-inline-code',
  mark: 'cm-lp-highlight',
  sup: 'cm-lp-sup',
  sub: 'cm-lp-sub',
  a: 'cm-lp-link'
}

function renderTokens(cell: HTMLElement, tokens: CellToken[]): void {
  const frag = document.createDocumentFragment()
  for (const tok of tokens) {
    // 最外层永远是带 data-at 的 span：点进渲染态的格子时靠它把 DOM 光标折回源码偏移
    const host = document.createElement('span')
    host.dataset['at'] = String(tok.at)
    let node: HTMLElement = host
    for (const tag of tok.tags) {
      const el = document.createElement(tag)
      const cls = CELL_CLASS[tag]
      if (cls) el.className = cls
      // 故意不写 href：格子在 contenteditable 里，真链接一点就把 WebView 导航走了。
      // ⌘/Ctrl + 点击由 wire() 接管，和正文里的链接同一条路（openExternal）
      if (tag === 'a' && tok.href) {
        el.dataset['href'] = tok.href
        el.title = tok.href
      }
      node.appendChild(el)
      node = el
    }
    if (tok.tex) {
      const math = document.createElement('span')
      math.className = 'cm-lp-math-inline'
      fillMath(math, tok.tex, false)
      node.appendChild(math)
    } else {
      node.appendChild(document.createTextNode(tok.text))
    }
    frag.appendChild(host)
  }
  cell.replaceChildren(frag)
}

/**
 * 写一格。
 * `rich` 非空 = 渲染态：DOM 里是渲染结果，和源码对不上，所以拿 `data-rich` 记住
 * 它当前对应的源码来比，否则每次 update 都要白重画一遍。
 * `rich` 为空 = 源码态（正在编辑的那一格）：必须拿 DOM 现有文字比 ——
 * 用户刚敲进去的字和文档已经一致时**不能**重写，否则光标和输入法都要遭殃。
 */
function fillCell(
  cell: HTMLTableCellElement,
  text: string,
  align: string,
  rich: CellToken[] | null
): void {
  if (rich) {
    if (cell.dataset['rich'] !== text) {
      cell.dataset['rich'] = text
      renderTokens(cell, rich)
    }
  } else {
    delete cell.dataset['rich']
    if (cellText(cell) !== text) cell.textContent = text
  }
  if (cell.style.textAlign !== align) cell.style.textAlign = align
}

/**
 * 行高估算（见 `TableWidget.estimatedHeight`）。34 只是**第一次画出来之前**的兜底：
 * 单元格 padding 5+5 + 边框 1 + 行高（0.92em × 1.55）≈ 34，与 `themes/live-preview.css`
 * 同源；格子一换行就远不止，所以量到真值之后就以真值为准（`learn()` 回灌）。
 * 表格上下那圈留白 8+8 = 16 也算在块里（它是 `.cm-lp-tableview` 的 padding，
 * 不是 margin —— 为什么不能是 margin，见 `themes/live-preview.css` 开头那段）。
 */
let rowH = 34
const TABLE_PAD = 16
/**
 * `learn()` 那条 measure 请求的去重键。**必须有**：不带 key 的 `requestMeasure`
 * 每调一次就往 `measureRequests` 里压一条，而同屏十几张表、每次重画都要学一遍。
 * 视口只要还在动（快速滚动、开关面板、异步内容落地），CM 那一轮就整批跳过排空
 * （源码里 `changed & UpdateFlag.Viewport` 时不交换队列）—— 六轮下来队列还没空，
 * 控制台里那句 `Measure loop restarted more than 5 times` 就是这么来的。
 * 所有表共用一个键：它们写的本来就是同一个全局 rowH，留最后一条足够。
 */
const ROW_H_KEY = 'cursive-table-rowH'

/** 排版偏好变了（字号/行距/栏宽），学到的行高作废 —— 见 `learn()` 里「只往上学」那段 */
export function forgetRowHeight(): void {
  rowH = 34
}

export class TableWidget extends WidgetType {
  constructor(
    readonly data: TableData,
    readonly editing: boolean,
    readonly active: ActiveCell | null
  ) {
    super()
  }

  eq(other: TableWidget): boolean {
    return (
      other.editing === this.editing &&
      sameCell(other.active, this.active) &&
      JSON.stringify(other.data) === JSON.stringify(this.data)
    )
  }

  /**
   * **必须给**，而且必须**贴着真值、宁高勿低**。
   *
   * 不给（默认 -1）时 CM 按「一行」算 —— 一张 100 行的表在高度图里只有 28px，
   * 于是：滚动条长度不对；表格块被算在视口之外 → 不渲染 → 永远量不到真高度 →
   * 永远出不来（死循环，整张表干脆不显示）。
   *
   * 更要命的是这个估值**不是只用一次**：CM 的 `heightRelevantDecoChanges` 对
   * 「点范围不相等」的装饰一律判为高度变更，而点一下格子、敲一个字都会换一个
   * widget 实例（`eq()` 不成立）—— 于是**每次交互高度图都先塌回估值**，下一帧量到
   * 真值再涨回去。估小了，这一帧里文档就短一截：浏览器把超出的 `scrollTop` 夹回来，
   * CM 随后又判定「已经滚到底」，measure 末尾那条分支就把视口钉到文末。
   * 症状就是「点一下单元格，整页往下跳」。
   */
  override get estimatedHeight(): number {
    return (this.data.rows.length + 1) * rowH + TABLE_PAD
  }

  /**
   * 把量到的真行高回灌给估值。走 CM 的 measure 阶段（不在 DOM 更新里读 offsetHeight
   * 强行触发重排），向上取整 —— 宁可估高：估高只是滚动条长一点点，估矮会甩视口。
   */
  private learn(view: EditorView, dom: HTMLElement): void {
    const rows = this.data.rows.length + 1
    view.requestMeasure({
      key: ROW_H_KEY,
      read: () => dom.offsetHeight,
      write: (h) => {
        if (h <= 0) return
        const next = Math.ceil(h / rows)
        // **只往上学**：一份文档里矮表和高表交替出现时，全局估值来回跳，
        // 每跳一次整张高度图就作废一次 —— 而作废一次就是新一轮 measure。
        // 宁高勿低本来就是这里的取舍（见 estimatedHeight 的注释），
        // 真要往下退，等排版偏好变了由 forgetRowHeight() 清零
        if (next > rowH) rowH = next
      }
    })
  }

  /**
   * 全部忽略（= 默认值，写出来是因为它是这套方案的地基）：CM 的 eventBelongsToEditor
   * 一旦判定事件不属于编辑器，它自己的 handler/observer 一概不跑 —— 于是格子里的
   * 按键/输入/选区变化全归 widget 和浏览器原生行为，CM 不会把 widget 内容当成编辑写回文档。
   * 换来的债：⌘Z 必须自己转发给 history（见 wire 里的 keydown）。
   */
  override ignoreEvent(): boolean {
    return true
  }

  /** 正在编辑的那一格显示源码，其余格子显示渲染结果 */
  private richAt(row: number, col: number): CellToken[] | null {
    const a = this.active
    if (this.editing && a && a.row === row && a.col === col) return null
    return this.data.rich?.[row]?.[col] ?? null
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-lp-tableview'
    const scroll = document.createElement('div')
    scroll.className = 'cm-lp-tablescroll'
    const table = document.createElement('table')
    buildRows(table, this.data, (r, c) => this.richAt(r, c))
    scroll.appendChild(table)
    wrap.append(scroll, buildHandles(view), buildToolbar(view))
    this.paintChrome(wrap)
    wire(wrap, view)

    this.learn(view, wrap)

    // 新建出来的 widget（输入规则刚补出骨架、或滚回视口）没有旧 DOM 可复用，
    // updateDOM 那条聚焦路径走不到；此刻元素还没挂进文档，focus() 也没用 —— 推迟一帧。
    const active = this.active
    if (this.editing && active) {
      requestAnimationFrame(() => {
        const cell = table.rows[active.row]?.cells[active.col]
        if (!cell?.isConnected || tableEditAt(view.state) == null) return
        if (cell.ownerDocument.activeElement === cell) return
        focusCell(cell, active.offset)
      })
    }
    return wrap
  }

  /**
   * 工具栏只在就地编辑时露面，按钮的置灰/高亮全靠 widget 自己这份数据算 ——
   * updateDOM 拿不到 view，也就不能去查 state（这也是它必须是纯数据的原因）。
   */
  private paintChrome(dom: HTMLElement): void {
    // is-editing 不只是样式钩子：专注模式靠它把「正在改的这张表」排除在压暗之外
    // （updateDOM 复用 DOM，所以类名要在这条两边都跑的路径上刷）
    dom.classList.toggle('is-editing', this.editing)
    const bar = dom.querySelector('.cm-lp-tbl-bar') as HTMLElement | null
    if (!bar) return
    const at = this.active
    bar.hidden = !(this.editing && at)
    if (!at) return
    for (const tool of TOOLS) {
      if (tool === '|') continue
      const btn = bar.querySelector(`[data-tool="${tool.key}"]`) as HTMLButtonElement | null
      if (!btn) continue
      btn.disabled = tool.off?.(this.data, at) ?? false
      btn.classList.toggle('is-on', tool.on?.(this.data, at) ?? false)
    }
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const doc = dom.ownerDocument
    // 别把正在编辑的那份 DOM 抢走：CM 找不到 eq 的 widget 时，会拿所有同类 widget 的 DOM
    // 挨个试 updateDOM，谁先返回 true 谁拿走
    if (!this.editing && dom.contains(doc.activeElement)) return false
    const table = dom.querySelector('table')
    if (!table) return false

    const cols = this.data.header.length
    let rewroteActive = false
    if (table.rows.length !== this.data.rows.length + 1 || table.rows[0]?.cells.length !== cols) {
      // 行列数变了（加行/删行/改结构）→ 整个表体重建，焦点随后由 active 补回来
      buildRows(table, this.data, (r, c) => this.richAt(r, c))
      rewroteActive = true
      hideHandles(dom)
    } else {
      for (let r = 0; r < table.rows.length; r++) {
        const cells = table.rows[r]!.cells
        for (let c = 0; c < cols; c++) {
          const cell = cells[c]
          if (!cell) continue
          // 正在输入法合成的格子碰不得：DOM 里是还没上屏的候选，文档里还没有
          if (cell.dataset['composing']) continue
          const text = r === 0 ? (this.data.header[c] ?? '') : (this.data.rows[r - 1]?.[c] ?? '')
          if (cell === doc.activeElement && cellText(cell) !== text) rewroteActive = true
          fillCell(cell, text, this.data.aligns[c] ?? 'left', this.richAt(r, c))
        }
      }
      moveHandles(dom)
    }
    this.paintChrome(dom)

    this.learn(view, dom)

    const active = this.active
    if (this.editing && active) {
      const cell = table.rows[active.row]?.cells[active.col]
      if (cell && doc.activeElement !== cell) {
        focusCell(cell, active.offset)
      } else if (cell && rewroteActive) {
        // ⌘B / ⌘Z 把正在编辑的这一格重写了 —— 光标得自己放回去
        placeCaret(cell, active.offset)
      }
    }
    return true
  }
}

function buildRows(
  table: HTMLTableElement,
  data: TableData,
  rich: (row: number, col: number) => CellToken[] | null
): void {
  table.replaceChildren()
  const head = table.createTHead().insertRow()
  data.header.forEach((cell, i) => {
    const th = document.createElement('th')
    editable(th)
    fillCell(th, cell, data.aligns[i] ?? 'left', rich(0, i))
    head.appendChild(th)
  })
  const body = table.createTBody()
  data.rows.forEach((row, r) => {
    const tr = body.insertRow()
    data.header.forEach((_, i) => {
      const td = tr.insertCell()
      editable(td)
      fillCell(td, row[i] ?? '', data.aligns[i] ?? 'left', rich(r + 1, i))
    })
  })
}

/** plaintext-only：WebKit 原生支持，顺手挡掉富文本粘贴 */
function editable(cell: HTMLTableCellElement): void {
  cell.contentEditable = 'plaintext-only'
  cell.spellcheck = false
  cell.addEventListener('paste', (e) => onCellPaste(e, cell))
}

/**
 * 0.4.0 还的第二条账：**格内粘贴**。
 *
 * 此前这儿退化成浏览器自己的纯文本粘贴（`plaintext-only`）—— 从网页 / 飞书复制一段
 * 带格式的文字，格子里只剩裸字，而正文那边（P2-4 智能粘贴）早就转成 Markdown 了。
 * 现在走**同一条** turndown 路，格子里粘出来的与正文里粘出来的一模一样。
 *
 * 换行另说：Markdown 的表格行就是一行，**格子里放不下换行**。多行并成一空格分隔的
 * 一行，并且**说一句** —— 从前是默默压扁，人只会觉得「怎么少了两行」。
 */
function onCellPaste(e: ClipboardEvent, cell: HTMLTableCellElement): void {
  const data = e.clipboardData
  if (!data) return
  e.preventDefault()
  const plain = data.getData('text/plain')
  const html = data.getData('text/html') || null
  void clipboardMarkdown(plain, html).then((md) => {
    const { text, lines } = cellPasteText(md)
    if (lines > 1) note(t('note.cellMultiline', { n: lines }))
    if (!text) return
    cell.focus()
    // `insertText` 会照常派 input 事件 —— 格子那条 input 监听器据此写回文档
    // （与人手打字走同一条路，撤销也因此归 CM 管，不落进 contenteditable 自己那套）
    document.execCommand('insertText', false, text)
  })
}

// ---------- 底部浮动工具栏 ----------

interface Tool {
  key: string
  /** 文字按钮；写成函数是因为文案跟界面语言走，渲染时才解析 */
  label?: () => string
  /** 图标按钮（对齐那三个）：16×16 的 path */
  path?: string
  title: () => string
  /** 置灰 */
  off?: (data: TableData, at: ActiveCell) => boolean
  /** 高亮（对齐按钮显示当前值） */
  on?: (data: TableData, at: ActiveCell) => boolean
  run: (state: EditorState, tf: number, at: ActiveCell) => TransactionSpec | null
  /** 跑完把焦点还给编辑器 —— 表格都没了，格子自然也没了 */
  leave?: boolean
}

const ALIGN_ICON: Record<Align, string> = {
  left: 'M2.5 4h11M2.5 8h6.5M2.5 12h11',
  center: 'M2.5 4h11M4.75 8h6.5M2.5 12h11',
  right: 'M2.5 4h11M6.5 8h6.5M2.5 12h11'
}
/** 整句 key，不是「整列」+ 方向名拼起来的 —— 拼接式语法在英文里读作 "Align column: Align left" */
const ALIGN_TITLE: Record<Align, Key> = {
  left: 'tbl.colAlignLeft',
  center: 'tbl.colAlignCenter',
  right: 'tbl.colAlignRight'
}

/**
 * 工具栏按钮表。每一项都是「读 state → 出 TransactionSpec」，
 * 与键盘那条路共用同一批纯函数，所以撤销栈、保存零损耗全都自动成立。
 */
const TOOLS: (Tool | '|')[] = [
  {
    key: 'row-up',
    label: () => t('tbl.rowUp'),
    title: () => t('tbl.rowUpTitle'),
    off: (_d, at) => at.row === 0,
    run: (s, tf, at) => insertRowAfter(s, tf, at.row - 1, at.col)
  },
  {
    key: 'row-down',
    label: () => t('tbl.rowDown'),
    title: () => t('tbl.rowDownTitle'),
    run: (s, tf, at) => insertRowAfter(s, tf, at.row, at.col)
  },
  {
    key: 'row-del',
    label: () => t('tbl.rowDel'),
    title: () => t('tbl.rowDelTitle'),
    off: (_d, at) => at.row === 0,
    run: (s, tf, at) => deleteRow(s, tf, at.row)
  },
  '|',
  {
    key: 'col-left',
    label: () => t('tbl.colLeft'),
    title: () => t('tbl.colLeftTitle'),
    run: (s, tf, at) => insertColAt(s, tf, at.col, at.row)
  },
  {
    key: 'col-right',
    label: () => t('tbl.colRight'),
    title: () => t('tbl.colRightTitle'),
    run: (s, tf, at) => insertColAt(s, tf, at.col + 1, at.row)
  },
  {
    key: 'col-del',
    label: () => t('tbl.colDel'),
    title: () => t('tbl.colDelTitle'),
    off: (data) => data.header.length <= 1,
    run: (s, tf, at) => deleteCol(s, tf, at.col)
  },
  '|',
  ...(['left', 'center', 'right'] as Align[]).map(
    (align): Tool => ({
      key: `al-${align}`,
      path: ALIGN_ICON[align],
      title: () => t(ALIGN_TITLE[align]),
      on: (data, at) => (data.aligns[at.col] ?? 'left') === align,
      run: (s, tf, at) => setAlign(s, tf, at.col, align)
    })
  ),
  '|',
  {
    key: 'tidy',
    label: () => t('tbl.tidy'),
    title: () => t('tbl.tidyTitle'),
    run: (s, tf, at) => tidyTable(s, tf, at.row, at.col)
  },
  {
    key: 'drop',
    label: () => t('tbl.delete'),
    title: () => t('tbl.deleteTitle'),
    leave: true,
    run: (s, tf) => deleteTable(s, tf)
  }
]

const TOOL_BY_KEY = new Map(TOOLS.filter((t): t is Tool => t !== '|').map((t) => [t.key, t]))

const SVG_NS = 'http://www.w3.org/2000/svg'

function svgIcon(path: string): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '13')
  svg.setAttribute('height', '13')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('stroke-linecap', 'round')
  const d = document.createElementNS(SVG_NS, 'path')
  d.setAttribute('d', path)
  svg.appendChild(d)
  return svg
}

/** 从工具栏/手柄回到表格块起点：借一个单元格走 posAtDOM 那条已经验证过的路 */
function tableOf(view: EditorView, el: HTMLElement): number {
  const cell = el.closest('.cm-lp-tableview')?.querySelector('th, td')
  return cell ? tableFromDOM(view, cell) : -1
}

function buildToolbar(view: EditorView): HTMLElement {
  const bar = document.createElement('div')
  bar.className = 'cm-lp-tbl-bar'
  bar.hidden = true
  for (const tool of TOOLS) {
    if (tool === '|') {
      const sep = document.createElement('i')
      sep.className = 'cm-lp-tbl-sep'
      bar.appendChild(sep)
      continue
    }
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'cm-lp-tbl-btn'
    btn.dataset['tool'] = tool.key
    btn.title = tool.title()
    if (tool.path) btn.appendChild(svgIcon(tool.path))
    else btn.textContent = tool.label?.() ?? ''
    bar.appendChild(btn)
  }
  // 按下就拦：焦点一旦离开格子，编辑态就散了，工具栏自己也跟着消失
  bar.addEventListener('mousedown', (e) => e.preventDefault())
  bar.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-tool]') as HTMLButtonElement | null
    const tool = btn && !btn.disabled ? TOOL_BY_KEY.get(btn.dataset['tool'] ?? '') : null
    if (!tool) return
    e.preventDefault()
    const tf = tableOf(view, bar)
    if (tf < 0 || tableEditAt(view.state) !== tf) return
    const data = tableAt(view.state, tf)
    const at = data && activeCellAt(view.state, tf, data)
    if (!at) return
    dispatch(view, tool.run(view.state, tf, at))
    if (tool.leave) view.focus()
  })
  return bar
}

// ---------- 悬停 +/− 手柄 ----------

/**
 * 鼠标扫到哪一格，就在那一列的上边框、那一行的左边框上各浮一颗药丸（＋ 插入 / − 删除）。
 * 位置按 getBoundingClientRect 现算，横向滚动、列宽变化都自动跟上。
 */
function buildHandles(view: EditorView): HTMLElement {
  const layer = document.createElement('div')
  layer.className = 'cm-lp-tbl-handles'
  layer.hidden = true
  layer.append(
    handlePill('is-col', [
      ['col-add', '＋', t('tbl.colRightTitle')],
      ['col-del', '−', t('tbl.colDelTitle')]
    ]),
    handlePill('is-row', [
      ['row-add', '＋', t('tbl.rowDownTitle')],
      ['row-del', '−', t('tbl.rowDelTitle')]
    ])
  )
  layer.addEventListener('mousedown', (e) => e.preventDefault())
  layer.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-hand]') as HTMLElement | null
    if (!btn) return
    e.preventDefault()
    const tf = tableOf(view, layer)
    if (tf < 0) return
    const row = Number(layer.dataset['row'] ?? 0)
    const col = Number(layer.dataset['col'] ?? 0)
    const state = view.state
    switch (btn.dataset['hand']) {
      case 'col-add':
        dispatch(view, insertColAt(state, tf, col + 1, row))
        break
      case 'col-del':
        dispatch(view, deleteCol(state, tf, col))
        break
      case 'row-add':
        dispatch(view, insertRowAfter(state, tf, row, col))
        break
      case 'row-del':
        dispatch(view, deleteRow(state, tf, row))
        break
    }
  })
  return layer
}

function handlePill(cls: string, buttons: [string, string, string][]): HTMLElement {
  const pill = document.createElement('div')
  pill.className = `cm-lp-tbl-handle ${cls}`
  for (const [hand, glyph, title] of buttons) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.dataset['hand'] = hand
    btn.title = title
    btn.textContent = glyph
    pill.appendChild(btn)
  }
  return pill
}

function placeHandles(wrap: HTMLElement, cell: HTMLTableCellElement): void {
  const layer = wrap.querySelector('.cm-lp-tbl-handles') as HTMLElement | null
  const table = cell.closest('table')
  const col = layer?.querySelector('.is-col') as HTMLElement | null
  const row = layer?.querySelector('.is-row') as HTMLElement | null
  if (!layer || !table || !col || !row) return
  const base = wrap.getBoundingClientRect()
  const box = cell.getBoundingClientRect()
  const all = table.getBoundingClientRect()
  layer.dataset['row'] = String(rowOf(cell))
  layer.dataset['col'] = String(cell.cellIndex)
  layer.hidden = false
  col.style.left = `${box.left - base.left + box.width / 2}px`
  col.style.top = `${all.top - base.top}px`
  row.style.left = `${all.left - base.left}px`
  row.style.top = `${box.top - base.top + box.height / 2}px`
  // 表头删不得，那颗 − 直接不出现
  const del = layer.querySelector('[data-hand="row-del"]') as HTMLElement | null
  if (del) del.hidden = rowOf(cell) === 0
}

/** 表格重排（改字、加列）之后把药丸挪到新位置；那一格没了就收起来 */
function moveHandles(dom: HTMLElement): void {
  const layer = dom.querySelector('.cm-lp-tbl-handles') as HTMLElement | null
  if (!layer || layer.hidden) return
  const table = dom.querySelector('table')
  const cell = table?.rows[Number(layer.dataset['row'])]?.cells[Number(layer.dataset['col'])]
  if (cell) placeHandles(dom, cell)
  else layer.hidden = true
}

function hideHandles(dom: HTMLElement): void {
  const layer = dom.querySelector('.cm-lp-tbl-handles') as HTMLElement | null
  if (layer) layer.hidden = true
}

// ---------- 事件（一律读 view.state 现算，绝不吃 widget 实例里的数据） ----------

function wire(wrap: HTMLElement, view: EditorView): void {
  const enter = (cell: HTMLTableCellElement, offset: number): void => {
    const tf = tableFromDOM(view, cell)
    if (tf < 0) return
    const pos = cellPos(view.state, tf, rowOf(cell), cell.cellIndex)
    if (!pos) return
    const anchor = pos.from + Math.min(offset, pos.to - pos.from)
    if (tableEditAt(view.state) === tf && view.state.selection.main.head === anchor) return
    view.dispatch({ selection: { anchor }, effects: setTableEdit.of(tf) })
  }

  const flush = (cell: HTMLTableCellElement): void => {
    const tf = tableFromDOM(view, cell)
    if (tf < 0) return
    const spec = writeCell(
      view.state,
      tf,
      rowOf(cell),
      cell.cellIndex,
      cellText(cell),
      caretOffset(cell)
    )
    if (spec) view.dispatch(spec)
  }

  // 点在格子之外（表格内边距、行间）会把原生选区送进 contentDOM，CM 一读就回落源码
  wrap.addEventListener('mousedown', (e) => {
    const cell = cellOf(e.target)
    if (cell) {
      // 格里的链接：和正文一样 ⌘/Ctrl + 点击跟过去（渲染态的 <a> 没有 href，
      // 真 href 在 contenteditable 里一点就把整个 WebView 导航走了）。
      // 去哪儿一律问 `editor/link.ts` —— 同一条链接写在格子里还是正文里，行为必须一样
      const link = (e.target as HTMLElement).closest?.('[data-href]') as HTMLElement | null
      if (link && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        // 挡住冒泡：contentDOM 上还挂着正文那条 ⌘+点击，让它再判一次是白费力气
        e.stopPropagation()
        const target = resolveLink(link.dataset['href']!, view.state.facet(docDir))
        if (target) openTarget(view, target)
      }
      return
    }
    const el = e.target as HTMLElement
    if (el.closest('.cm-lp-tbl-bar, .cm-lp-tbl-handles')) return
    // 滚动条不能拦，拦了就拖不动
    if (el.scrollWidth > el.clientWidth && e.offsetY > el.clientHeight) return
    e.preventDefault()
    ;(wrap.querySelector('th, td') as HTMLTableCellElement | null)?.focus()
  })

  wrap.addEventListener('mouseover', (e) => {
    const cell = cellOf(e.target)
    if (cell) placeHandles(wrap, cell)
  })
  wrap.addEventListener('mouseleave', () => hideHandles(wrap))

  wrap.addEventListener('focusin', (e) => {
    const cell = cellOf(e.target)
    if (cell && !syncing) enter(cell, caretOffset(cell))
  })

  wrap.addEventListener('input', (e) => {
    const cell = cellOf(e.target)
    if (cell && !(e as InputEvent).isComposing) flush(cell)
  })

  wrap.addEventListener('compositionstart', (e) => {
    const cell = cellOf(e.target)
    if (cell) cell.dataset['composing'] = '1'
  })

  wrap.addEventListener('compositionend', (e) => {
    const cell = cellOf(e.target)
    if (!cell) return
    delete cell.dataset['composing']
    flush(cell)
  })

  // 格内移动光标不产生事务，CM 选区会越来越陈旧 —— 而 ⌘B/⌘I 这类菜单命令正照着它干活
  const sync = (e: Event): void => {
    const cell = cellOf(e.target)
    // 合成期间不碰选区：候选还没上屏，别给输入法添乱（CM 自己也是这么躲的）
    if (cell && !cell.dataset['composing']) enter(cell, caretOffset(cell))
  }
  wrap.addEventListener('keyup', sync)
  wrap.addEventListener('mouseup', sync)

  wrap.addEventListener('beforeinput', (e) => {
    const type = (e as InputEvent).inputType
    if (type !== 'historyUndo' && type !== 'historyRedo') return
    // 原生 contenteditable 的撤销只改 DOM、不碰文档，放它过去就是永久失同步
    e.preventDefault()
    ;(type === 'historyRedo' ? redo : undo)(view)
  })

  wrap.addEventListener('keydown', (e) => {
    const cell = cellOf(e.target)
    if (!cell) return
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      ;(e.shiftKey ? redo : undo)(view)
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return

    const tf = tableFromDOM(view, cell)
    if (tf < 0) return
    const table = cell.closest('table')!
    const row = rowOf(cell)
    const col = cell.cellIndex
    const lastRow = table.rows.length - 1
    const lastCol = (table.rows[row]?.cells.length ?? 1) - 1

    switch (e.key) {
      case 'Tab': {
        e.preventDefault()
        if (e.shiftKey) {
          if (col > 0) move(view, tf, row, col - 1, true)
          else if (row > 0) move(view, tf, row - 1, lastCol, true)
        } else if (col < lastCol) move(view, tf, row, col + 1)
        else if (row < lastRow) move(view, tf, row + 1, 0)
        else dispatch(view, insertRowAfter(view.state, tf, row, 0))
        return
      }
      case 'Enter': {
        e.preventDefault()
        if (row < lastRow) move(view, tf, row + 1, col)
        else dispatch(view, insertRowAfter(view.state, tf, row, col))
        return
      }
      case 'Escape': {
        // 保留的逃生口：回到管道符源码，光标停在刚才那一格
        e.preventDefault()
        view.dispatch({ selection: view.state.selection, effects: setTableEdit.of(null) })
        view.focus()
        return
      }
      case 'ArrowDown': {
        e.preventDefault()
        if (row < lastRow) move(view, tf, row + 1, col)
        else leave(view, tf, 1)
        return
      }
      case 'ArrowUp': {
        e.preventDefault()
        if (row > 0) move(view, tf, row - 1, col)
        else leave(view, tf, -1)
        return
      }
      case 'ArrowLeft': {
        if (caretOffset(cell) > 0 || !isCollapsed(cell)) return
        e.preventDefault()
        if (col > 0) move(view, tf, row, col - 1, true)
        else if (row > 0) move(view, tf, row - 1, lastCol, true)
        else leave(view, tf, -1)
        return
      }
      case 'ArrowRight': {
        if (caretOffset(cell) < cellText(cell).length || !isCollapsed(cell)) return
        e.preventDefault()
        if (col < lastCol) move(view, tf, row, col + 1)
        else if (row < lastRow) move(view, tf, row + 1, 0)
        else leave(view, tf, 1)
        return
      }
    }
  })
}

function rowOf(cell: HTMLTableCellElement): number {
  return (cell.parentElement as HTMLTableRowElement).rowIndex
}

function isCollapsed(cell: HTMLElement): boolean {
  return cell.ownerDocument.defaultView?.getSelection()?.isCollapsed !== false
}

function dispatch(view: EditorView, spec: TransactionSpec | null): void {
  if (spec) view.dispatch(spec)
}

/** 移动 = 只改 CM 选区，聚焦哪一格由 widget 的 updateDOM 镜像过去 */
function move(view: EditorView, tableFrom: number, row: number, col: number, atEnd = false): void {
  const pos = cellPos(view.state, tableFrom, row, col)
  if (!pos) return
  view.dispatch({
    selection: { anchor: atEnd ? pos.to : pos.from },
    effects: setTableEdit.of(tableFrom)
  })
}

/** 从表格上/下沿走出去：光标落到相邻行，焦点还给编辑器 */
function leave(view: EditorView, tableFrom: number, dir: 1 | -1): void {
  const node = tableNodeAt(view.state, tableFrom)
  const doc = view.state.doc
  const edge = dir > 0 ? (node?.to ?? tableFrom) : tableFrom
  const line = doc.lineAt(edge)
  const no = dir > 0 ? line.number + 1 : line.number - 1
  const anchor = no >= 1 && no <= doc.lines ? doc.line(no).from : edge
  view.dispatch({ selection: { anchor }, effects: setTableEdit.of(null), scrollIntoView: true })
  view.focus()
}

// ---------- 从表格外面用方向键走进来 ----------

/**
 * ↓/→ 撞上渲染态表格的块首、↑/← 撞上块尾 → 进单元格，而不是让光标掉进替换区间触发回显。
 * 不用 EditorView.atomicRanges：那是全体块级 widget 的总开关，会顺带让数学块/mermaid/
 * 脚注定义再也用方向键进不去。
 */
export const tableEnterKeymap: KeyBinding[] = [
  { key: 'ArrowDown', run: (v) => enterTable(v, 1, false) },
  { key: 'ArrowRight', run: (v) => enterTable(v, 1, true) },
  { key: 'ArrowUp', run: (v) => enterTable(v, -1, false) },
  { key: 'ArrowLeft', run: (v) => enterTable(v, -1, true) }
]

function enterTable(view: EditorView, dir: 1 | -1, horizontal: boolean): boolean {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty || state.selection.ranges.length > 1) return false
  const line = state.doc.lineAt(sel.head)
  // 左右方向键只在行首/行尾才算「撞上」，否则是正常的行内移动
  if (horizontal && sel.head !== (dir > 0 ? line.to : line.from)) return false
  const no = line.number + dir
  if (no < 1 || no > state.doc.lines) return false
  const probe = state.doc.line(no)
  const node = tableNodeAt(state, dir > 0 ? probe.from : probe.to, dir > 0 ? 1 : -1)
  if (!node || (dir > 0 ? node.from !== probe.from : node.to !== probe.to)) return false

  const data = parseTable(state.doc.sliceString(node.from, node.to))
  if (!data) return false
  if (!tableRendered(state, new Reveal(state, state.facet(revealScope)), node.from, node.to)) {
    return false
  }

  if (dir > 0) move(view, node.from, 0, 0)
  else move(view, node.from, data.rows.length, Math.max(0, data.header.length - 1), true)
  return true
}
