import { EditorState, type TransactionSpec } from '@codemirror/state'
import { type EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import { holdPointerLayout, pointerSelection, pointerSelectionEvents } from '../src/renderer/editor/pointer-selection'
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

describe('拖选结束后的延迟布局', () => {
  function editor() {
    const ownerDocument = Object.assign(new EventTarget(), { defaultView: new EventTarget() })
    const contentDOM = Object.assign(new EventTarget(), {
      ownerDocument, style: { paddingBottom: '' }, closest: () => null
    })
    let state = stateAt(target).update({ effects: holdPointerLayout.of(true) }).state
    let request: any
    const view = {
      contentDOM,
      scrollDOM: { scrollTop: 0, scrollHeight: 300, clientHeight: 200,
        getBoundingClientRect: () => ({ top: 0 }) },
      get state() { return state },
      coordsAtPos: vi.fn((pos: number) => {
        state.doc.lineAt(pos) // 与真实视图一样，旧位置越界必须报错。
        return { top: 100, bottom: 120 }
      }),
      requestMeasure: (r: any) => { request = r },
      dispatch: (spec: TransactionSpec) => {
        const tr = state.update(spec)
        state = tr.state
        plugin.update({ docChanged: tr.docChanged, selectionSet: !!tr.selection })
      }
    } as unknown as EditorView
    const plugin = (pointerSelectionEvents as unknown as { create(v: EditorView): any }).create(view)
    contentDOM.dispatchEvent(new Event('keydown'))
    expect(request).toBeDefined()
    vi.mocked(view.coordsAtPos).mockClear()
    return { view, plugin, request }
  }

  it('文档在测量前被清空，旧位置不再参与布局', () => {
    const { view, plugin, request } = editor()
    view.dispatch({ changes: { from: 0, to: view.state.doc.length } })
    expect(() => request.write(request.read(view), view)).not.toThrow()
    expect(view.coordsAtPos).not.toHaveBeenCalled()
    plugin.destroy()
  })

  it('切换标签销毁旧插件后，不再读取新标签的坐标', () => {
    const { view, plugin, request } = editor()
    plugin.destroy()
    request.write(request.read(view), view)
    expect(view.coordsAtPos).not.toHaveBeenCalled()
  })

  it('读取与写入之间选区改变，旧补偿不再滚动视口', () => {
    const { view, plugin, request } = editor()
    const measured = request.read(view)
    measured.at.top = 180
    view.dispatch({ selection: { anchor: 0 } })
    request.write(measured, view)
    expect(view.scrollDOM.scrollTop).toBe(0)
    plugin.destroy()
  })

  it('同一次手势未被打断，仍补偿布局变化', () => {
    const { view, plugin, request } = editor()
    const measured = request.read(view)
    measured.at.top = 180
    request.write(measured, view)
    expect(view.scrollDOM.scrollTop).toBe(80)
    plugin.destroy()
  })
})
