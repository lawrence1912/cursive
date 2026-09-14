import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { holdPointerLayout, pointerSelection } from '../src/renderer/editor/pointer-selection'
import { Reveal } from '../src/renderer/editor/live-preview/reveal'
import { blockField } from '../src/renderer/editor/live-preview'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'

const doc = 'Start\n\n$$\nx^2\n$$\n\nTarget\n'
const math = doc.indexOf('x^2')
const target = doc.indexOf('Target')
function stateAt(anchor: number) {
  return EditorState.create({
    doc, selection: { anchor }, extensions: [cursiveMarkdown(), pointerSelection, blockField]
  })
}

describe('鼠标手势固定回显布局', () => {
  it('上方源码在拖选结束前不会突然长成预览，真实选区仍更新', () => {
    let state = stateAt(math)
    state = state.update({ effects: holdPointerLayout.of(true) }).state
    const blocks = state.field(blockField)
    state = state.update({ selection: { anchor: target }, userEvent: 'select.pointer' }).state
    expect(state.selection.main.head).toBe(target)
    expect(new Reveal(state, 'line').touches(math, math + 3)).toBe(true)
    expect(state.field(blockField)).toBe(blocks)
    state = state.update({ effects: holdPointerLayout.of(false) }).state
    expect(new Reveal(state, 'line').touches(math, math + 3)).toBe(false)
    expect(state.field(blockField).size).toBe(1)
  })

  it('拖选跨过已渲染的块时不拆 widget，松手后才回显选中块', () => {
    let state = stateAt(0)
    state = state.update({ effects: holdPointerLayout.of(true) }).state
    const blocks = state.field(blockField)
    state = state.update({ selection: { anchor: 0, head: target }, userEvent: 'select.pointer' }).state
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toContain('x^2')
    expect(state.field(blockField)).toBe(blocks)
    state = state.update({ effects: holdPointerLayout.of(false) }).state
    expect(state.field(blockField).size).toBe(0)
  })

  it('编辑文档立即解除固定，键盘移动仍使用实时选区', () => {
    let state = stateAt(math)
    state = state.update({ effects: holdPointerLayout.of(true) }).state
    state = state.update({ changes: { from: 0, insert: 'a' } }).state
    expect(state.field(pointerSelection)).toBeNull()
    state = state.update({ selection: { anchor: target + 1 } }).state
    expect(new Reveal(state, 'line').touches(math + 1, math + 4)).toBe(false)
  })
})
