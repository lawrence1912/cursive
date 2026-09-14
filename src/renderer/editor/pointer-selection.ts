import { StateEffect, StateField, type EditorSelection } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'

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

export const pointerSelectionEvents = ViewPlugin.fromClass(class {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private view: EditorView) {
    view.contentDOM.addEventListener('mousedown', this.start, true)
    view.contentDOM.ownerDocument.addEventListener('mouseup', this.end)
    view.contentDOM.ownerDocument.addEventListener('mousemove', this.move)
    view.contentDOM.addEventListener('keydown', this.release, true)
    view.contentDOM.ownerDocument.defaultView!.addEventListener('blur', this.release)
    view.contentDOM.ownerDocument.addEventListener('pointercancel', this.release)
  }

  private start = (event: MouseEvent): void => {
    if (event.button !== 0 || event.defaultPrevented) return
    // widget/表格的自有控件已处理点击，不参与 CM 的正文拖选。
    if ((event.target as Element).closest('[contenteditable="false"], button, input, textarea')) return
    this.release()
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
    if (this.view.state.field(pointerSelection)) {
      const head = this.view.state.selection.main.head
      const caret = this.view.coordsAtPos(head)
      const scroller = this.view.scrollDOM.getBoundingClientRect()
      const effects: StateEffect<unknown>[] = [holdPointerLayout.of(false)]
      // 回显切换后仍把手势落点放在同一屏幕高度，滚动补偿由 CM 完成。
      if (caret && caret.top >= scroller.top && caret.bottom <= scroller.bottom) {
        effects.push(EditorView.scrollIntoView(head, {
          y: 'start', yMargin: caret.top - scroller.top - this.view.scrollDOM.clientTop
        }))
      }
      this.view.dispatch({ effects })
    }
  }

  destroy(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.view.contentDOM.removeEventListener('mousedown', this.start, true)
    this.view.contentDOM.ownerDocument.removeEventListener('mouseup', this.end)
    this.view.contentDOM.ownerDocument.removeEventListener('mousemove', this.move)
    this.view.contentDOM.removeEventListener('keydown', this.release, true)
    this.view.contentDOM.ownerDocument.defaultView!.removeEventListener('blur', this.release)
    this.view.contentDOM.ownerDocument.removeEventListener('pointercancel', this.release)
  }
})
