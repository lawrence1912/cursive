import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { buildDecorations } from './decorate'
import { Reveal, revealScope } from './reveal'
import {
  cellSpan,
  collectHeadings,
  currentTheme,
  EmojiWidget,
  extractFence,
  FootnoteDefWidget,
  MathWidget,
  MermaidWidget,
  parseTable,
  TableWidget,
  TocWidget
} from './widgets'

export { docDir } from './decorate'
export { revealScope, type RevealScope } from './reveal'
export { currentTheme } from './widgets'

/** 主题切换时发进编辑器：块级 widget（mermaid）跟着重渲染成对应配色 */
export const themeEffect = StateEffect.define<'light' | 'dark'>()

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
 * 块级 widget（真表格 / 数学块 / mermaid）。
 * 块级（跨行）装饰不允许从 ViewPlugin 提供，必须走 StateField；
 * 光标碰到时由 decorate.ts 回显源码（两个集合不会重叠：同一套 reveal 判定）。
 * 三种块共用一次全文遍历 —— 各开一个 StateField 就是白跑三遍语法树。
 */
const blockField = StateField.define<DecorationSet>({
  create: buildBlocks,
  update(value, tr) {
    const themeChanged = tr.effects.some((e) => e.is(themeEffect))
    if (!tr.docChanged && !tr.selection && !themeChanged) return value.map(tr.changes)
    return buildBlocks(tr.state)
  },
  provide: (f) => EditorView.decorations.from(f)
})

/**
 * 块级装饰的唯一产出点。导出给单测：不依赖 DOM 就能断言
 * 块级装饰的正确性（test/block.test.ts）。
 */
export function buildBlocks(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = []
  const reveal = new Reveal(state, state.facet(revealScope))
  // 与 buildDecorations 同款坑：CM 的 parse 是异步分块的，而本字段的重建只挂在
  // docChanged/selection/主题效应上 —— 「打开文件 / 外部重载 / 切标签」这类纯换
  // state 的路径，字段初值是在空树上算的，之后没人再推它一把，表格/公式/图就
  // 永远不出现（Context.md 里 ViewPlugin 那条的块级版，tableField 时代就潜伏着）。
  // 块级装饰本来就是全文范围的，这里只能全文强制同步解析。
  ensureSyntaxTree(state, state.doc.length)
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter: (node) => {
      switch (node.name) {
        case 'Table': {
          if (reveal.touches(node.from, node.to)) return false
          const data = parseTable(state.doc.sliceString(node.from, node.to))
          if (data)
            out.push(
              Decoration.replace({ widget: new TableWidget(data), block: true }).range(
                node.from,
                node.to
              )
            )
          return false
        }
        case 'DisplayMath': {
          if (reveal.touches(node.from, node.to)) return false
          const text = state.doc.sliceString(node.from, node.to)
          const tex = text.slice(2, Math.max(2, text.length - 2))
          if (tex.trim())
            out.push(
              Decoration.replace({ widget: new MathWidget(tex, true), block: true }).range(
                node.from,
                node.to
              )
            )
          return false
        }
        case 'FencedCode': {
          // 只有 mermaid 代码块换成图；其它语言的照旧走行级高亮
          const fence = extractFence(state.doc.sliceString(node.from, node.to))
          if (!fence || fence.lang !== 'mermaid' || !fence.src.trim()) return
          if (reveal.touches(node.from, node.to)) return false
          out.push(
            Decoration.replace({
              widget: new MermaidWidget(fence.src, currentTheme()),
              block: true
            }).range(node.from, node.to)
          )
          return false
        }
        case 'FootnoteDefinition': {
          // 定义区折叠成一行；光标进入回落源码（与表格同一套 reveal 判定）
          if (reveal.touches(node.from, node.to)) return false
          const m = /^\[\^([^\s\]]+)\]:\s*([\s\S]*)$/.exec(
            state.doc.sliceString(node.from, node.to)
          )
          if (!m) return false
          out.push(
            Decoration.replace({
              widget: new FootnoteDefWidget(m[1], m[2].trim()),
              block: true
            }).range(node.from, node.to)
          )
          return false
        }
        case 'TocBlock': {
          // [TOC] → 目录组件；标题数据来自全文语法树（此处已全文 ensure）
          if (reveal.touches(node.from, node.to)) return false
          const entries = collectHeadings(state)
          if (!entries.length) return false
          out.push(
            Decoration.replace({ widget: new TocWidget(entries), block: true }).range(
              node.from,
              node.to
            )
          )
          return false
        }
      }
    }
  })
  return Decoration.set(out, true)
}

export function livePreview(): Extension {
  return [livePreviewPlugin, blockField, openLinkOnClick, editTableOnClick]
}

/** 源代码模式就是把上面这套整个撤掉 */
export const noLivePreview: Extension = []

export const emptyDecorations = Decoration.none
