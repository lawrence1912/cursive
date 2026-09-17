import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  FLASH_MS,
  flashedLine,
  jumpTo,
  landingFlash,
  stableNavigation
} from '../src/renderer/editor/navigation'

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

/**
 * 落点提示：按名字跳过去之后，那一行先亮一下再淡出（`editor/navigation.ts`）。
 * 这里守三件事 —— 亮在**落点那一行的行首**（行级装饰只能挂行首）、文档一改就撤、
 * 到点自己消失。淡出本身是 CSS 的事（`editor/theme.ts`），不在这儿断言。
 */
describe('跳转落点提示', () => {
  function flashEditor() {
    let state = EditorState.create({
      doc: '第一行\n第二行\n第三行\n第四行',
      extensions: [landingFlash]
    })
    const view = {
      dom: new EventTarget(),
      dispatch: vi.fn(),
      get state() {
        return state
      }
    } as unknown as EditorView
    const plugin = (landingFlash as unknown as { 1: { create(v: EditorView): any } })[1].create(view)
    const apply = (spec: any): void => {
      const tr = state.update(spec)
      state = tr.state
      plugin.update({ transactions: [tr], geometryChanged: false })
    }
    vi.mocked(view.dispatch).mockImplementation(apply)
    return { view, plugin, apply, at: () => flashedLine(state), state: () => state }
  }

  it('跳过去之后，落点那一行的行首亮着', () => {
    vi.useFakeTimers()
    const ed = flashEditor()
    const target = ed.state().doc.line(3).from + 1 // 行中间也要归到行首
    jumpTo(ed.view, target)
    expect(ed.at()).toBe(ed.state().doc.line(3).from)
    ed.plugin.destroy()
  })

  it('再跳一次就换到新的落点', () => {
    vi.useFakeTimers()
    const ed = flashEditor()
    jumpTo(ed.view, ed.state().doc.line(2).from)
    jumpTo(ed.view, ed.state().doc.line(4).from)
    expect(ed.at()).toBe(ed.state().doc.line(4).from)
    ed.plugin.destroy()
  })

  it('一动文档就撤 —— 改的往往正是那一行', () => {
    vi.useFakeTimers()
    const ed = flashEditor()
    jumpTo(ed.view, ed.state().doc.line(3).from)
    expect(ed.at()).not.toBeNull()
    ed.apply({ changes: { from: 0, insert: '前' } })
    expect(ed.at()).toBeNull()
    ed.plugin.destroy()
  })

  it('到点自己消失，而且只派一次', () => {
    vi.useFakeTimers()
    const ed = flashEditor()
    jumpTo(ed.view, ed.state().doc.line(2).from)
    vi.mocked(ed.view.dispatch).mockClear()
    vi.advanceTimersByTime(FLASH_MS - 1)
    expect(ed.at()).not.toBeNull()
    vi.advanceTimersByTime(2)
    expect(ed.at()).toBeNull()
    expect(ed.view.dispatch).toHaveBeenCalledTimes(1)
    // 已经灭了就不再多派一次空事务
    vi.runAllTimers()
    expect(ed.view.dispatch).toHaveBeenCalledTimes(1)
    ed.plugin.destroy()
  })
})
