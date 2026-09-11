import { EditorView } from '@codemirror/view'
import { ChangeSet, EditorSelection, EditorState, type ChangeSpec } from '@codemirror/state'
import type { MenuAction } from '../../shared/types'

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
    default:
      return null
  }
}

/** 导出给单测：算出格式动作要发的 changes + 新选区（不依赖视图） */
export function makeFormatSpec(
  state: EditorState,
  action: MenuAction
): { changes: ChangeSpec[]; selection: EditorSelection } {
  const op = formatActionOf(action)
  const changes: ChangeSpec[] = []
  if (!op) return { changes, selection: state.selection }
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
        // 无选区：光标在词上就用该词，否则插空对
        const word = wordAt(state, from)
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
      // 不该走到这里（inline/link/fence 已在 emitForRange/emitLineOp 挡掉）
      return
  }
  void doc
  void state
}

/** 光标所在的中文/英文词（Intl.Segmenter 分词）；不在词上返回 null */
export function wordAt(state: EditorState, pos: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(pos)
  const text = line.text
  if (!text) return null
  const seg = new Intl.Segmenter(undefined, { granularity: 'word' })
  for (const s of seg.segment(text)) {
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
  return (
    doc.sliceString(from, from + open.length) === open &&
    doc.sliceString(to - close.length, to) === close
  )
}

