import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { EditorView } from '@codemirror/view'
import { FootnoteDefWidget, ImageWidget, MathWidget, TocWidget, loadKatex, primeHeights } from '../src/renderer/editor/live-preview/widgets'
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

/**
 * 块级 widget 的**根节点不能有上下 margin**。
 *
 * CM 给每个块记高度用的是 `dom.getBoundingClientRect().height`，margin 不在里面 ——
 * 一张 `margin: 8px 0` 的表在高度图里就比真实版面矮 16px，它后面的每一行都往下偏这么多，
 * 还一路累加。偏移超过半个行盒，`posAtCoords` 就会挑中下一行：**表格下方点一条链接，
 * 光标落到下一条上**（实测行高 28px、偏 16px 必现）；`pointer-selection.ts` 的滚动复位
 * 同样按高度图算，偏多少就还错多少。
 *
 * 所以留白一律写成根节点的 padding（根节点自己不画东西），根节点有皮肤的
 * （目录、脚注定义）则套一层 `.cm-lp-blockgap`。新增块级 widget 时把根类名加进下表。
 */
const BLOCK_ROOTS = ['cm-lp-blockgap', 'cm-lp-tableview', 'cm-lp-mathview', 'cm-lp-mermaid']

/** 选择器里作用在**元素自身**的那几条（`.a.b` `.a:hover` 算，`.a .b` `.a > .b` 不算） */
function selfRules(css: string, cls: string): string[] {
  const out: string[] = []
  // 注释先剥掉：块注释会被当成选择器的一部分，正文里又常写着类名
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    for (const sel of m[1]!.split(',')) {
      const t = sel.trim()
      if (new RegExp(`^\\.${cls}(?![\\w-])[^\\s>+~]*$`).test(t)) out.push(m[2]!)
    }
  }
  return out
}

describe('块级 widget 的上下留白', () => {
  const css = readFileSync('src/renderer/themes/live-preview.css', 'utf8')

  it.each(BLOCK_ROOTS)('.%s 不写上下 margin（CM 量不到，高度图会矮一截）', (cls) => {
    const rules = selfRules(css, cls)
    expect(rules.length).toBeGreaterThan(0)
    for (const body of rules) {
      expect(body).not.toMatch(/(^|[\s;])margin(-top|-bottom|-block(-start|-end)?)?\s*:/)
    }
  })

  it('有皮肤的那两个把留白交给 .cm-lp-blockgap 外壳，量到的就是含留白的那一层', () => {
    const toc = new TocWidget([{ text: '一', level: 1, pos: 0 }])
    const tocDom = toc.toDOM(view) as unknown as Element
    expect(tocDom.className.split(' ')[0]).toBe('cm-lp-blockgap')
    expect(tocDom.children[0]!.className).toBe('cm-lp-toc')
    // 量的必须是外壳：记进盘里的高度少一圈留白的话，视口外的估值又会偏
    toc.destroy(tocDom as unknown as HTMLElement)
    expect(observers[0]!.disconnect).toHaveBeenCalledOnce()

    const note = new FootnoteDefWidget('a', '正文').toDOM(view) as unknown as Element
    expect(note.className.split(' ')[0]).toBe('cm-lp-blockgap')
    expect(note.children[0]!.className).toBe('cm-lp-footnote-def')

    // 根节点自己不画东西的那几个照旧是根节点本身
    expect((new MathWidget('x', true).toDOM(view) as unknown as Element).className).toBe('cm-lp-mathview')
  })
})
