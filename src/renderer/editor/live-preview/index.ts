import { syntaxTree } from '@codemirror/language'
import {
  Prec,
  StateEffect,
  StateField,
  type ChangeDesc,
  type EditorState,
  type Extension,
  type Range,
  type Text
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
import { carryDecorations } from '../carry'
import { inlineSegments } from '../inline-text'
import { foldedSpans, sectionFoldField, toggleSectionFold } from '../fold'
import { followTag } from '../frontmatter'
import { docDir } from '../doc-dir'
import { HEADING_RE } from '../headings'
import { followLink } from '../link'
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
  SectionFoldWidget,
  collectHeadings,
  currentTheme,
  EmojiWidget,
  FootnoteDefWidget,
  MathWidget,
  MermaidWidget,
  TocWidget
} from './widgets'

export { docDir } from '../doc-dir'
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
      // composing 要等首个文本变更才为 true；从 compositionstart 就保护原生组字选区。
      if (u.view.compositionStarted) {
        this.wasComposing = true
        this.carry(u)
        return
      }
      // 进/出表格编辑态只带一个 effect（不改文档也不改选区），不认它就不会重铺行样式
      const tableEdit = u.transactions.some((tr) => tr.effects.some((e) => e.is(setTableEdit)))
      const pointerChanged = u.startState.field(pointerSelection, false) !== u.state.field(pointerSelection, false)
      // 鼠标拖选期间保留预览布局。选区仍正常更新，但 inline widget 不能跟着每个
      // selectionSet 在源码/预览间翻面，否则异步图片或公式会把拖选落点推开。
      if (u.state.field(pointerSelection, false)) {
        this.carry(u)
        return
      }
      if (this.wasComposing || u.docChanged || u.selectionSet || u.viewportChanged || tableEdit || pointerChanged) {
        this.wasComposing = false
        this.decorations = buildDecorations(u.view)
      }
    }

    /**
     * 这一轮不重算（合成中 / 拖选中）—— 但手里这份的**位置必须跟着文档走**。
     * 上面两条 `return` 都得过这里，理由见 `editor/carry.ts`：CM 直接拿 ViewPlugin
     * 的装饰去画当前文档，不映射就是拿旧坐标画新文档。
     */
    private carry(u: ViewUpdate): void {
      if (u.docChanged) this.decorations = carryDecorations(this.decorations, u.changes, u.state.doc)
    }
  },
  { decorations: (p) => p.decorations }
)

/**
 * ⌘/Ctrl + 点击 = 跟着链接走，或者**搜一颗标签**（0.4.1）。去哪儿由
 * `editor/link.ts` 判（外部地址给系统、本地文档开标签、`#锚点` 就地跳）、
 * front matter 里的标签由 `editor/frontmatter.ts` 翻成一条工作区搜索，
 * 这里只负责把「点在哪个位置上」交出去。
 *
 * **认的是语法树而不是 `.cm-lp-link` 类**：引用定义 `[id]: 地址` 那一行有意不上色，
 * 但它照样该跟得过去；反过来，类名是装饰层的实现细节，点击不该绑在它身上。
 *
 * 不是链接就必须**返回 false**：⌘+点击在 CodeMirror 里本来是「加一个光标」
 * （0.2.0 的多光标），把它一律吃掉等于拿走一个既有功能。
 */
const openLinkOnClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (!(event.metaKey || event.ctrlKey)) return false
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (pos == null) return false
    // 先问链接，再问标签：两者不可能是同一个位置（一个在正文、一个在 front matter），
    // 顺序只是省掉一次没必要的树查询
    if (!followLink(view, pos, view.state.facet(docDir)) && !followTag(view.state, pos))
      return false
    event.preventDefault()
    return true
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
      (e) =>
        e.is(themeEffect) || e.is(setTableEdit) || e.is(toggleCalloutFold) || e.is(toggleSectionFold)
    )
    // 后台 parse 推进（空事务）也要认：文档大到一次 ensure 解析不完时，块级装饰
    // 只在这条路上才等得到剩下的树 —— 否则半截表格就一直半截着。
    // 比的是**覆盖长度**而不是树对象：`ensureSyntaxTree` 每跑一次都会换一个新的 Tree
    // 对象（内容一字不差也换），写成 `!==` 就成了「上一次重建自己造成下一次重建」——
    // 全量重建永远停不下来，下面那条增量的路一次都轮不上（实测 40/40 次全落在这儿）。
    const grew = syntaxTree(tr.state).length > syntaxTree(tr.startState).length
    const pointerChanged = tr.startState.field(pointerSelection, false) !== tr.state.field(pointerSelection, false)
    if (!tr.docChanged && !effect && !grew && tr.state.field(pointerSelection, false))
      return carryToc(tr.startState, tr.state, value)
    if (!tr.docChanged && !tr.selection && !effect && !grew && !pointerChanged)
      return carryToc(tr.startState, tr.state, value.map(tr.changes))
    // 三条路共用同一台增量机器（见 `patchBlocks`）：挪光标只重建翻面的那两个块
    // （3602 行实测 10.9ms → 0.3ms）、打字只重建改动落在的那个块、后台 parse 推进
    // 只重建新长出来的那一段。效应那三个（主题 / 表格编辑态 / 折叠）是**每一个**块
    // 都可能跟着变样，没有脏区可言，只能全量。
    if (!effect) {
      const patched = patchBlocks(
        value,
        tr.startState,
        tr.state,
        tr.docChanged ? tr.changes : null,
        grew ? syntaxTree(tr.startState).length : null
      )
      if (patched) return patched
    }
    return buildBlocks(tr.state)
  },
  provide: (f) => EditorView.decorations.from(f)
})

/**
 * 「这份文档里有没有 `[TOC]`」—— 按 state 记。
 *
 * 目录是这一堆块级构件里**唯一的全文依赖**：烘进 `TocWidget` 的是
 * `collectHeadings(state)` 的整份标题表，改一个标题、或者后台再解析出几个标题，
 * 全篇的目录都得跟着变 —— 而脏区只盖得住改动落在的那个块。于是遇到「可能动到
 * 标题表」的事务时，有目录的文档一律退回全量重建（见 `patchBlocks`）。
 *
 * 这个标记是**白拿的**：全量重建本来就要走遍全树，`collectBlocks` 顺手记一笔；
 * 增量那条把上一份带过来，再并上脏区里新看到的。**拿不到就当有** —— 宁可多做一次
 * 全量，不能让目录停在半截。只有一个方向不准：删掉文档里唯一的 `[TOC]` 之后标记
 * 仍是 true，代价是此后改标题多走全量，下一次全量重建自己就把它纠正回来。
 */
const tocDocs = new WeakMap<EditorState, boolean>()

/** 两条「原样带过去」的早退路也要把目录标记带上，否则下一次判定只能按「当有」走全量 */
function carryToc(old: EditorState, now: EditorState, value: DecorationSet): DecorationSet {
  const seen = tocDocs.get(old)
  if (seen !== undefined) tocDocs.set(now, seen)
  return value
}

/** 脏区里有没有标题节点 —— 有就意味着这次改动可能改了标题表（`[TOC]` 要重算） */
function touchesHeading(tree: Tree, span: Span): boolean {
  let found = false
  tree.iterate({
    from: span.from,
    to: span.to,
    enter: (node) => {
      if (found) return false
      if (HEADING_RE.test(node.name)) {
        found = true
        return false
      }
      return undefined
    }
  })
  return found
}

/**
 * 「配对跨多远都算数」的标记：围栏 ``` / ~~~ 与 front matter 的 `---`。
 *
 * 别的块级构件都是**一段连续的行**，开头在哪儿、到哪一行为止只由它自己那几行决定 ——
 * 于是一次改动能搅动的范围，不会超出「老树里它所在的那个块 ∪ 新树里它所在的那个块」。
 * 围栏是唯一的例外：它靠**配对**收尾，改动落在一条围栏行上，几百行之外的那条 ```
 * 会从「收尾」变成「开头」，把后面整篇吞进代码块 —— 而那一段离脏区要多远有多远。
 * （实测：在 ```mermaid 那行行首插一个字，文末的脚注定义在全量重建里已经被吞掉，
 * 增量那边却还留着一条过期装饰 —— test/block.test.ts 的逐位置扫描当场抓到。）
 *
 * 判定按**改动碰到的整行**来，不是按插进去的那几个字：在 ```mermaid 行首插一个 `字`，
 * 插入的内容里一个反引号都没有，可它照样把这条围栏废掉了。
 */
const PAIRING_MARK = /```|~~~|^---[ \t]*$/m
function pairingRisk(doc: Text, span: Span): boolean {
  const start = doc.lineAt(span.from)
  const end = span.to <= start.to ? start : doc.lineAt(span.to)
  return PAIRING_MARK.test(doc.sliceString(start.from, end.to))
}

/** 老坐标上的一段脏区搬到新坐标。两端各按各的方向映射，改动贴着边界时才不会缩进去 */
function mapSpan(span: Span, changes: ChangeDesc | null): Span {
  if (!changes) return span
  return { from: changes.mapPos(span.from, -1), to: changes.mapPos(span.to, 1) }
}

/**
 * 增量重建 —— **三条路共用这一台机器**，区别只在脏区是怎么算出来的：
 *   · **挪光标**（`changes`/`grownFrom` 都为空）：翻面的只有「光标离开的那个块」和
 *     「光标进来的这个块」；
 *   · **打字**（带 `changes`）：变样的只有改动落在的那个块；
 *   · **后台 parse 推进**（带 `grownFrom` = 上一份快照的末尾）：新长出来的只有
 *     `[旧快照末尾, 新树末尾]` 那一段。
 * 其余几千行的块级装饰一模一样，重扫全文纯属白干（1 万行实测：每按一个键 3.3ms 的
 * 全文遍历，3 万行 10.9ms —— 后者已经吃掉一整帧）。
 *
 * 换得干净是因为两边的「相交」判定正好是同一条：
 *   · `RangeSet.update` 的 filter 作用于**与 [from,to] 相交**的每一条装饰（哪怕它伸出区间外）；
 *   · `Tree.iterate({from,to})` 进入的也正是**与 [from,to] 相交**的每一个节点。
 * 而一条块级装饰的范围就是它那个节点的范围 —— 两边收的是同一批，不会漏也不会重。
 *
 * **改动的脏区要在新旧两棵树上各撑一次**（只有打字这条路有这个要求）：一次改动能让
 * 块的边界整个搬家 —— 新树那侧盖住「块长大了」（一行字把后面几段并了进来），老树那侧
 * 盖住「块缩短了」（原先被它盖住的那一段，在新树里成了别的块，得有人去建）。
 * 而**跨多远都算数**的那一种（围栏配对）不在脏区的能力范围内，由下面 `pairingRisk`
 * 那条红线整条交回全量 —— 老树那一侧因此更像安全网：正确性不该押在
 * 「我把所有能跨块的语法都数全了」上。
 *
 * 树只认现成的（`knownTree`）：在这儿为老 state 再 ensure 一次就是 5ms，正是要躲开
 * 的那笔。没有现成的树、或脏区大到横跨半份文档，就返回 null 交回全量重建 ——
 * 宁可慢一次，不能画错。
 *
 * 导出给单测：`test/block.test.ts` 拿一串光标位置、一串改动逐个比对
 * 「增量结果 === 全量重建结果」，这条路一旦漂移就当场红。
 */
export function patchBlocks(
  value: DecorationSet,
  old: EditorState,
  now: EditorState,
  changes: ChangeDesc | null = null,
  grownFrom: number | null = null
): DecorationSet | null {
  const scope = now.facet(revealScope)
  const upto = old.doc.length
  const oldTree = knownTree(old, upto)
  if (!oldTree) return null
  // 文档变了、或者树长出来了，就得拿新树；两者都没有时老树对新 state 一样成立
  const tree = changes || grownFrom !== null ? parsedTree(now) : oldTree

  const spans: Span[] = []
  // 改动的原始范围（新旧坐标各一份）留一份底：围栏红线与目录判定都要按它来，而
  // **两条判定都排在阈值之后** —— 脏区大到该退回全量时，这两趟扫描纯属白花
  const edits: { a: Span; b: Span }[] = []
  const dirtyOld = (from: number, to: number): void =>
    void spans.push(mapSpan(blockSpan(oldTree, from, to), changes))
  const dirtyNow = (from: number, to: number): void => void spans.push(blockSpan(tree, from, to))

  // 光标翻面的那两个块：动前的按老树撑再映射，动后的按新树撑
  for (const s of new Reveal(old, scope).ranges) dirtyOld(s.from, s.to)
  for (const s of new Reveal(now, scope).ranges) dirtyNow(s.from, s.to)
  // 改动落在的那个块（两棵树各撑一次，理由见上面）
  changes?.iterChangedRanges((fromA, toA, fromB, toB) => {
    edits.push({ a: { from: fromA, to: toA }, b: { from: fromB, to: toB } })
    dirtyOld(fromA, toA)
    dirtyNow(fromB, toB)
  })
  // 后台 parse 新解析出来的那一段。左边界撑到顶层块：旧快照很可能断在某个块的中间
  if (grownFrom !== null) dirtyNow(Math.min(grownFrom, tree.length), tree.length)

  // 0.4.0 F1：脏区碰到折叠区，就把**整段折叠区**吞进来。药丸那条替换装饰从标题行末尾
  // 一直盖到本节最后一行，而脏区只按块撑 —— 只盖住半条的话，RangeSet 那趟 filter
  // （按装饰自己的 from/to 算）既删不干净又会重出一条，两条重叠的跨行替换当场报错。
  // **两边的折叠区都要算**：删掉一个折起来的标题时，新 state 里那条折叠已经没了，
  // 只有老 state 还记得该把哪一段重算（不然那颗药丸会留在原地，底下的正文一直藏着）
  const foldZones: Span[] = foldedSpans(now).map((f) => ({ from: f.from, to: f.to }))
  for (const f of foldedSpans(old)) {
    const from = changes ? changes.mapPos(f.from, -1) : f.from
    const to = changes ? changes.mapPos(f.to, 1) : f.to
    if (to > from) foldZones.push({ from, to })
  }
  if (foldZones.length) {
    for (const s of spans) {
      for (const z of foldZones) {
        if (z.to < s.from || z.from > s.to) continue
        s.from = Math.min(s.from, z.from)
        s.to = Math.max(s.to, z.to)
      }
    }
  }
  const merged = mergeSpans(spans)
  // 脏区盖住大半份文档（全选、几十个光标、一次改动把后面整篇吞进代码块）就别绕了：
  // 那时候增量省不下什么，还要多走几趟 RangeSet。阈值按**撑开之后**的脏区算 ——
  // 撑到顶层块边界之后，一个长代码块就可能占掉小半份文档，卡在 1/2 会让绝大多数
  // 光标移动白白退回全量
  const touched = merged.reduce((n, s) => n + (s.to - s.from), 0)
  if (merged.length > 8 || touched * 5 >= now.doc.length * 4) return null
  // 改动碰到围栏行：这一次能搅动的范围没有上界，脏区那套推理不成立（见 `pairingRisk`）
  if (edits.some((e) => pairingRisk(old.doc, e.a) || pairingRisk(now.doc, e.b))) return null
  // 目录是全文依赖，脏区盖不住（见 `tocDocs`）。两棵树都要查：新树认得出**新写出来**
  // 的标题，而**删掉**一行 `## 小节` 之后只有老树那边还看得见它
  if (
    (tocDocs.get(old) ?? true) &&
    edits.some((e) => touchesHeading(oldTree, e.a) || touchesHeading(tree, e.b))
  )
    return null
  // 文档没动，这棵树对新 state 一样成立 —— 记在它名下，下一次移动光标才接得上
  // （不记的话增量与全量会一步一跳地交替，等于白改）。文档变了那条不必记：
  // 上面的 `parsedTree(now)` 自己就记过了
  if (!changes) rememberTree(now, tree, upto)

  let out = changes ? value.map(changes) : value
  let toc = tocDocs.get(old) ?? true
  for (const s of merged) {
    const got = collectBlocks(now, tree, s.from, s.to)
    toc ||= got.toc
    out = out.update({
      filterFrom: s.from,
      filterTo: s.to,
      filter: () => false,
      add: got.add,
      sort: true
    })
  }
  tocDocs.set(now, toc)
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
    // 先把落点夹进树里：树可能是半截的（ensure 超预算就只解析到一半），而脏区是按
    // **文档**坐标来的 —— 树外的位置 resolveInner 给不出有意义的节点。夹的是解析的
    // 起点，不是 out：脏区右边界照旧留在文档坐标上，过期装饰才清得干净
    pos = Math.max(0, Math.min(pos, tree.length))
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
  const got = collectBlocks(state, parsedTree(state), 0, state.doc.length)
  // 走遍全树的这一趟顺手把「有没有 `[TOC]`」记下来（见 `tocDocs`）：全量重建是这个
  // 标记唯一的准确来源，增量那条只能在自己的脏区里看见新增的那一个
  tocDocs.set(state, got.toc)
  return Decoration.set(got.add, true)
}

/**
 * 在 [from,to] 这段上产出块级装饰：全量重建给 0..doc.length，增量那条只给脏区。
 * 顺带回报这一段里**有没有 `[TOC]`**（`toc`）—— 那是目录那条全文依赖的唯一信号源，
 * 见 `tocDocs`；它得在 reveal 判定之前记，因为光标正压着的目录同样是一份目录。
 */
function collectBlocks(
  state: EditorState,
  tree: Tree,
  from: number,
  to: number
): { add: Range<Decoration>[]; toc: boolean } {
  const out: Range<Decoration>[] = []
  let toc = false
  const reveal = new Reveal(state, state.facet(revealScope))
  const editAt = tableEditAt(state)
  // 0.4.0 F1 折叠一节。两件事在这儿一起做，因为它们必须看同一份折叠区：
  // ① 折起来的那几段**整段换成一颗药丸**；② 段里的块（表格 / 公式 / mermaid）
  // **一个都不许再出装饰** —— 两条跨行替换重叠 CM 当场报错（判断 2 那个老坑的新形状）
  const folds = foldedSpans(state)
  const hidden = (pos: number): boolean => folds.some((f) => pos >= f.from && pos < f.to)
  for (const f of folds) {
    if (f.from < from || f.from >= to) continue
    const lines = state.doc.lineAt(f.to).number - state.doc.lineAt(f.from).number
    out.push(Decoration.replace({ widget: new SectionFoldWidget(lines) }).range(f.from, f.to))
  }
  tree.iterate({
    from,
    to,
    enter: (node) => {
      // 折起来的那一段里，块级装饰一个都不出（上面那颗药丸已经把它整段盖住了）
      if (hidden(node.from)) return false
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
              widget: new FootnoteDefWidget(
                m[1],
                m[2].trim(),
                // 片段从**正文那一段**切（跳过 `[^label]:` 那几个字符），
                // 否则标签自己也会被当成行内语法走一遍
                inlineSegments(state, node.from + (m[0].length - m[2].length), node.to)
              ),
              block: true
            }).range(node.from, node.to)
          )
          return false
        }
        case 'TocBlock': {
          // [TOC] → 目录组件；标题数据来自全文语法树（此处已全文 ensure）。
          // **先记账再判 reveal**：回显源码的目录、以及还没有任何标题可列的目录都
          // 没有装饰可查，漏记就会让增量那条路以为「这文档没有目录」
          toc = true
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
  return { add: out, toc }
}

export function livePreview(): Extension {
  return [
    pointerSelection,
    pointerSelectionEvents,
    livePreviewPlugin,
    tableEditField,
    calloutFoldField,
    sectionFoldField,
    blockField,
    openLinkOnClick,
    // 必须压过 defaultKeymap 的光标移动：方向键撞上渲染态表格时要进单元格
    Prec.high(keymap.of(tableEnterKeymap))
  ]
}

/** 源代码模式就是把上面这套整个撤掉 */
export const noLivePreview: Extension = []

export const emptyDecorations = Decoration.none
