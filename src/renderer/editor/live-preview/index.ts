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
import type { SyntaxNode, Tree } from '@lezer/common'
import { calloutFolded, calloutFoldField, toggleCalloutFold } from '../callout'
import { knownTree, parsedTree, rememberTree } from '../syntax'
import { extractFence } from './code'
import { buildDecorations, calloutAt } from './decorate'
import { pointerSelection, pointerSelectionEvents } from '../pointer-selection'
import { Reveal, revealScope, type Span } from './reveal'
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
export { forgetRowHeight, setTableEdit } from './table'
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
      const pointerChanged = u.startState.field(pointerSelection, false) !== u.state.field(pointerSelection, false)
      // 鼠标拖选期间保留预览布局。选区仍正常更新，但 inline widget 不能跟着每个
      // selectionSet 在源码/预览间翻面，否则异步图片或公式会把拖选落点推开。
      if (u.state.field(pointerSelection, false)) return
      if (this.wasComposing || u.docChanged || u.selectionSet || u.viewportChanged || tableEdit || pointerChanged) {
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
/** 导出给单测：`test/block.test.ts` 要能从 state 上取出这份装饰，验证增量那条路 */
export const blockField = StateField.define<DecorationSet>({
  create: buildBlocks,
  update(value, tr) {
    const effect = tr.effects.some(
      (e) => e.is(themeEffect) || e.is(setTableEdit) || e.is(toggleCalloutFold)
    )
    // 后台 parse 推进（空事务）也要认：文档大到一次 ensure 解析不完时，块级装饰
    // 只在这条路上才等得到剩下的树 —— 否则半截表格就一直半截着。
    // 比的是**覆盖长度**而不是树对象：`ensureSyntaxTree` 每跑一次都会换一个新的 Tree
    // 对象（内容一字不差也换），写成 `!==` 就成了「上一次重建自己造成下一次重建」——
    // 全量重建永远停不下来，下面那条增量的路一次都轮不上（实测 40/40 次全落在这儿）。
    const grew = syntaxTree(tr.state).length > syntaxTree(tr.startState).length
    const pointerChanged = tr.startState.field(pointerSelection, false) !== tr.state.field(pointerSelection, false)
    if (!tr.docChanged && !effect && !grew && tr.state.field(pointerSelection, false)) return value
    if (!tr.docChanged && !tr.selection && !effect && !grew && !pointerChanged) return value.map(tr.changes)
    // 只是移动了一下光标：能翻面的就那两个块，别为此重扫全文（3602 行实测 10.9ms → 0.3ms）
    if (!tr.docChanged && !effect && !grew) {
      const patched = patchBlocks(value, tr.startState, tr.state)
      if (patched) return patched
    }
    return buildBlocks(tr.state)
  },
  provide: (f) => EditorView.decorations.from(f)
})

/**
 * 选区变化的增量重建：文档一个字没变，翻面的只有「光标离开的那个块」和
 * 「光标进来的这个块」—— 其余几千行的块级装饰一模一样，重扫全文纯属白干。
 * 于是只在这两段上「清掉旧的 + 重建新的」。
 *
 * 换得干净是因为两边的「相交」判定正好是同一条：
 *   · `RangeSet.update` 的 filter 作用于**与 [from,to] 相交**的每一条装饰（哪怕它伸出区间外）；
 *   · `Tree.iterate({from,to})` 进入的也正是**与 [from,to] 相交**的每一个节点。
 * 而一条块级装饰的范围就是它那个节点的范围 —— 两边收的是同一批，不会漏也不会重。
 *
 * 树只认现成的（`knownTree`）：在这儿 ensure 一次就是 5ms，正是要躲开的那笔。
 * 没有现成的树、或选区大到横跨半份文档，就返回 null 交回全量重建 ——
 * 宁可慢一次，不能画错。
 *
 * 导出给单测：`test/block.test.ts` 拿一串光标位置逐个比对
 * 「增量结果 === 全量重建结果」，这条路一旦漂移就当场红。
 */
export function patchBlocks(
  value: DecorationSet,
  old: EditorState,
  now: EditorState
): DecorationSet | null {
  const scope = now.facet(revealScope)
  const upto = old.doc.length
  const tree = knownTree(old, upto)
  if (!tree) return null
  const spans = mergeSpans(
    [...new Reveal(old, scope).ranges, ...new Reveal(now, scope).ranges].map((s) =>
      blockSpan(tree, s.from, s.to)
    )
  )
  // 脏区盖住大半份文档（全选、几十个光标）就别绕了：那时候增量省不下什么，
  // 还要多走几趟 RangeSet。阈值按**撑开之后**的脏区算 —— 撑到顶层块边界之后，
  // 一个长代码块就可能占掉小半份文档，卡在 1/2 会让绝大多数光标移动白白退回全量
  const touched = spans.reduce((n, s) => n + (s.to - s.from), 0)
  if (spans.length > 8 || touched * 5 >= now.doc.length * 4) return null
  // 文档没动，这棵树对新 state 一样成立 —— 记在它名下，下一次移动光标才接得上
  // （不记的话增量与全量会一步一跳地交替，等于白改）
  rememberTree(now, tree, upto)

  let out = value
  for (const s of spans) {
    out = out.update({
      filterFrom: s.from,
      filterTo: s.to,
      filter: () => false,
      add: collectBlocks(now, tree, s.from, s.to),
      sort: true
    })
  }
  return out
}

/**
 * 把脏区撑到与之相交的**顶层块**的边界。
 *
 * 不能直接拿 reveal 区间当脏区：**块级装饰的范围不一定等于它那个节点的范围**。
 * 折叠告示块就是反例 —— 装饰从首行末尾画到块尾（`head.to → node.to`），而它成不成立
 * 由**整块**有没有被光标碰到决定。光标落在告示块首行时，那条装饰的范围里并不含光标
 * 那一点，只按 reveal 区间过滤就会把它原样留着，而全量重建那边早就该把它撤了
 * （`EXAMPLE.md` 上 reveal=node 实测到这一处，见 test/block.test.ts）。
 *
 * 撑到顶层块之后这条就闭合了：装饰 ⊆ 它的节点 ⊆ 某个顶层块，而与 reveal 区间相交的
 * 顶层块整块都在脏区里 —— 该撤的一条不漏，该留的一条不多。
 */
function blockSpan(tree: Tree, from: number, to: number): Span {
  let out: Span = { from, to }
  const grow = (pos: number, side: -1 | 1): void => {
    // 往上走到 Document 的直接子节点 —— 与 `reveal.ts` 的 block 档同一条规矩。
    // 「一路走到再往上就是整棵树」那种写法在这里是错的：带 YAML frontmatter 的文档里，
    // 正文被套在**第二层 Document** 里（Document 0-N → [FrontMatter, Document 96-N]），
    // 那样撑出来的脏区是整份文档，每次移动光标都白白退回全量重建。
    let node: SyntaxNode = tree.resolveInner(pos, side)
    while (node.parent && node.parent.name !== 'Document') node = node.parent
    // 落在块与块之间（空行）：解析到的就是 Document 本身，没什么可撑的
    if (node.name === 'Document') return
    out = { from: Math.min(out.from, node.from), to: Math.max(out.to, node.to) }
  }
  // 两端各按两个方向解析：块**贴着**脏区边界结束/开始时（reveal 的相交判定含相切），
  // 只解析一个方向会漏掉贴边的那一个
  grow(from, -1)
  grow(from, 1)
  grow(to, -1)
  grow(to, 1)
  return out
}

/** 排序并合并相交/相邻的区间：多光标时两份露出区间凑一起，重叠的没必要各清一遍 */
function mergeSpans(raw: Span[]): Span[] {
  const sorted = [...raw].sort((a, b) => a.from - b.from)
  const out: Span[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to)
    else out.push({ ...s })
  }
  return out
}

/**
 * 块级装饰的唯一产出点。导出给单测：不依赖 DOM 就能断言
 * 块级装饰的正确性（test/block.test.ts）。
 */
export function buildBlocks(state: EditorState): DecorationSet {
  // 与 buildDecorations 同款坑：CM 的 parse 是异步分块的，而本字段的重建只挂在
  // docChanged/selection/主题效应上 —— 「打开文件 / 外部重载 / 切标签」这类纯换
  // state 的路径，字段初值是在空树上算的，之后没人再推它一把，表格/公式/图就
  // 永远不出现（Context.md 里 ViewPlugin 那条的块级版，tableField 时代就潜伏着）。
  // 块级装饰本来就是全文范围的，这里只能全文强制同步解析 —— 且**必须用 ensure 的
  // 返回值**，`syntaxTree(state)` 读的快照这会儿还停在打开文件时那 3000 字上
  // （见 `editor/syntax.ts`）。
  return Decoration.set(collectBlocks(state, parsedTree(state), 0, state.doc.length), true)
}

/** 在 [from,to] 这段上产出块级装饰：全量重建给 0..doc.length，增量那条只给脏区 */
function collectBlocks(
  state: EditorState,
  tree: Tree,
  from: number,
  to: number
): Range<Decoration>[] {
  const out: Range<Decoration>[] = []
  const reveal = new Reveal(state, state.facet(revealScope))
  const editAt = tableEditAt(state)
  tree.iterate({
    from,
    to,
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
  return out
}

export function livePreview(): Extension {
  return [
    pointerSelection,
    pointerSelectionEvents,
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
