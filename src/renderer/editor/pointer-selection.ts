import { StateEffect, StateField, type EditorSelection } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

export const holdPointerLayout = StateEffect.define<boolean>()

/** 鼠标手势期间只固定回显依据，真实选区仍交给 CM，复制/拖选照常工作。 */
export const pointerSelection = StateField.define<EditorSelection | null>({
  create: () => null,
  update(value, tr) {
    if (tr.docChanged) return null
    for (const effect of tr.effects) {
      if (effect.is(holdPointerLayout)) value = effect.value ? tr.startState.selection : null
    }
    return value
  }
})

export const pointerSelectionEvents = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null
    private layoutGeneration = 0

    /**
     * 回显翻面时的**底部留白**（px）。
     *
     * 翻面会让文档变矮：图片 / 公式 / mermaid / 折叠告示块换成源码，一屏高的块
     * 只剩几行。而浏览器的滚动容器一旦变矮，超出新上限的 `scrollTop` 会被**夹回去** ——
     * 在文末点开一个高块时，整页往下跳一大截（实测文末 400px 的图，点了跳 377px）。
     * 这里在翻面后按「落点要回去的那个 `scrollTop`」补一层 `.cm-content` 底部留白，
     * 把可滚动范围撑够：`scrollTop` 合法了，CM 的滚动目标就能把行首放回原处。
     * 只有真会被夹回去时才补（留白量 = 目标 scrollTop + 视口高 - 实际内容高），
     * 平时是 0；文档真的改了（`docChanged`）就作废。
     */
    private pad = 0

    constructor(private view: EditorView) {
      view.contentDOM.addEventListener('mousedown', this.start, true)
      view.contentDOM.ownerDocument.addEventListener('mouseup', this.end)
      view.contentDOM.ownerDocument.addEventListener('mousemove', this.move)
      view.contentDOM.addEventListener('keydown', this.release, true)
      view.contentDOM.ownerDocument.defaultView!.addEventListener('blur', this.release)
      view.contentDOM.ownerDocument.addEventListener('pointercancel', this.release)
    }

    update(u: ViewUpdate): void {
      if (u.docChanged || u.selectionSet) this.layoutGeneration++
      if (!u.docChanged || !this.pad) return
      this.pad = 0
      this.view.contentDOM.style.paddingBottom = ''
    }

    private start = (event: MouseEvent): void => {
      if (event.button !== 0 || event.defaultPrevented) return
      // widget/表格的自有控件已处理点击，不参与 CM 的正文拖选。
      if ((event.target as Element).closest('[contenteditable="false"], button, input, textarea')) return
      this.layoutGeneration++
      /*
       * 上一次手势没能正常收尾时（松手落在窗口外、被别的东西吃掉），这里**只把它作废**，
       * 不走 `release()`。
       *
       * 因为 release 不只是「翻回跟随光标」，它还要**把视口滚回落点**（`scrollIntoView`
       * 加那笔 `scrollTop` 补偿）。而这一刻鼠标正按在某个字上：先滚一下，这次 mousedown
       * 的坐标就不再是刚才那个字了 —— **⌘+点击链接当场失灵**（`editor/link.ts` 按坐标
       * 找位置，找到的已经是别处；表现是第一下正常、之后每一下都落空）。
       * E2E 的 links.md 整条红就是它，真机上则表现为「拖选时松手落在窗口外，
       * 下一次点击点不准」。
       *
       * 何况下一句立刻就要重新 hold：补偿一个马上要被覆盖的布局，本来也没有意义。
       * 真正的收尾仍然走 release —— 挂在 mouseup / keydown / blur / pointercancel 上。
       */
      if (this.timer !== null) clearTimeout(this.timer)
      this.timer = null
      this.view.dispatch({ effects: holdPointerLayout.of(true) })
    }

    private end = (): void => {
      if (!this.view.state.field(pointerSelection) || this.timer !== null) return
      // CM 的 mouseup 还可能提交最后一次选区，等该事件的所有监听器完成。
      this.timer = setTimeout(this.release, 0)
    }

    private move = (event: MouseEvent): void => {
      if (event.buttons === 0) this.end()
    }

    private release = (): void => {
      if (this.timer !== null) clearTimeout(this.timer)
      this.timer = null
      if (!this.view.state.field(pointerSelection)) return

      const head = this.view.state.selection.main.head
      const scroller = this.view.scrollDOM
      // 锚在**光标那一行的行首**，不是光标本身：光标可能落在被替换的块级 widget
      // 内部（`x^2` 那行），它的屏幕坐标随 widget 内部布局走；行首才是「这一行
      // 从哪儿开始」的稳定参照。回显翻面后让行首停在同一个屏幕高度，正文就不跳了。
      const anchor = this.view.state.doc.lineAt(head).from
      const top = this.view.coordsAtPos(anchor)
      const effects: StateEffect<unknown>[] = [holdPointerLayout.of(false)]
      let wantTop = 0
      if (top) {
        const box = scroller.getBoundingClientRect()
        const h = Math.max(top.bottom - top.top, 1)
        wantTop = Math.max(0, Math.min(top.top - box.top, scroller.clientHeight - h))
        effects.push(EditorView.scrollIntoView(anchor, { y: 'start', yMargin: wantTop }))
      }
      this.view.dispatch({ effects })
      if (!top) return

      // 测量可能晚于下一次编辑、手势或标签切换；旧落点不能再读坐标或补滚动。
      const generation = this.layoutGeneration
      this.view.requestMeasure({
        key: this,
        read: (view) => {
          if (generation !== this.layoutGeneration) return null
          return { natural: view.scrollDOM.scrollHeight - this.pad, at: view.coordsAtPos(anchor) }
        },
        write: (m, view) => {
          if (!m?.at || generation !== this.layoutGeneration) return
          const dom = view.scrollDOM
          // 落点该回到的 scrollTop（夹回来之前或之后都行，`at` 是当下真值）
          const desired = Math.max(
            0,
            dom.scrollTop + (m.at.top - (dom.getBoundingClientRect().top + wantTop))
          )
          const need = Math.max(0, Math.ceil(desired + dom.clientHeight - m.natural))
          if (need !== this.pad) {
            this.pad = need
            view.contentDOM.style.paddingBottom = need ? `${need}px` : ''
          }
          if (Math.abs(dom.scrollTop - desired) > 0.5) dom.scrollTop = desired
        }
      })
    }

    destroy(): void {
      this.layoutGeneration++
      if (this.timer !== null) clearTimeout(this.timer)
      if (this.pad) this.view.contentDOM.style.paddingBottom = ''
      this.view.contentDOM.removeEventListener('mousedown', this.start, true)
      this.view.contentDOM.ownerDocument.removeEventListener('mouseup', this.end)
      this.view.contentDOM.ownerDocument.removeEventListener('mousemove', this.move)
      this.view.contentDOM.removeEventListener('keydown', this.release, true)
      this.view.contentDOM.ownerDocument.defaultView!.removeEventListener('blur', this.release)
      this.view.contentDOM.ownerDocument.removeEventListener('pointercancel', this.release)
    }
  }
)
