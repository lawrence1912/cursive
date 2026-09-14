import { EditorView } from '@codemirror/view'
import {
  ChangeSet,
  EditorSelection,
  EditorState,
  type ChangeSpec,
  type StateEffect
} from '@codemirror/state'
import type { MenuAction } from '../../shared/types'
import { setTableEdit } from './live-preview'

/**
 * P2-1 格式化命令引擎。
 *
 * 铁律：一次视图 update 只发一个事务（view.dispatch({changes, selection})），
 * 这样 ⌘Z 一次就能撤回整个格式化动作，而不是逐字符。改动全部走源码
 * （dispatch({changes})），撤销栈免费兼容。
 *
 * 幂等：已经应用同种格式 → 这次切换把它摘掉；不同级标题 → 换成目标级。
 * 多光标：每个选区独立判定开/关，合并进同一个事务。
 * 无选区：作用于光标所在词（中文按 Intl.Segmenter 分词，不是按空格）。
 */

type LineOp =
  | { kind: 'h1'; k: 1 | 2 | 3 | 4 | 5 | 6 }
  | { kind: 'p' }
  | { kind: 'quote' }
  | { kind: 'ulist' }
  | { kind: 'olist' }
  | { kind: 'task' }
  | { kind: 'fence' }
  | { kind: 'inline'; open: string; close: string }
  | { kind: 'link' }
  | { kind: 'insert'; what: InsertKind }

/** P2-9 插入类的种类；骨架与光标落点都在 `skeletonOf` 一处定义 */
type InsertKind =
  | 'table'
  | 'hr'
  | 'image'
  | 'math-block'
  | 'callout'
  | 'mermaid'
  | 'toc'
  | 'footnote'

/** MenuAction 的格式项 → 具体操作。非格式项返回 null */
export function formatActionOf(action: MenuAction): LineOp | null {
  switch (action) {
    case 'fmt:bold':
      return { kind: 'inline', open: '**', close: '**' }
    case 'fmt:italic':
      return { kind: 'inline', open: '*', close: '*' }
    case 'fmt:underline':
      return { kind: 'inline', open: '<u>', close: '</u>' }
    case 'fmt:strikethrough':
      return { kind: 'inline', open: '~~', close: '~~' }
    case 'fmt:code-inline':
      return { kind: 'inline', open: '`', close: '`' }
    // P2-9：方言里早就有的四个行内标记，形状与上面五个完全同构。
    // `~下标~` 与 `~~删除线~~`、`$行内$` 与 `$$块级$$` 靠 isWrapped 里的 runIs
    // 区分（同字符重复型标记那条判断，P2-8 为 `*`/`**` 加的，这里白拿）
    case 'fmt:highlight':
      return { kind: 'inline', open: '==', close: '==' }
    case 'fmt:superscript':
      return { kind: 'inline', open: '^', close: '^' }
    case 'fmt:subscript':
      return { kind: 'inline', open: '~', close: '~' }
    case 'fmt:math-inline':
      return { kind: 'inline', open: '$', close: '$' }
    case 'fmt:h1':
      return { kind: 'h1', k: 1 }
    case 'fmt:h2':
      return { kind: 'h1', k: 2 }
    case 'fmt:h3':
      return { kind: 'h1', k: 3 }
    case 'fmt:h4':
      return { kind: 'h1', k: 4 }
    case 'fmt:h5':
      return { kind: 'h1', k: 5 }
    case 'fmt:h6':
      return { kind: 'h1', k: 6 }
    case 'fmt:p':
      return { kind: 'p' }
    case 'fmt:quote':
      return { kind: 'quote' }
    case 'fmt:ulist':
      return { kind: 'ulist' }
    case 'fmt:olist':
      return { kind: 'olist' }
    case 'fmt:task':
      return { kind: 'task' }
    case 'fmt:code-block':
      return { kind: 'fence' }
    case 'fmt:link':
      return { kind: 'link' }
    // ---- P2-9 插入类 ----
    case 'fmt:table':
      return { kind: 'insert', what: 'table' }
    case 'fmt:hr':
      return { kind: 'insert', what: 'hr' }
    case 'fmt:image':
      return { kind: 'insert', what: 'image' }
    case 'fmt:math-block':
      return { kind: 'insert', what: 'math-block' }
    case 'fmt:callout':
      return { kind: 'insert', what: 'callout' }
    case 'fmt:mermaid':
      return { kind: 'insert', what: 'mermaid' }
    case 'fmt:toc':
      return { kind: 'insert', what: 'toc' }
    case 'fmt:footnote':
      return { kind: 'insert', what: 'footnote' }
    default:
      return null
  }
}

/** 一次格式化动作要发的事务。`effects` 只有插入表格用得上（见 insertSpec） */
export interface FormatSpec {
  changes: ChangeSpec[]
  selection: EditorSelection
  effects?: StateEffect<unknown>[]
}

/** 导出给单测：算出格式动作要发的 changes + 新选区（不依赖视图） */
export function makeFormatSpec(state: EditorState, action: MenuAction): FormatSpec {
  const op = formatActionOf(action)
  const changes: ChangeSpec[] = []
  if (!op) return { changes, selection: state.selection }
  // 插入类是另一种东西（不是开关），走单独一条路：只认主选区、不保留选区
  if (op.kind === 'insert') return insertSpec(state, op.what)
  const ranges = state.selection.ranges
  for (const r of ranges) emitForRange(state, op, r.from, r.to, changes)
  // 保留选区（不折叠成光标）：幂等开关要靠「选区仍盖住格式化后的内容」判定。
  // 映射用 CodeMirror 自己的 ChangeSet.mapPos —— 手写位移在删除/插入混合时
  // 会混用原始与位移后坐标，把选区映射到文档尾之外（"Selection outside"）。
  // from 取 assoc=-1（贴左）、to 取 assoc=1（贴右）：插入的定界符被包进选区，
  // 下一次按键 isWrapped 才能认出并摘掉。
  const cs = changes.length ? ChangeSet.of(changes, state.doc.length) : null
  const sel = state.selection.ranges.map((r) =>
    EditorSelection.range(
      cs ? cs.mapPos(r.from, -1) : r.from,
      cs ? cs.mapPos(r.to, 1) : r.to
    )
  )
  return { changes, selection: EditorSelection.create(sel, state.selection.mainIndex) }
}

/** 把单个格式动作应用到活动视图。非格式 action 直接返回。 */
export function applyFormat(view: EditorView, action: MenuAction): void {
  const spec = makeFormatSpec(view.state, action)
  view.dispatch(spec)
}

function emitForRange(
  state: EditorState,
  op: LineOp,
  from: number,
  to: number,
  out: ChangeSpec[]
): void {
  switch (op.kind) {
    case 'inline': {
      const { open, close } = op
      const doc = state.doc
      if (to <= from) {
        // 无选区：光标在词上就用该词（已被定界符夹着则连定界符一起），否则插空对
        const word = inlineTargetAt(state, from, open, close)
        if (word) {
          if (isWrapped(doc, word.from, word.to, open, close)) {
            out.push(
              { from: word.from, to: word.from + open.length },
              { from: word.to - close.length, to: word.to }
            )
          } else {
            out.push({ from: word.from, insert: open }, { from: word.to, insert: close })
          }
        } else {
          out.push({ from, insert: open + close })
        }
        return
      }
      if (isWrapped(doc, from, to, open, close)) {
        out.push({ from, to: from + open.length }, { from: to - close.length, to })
      } else {
        out.push({ from, insert: open }, { from: to, insert: close })
      }
      return
    }
    case 'link': {
      if (to <= from) {
        const word = wordAt(state, from)
        out.push({
          from: word ? word.from : from,
          insert: `[${word ? state.doc.sliceString(word.from, word.to) : ''}]()`
        })
        return
      }
      // 链接是 [x](url) 非对称结构，直接对选区文本判正则（isWrapped 的双定界符不适用）
      const m = /^\[(.*)\]\((.*)\)$/.exec(state.doc.sliceString(from, to))
      if (m) {
        // 已是链接 → 摘回纯文本（去掉 [ ] 与 (url)）
        out.push({ from, to: from + m[0].length, insert: m[1]! })
      } else {
        out.push({ from, insert: '[' }, { from: to, insert: ']()' })
      }
      return
    }
    default:
      // 行级操作（标题/段落/引用/列表/任务/围栏）
      emitLineOp(state, op, from, to, out)
      return
  }
}

/** 行级：作用于选区覆盖的行区间。 */
function emitLineOp(state: EditorState, op: LineOp, from: number, to: number, out: ChangeSpec[]): void {
  const doc = state.doc
  const startLineNo = doc.lineAt(from).number
  const endLineNo = doc.lineAt(to).number
  // 围栏是块级（包住整个选区），逐行处理只适用于标题/引用/列表/任务
  if (op.kind === 'fence') {
    emitFence(doc, from, to, out)
    return
  }
  for (let ln = startLineNo; ln <= endLineNo; ln++) {
    const line = doc.line(ln)
    emitOnLine(state, op, line.from, line.to, out)
  }
}

/** 围栏：首行已是 ``` 则摘（去掉首尾围栏行），否则在选区外包围栏 */
function emitFence(doc: EditorState['doc'], from: number, to: number, out: ChangeSpec[]): void {
  const firstLine = doc.lineAt(from)
  const lastLine = doc.lineAt(to)
  if (/^```[ \t]*$/.test(firstLine.text)) {
    // 光标停在开围栏行上 → 摘掉开围栏 + 之后的第一个闭围栏
    out.push({ from: firstLine.from, to: Math.min(firstLine.to + 1, doc.length) })
    const closeLine = findClosingFence(doc, firstLine.number)
    if (closeLine) out.push({ from: Math.max(closeLine.from - 1, 0), to: Math.min(closeLine.to + 1, doc.length) })
  } else {
    // 包上：首行前插入 ```，末行后插入 ```（尾部带换行，闭围栏独占一行）
    out.push({ from: firstLine.from, insert: '```\n' })
    out.push({ from: lastLine.to, insert: '\n```' })
  }
}

/** 从 start 行之后找最近的 ``` 闭围栏（扫到文档尾） */
function findClosingFence(doc: EditorState['doc'], start: number): { from: number; to: number } | null {
  for (let ln = start + 1; ln <= doc.lines; ln++) {
    const line = doc.line(ln)
    if (/^```[ \t]*$/.test(line.text)) return { from: line.from, to: line.to }
  }
  return null
}

function emitOnLine(
  state: EditorState,
  op: LineOp,
  _lineFrom: number,
  _lineTo: number,
  out: ChangeSpec[]
): void {
  const doc = state.doc
  const line = doc.lineAt(_lineFrom)
  const text = line.text
  switch (op.kind) {
    case 'h1': {
      const m = /^(#{1,6})([ \t])/.exec(text)
      const level = m ? m[1]!.length : 0
      if (level === op.k) {
        // 已同级 → 摘成正文
        out.push({ from: line.from, to: line.from + m![0].length })
      } else if (m) {
        // 换级
        out.push({ from: line.from, to: line.from + m[0].length, insert: '#'.repeat(op.k) + ' ' })
      } else {
        out.push({ from: line.from, insert: '#'.repeat(op.k) + ' ' })
      }
      return
    }
    case 'p': {
      const m = /^(#{1,6})([ \t])/.exec(text)
      if (m) out.push({ from: line.from, to: line.from + m[0].length })
      return
    }
    case 'quote': {
      if (/^>([ \t]|$)/.test(text)) {
        out.push({ from: line.from, to: line.from + (/^>([ \t])/.test(text) ? 2 : 1) })
      } else out.push({ from: line.from, insert: '> ' })
      return
    }
    case 'ulist': {
      if (/^[-*+]([ \t]|$)/.test(text)) {
        out.push({ from: line.from, to: line.from + (/^[-*+][ \t]/.test(text) ? 2 : 1) })
      } else out.push({ from: line.from, insert: '- ' })
      return
    }
    case 'olist': {
      const m = /^(\d+)([.、])([ \t]|$)/.exec(text)
      if (m) out.push({ from: line.from, to: line.from + m[0].length })
      else out.push({ from: line.from, insert: '1. ' })
      return
    }
    case 'task': {
      if (/^[-*+]\s\[[ xX]\]([ \t]|$)/.test(text)) {
        // 已是任务项 → 去掉 "- [ ] "
        const m = /^[-*+]\s\[[ xX]\]\s?/.exec(text)
        out.push({ from: line.from, to: line.from + m![0].length })
        return
      }
      if (/^[-*+]([ \t]|$)/.test(text)) {
        const m = /^[-*+][ \t]/.exec(text)
        out.push({ from: line.from, to: line.from + m![0].length, insert: '- [ ] ' })
      } else {
        out.push({ from: line.from, insert: '- [ ] ' })
      }
      return
    }
    case 'inline':
    case 'link':
    case 'fence':
    case 'insert':
      // 不该走到这里（这四种已在 makeFormatSpec/emitForRange/emitLineOp 挡掉）
      return
  }
  void doc
  void state
}

// ---------- P2-9 插入类 ----------

/**
 * 插入类：在光标处插一段骨架，光标停在「该接着打字的地方」。
 *
 * 与上面那 18 个开关是两种东西，所以走单独一条路：
 *   - **只作用于主选区** —— 多光标插三张表没有意义
 *   - **不保留选区**。开关要靠「选区仍盖住格式化后的内容」做幂等判定，插入没这回事，
 *     一律收成一个光标
 *   - **块级骨架一律另起一段，不吃选区**（只有图片把选区当 alt）。「选中一段变成告示块」
 *     听着顺，但那是 `fmt:quote` 的活儿 + 一行类型标记，混进来只会让这条路两种语义
 */
interface Skeleton {
  /** 源码骨架。块级的不带首尾空行 —— 垫空行归 `blockSlot` */
  text: string
  /** 光标落在 text 内的偏移 */
  cursor: number
  /** 块级 = 必须独占一段 */
  block: boolean
}

/** 新表默认 3 列 × 2 行；单元格空格填充与 input-rules 的骨架同款 */
const TABLE_COLS = 3
const TABLE_ROWS = 2

function skeletonOf(what: Exclude<InsertKind, 'footnote'>, selected: string): Skeleton {
  switch (what) {
    case 'table': {
      const row = (cell: string) =>
        `| ${Array.from({ length: TABLE_COLS }, () => cell).join(' | ')} |`
      const rows = [row('   '), row('---')]
      for (let i = 0; i < TABLE_ROWS; i++) rows.push(row('   '))
      // 光标落在表头第一格（`| ` 之后）—— 配合 setTableEdit，新表直接以渲染态出现，
      // 焦点已经在那一格里
      return { text: rows.join('\n'), cursor: 2, block: true }
    }
    case 'hr':
      // 带尾换行：光标停到分隔线**下面**那一空行，接着就能写正文
      return { text: '---\n', cursor: 4, block: true }
    case 'toc':
      return { text: '[TOC]\n', cursor: 6, block: true }
    case 'math-block':
      return { text: '$$\n\n$$', cursor: 3, block: true }
    case 'mermaid':
      return { text: '```mermaid\n\n```', cursor: 11, block: true }
    case 'callout':
      // NOTE 是 decorate.ts 那张类型表里的第一条；写成表外的类型也只是退回普通引用
      return { text: '> [!NOTE]\n> ', cursor: 12, block: true }
    case 'image':
      // 有选区就拿它当 alt；光标一律落进 url 那对括号（alt 可以不写，url 不能）
      return { text: `![${selected}]()`, cursor: selected.length + 4, block: false }
  }
}

/**
 * 块级骨架的落点：保证它独占一段。
 *
 * 光标在空行上 → 就地占用那一行（行上的空白一起换掉）；在有字的行上 → 落到该行之后。
 * 上一段有字就垫一个空行 —— 表格 / 围栏 / 公式块紧贴文字会被当成那一段的续行，
 * `---` 贴在文字下面更会直接变成 setext 二级标题而不是分隔线。
 * 尾部只在「下一行还有字、且骨架自己没带尾换行」时补，免得多出一条空行。
 */
function blockSlot(
  doc: EditorState['doc'],
  pos: number,
  text: string
): { from: number; to: number; before: string; after: string } {
  const line = doc.lineAt(pos)
  const blank = line.text.trim() === ''
  const prev = line.number > 1 ? doc.line(line.number - 1) : null
  const next = line.number < doc.lines ? doc.line(line.number + 1) : null
  const above = blank ? prev?.text.trim() : line.text.trim()
  const before = above ? (blank ? '\n' : '\n\n') : ''
  const after = next?.text.trim() && !text.endsWith('\n') ? '\n' : ''
  return blank
    ? { from: line.from, to: line.to, before, after }
    : { from: line.to, to: line.to, before, after }
}

function insertSpec(state: EditorState, what: InsertKind): FormatSpec {
  if (what === 'footnote') return footnoteSpec(state)
  const main = state.selection.main
  const skel = skeletonOf(what, state.doc.sliceString(main.from, main.to))
  if (!skel.block) {
    return {
      changes: [{ from: main.from, to: main.to, insert: skel.text }],
      selection: EditorSelection.single(main.from + skel.cursor)
    }
  }
  const slot = blockSlot(state.doc, main.to, skel.text)
  const at = slot.from + slot.before.length
  const spec: FormatSpec = {
    changes: [{ from: slot.from, to: slot.to, insert: slot.before + skel.text + slot.after }],
    selection: EditorSelection.single(at + skel.cursor)
  }
  // 表格插完直接进就地编辑态 —— 与 input-rules 的表格骨架同一条路。
  // 值 = 表格块起点（改动之后的位置）。源代码模式/单测里没有这个字段，effect 被原样忽略
  return what === 'table' ? { ...spec, effects: [setTableEdit.of(at)] } : spec
}

/**
 * 脚注是两处改动：光标处插引用 `[^n]`，文末插定义 `[^n]: `，光标停到定义那一行去写正文。
 * 编号取「文档里现有数字标签的最大值 + 1」—— 复用已有编号会静默把两处引用并成同一条注。
 */
function footnoteSpec(state: EditorState): FormatSpec {
  const doc = state.doc
  let max = 0
  for (const m of doc.toString().matchAll(/\[\^(\d+)\]/g)) max = Math.max(max, Number(m[1]))
  const ref = `[^${max + 1}]`
  const at = state.selection.main.to
  // 定义区接在文末，且必须独占一段。「文末已是空行」这条要排除掉「引用正插在那一空行上」
  // 的情形 —— 引用一插进去那行就不空了，不垫的话定义会和引用挤在同一行
  const last = doc.line(doc.lines)
  const pad = last.text.trim() === '' && at < last.from ? '' : '\n\n'
  const def = `${pad}${ref}: `
  return {
    changes: [
      { from: at, insert: ref },
      { from: doc.length, insert: def }
    ],
    // 定义正好在文档末尾，光标就是新的文档长度
    selection: EditorSelection.single(doc.length + ref.length + def.length)
  }
}

/** 分词器构造不便宜，而 formatStateAt 每次光标移动都要走一趟 —— 建一次就够 */
let seg: Intl.Segmenter | null = null
function segmenter(): Intl.Segmenter {
  return (seg ??= new Intl.Segmenter(undefined, { granularity: 'word' }))
}

/** 光标所在的中文/英文词（Intl.Segmenter 分词）；不在词上返回 null */
export function wordAt(state: EditorState, pos: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(pos)
  const text = line.text
  if (!text) return null
  for (const s of segmenter().segment(text)) {
    const from = line.from + s.index
    const to = from + s.segment.length
    if (s.isWordLike && pos >= from && pos < to) return { from, to }
  }
  return null
}

/** 判断 [from,to) 是否恰好由 open…close 包裹：看范围内首尾定界符，
 *  不依赖范围外（doc 开头 from=0 时向前取值会越界判失败） */
function isWrapped(
  doc: EditorState['doc'],
  from: number,
  to: number,
  open: string,
  close: string
): boolean {
  if (doc.sliceString(from, from + open.length) !== open) return false
  if (doc.sliceString(to - close.length, to) !== close) return false
  // 同字符重复型标记（* ** ~~ `）还要确认这一串的长度就是它自己：
  // 不加这条，`*` 会把 `**粗体**` 认成斜体 —— 格式栏上 B 和 I 一起亮，
  // ⌘I 还会把它啃成 `*粗体*`
  const ch = open[0]!
  if (![...open].every((c) => c === ch)) return true
  return runIs(doc, from, open.length, ch) && runIs(doc, to - close.length, close.length, ch)
}

/** `at` 处这一串连续的 ch 长度恰好是 len（两侧都不再是 ch） */
function runIs(doc: EditorState['doc'], at: number, len: number, ch: string): boolean {
  return doc.sliceString(at - 1, at) !== ch && doc.sliceString(at + len, at + len + 1) !== ch
}

/**
 * 光标所在行上、**把光标夹在中间**的那一对定界符。
 * 为什么不只看「光标所在词」：中文分词会把 `**粗体**` 里的词切开，光标停在两字中间时
 * 词边界压根碰不到星号，于是「再按一次 ⌘B」会套成 `****粗体****` 而不是取消。
 * 有选区那条路一直是对的，无选区这条以前漏了 —— 格式栏把它摆到了明面上：
 * **亮着的按钮点下去必须灭**。
 */
function enclosingWrap(
  state: EditorState,
  pos: number,
  open: string,
  close: string
): { from: number; to: number } | null {
  const line = state.doc.lineAt(pos)
  const rel = pos - line.from
  const start = line.text.lastIndexOf(open, Math.max(0, rel - 1))
  if (start < 0) return null
  const end = line.text.indexOf(close, Math.max(start + open.length, rel))
  if (end < 0) return null
  const from = line.from + start
  const to = line.from + end + close.length
  return isWrapped(state.doc, from, to, open, close) ? { from, to } : null
}

/** 行内格式该作用在哪一段：已经被包住就连定界符一起，否则是光标所在词 */
function inlineTargetAt(
  state: EditorState,
  pos: number,
  open: string,
  close: string
): { from: number; to: number } | null {
  return enclosingWrap(state, pos, open, close) ?? wordAt(state, pos)
}

/** 标题按级别排开，工具栏的「块类型」下拉直接按下标取 */
export const HEADING_ACTIONS = [
  'fmt:h1',
  'fmt:h2',
  'fmt:h3',
  'fmt:h4',
  'fmt:h5',
  'fmt:h6'
] as const satisfies readonly MenuAction[]

const INLINE_ACTIONS = [
  'fmt:bold',
  'fmt:italic',
  'fmt:underline',
  'fmt:strikethrough',
  'fmt:code-inline',
  'fmt:highlight',
  'fmt:superscript',
  'fmt:subscript',
  'fmt:math-inline'
] as const satisfies readonly MenuAction[]

/** 工具栏「插入」下拉里的条目顺序；插入类**永远不点亮**（它们不是开关） */
export const INSERT_ACTIONS = [
  'fmt:table',
  'fmt:image',
  'fmt:hr',
  'fmt:math-block',
  'fmt:callout',
  'fmt:mermaid',
  'fmt:footnote',
  'fmt:toc'
] as const satisfies readonly MenuAction[]

/**
 * P2-8：光标处当前生效的格式，给底部格式栏点亮按钮用。
 *
 * **判定必须和 emitForRange / emitOnLine 同源** —— 亮着的按钮点下去就得是「取消」。
 * 两处一旦分家，用户第一眼就会发现。所以这里复用的是同一批正则和同一个 isWrapped，
 * 而不是去查语法树（`<u>` 下划线在树上压根没有节点，查树反而对不上）。
 *
 * 两处刻意的偏离，为的是让高亮读起来不别扭：
 *   - 任务项行**不**点亮「无序列表」（它确实匹配 `^[-*+] `，但用户眼里那是任务不是列表）
 *   - 「正文」在所有非标题行上常亮 —— 它是块类型指示器，不是开关
 *
 * 已知局限：「代码块」只在光标停在 ``` 围栏行时点亮（`emitFence` 就是这么判的），
 * 光标在围栏**内部**不亮。
 */
export function formatStateAt(state: EditorState): Set<MenuAction> {
  const on = new Set<MenuAction>()
  const doc = state.doc
  const main = state.selection.main

  // 行内：无选区时看光标所在词，与 emitForRange 的无选区分支走同一个 wrappedWordAt
  for (const action of INLINE_ACTIONS) {
    const op = formatActionOf(action)
    if (op?.kind !== 'inline') continue
    const span = main.empty
      ? inlineTargetAt(state, main.from, op.open, op.close)
      : { from: main.from, to: main.to }
    if (span && isWrapped(doc, span.from, span.to, op.open, op.close)) on.add(action)
  }
  // 链接是 [x](u) 非对称结构，只有选区盖住整段时才认（和 emitForRange 一致）
  if (!main.empty && /^\[(.*)\]\((.*)\)$/.test(doc.sliceString(main.from, main.to))) {
    on.add('fmt:link')
  }

  const text = doc.lineAt(main.from).text
  const heading = /^(#{1,6})([ \t])/.exec(text)
  if (heading) on.add(HEADING_ACTIONS[heading[1]!.length - 1]!)
  else on.add('fmt:p')
  if (/^>([ \t]|$)/.test(text)) on.add('fmt:quote')
  if (/^[-*+]\s\[[ xX]\]([ \t]|$)/.test(text)) on.add('fmt:task')
  else if (/^[-*+]([ \t]|$)/.test(text)) on.add('fmt:ulist')
  if (/^(\d+)([.、])([ \t]|$)/.test(text)) on.add('fmt:olist')
  if (/^```[ \t]*$/.test(text)) on.add('fmt:code-block')
  return on
}
