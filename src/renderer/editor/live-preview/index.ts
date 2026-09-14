import { syntaxTree } from '@codemirror/language'
import {
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { calloutFolded, calloutFoldField, toggleCalloutFold } from '../callout'
import { parsedTree } from '../syntax'
import { extractFence } from './code'
import { buildDecorations, calloutAt } from './decorate'
import { Reveal, revealScope } from './reveal'
import {
  activeCellAt,
  setTableEdit,
  tableDataAt,
  tableEditAt,
  tableEditField,
  tableEnterKeymap,
  tableRendered,
  TableWidget
} from './table'
import {
  CalloutFoldWidget,
  collectHeadings,
  currentTheme,
  EmojiWidget,
  FootnoteDefWidget,
  MathWidget,
  MermaidWidget,
  TocWidget
} from './widgets'

export { docDir } from './decorate'
export { revealScope, type RevealScope } from './reveal'
export { setTableEdit } from './table'
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
      // 进/出表格编辑态只带一个 effect（不改文档也不改选区），不认它就不会重铺行样式
      const tableEdit = u.transactions.some((tr) => tr.effects.some((e) => e.is(setTableEdit)))
      if (this.wasComposing || u.docChanged || u.selectionSet || u.viewportChanged || tableEdit) {
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
 * 块级 widget（真表格 / 数学块 / mermaid）。
 * 块级（跨行）装饰不允许从 ViewPlugin 提供，必须走 StateField；
 * 光标碰到时由 decorate.ts 回显源码（两个集合不会重叠：同一套 reveal 判定）。
 * 三种块共用一次全文遍历 —— 各开一个 StateField 就是白跑三遍语法树。
 */
const blockField = StateField.define<DecorationSet>({
  create: buildBlocks,
  update(value, tr) {
    const effect = tr.effects.some(
      (e) => e.is(themeEffect) || e.is(setTableEdit) || e.is(toggleCalloutFold)
    )
    // 后台 parse 推进（空事务）也要认：文档大到一次 ensure 解析不完时，块级装饰
    // 只在这条路上才等得到剩下的树 —— 否则半截表格就一直半截着
    const grew = syntaxTree(tr.startState) !== syntaxTree(tr.state)
    if (!tr.docChanged && !tr.selection && !effect && !grew) return value.map(tr.changes)
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
  const editAt = tableEditAt(state)
  // 与 buildDecorations 同款坑：CM 的 parse 是异步分块的，而本字段的重建只挂在
  // docChanged/selection/主题效应上 —— 「打开文件 / 外部重载 / 切标签」这类纯换
  // state 的路径，字段初值是在空树上算的，之后没人再推它一把，表格/公式/图就
  // 永远不出现（Context.md 里 ViewPlugin 那条的块级版，tableField 时代就潜伏着）。
  // 块级装饰本来就是全文范围的，这里只能全文强制同步解析 —— 且**必须用 ensure 的
  // 返回值**，`syntaxTree(state)` 读的快照这会儿还停在打开文件时那 3000 字上
  // （见 `editor/syntax.ts`）。
  parsedTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter: (node) => {
      switch (node.name) {
        case 'Table': {
          // 就地编辑中的那张表不回落源码 —— 光标本来就在它的某一格里，
          // reveal 判定对它失效（tableEditField 说了算，见 table.ts）
          const editing = editAt === node.from
          if (!tableRendered(state, reveal, node.from, node.to)) return false
          const data = tableDataAt(state, node.from, node.to)
          if (data)
            out.push(
              Decoration.replace({
                widget: new TableWidget(
                  data,
                  editing,
                  editing ? activeCellAt(state, node.from, data) : null
                ),
                block: true
              }).range(node.from, node.to)
            )
          return false
        }
        case 'Blockquote': {
          // 折起来的告示块：正文整段换成一颗省略号药丸。范围从首行末尾起 ——
          // 连着换行符一起吃掉，下面几行才会并进首行那一行里（CM 自带折叠同款）。
          // 跨行的替换装饰只能从 StateField 出，所以它在这里而不在 decorate.ts。
          const cal = calloutAt(state.doc, node.node)
          if (!cal?.foldable || !calloutFolded(state, node.from, cal.folded)) return
          if (reveal.touches(node.from, node.to)) return false
          const head = state.doc.lineAt(node.from)
          if (head.to >= node.to) return false // 只有一行，没东西可折
          out.push(
            Decoration.replace({ widget: new CalloutFoldWidget() }).range(head.to, node.to)
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
  return [
    livePreviewPlugin,
    tableEditField,
    calloutFoldField,
    blockField,
    openLinkOnClick,
    // 必须压过 defaultKeymap 的光标移动：方向键撞上渲染态表格时要进单元格
    Prec.high(keymap.of(tableEnterKeymap))
  ]
}

/** 源代码模式就是把上面这套整个撤掉 */
export const noLivePreview: Extension = []

export const emptyDecorations = Decoration.none
