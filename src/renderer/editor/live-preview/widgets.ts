import { WidgetType, type EditorView } from '@codemirror/view'

/**
 * 每个 widget 都必须实现 eq()：CodeMirror 靠它判断能否复用 DOM。
 * 不实现的话每次按键都会把所有 widget 重建一遍（图片重新解码、图表重画）。
 */

/** 无序列表的 `-` `*` `+` → 圆点 */
export class BulletWidget extends WidgetType {
  constructor(readonly depth: number) {
    super()
  }
  eq(other: BulletWidget): boolean {
    return other.depth === this.depth
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-lp-bullet'
    // 按层级换符号，和 Typora 一致
    el.textContent = ['•', '◦', '▪'][this.depth % 3] ?? '•'
    return el
  }
}

/** 任务列表的 `[ ]` / `[x]` → 真复选框，点击直接改源码 */
export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-lp-checkbox'
    box.checked = this.checked
    box.addEventListener('mousedown', (e) => {
      e.preventDefault()
      // 位置在文档变化后会漂移，所以点击时现查，不存构造时的位置
      const pos = view.posAtDOM(box)
      const line = view.state.doc.lineAt(pos)
      const at = line.text.indexOf(this.checked ? '[x]' : '[ ]')
      if (at < 0) return
      view.dispatch({
        changes: {
          from: line.from + at + 1,
          to: line.from + at + 2,
          insert: this.checked ? ' ' : 'x'
        }
      })
    })
    return box
  }
  ignoreEvent(): boolean {
    return false
  }
}

/** `---` → 真正的分隔线 */
export class RuleWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'cm-lp-rule'
    el.appendChild(document.createElement('hr'))
    return el
  }
}

/** `![alt](src)` → 真图片，加载失败退回显示 alt */
export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string
  ) {
    super()
  }
  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-lp-image'
    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt
    img.addEventListener('error', () => {
      wrap.classList.add('is-broken')
      wrap.textContent = this.alt || '图片加载失败'
    })
    wrap.appendChild(img)
    return wrap
  }
}
