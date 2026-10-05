import { isolateHistory } from '@codemirror/commands'
import type { ChangeSpec, EditorState, TransactionSpec } from '@codemirror/state'
import type katex from 'katex'
import { parsedTree } from './syntax'

/** 分组内容保持原样，尤其不能整理 \text 中有意义的空格或注释里的花括号。 */
function groupEnd(tex: string, start: number): number {
  let depth = 0
  for (let i = start; i < tex.length; i++) {
    if (tex[i] === '\\') { i++; continue }
    if (tex[i] === '%') {
      const end = tex.indexOf('\n', i)
      if (end < 0) return tex.length
      i = end
    } else if (tex[i] === '{') depth++
    else if (tex[i] === '}' && --depth === 0) return i + 1
  }
  return tex.length
}

/** 只整理数学层的空白，命令、参数组与文本内容不重写。 */
export function formatLatex(tex: string, display: boolean): string {
  const lines: string[] = []
  let line = ''
  let depth = 0
  const flush = (): void => {
    if (line.trim()) lines.push('  '.repeat(depth) + line.trim())
    line = ''
  }
  for (let i = 0; i < tex.length;) {
    const rest = tex.slice(i)
    const env = display && /^\\(begin|end)\{([^{}]+)\}/.exec(rest)
    if (env) {
      flush()
      if (env[1] === 'end') depth = Math.max(0, depth - 1)
      line = env[0]
      i += env[0].length
      // array / alignedat 的列参数与环境名放在同一行。
      if (env[1] === 'begin') {
        const args = /^(?:[ \t]*\[[^\]\n]*\])?(?:[ \t]*\{[^{}\n]*\})?/.exec(tex.slice(i))![0]
        line += args
        i += args.length
      }
      flush()
      if (env[1] === 'begin') depth++
      continue
    }
    if (rest.startsWith('\\\\')) {
      const row = /^\\\\\*?(?:\[[^\]\n]*\])?/.exec(rest)![0]
      line = line.trimEnd() + ' ' + row
      i += row.length
      if (display) flush()
      else line += ' '
    } else if (tex[i] === '{') {
      const end = groupEnd(tex, i)
      line += tex.slice(i, end)
      i = end
    } else if (tex[i] === '\\') {
      const command = /^\\(?:[a-zA-Z]+|[\s\S])/.exec(rest)?.[0] ?? '\\'
      line += command
      i += command.length
    } else if (tex[i] === '%') {
      const end = tex.indexOf('\n', i)
      line += tex.slice(i, end < 0 ? tex.length : end)
      flush()
      i = end < 0 ? tex.length : end + 1
    } else if (tex[i] === '\n' && display) {
      flush()
      i++
    } else if (/[=+<>&]/.test(tex[i]!)) {
      const op = tex[i++]!
      line = line.trimEnd() + (op === '=' && line.trimEnd().endsWith('&') ? '' : ' ') + op + ' '
    } else if (/\s/.test(tex[i]!)) {
      if (line && !line.endsWith(' ')) line += ' '
      i++
    } else {
      line += tex[i++]
    }
  }
  flush()
  return lines.join('\n')
}

export function latexFormatSpec(state: EditorState, renderer: typeof katex): {
  spec: TransactionSpec | null; found: number; changed: number; skipped: number
} {
  const changes: ChangeSpec[] = []
  let skipped = 0
  if (state.readOnly) return { spec: null, found: 0, changed: 0, skipped }
  const ranges = state.selection.ranges
  const tree = parsedTree(state)
  const targets: { from: number; to: number; display: boolean; delim: string }[] = []
  let overlapsMath = false
  let overlapsCode = false
  tree.iterate({ enter(node) {
    const overlaps = ranges.some(r => r.empty ? r.from >= node.from && r.to <= node.to
      : r.from < node.to && r.to > node.from)
    if (!overlaps) return false
    if (['FencedCode', 'CodeBlock', 'InlineCode'].includes(node.name)) {
      overlapsCode = true
      return false
    }
    if (node.name !== 'DisplayMath' && node.name !== 'InlineMath') return
    overlapsMath = true
    if (ranges.some(r => (r.from >= node.from && r.to <= node.to)
      || (r.from <= node.from && r.to >= node.to))) {
      targets.push({ from: node.from, to: node.to, display: node.name === 'DisplayMath',
        delim: state.doc.sliceString(node.from, node.from + 2) === '$$' ? '$$' : '$' })
    }
    return false
  } })
  // 纯 TeX 必须由用户明确选中；代码示例、货币、残缺的 $ 定界符不走此分支。
  if (!overlapsMath && !overlapsCode && ranges.length === 1 && !ranges[0]!.empty) {
    const r = ranges[0]!
    const text = state.doc.sliceString(r.from, r.to)
    if (!text.includes('$') && /\\[a-zA-Z]+|[=^_]/.test(text)) {
      targets.push({ from: r.from, to: r.to, display: true, delim: '' })
    }
  }
  for (const target of targets) {
    const raw = state.doc.sliceString(target.from, target.to)
    const source = target.display && target.delim ? raw.trimEnd() : raw
    const tex = target.delim ? source.slice(target.delim.length, -target.delim.length) : source
    const formatted = formatLatex(tex, target.display)
    try {
      const options = { displayMode: target.display, output: 'html' as const, strict: false, throwOnError: true }
      if (renderer.renderToString(tex, options) !== renderer.renderToString(formatted, options)) {
        skipped++
        continue
      }
    } catch {
      skipped++
      continue
    }
    const insert = target.delim === '$$' && target.display ? `$$\n${formatted}\n$$`
      : target.delim + formatted + target.delim
    if (insert !== raw) changes.push({ from: target.from, to: target.to, insert })
  }
  return { found: targets.length, changed: changes.length, skipped, spec: changes.length ? {
    changes, userEvent: 'input.format', annotations: isolateHistory.of('full')
  } : null }
}
