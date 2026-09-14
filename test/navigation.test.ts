import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { jumpTo, stableNavigation } from '../src/renderer/editor/navigation'

function editor() {
  const dom = new EventTarget()
  const view = { dom, dispatch: vi.fn() } as unknown as EditorView
  const plugin = (stableNavigation as unknown as { create(view: EditorView): any }).create(view)
  let state = EditorState.create({ doc: 'start\nheading\nend' })
  const update = (spec = {}, geometryChanged = false) => {
    const tr = state.update(spec)
    state = tr.state
    plugin.update({ transactions: [tr], geometryChanged })
  }
  vi.mocked(view.dispatch).mockImplementation((spec: any) => update(spec))
  return { dom, view, plugin, update }
}

afterEach(() => vi.useRealTimers())

describe('异步布局期间保持显式导航', () => {
  it('延迟多次变高仍对齐同一位置，布局不变时不轮询', () => {
    vi.useFakeTimers()
    const { view, plugin, update } = editor()
    jumpTo(view, 6)
    vi.mocked(view.dispatch).mockClear()
    vi.advanceTimersByTime(2000)
    expect(view.dispatch).not.toHaveBeenCalled()
    for (let i = 0; i < 3; i++) {
      update({}, true)
      update({}, true)
      vi.runAllTimers()
      expect(view.dispatch).toHaveBeenCalledTimes(i + 1)
      expect(plugin.target).toBe(6)
    }
    plugin.destroy()
  })

  for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
    it(`${event} 立即取消待执行的对齐`, () => {
      vi.useFakeTimers()
      const { dom, view, plugin, update } = editor()
      jumpTo(view, 6)
      update({}, true)
      vi.mocked(view.dispatch).mockClear()
      dom.dispatchEvent(new Event(event))
      vi.runAllTimers()
      expect(plugin.target).toBeNull()
      expect(view.dispatch).not.toHaveBeenCalled()
      plugin.destroy()
    })
  }

  it('编辑、其他选区导航、销毁均取消旧目标，新跳转替换旧目标', () => {
    vi.useFakeTimers()
    const { view, plugin, update } = editor()
    jumpTo(view, 6)
    update({ changes: { from: 0, insert: 'x' } })
    expect(plugin.target).toBeNull()
    jumpTo(view, 6)
    update({ selection: { anchor: 0 } })
    expect(plugin.target).toBeNull()
    jumpTo(view, 6)
    update({}, true)
    jumpTo(view, 0)
    expect(plugin.target).toBe(0)
    plugin.destroy()
    vi.mocked(view.dispatch).mockClear()
    vi.runAllTimers()
    expect(view.dispatch).not.toHaveBeenCalled()
  })
})
