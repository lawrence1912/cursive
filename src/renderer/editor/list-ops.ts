import { ChangeSet, EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state'

/**
 * P2-3 列表智能：Tab / ⇧Tab 升降级 + 有序列表重编号。
 *
 * 回车续行、空列表项退出、任务项续 `[ ]` 由 markdownKeymap 的
 * insertNewlineContinueMarkup 负责；这里补「升降级」——原来 Tab 绑的是
 * indentWithTab（纯空格），在列表里要先接管。
 *
 * 每行只发一条「前缀替换」change（缩进 + 重编号合并），一个事务完成 →
 * ⌘Z 一步撤回，也不会出现缩进与重编号两条 change 重叠的坑。
 */

interface ListInfo {
  indent: number
  /** '-', '*', '+', '1.' ... 保留原分隔符风格 */
  marker: string
  /** 标记与内容之间的空格 */
  gap: string
  ordered: boolean
}

const LIST_RE = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(.*)$/

export function listInfo(text: string): ListInfo | null {
  const m = LIST_RE.exec(text)
  if (!m) return null
  return {
    indent: m[1]!.length,
    marker: m[2]!,
    gap: m[3]!,
    ordered: /^\d/.test(m[2]!)
  }
}

const INDENT_UNIT = '  '

/** 选区覆盖的行号（去重升序） */
function selectedLines(state: EditorState): number[] {
  const set = new Set<number>()
  for (const r of state.selection.ranges) {
    for (let ln = state.doc.lineAt(r.from).number; ln <= state.doc.lineAt(r.to).number; ln++) set.add(ln)
  }
  return [...set].sort((a, b) => a - b)
}

/**
 * 升降级。dir=1 缩进一级，dir=-1 减少一级。
 * 返回 null 表示选区里没有列表行（调用方回退到普通 Tab）。
 */
export function changeListIndent(state: EditorState, dir: 1 | -1): TransactionSpec | null {
  const doc = state.doc
  const lines = selectedLines(state)
  const changes: { from: number; to: number; insert: string }[] = []
  let any = false
  const done = new Set<number>()

  for (const ln of lines) {
    if (done.has(ln)) continue
    const line = doc.line(ln)
    const info = listInfo(line.text)
    if (!info) continue
    any = true

    if (info.ordered) {
      // 连续的有序列表段（同缩进）整体重编号：先向前扩到段首，再向后扩到段尾。
      // 只向后找的话，光标落在段中/段尾时前半段编号会漏。
      let start = ln
      while (start - 1 >= 1) {
        const prev = listInfo(doc.line(start - 1).text)
        if (!prev || !prev.ordered || prev.indent !== info.indent) break
        start--
      }
      let end = ln
      while (end + 1 <= doc.lines) {
        const next = listInfo(doc.line(end + 1).text)
        if (!next || !next.ordered || next.indent !== info.indent) break
        end++
      }
      let n = 1
      for (let cur = start; cur <= end; cur++) {
        const l = doc.line(cur)
        const curInfo = listInfo(l.text)!
        const indent = Math.max(0, curInfo.indent + dir * INDENT_UNIT.length)
        const delim = curInfo.marker.slice(-1) === ')' ? ')' : '.'
        changes.push({
          from: l.from,
          to: l.from + curInfo.indent + curInfo.marker.length,
          insert: ' '.repeat(indent) + `${n}${delim}`
        })
        done.add(cur)
        n++
      }
    } else {
      const indent = Math.max(0, info.indent + dir * INDENT_UNIT.length)
      changes.push({
        from: line.from,
        to: line.from + info.indent,
        insert: ' '.repeat(indent)
      })
      done.add(ln)
    }
  }

  if (!any) return null
  const cs = ChangeSet.of(changes, doc.length)
  const sel = state.selection.ranges.map((r) =>
    EditorSelection.range(cs.mapPos(r.from, -1), cs.mapPos(r.to, 1))
  )
  return {
    changes,
    selection: EditorSelection.create(sel, state.selection.mainIndex),
    userEvent: 'input.indent'
  }
}
