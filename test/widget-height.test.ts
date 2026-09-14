import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorView } from '@codemirror/view'
import { FootnoteDefWidget, ImageWidget, MathWidget, loadKatex, primeHeights } from '../src/renderer/editor/live-preview/widgets'
import { HEIGHT_STORE_KEY, HEIGHT_STORE_VERSION } from '../src/renderer/editor/live-preview/height-store'

vi.mock('../src/renderer/editor/live-preview/katex', () => ({
  default: { renderToString: () => '<span>formula</span>' }
}))

class Element extends EventTarget {
  isConnected = true
  style = {}
  className = ''
  innerHTML = ''
  textContent = ''
  height = 24
  children: Element[] = []
  classList = { add: vi.fn() }
  setAttribute = vi.fn()
  append(...els: Element[]) { this.children.push(...els) }
  appendChild(el: Element) { this.children.push(el) }
  getBoundingClientRect() { return { height: this.height } }
}

let observers: { callback: () => void; disconnect: ReturnType<typeof vi.fn> }[]
let view: EditorView
let width: number

beforeEach(() => {
  observers = []
  width = 800
  vi.stubGlobal('document', { createElement: () => new Element(), createTextNode: () => new Element() })
  vi.stubGlobal('getComputedStyle', () => ({ fontFamily: 'serif', fontSize: '16px', lineHeight: '24px' }))
  vi.stubGlobal('ResizeObserver', class {
    disconnect = vi.fn()
    observe = vi.fn()
    constructor(readonly callback: () => void) { observers.push(this) }
  })
  view = {
    contentDOM: { get clientWidth() { return width } },
    scrollDOM: { clientHeight: 700 },
    requestMeasure: vi.fn((request) => {
      if (request) request.write?.(request.read(view), view)
    })
  } as unknown as EditorView
})

afterEach(() => vi.unstubAllGlobals())

describe('widget 高度学习', () => {
  it('公式异步填充后再次变高，缓存更新为完成后的高度', async () => {
    const widget = new MathWidget('late-formula', true)
    const dom = widget.toDOM(view) as unknown as Element
    observers[0].callback()
    await loadKatex()
    dom.height = 180
    observers[0].callback()
    expect(new MathWidget('late-formula', true).estimatedHeight).toBe(180)
    widget.destroy(dom as unknown as HTMLElement)
    expect(observers[0].disconnect).toHaveBeenCalledOnce()
  })

  it('同一图片不同尺寸不共享高度，宽度变化废弃旧排版缓存', () => {
    const widget = new ImageWidget('sized.png', '', 300, 200)
    const dom = widget.toDOM(view) as unknown as Element
    // 记的是 widget 那个盒子的高度，不是内层 <img> 的 —— 内层只负责「变了通知我」
    dom.children[0].children[0].height = 180
    dom.height = 200
    observers[0].callback()
    expect(new ImageWidget('sized.png', '', 300, 200).estimatedHeight).toBe(200)
    expect(new ImageWidget('sized.png', '', 600, 400).estimatedHeight).toBe(400)
    const other = new ImageWidget('other.png', '')
    const second = other.toDOM(view) as unknown as Element
    width = 400
    second.height = 100
    observers[1].callback()
    expect(new ImageWidget('other.png', '').estimatedHeight).toBe(100)
    expect(new ImageWidget('sized.png', '', 300, 200).estimatedHeight).toBe(200)
    // 改写过的实测值也会被失效，而不是继续拿旧宽度下的高度。
    width = 800
    dom.height = 333
    observers[0].callback()
    expect(widget.estimatedHeight).toBe(333)
    width = 400
    observers[1].callback()
    expect(widget.estimatedHeight).toBe(200)
    widget.destroy(dom as unknown as HTMLElement)
    other.destroy(second as unknown as HTMLElement)
  })

  it('图裂之后摘掉观察者：裂图那个虚线框的高度不会顶替这张图', () => {
    const widget = new ImageWidget('gone.png', '')
    const dom = widget.toDOM(view) as unknown as Element
    dom.children[0].children[0].dispatchEvent(new Event('error'))
    // 摘掉之后浏览器就不会再回调了，裂图盒子量到多少都进不了这张图的 key
    expect(observers[0].disconnect).toHaveBeenCalledOnce()
    expect(new ImageWidget('gone.png', '').estimatedHeight).toBe(240)
    widget.destroy(dom as unknown as HTMLElement)
  })

  it('落盘那份在文档进编辑器之前就预热进来，不必等第一个 widget 画出来', () => {
    width = 900
    const layout = `900:serif:16px:24px:700`
    const entries = { 'img:["primed.png",null,null]': 321 }
    vi.stubGlobal('localStorage', {
      getItem: (k: string) =>
        k === HEIGHT_STORE_KEY ? JSON.stringify({ v: HEIGHT_STORE_VERSION, layout, entries }) : null,
      setItem: () => {}
    })
    // 一个 widget 都还没画，estimatedHeight 就该拿到盘上那份 —— CM 的顺序是
    // 先查 estimatedHeight 进高度表、再 toDOM，晚一步这份文档的第一张图就白跳一次
    primeHeights(view)
    expect(new ImageWidget('primed.png', '').estimatedHeight).toBe(321)
    // 排版条件对不上的就不认（宽度换一个，盘上那份整份作废）
    width = 640
    primeHeights(view)
    expect(new ImageWidget('primed.png', '').estimatedHeight).toBe(240)
  })

  it('还没上屏（宽度为 0）时不预热 —— 那时候算出来的排版指纹没有意义', () => {
    width = 0
    primeHeights(view)
    const widget = new ImageWidget('unlaid.png', '')
    const dom = widget.toDOM(view) as unknown as Element
    width = 800
    dom.height = 150
    observers[0].callback()
    expect(new ImageWidget('unlaid.png', '').estimatedHeight).toBe(150)
    widget.destroy(dom as unknown as HTMLElement)
  })

  it('已移除的节点不再请求测量', () => {
    const widget = new ImageWidget('removed.png', '')
    const dom = widget.toDOM(view) as unknown as Element
    dom.isConnected = false
    observers[0].callback()
    expect(view.requestMeasure).not.toHaveBeenCalled()
    widget.destroy(dom as unknown as HTMLElement)
  })
})

describe('预览点击进入源码', () => {
  it('图片、公式和脚注定义阻止 mousedown 改选区，click 才按当前 DOM 位置进入源码', () => {
    let from = 4
    Object.assign(view, {
      state: { doc: { length: 100 } },
      posAtDOM: () => from,
      dispatch: vi.fn(),
      focus: vi.fn()
    })
    const widgets = [new ImageWidget('click.png', ''), new MathWidget('x', true), new FootnoteDefWidget('note', '脚注内容')]
    for (const widget of widgets) {
      const dom = widget.toDOM(view) as unknown as Element
      const control = widget instanceof ImageWidget ? dom.children[0] : dom
      const down = Object.assign(new Event('mousedown', { cancelable: true }), { button: 0 })
      control.dispatchEvent(down)
      expect(down.defaultPrevented).toBe(true)
      expect(view.dispatch).not.toHaveBeenCalled()
      from += 10 // widget DOM 被复用时，点击不能仍跳到创建时的旧位置。
      control.dispatchEvent(Object.assign(new Event('click', { cancelable: true }), { button: 0 }))
      expect(view.dispatch).toHaveBeenLastCalledWith({
        selection: { anchor: from + 1 }, scrollIntoView: true, userEvent: 'select.pointer'
      })
      vi.mocked(view.dispatch).mockClear()
      widget.destroy(dom as unknown as HTMLElement)
    }
  })
})

it('脚注定义支持 Enter 和空格进入源码', () => {
  Object.assign(view, {
    state: { doc: { length: 100 } },
    posAtDOM: () => 20,
    dispatch: vi.fn(),
    focus: vi.fn()
  })
  for (const key of ['Enter', ' ']) {
    const dom = new FootnoteDefWidget('note', '脚注内容').toDOM(view)
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key })
    dom.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(view.dispatch).toHaveBeenLastCalledWith({
      selection: { anchor: 21 }, scrollIntoView: true, userEvent: 'select'
    })
  }
})
