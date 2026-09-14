import { StateEffect } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

const navigate = StateEffect.define<number>()

/** 保留文档位置而非像素位置，让晚到的图片/图表也服从这次导航。 */
export function jumpTo(view: EditorView, pos: number): void {
  view.dispatch({
    selection: { anchor: pos },
    effects: [navigate.of(pos), EditorView.scrollIntoView(pos, { y: 'start', yMargin: 12 })]
  })
}

export const stableNavigation = ViewPlugin.fromClass(class {
  target: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private aligning = false

  constructor(private view: EditorView) {
    // 捕获阶段也能收到 widget 内部拦截的操作；不监听 scroll，CM 自己也会滚动。
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      view.dom.addEventListener(event, this.cancel, true)
    }
  }

  private cancel = (): void => {
    this.target = null
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  update(u: ViewUpdate): void {
    for (const tr of u.transactions) {
      const start = tr.effects.find((e) => e.is(navigate))
      if (start) {
        this.cancel()
        this.target = start.value
      } else if (tr.docChanged || tr.selection || (!this.aligning && tr.scrollIntoView)) {
        this.cancel()
      }
    }
    if (this.target === null || !u.geometryChanged || this.timer !== null) return
    // 跳出 CM 的 update/measure，避免嵌套 dispatch。
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.target === null) return
      this.aligning = true
      try {
        this.view.dispatch({
          effects: EditorView.scrollIntoView(this.target, { y: 'start', yMargin: 12 })
        })
      } finally {
        this.aligning = false
      }
    }, 0)
  }

  destroy(): void {
    this.cancel()
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      this.view.dom.removeEventListener(event, this.cancel, true)
    }
  }
})

export function hasNavigationTarget(view: EditorView): boolean {
  return view.plugin(stableNavigation)?.target != null
}
