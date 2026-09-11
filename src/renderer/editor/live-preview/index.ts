import { syntaxTree } from '@codemirror/language'
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { buildDecorations } from './decorate'
import { Reveal, revealScope } from './reveal'
import { parseTable, TableWidget } from './widgets'

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

/**
 * 表格 → 真表格。
 * 块级（跨行）装饰不允许从 ViewPlugin 提供，必须走 StateField；
 * 光标碰到时由 decorate.ts 回显管道符源码（两个集合不会重叠：同一套 reveal 判定）。
 */
const tableField = StateField.define<DecorationSet>({
  create: buildTables,
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value.map(tr.changes)
    return buildTables(tr.state)
  },
  provide: (f) => EditorView.decorations.from(f)
})

function buildTables(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = []
  const reveal = new Reveal(state, state.facet(revealScope))
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter: (node) => {
      if (node.name !== 'Table') return
      if (reveal.touches(node.from, node.to)) return false
      const data = parseTable(state.doc.sliceString(node.from, node.to))
      if (data) {
        out.push(
          Decoration.replace({ widget: new TableWidget(data), block: true }).range(node.from, node.to)
        )
      }
      return false
    }
  })
  return Decoration.set(out, true)
}

export function livePreview(): Extension {
  return [livePreviewPlugin, tableField, openLinkOnClick]
}

/** 源代码模式就是把上面这套整个撤掉 */
export const noLivePreview: Extension = []

export const emptyDecorations = Decoration.none
