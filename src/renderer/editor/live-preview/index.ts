import { syntaxTree } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { buildDecorations } from './decorate'

export { docDir } from './decorate'
export { revealScope, type RevealScope } from './reveal'

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    /** 上一次 update 时正在输入法合成 */
    private wasComposing = false

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }

    update(u: ViewUpdate): void {
      // 输入法合成期间重算装饰器会吞字 —— 中文连打必踩的坑。
      // 合成结束后靠 wasComposing 补一次，避免残留过期的装饰。
      if (u.view.composing) {
        this.wasComposing = true
        return
      }
      if (this.wasComposing || u.docChanged || u.selectionSet || u.viewportChanged) {
        this.wasComposing = false
        this.decorations = buildDecorations(u.view)
      }
    }
  },
  { decorations: (p) => p.decorations }
)

/** ⌘/Ctrl + 点击链接文字，用系统浏览器打开 */
const openLinkOnClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (!(event.metaKey || event.ctrlKey)) return false
    if (!(event.target as HTMLElement | null)?.closest?.('.cm-lp-link')) return false
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (pos == null) return false

    for (let n = syntaxTree(view.state).resolveInner(pos, 1); n; n = n.parent!) {
      if (n.name !== 'Link') continue
      const url = n.getChild('URL')
      if (!url) break
      event.preventDefault()
      void window.api.openExternal(view.state.doc.sliceString(url.from, url.to))
      return true
    }
    return false
  }
})

export function livePreview(): Extension {
  return [livePreviewPlugin, openLinkOnClick]
}

/** 源代码模式就是把上面这套整个撤掉 */
export const noLivePreview: Extension = []

export const emptyDecorations = Decoration.none
