import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'
import { Reveal, type RevealScope } from '../src/renderer/editor/live-preview/reveal'

const DOC = ['# 标题', '', '带 **粗体** 的一段。', '第二段。'].join('\n')

function revealAt(pos: number, scope: RevealScope): Reveal {
  return new Reveal(
    EditorState.create({ doc: DOC, selection: { anchor: pos }, extensions: [cursiveMarkdown()] }),
    scope
  )
}

const boldStart = DOC.indexOf('**粗体**')
const boldInner = boldStart + 3
const line3Start = DOC.indexOf('带 **粗体**')
const line4Start = DOC.indexOf('第二段。')

describe('光标回显范围', () => {
  it('node：只覆盖光标本身，同一行别处不受影响', () => {
    const r = revealAt(boldInner, 'node')
    expect(r.touches(boldInner, boldInner)).toBe(true)
    expect(r.touches(line3Start, line3Start + 1)).toBe(false)
  })

  it('line：光标所在整行都露出，其它行不露', () => {
    const r = revealAt(boldInner, 'line')
    expect(r.touches(line3Start, line3Start + 1)).toBe(true)
    expect(r.touches(boldStart, boldStart + 8)).toBe(true)
    expect(r.touches(line4Start, line4Start + 3)).toBe(false)
    expect(r.touches(0, 5)).toBe(false)
  })

  it('block：整个段落露出', () => {
    const r = revealAt(boldInner, 'block')
    expect(r.touches(line3Start, line3Start + 1)).toBe(true)
    expect(r.touches(0, 5)).toBe(false)
  })

  it('多光标的区间会合并，且都能命中', () => {
    const state = EditorState.create({
      doc: DOC,
      selection: EditorSelection.create([
        EditorSelection.cursor(1),
        EditorSelection.cursor(line4Start + 1)
      ]),
      // 不开这个 facet 的话 CodeMirror 会把多光标折叠成一个
      extensions: [cursiveMarkdown(), EditorState.allowMultipleSelections.of(true)]
    })
    const r = new Reveal(state, 'line')
    expect(r.touches(0, 3)).toBe(true)
    expect(r.touches(line4Start, line4Start + 3)).toBe(true)
    expect(r.touches(line3Start, line3Start + 1)).toBe(false)
  })

  it('选区跨行时，覆盖到的每一行都露出', () => {
    const state = EditorState.create({
      doc: DOC,
      selection: { anchor: line3Start + 1, head: line4Start + 2 },
      extensions: [cursiveMarkdown()]
    })
    const r = new Reveal(state, 'line')
    expect(r.touches(line3Start, line3Start + 1)).toBe(true)
    expect(r.touches(line4Start, line4Start + 1)).toBe(true)
  })
})
