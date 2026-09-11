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
import { cellSpan, parseTable, TableWidget } from './widgets'

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
 * 点表格单元格 → 光标落到源码里对应的那一格（选区一动，reveal 判定就把整块换回管道符源码）。
 * 没有这条，表格是块级 replace 装饰 + widget 默认吞事件，点上去毫无反应 —— 表格改不了。
 * 另一半在 widgets.ts：TableWidget.ignoreEvent 放行 mousedown。
 */
const editTableOnClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    const cell = (event.target as HTMLElement | null)?.closest?.('td, th') as HTMLTableCellElement | null
    if (!cell?.closest('.cm-lp-tableview')) return false

    // widget 子节点的 posAtDOM = 被替换区间的起点，也就是表格块的开头
    const pos = view.posAtDOM(cell)
    let tableFrom = -1
    syntaxTree(view.state).iterate({
      from: pos,
      to: pos,
      enter: (n) => {
        if (n.name === 'Table') tableFrom = n.from
      }
    })
    if (tableFrom < 0) return false

    const row = cell.parentElement as HTMLTableRowElement
    // 源码第 1 行是分隔行（|---|---|），DOM 里没有它：表头 → 第 0 行，正文第 n 行 → 第 n+1 行
    const lineNo =
      view.state.doc.lineAt(tableFrom).number + (row.rowIndex === 0 ? 0 : row.rowIndex + 1)
    if (lineNo > view.state.doc.lines) return false
    const line = view.state.doc.line(lineNo)
    const span = cellSpan(line.text, cell.cellIndex)
    // 没法把 x 精确映射到字符，至少方向别拧：点左半格进格首，右半格进格尾
    const box = cell.getBoundingClientRect()
    const anchor = span
      ? line.from + (event.clientX > box.left + box.width / 2 ? span.to : span.from)
      : line.to

    event.preventDefault()
    view.dispatch({ selection: { anchor }, scrollIntoView: true })
    view.focus()
    return true
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
  return [livePreviewPlugin, tableField, openLinkOnClick, editTableOnClick]
}

/** 源代码模式就是把上面这套整个撤掉 */
export const noLivePreview: Extension = []

export const emptyDecorations = Decoration.none
