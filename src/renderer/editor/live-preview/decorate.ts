import { type EditorState, type Range, type Text } from '@codemirror/state'
import { Decoration, type DecorationSet, type EditorView } from '@codemirror/view'
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common'
import { t } from '../../i18n'
import { linkTitle } from '../link'
import { calloutFolded, matchCallout, type CalloutMatch } from '../callout'
import { itemSpan, sectionFolded, spanOf as foldSpanOf, type FoldSpan } from '../fold'
import { collectHeadings } from '../headings'
import { docDir } from '../doc-dir'
import { EMOJI } from '../emoji'
import { parsedTree } from '../syntax'
import { CodeHeadWidget, fenceParts } from './code'
import { Reveal, revealScope } from './reveal'
import { tableEditAt } from './table'
import {
  BulletWidget,
  CalloutHeadWidget,
  CheckboxWidget,
  EmojiWidget,
  FoldHandleWidget,
  FootnoteRefWidget,
  ImageWidget,
  MathWidget,
  RuleWidget,
  footnoteLabels
} from './widgets'

const HIDE = Decoration.replace({})

/** 零长度的 replace 是无效装饰，会把 CodeMirror 的行渲染搞崩，统一在这里挡掉 */
function pushHide(ctx: Ctx, from: number, to: number): void {
  if (to > from) ctx.out.push(HIDE.range(from, to))
}

/**
 * 同一行之内才藏。CommonMark 允许链接的标签 / 标题换行写（`[文字][\n id]`），
 * 而跨行的 replace 装饰会把两行在屏幕上并成一行 —— 文档一个字没变，看着却像丢了内容。
 * 这种写法极少见，撞上就宁可把源码露出来。
 */
function hideSameLine(ctx: Ctx, from: number, to: number): void {
  if (ctx.doc.lineAt(from).to < to) return
  pushHide(ctx, from, to)
}
const lineCache = new Map<string, Decoration>()
function lineDeco(cls: string): Decoration {
  let d = lineCache.get(cls)
  if (!d) lineCache.set(cls, (d = Decoration.line({ class: cls })))
  return d
}
const markCache = new Map<string, Decoration>()
/**
 * 带 title 的链接标记。类名那份走下面的 markCache，这一份每次现造 ——
 * title 因链接而异，缓存等于给每条不同的地址各留一份。CM 比装饰是**按值**比
 * （MarkDecoration.eq 比类名和属性），现造不会引起额外的 DOM 重绘。
 */
function linkDeco(title: string): Decoration {
  return Decoration.mark({ class: 'cm-lp-link', attributes: { title } })
}
/**
 * 没有单独一截地址可说的链接（引用式 `[文字][id]`、裸链接、`<地址>`）：只说怎么打开。
 * 那句话随语言变，键里带上它本身（同 tagDeco）
 */
function openableDeco(cls: string): Decoration {
  const title = linkTitle()
  const key = `${cls}|${title}`
  let d = markCache.get(key)
  if (!d) markCache.set(key, (d = Decoration.mark({ class: cls, attributes: { title } })))
  return d
}
/**
 * 标签那颗药丸（0.4.1）。title 是固定的一句话，所以可以走缓存 ——
 * 但它随语言变，键里带上当下那句本身，切语言时自然换一份
 */
function tagDeco(): Decoration {
  const title = t('w.tagSearch')
  let d = markCache.get('fm-tag:' + title)
  if (!d)
    markCache.set(
      'fm-tag:' + title,
      (d = Decoration.mark({ class: 'cm-lp-fm-tag', attributes: { title } }))
    )
  return d
}
function markDeco(cls: string): Decoration {
  let d = markCache.get(cls)
  if (!d) markCache.set(cls, (d = Decoration.mark({ class: cls })))
  return d
}

interface Ctx {
  out: Range<Decoration>[]
  /** 告示块的折叠态存在 state 上（不写回文档），行样式要跟着变 */
  state: EditorState
  doc: Text
  reveal: Reveal
  dir: string | null
  /** 正在就地编辑的表格块起点：它不回落源码，也就不该铺回显用的行样式 */
  editAt: number | null
  /** 当前可视区间，行级装饰只在这个范围内铺，避免为屏幕外的长代码块白干 */
  visFrom: number
  visTo: number
}

export function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const ctx: Ctx = {
    out: [],
    state,
    doc: state.doc,
    reveal: new Reveal(state, state.facet(revealScope)),
    dir: state.facet(docDir),
    editAt: tableEditAt(state),
    visFrom: 0,
    visTo: 0
  }
  // parse 是异步分块的：只用 syntaxTree(state) 的话，首次打开长文档时
  // 深处的节点拿不到树，装饰会缺失直到用户交互触发重建。
  // 这里把可视范围强制同步解析到位（有界：不超视口 + 1KB 余量）。
  const ranges = view.visibleRanges
  const visEnd = ranges.length ? ranges[ranges.length - 1].to : state.doc.length
  const tree = parsedTree(state, Math.min(visEnd + 1000, state.doc.length))

  for (const { from, to } of view.visibleRanges) {
    ctx.visFrom = from
    ctx.visTo = to
    tree.iterate({ from, to, enter: (node) => visit(node, ctx) })
  }
  // true = 交给 CodeMirror 排序。行级/替换/标记混在一起，手工保序太容易出错
  return Decoration.set(ctx.out, true)
}

/**
 * 0.4.0 F1：标题行右侧那颗折叠把手。
 *
 * **它从 ViewPlugin 出而不是从 blockField 出**：把手的「有没有」取决于这一节后面
 * 还有没有正文（而那是标题**之外**的事），blockField 那条增量重建只按脏区走，
 * 在标题旁边的编辑不会重算它 —— 于是会留下一颗过期的把手。ViewPlugin 每次都按
 * 视口重来一遍，天然不会过期，代价也只有视口这么大。点击那一半在 `FoldHandleWidget`。
 */
/**
 * 首行末尾那颗折叠把手。**side: -1 是必需的**：折起来之后那条替换装饰正是从
 * `span.from` 开始的，把手排在它前面才留得住（排后面就被一起替换掉了，
 * 于是「折起来就再也点不开」）。
 */
function foldHandle(ctx: Ctx, span: FoldSpan | null, kind: 'section' | 'item'): void {
  if (!span) return // 只有首行，没东西可折
  ctx.out.push(
    Decoration.widget({
      widget: new FoldHandleWidget(sectionFolded(ctx.state, span.pos), kind),
      side: -1
    }).range(span.from)
  )
}

/** 标题那一颗 */
function sectionFoldHandle(ctx: Ctx, pos: number): void {
  const h = collectHeadings(ctx.state).find((x) => x.pos === pos)
  if (!h) return
  foldHandle(ctx, foldSpanOf(ctx.state, h), 'section')
}

/** 返回 false 表示不再深入这个节点的子树 */
function visit(node: SyntaxNodeRef, ctx: Ctx): boolean | void {
  const { out, doc, reveal } = ctx
  const revealed = reveal.touches(node.from, node.to)

  switch (node.name) {
    // ---------- 块级：铺行样式 ----------
    case 'Frontmatter':
      decorateFrontmatter(ctx, node.node)
      return false

    case 'ATXHeading1':
    case 'ATXHeading2':
    case 'ATXHeading3':
    case 'ATXHeading4':
    case 'ATXHeading5':
    case 'ATXHeading6':
      addLines(ctx, node.from, node.to, `cm-lp-h${node.name.slice(-1)}`)
      sectionFoldHandle(ctx, node.from)
      return

    case 'Blockquote': {
      // 告示块本质还是引用块（P1-6 刻意不新增块级节点），两者在这里分道扬镳
      const cal = calloutAt(doc, node.node)
      if (!cal) {
        addLines(ctx, node.from, node.to, 'cm-lp-quote')
        return
      }
      addLines(ctx, node.from, node.to, `cm-lp-callout cm-lp-callout-${cal.tone}`)
      edgeLine(ctx, node.from, 'cm-lp-callout-head')
      // 折起来时正文那几行被 blockField 整段替换掉，卡片的下沿就落回首行
      const folded = cal.foldable && calloutFolded(ctx.state, node.from, cal.folded)
      edgeLine(ctx, folded ? node.from : doc.lineAt(node.to).from, 'cm-lp-callout-close')
      return
    }

    case 'FencedCode': {
      addLines(ctx, node.from, node.to, 'cm-lp-code')
      decorateFence(ctx, node.node)
      return false
    }

    case 'Table': {
      // 真表格渲染在 index.ts 的 blockField（块级装饰必须走 StateField）。
      // 这里只负责「光标碰到 → 回显管道符源码」的行样式；就地编辑中的那张表
      // 压根不回落，行样式也就不能铺（否则一层源码样式叠在 widget 底下）。
      if (revealed && node.from !== ctx.editAt) addLines(ctx, node.from, node.to, 'cm-lp-table')
      return false
    }

    case 'DisplayMath': {
      // 同表格：块渲染在 blockField，这里负责回显时的行样式
      if (revealed) addLines(ctx, node.from, node.to, 'cm-lp-math')
      return false
    }

    // ---------- 块级：整行换成组件 ----------
    case 'HorizontalRule': {
      if (revealed) return
      const line = doc.lineAt(node.from)
      // 不能用 block: true —— ViewPlugin 提供的装饰不允许跨行/块级。
      // 覆盖整行文字的行内替换 + CSS display:block，效果一样且合法。
      if (line.to > line.from) {
        out.push(Decoration.replace({ widget: new RuleWidget() }).range(line.from, line.to))
      }
      return false
    }

    // ---------- 语法标记：藏起来 ----------
    case 'HeaderMark':
    case 'QuoteMark':
      if (!revealed) hideWithTrailingSpace(ctx, node.from, node.to)
      return

    case 'EmphasisMark':
    case 'StrikethroughMark':
    case 'LinkMark':
      if (!revealed) pushHide(ctx, node.from, node.to)
      return

    case 'CodeMark':
      // 只藏行内代码的反引号。围栏那两条 ``` 归 decorateFence 管 ——
      // 整行换成语言条 / 压成卡片下边距，不是简单藏掉留个空行
      if (!revealed && node.node.parent?.name === 'InlineCode') {
        pushHide(ctx, node.from, node.to)
      }
      return

    case 'URL': {
      const owner = node.node.parent?.name
      // `[文字](地址)` 里的地址藏起来（它是标记，不是正文）
      if (owner === 'Link') {
        if (!revealed) pushHide(ctx, node.from, node.to)
        return
      }
      // 裸链接（GFM autolink）本身就是正文，留着 —— 但它**是**链接，
      // 该和正文里的链接同一个样子、同一条 ⌘+点击。`<地址>` 归 Autolink 那条整段上色。
      // 引用定义 `[id]: 地址` 里的那个不上色：定义行是元数据不是正文
      // （⌘+点击照样跟得过去 —— 点击认的是语法树，不是这个类名）
      if (owner !== 'Autolink' && owner !== 'LinkReference') {
        out.push(openableDeco('cm-lp-link cm-lp-autolink').range(node.from, node.to))
      }
      return
    }

    case 'LinkLabel':
      // 引用式链接 `[文字][id]` 里的 `[id]`：和行内写法的地址一样是标记，不是正文
      // （不藏的话屏幕上是「文字[id]」，而导出的 HTML 里只有「文字」—— 两条路各说一套）。
      // 定义那一行 `[id]: 地址` 的标签**不藏**：那儿的 `[id]` 就是这一行的全部意义
      if (!revealed && node.node.parent?.name === 'Link') hideSameLine(ctx, node.from, node.to)
      return

    case 'LinkTitle': {
      // `[文字](地址 "说明")` 里的说明：导出时它是 `<a title>`（悬停才出来），
      // 预览里却当正文画在链接后面。`INLINE_MARKS` 早就把它算作标记（大纲、表格格内
      // 都藏着），只有装饰层漏了这一条 —— 补上，顺带连它前面那个空格一起藏掉，
      // 不然链接后面会多出一个空位
      if (revealed || node.node.parent?.name !== 'Link') return
      const gap = node.from > 0 && doc.sliceString(node.from - 1, node.from) === ' ' ? 1 : 0
      hideSameLine(ctx, node.from - gap, node.to)
      return
    }

    case 'Escape':
      // `\,` → 藏掉反斜杠，只显示被转义的字符
      if (!revealed) pushHide(ctx, node.from, node.from + 1)
      return

    case 'CalloutMark': {
      // 解析器只保证「段落第一个字符 + 类型表里有」，「必须在引用块里」这一半在这
      if (revealed || node.node.parent?.parent?.name !== 'Blockquote') return
      const cal = matchCallout(doc.sliceString(node.from, node.to))
      if (!cal) return
      const end = skipSpaces(doc, node.to)
      const quoteFrom = node.node.parent.parent.from
      out.push(
        Decoration.replace({
          widget: new CalloutHeadWidget(
            cal.icon,
            // 行里还有别的字 = 用户写了自定义标题，就别再补类型名
            end < doc.lineAt(node.from).to ? '' : cal.label,
            cal.foldable,
            cal.foldable && calloutFolded(ctx.state, quoteFrom, cal.folded)
          )
        }).range(node.from, end)
      )
      return false
    }

    case 'Highlight':
      out.push(markDeco('cm-lp-highlight').range(node.from, node.to))
      return

    case 'HighlightMark':
    case 'SuperscriptMark':
    case 'SubscriptMark':
      if (!revealed) pushHide(ctx, node.from, node.to)
      return

    case 'Superscript':
      out.push(markDeco('cm-lp-sup').range(node.from, node.to))
      return

    case 'Subscript':
      out.push(markDeco('cm-lp-sub').range(node.from, node.to))
      return

    case 'FootnoteRef': {
      if (revealed) return
      const label = /^\[\^([^\s\]]+)\]$/.exec(doc.sliceString(node.from, node.to))?.[1]
      if (!label) return
      // 没有对应定义就留着源码：换成角标的话，那是一个点了没反应、悬停也没内容的
      // 假脚注 —— 看得见的 `[^label]` 才说得清「这条还没定义」。导出同款（render.ts）。
      // **查的是整张表而不是一条条找**：这里每次按键都要跑，而视口里可能有十几个引用
      // —— 一条 `findFootnoteDef` 就是一遍全文扫描（见 `footnoteLabels` 上的实测）
      if (!footnoteLabels(ctx.state).has(label)) return
      out.push(
        Decoration.replace({ widget: new FootnoteRefWidget(label) }).range(node.from, node.to)
      )
      return false
    }

    case 'Emoji': {
      // 表里没有的短代码解析器根本不会产出节点，所以这里必有字符
      if (revealed) return
      const name = doc.sliceString(node.from + 1, node.to - 1)
      const char = EMOJI[name]
      if (!char) return
      out.push(Decoration.replace({ widget: new EmojiWidget(char) }).range(node.from, node.to))
      return false
    }

    // ---------- 行内：换成组件 ----------
    case 'InlineMath': {
      // KaTeX 行内公式。MathMark 的样式交给 theme.ts（tags.processingInstruction），
      // 不 revealed 时整个节点换成渲染结果 —— 光标碰到走上面的 revealed 提前返回
      if (revealed) return
      const text = doc.sliceString(node.from, node.to)
      const delim = text.startsWith('$$') ? 2 : 1
      const tex = text.slice(delim, text.length - delim)
      if (!tex.trim()) return
      out.push(
        Decoration.replace({ widget: new MathWidget(tex, false) }).range(node.from, node.to)
      )
      return false
    }

    case 'Image': {
      if (revealed) return
      const parsed = parseImage(doc.sliceString(node.from, node.to))
      if (!parsed) return
      const src = resolveSrc(parsed.src, ctx.dir)
      if (!src) return
      out.push(
        Decoration.replace({
          widget: new ImageWidget(src, parsed.alt, parsed.width, parsed.height)
        }).range(node.from, node.to)
      )
      return false
    }

    // 折叠一条列表（0.4.1）：把手挂在本条首行末尾，与标题那颗同款。
    // **不 return false** —— 子项、行内语法、复选框全在这个子树里，还得往下走
    case 'ListItem':
      foldHandle(ctx, itemSpan(ctx.state, node.node), 'item')
      return

    case 'ListMark': {
      if (revealed) return
      const item = node.node.parent
      if (!item) return
      // 有序列表保留 "1." 这样的编号，只做样式
      if (item.parent?.name === 'OrderedList') {
        out.push(markDeco('cm-lp-ordinal').range(node.from, node.to))
        return
      }
      // 任务项已经有复选框代表它，不再画圆点，整个 "- " 藏掉
      if (hasChild(item, 'Task')) {
        hideWithTrailingSpace(ctx, node.from, node.to)
        return
      }
      const end = skipSpaces(doc, node.to)
      out.push(
        Decoration.replace({ widget: new BulletWidget(bulletDepth(item)) }).range(node.from, end)
      )
      return
    }

    case 'TaskMarker': {
      if (revealed) return
      const checked = doc.sliceString(node.from, node.to).toLowerCase().includes('x')
      out.push(
        Decoration.replace({ widget: new CheckboxWidget(checked, ctx.state.readOnly) }).range(node.from, node.to)
      )
      return false
    }

    // ---------- 行内：只加样式 ----------
    case 'InlineCode':
      out.push(markDeco('cm-lp-inline-code').range(node.from, node.to))
      return

    case 'Link': {
      // 预览里地址是藏着的，于是「这条链接通向哪儿」无从得知 —— 悬停给一个 title
      // （表格格内的链接一直是这么做的，见 table.ts 的 renderTokens）。
      // **只认行内写法**：引用式 `[文字][id]` 的地址要查定义表 = 扫一遍全文，
      // 而这份装饰每次选区变动都要重建（判断 2），那笔开销不能摊在这儿
      const dest = node.node.getChild('URL')
      out.push(
        (dest ? linkDeco(linkTitle(doc.sliceString(dest.from, dest.to))) : openableDeco('cm-lp-link')).range(
          node.from,
          node.to
        )
      )
      return
    }

    case 'Autolink':
      // `<https://…>`：尖括号已由 LinkMark 藏掉，整段按链接上色。地址就是正文，
      // 悬停说明只说怎么打开
      out.push(openableDeco('cm-lp-link cm-lp-autolink').range(node.from, node.to))
      return
  }
}

// ---------- 工具 ----------

/**
 * 告示块判定：引用块的第一个内容子节点就是 CalloutMark。
 * 嵌套的 `> > [!note]` 只有里层那个引用块算告示块，外层照旧是普通引用 —— 不递归。
 */
export function calloutAt(doc: Text, quote: SyntaxNode): CalloutMatch | null {
  for (let c = quote.firstChild; c; c = c.nextSibling) {
    if (c.name === 'QuoteMark') continue
    if (c.name !== 'Paragraph' || c.firstChild?.name !== 'CalloutMark') return null
    return matchCallout(doc.sliceString(c.firstChild.from, c.firstChild.to))
  }
  return null
}

/**
 * 围栏代码块的两条 ``` 行。
 *
 * **每条围栏行各算各的回显**，不是整块 reveal：光标在代码体里敲字时围栏保持藏着
 * （卡片不会一边打字一边抽动），只有光标真落在围栏那一行才回显源码去改语言。
 * 顺带的好处是写代码时顶部那条语言/复制一直够得着 —— 老版本整块 revealed
 * 就把复制按钮收走了，恰恰是最想复制的时候。
 *
 * 首尾两行各加 `.cm-lp-code-open` / `-close`，CSS 才能把逐行背景收成一张圆角卡片；
 * 藏起来的那条再加 `.cm-lp-fence-off` —— 源码没了，行高得跟着塌下去，
 * 否则卡片上下各留一条空条（这正是当初「藏了会剩个空行更难看」的那个坑，
 * 解法是让空行变成卡片的内边距，而不是让围栏一直露着）。
 */
function decorateFence(ctx: Ctx, node: SyntaxNode): void {
  const { doc, out, reveal } = ctx
  const fence = fenceParts(doc, node)
  const openLine = doc.lineAt(node.from)
  const closeLine = fence?.closeFrom == null ? null : doc.lineAt(fence.closeFrom)

  // 只开了个头的裸 ```（没语言、没内容、也没闭合）不藏：这一行凭空消失更吓人
  const worth =
    !!fence && (fence.lang !== '' || fence.body.trim() !== '' || fence.closeFrom !== null)
  const hideOpen = worth && !reveal.touches(openLine.from, openLine.to)
  const hideClose = !!closeLine && !reveal.touches(closeLine.from, closeLine.to)

  edgeLine(ctx, openLine.from, hideOpen ? 'cm-lp-code-open cm-lp-fence-off' : 'cm-lp-code-open')
  const bottom = closeLine ?? doc.lineAt(node.to)
  edgeLine(ctx, bottom.from, hideClose ? 'cm-lp-code-close cm-lp-fence-off' : 'cm-lp-code-close')

  if (!fence) return
  if (hideOpen)
    out.push(
      Decoration.replace({
        // 语言之后剩下的参数（```js title=a.js 的后半截）只进 tooltip，不上屏
        widget: new CodeHeadWidget(fence.lang, doc.sliceString(fence.langTo, fence.openTo))
      }).range(fence.openFrom, fence.openTo)
    )
  if (hideClose && fence.closeFrom !== null && fence.closeTo !== null)
    pushHide(ctx, fence.closeFrom, fence.closeTo)
}

/**
 * front matter（0.4.1）。**YAML 那棵树就在 Frontmatter 底下**（`yamlFrontmatter` 把
 * `Stream > Document > BlockMapping > Pair > Key/Literal/FlowSequence` 整套挂了上来），
 * 所以这儿不自己解析一行 YAML —— 与表格「片段从文档自己的语法树上采」同一条路。
 *
 * 为什么单独一个函数、而不是让主 `visit` 往下走：那台 switch 认的是 Markdown 的节点名，
 * 放 YAML 的树进去，两套语法从此共用一张表 —— 哪天两边撞上同名节点（`Document`、
 * `Item`、`Literal` 都是现成的候选）就会串味，而那种串味只在「某种文档」上出现。
 *
 * 四件事，全部按行判回显（光标落在哪一行，哪一行就回落成原样的 YAML）：
 * ① 两条 `---` 收成卡片的上下边（同代码块围栏：直接藏会剩一个空行，所以把空行压成边距）；
 * ② `key:` 的冒号藏掉、键名单独上样式；
 * ③ `[a, b, c]` 的方括号与逗号藏掉，每一项做成一颗标签；
 * ④ 卡片首尾行收圆角。
 */
function decorateFrontmatter(ctx: Ctx, node: SyntaxNode): void {
  const { doc, reveal } = ctx
  const open = doc.lineAt(node.from)
  // **`node.to` 落在闭合 `---` 的下一行行首**（front matter 这个节点带着尾换行），
  // 直接拿它铺行样式会把正文前面那个空行也铺成卡片的一部分 —— 从前看不出来
  // （没有圆角、底色也就多一条），现在卡片收了圆角，那一条会露在圆角下面
  const close = doc.lineAt(node.to > node.from ? node.to - 1 : node.to)
  addLines(ctx, open.from, close.to, 'cm-lp-frontmatter')
  edgeLine(ctx, open.from, 'cm-lp-fm-open')
  edgeLine(ctx, close.from, 'cm-lp-fm-close')

  const shown = (from: number, to: number): boolean => !reveal.touches(from, to)

  for (const child of childrenOf(node)) {
    if (child.name === 'DashLine') {
      // DashLine 带着行尾那个换行符，藏的时候只藏到行末为止
      const line = doc.lineAt(child.from)
      if (!shown(line.from, line.to)) continue
      edgeLine(ctx, line.from, 'cm-lp-fm-edge')
      pushHide(ctx, line.from, line.to)
      continue
    }
    if (child.name !== 'Stream') continue
    for (const pair of pairsOf(child)) decoratePair(ctx, pair, shown)
  }
}

/**
 * 一条 `key: value`。**回显按每个节点自己那一行判**，不按这条 Pair 的首行 ——
 * 块序列写法（`tags:` 换行再 `- 运维`）的一条 Pair 横跨好几行，按首行判的话，
 * 光标在 `- 备份` 上时那一行照样是渲染态，改都改不动。
 */
function decoratePair(
  ctx: Ctx,
  pair: SyntaxNode,
  shown: (from: number, to: number) => boolean
): void {
  const onShownLine = (n: SyntaxNode): boolean => {
    const line = ctx.doc.lineAt(n.from)
    return shown(line.from, line.to)
  }
  for (let c = pair.firstChild; c; c = c.nextSibling) {
    if (c.name === 'Key') {
      if (onShownLine(c)) ctx.out.push(markDeco('cm-lp-fm-key').range(c.from, c.to))
    } else if (c.name === ':') {
      // 冒号归标记，键名与值之间那个空格留着当分隔
      if (onShownLine(c)) pushHide(ctx, c.from, c.to)
    } else if (c.name === 'FlowSequence' || c.name === 'BlockSequence') {
      // 两种数组写法同一套长相：`[a, b]` 与「换行 - a / - b」都是一串标签
      for (let it = c.firstChild; it; it = it.nextSibling) {
        if (!onShownLine(it)) continue
        if (it.name === 'Item') {
          if (it.to > it.from) ctx.out.push(tagDeco().range(it.from, it.to))
        } else if (it.name === '-') {
          // 块序列的横杠连着后面那个空格一起藏，缩进留着当层级
          hideWithTrailingSpace(ctx, it.from, it.to)
        } else {
          // `[`、`]`、`,` 是 YAML 的标记，不是内容
          pushHide(ctx, it.from, it.to)
        }
      }
    }
  }
}

function* childrenOf(node: SyntaxNode): Generator<SyntaxNode> {
  for (let c = node.firstChild; c; c = c.nextSibling) yield c
}

/** `Stream > Document > BlockMapping > Pair*`，中间两层没有别的分支 */
function* pairsOf(stream: SyntaxNode): Generator<SyntaxNode> {
  for (const doc of childrenOf(stream))
    for (const map of childrenOf(doc))
      for (const pair of childrenOf(map)) if (pair.name === 'Pair') yield pair
}

function addLines(ctx: Ctx, from: number, to: number, cls: string): void {
  const start = Math.max(from, ctx.visFrom)
  const end = Math.min(to, ctx.visTo)
  if (start > end) return
  const deco = lineDeco(cls)
  let pos = ctx.doc.lineAt(start).from
  while (pos <= end) {
    const line = ctx.doc.lineAt(pos)
    ctx.out.push(deco.range(line.from))
    if (line.to >= ctx.doc.length) break
    pos = line.to + 1
  }
}

/** 给块首/块尾那一行单独补一个类；不在视口里就跳过（和 addLines 同一套裁剪口径） */
function edgeLine(ctx: Ctx, pos: number, cls: string): void {
  const line = ctx.doc.lineAt(pos)
  if (line.from < ctx.visFrom || line.from > ctx.visTo) return
  ctx.out.push(lineDeco(cls).range(line.from))
}

function skipSpaces(doc: Text, pos: number): number {
  const line = doc.lineAt(pos)
  let end = pos
  while (end < line.to && doc.sliceString(end, end + 1) === ' ') end++
  return end
}

/** 藏掉标记本身以及它后面的空格，否则会留下一个突兀的缩进 */
function hideWithTrailingSpace(ctx: Ctx, from: number, to: number): void {
  pushHide(ctx, from, skipSpaces(ctx.doc, to))
}

function hasChild(node: SyntaxNode, name: string): boolean {
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === name) return true
  return false
}

/** 嵌套层级，用来决定圆点符号 */
function bulletDepth(item: SyntaxNode): number {
  let depth = 0
  for (let n: SyntaxNode | null = item.parent; n; n = n.parent) {
    if (n.name === 'BulletList' || n.name === 'OrderedList') depth++
  }
  return Math.max(0, depth - 1)
}

/**
 * 解析图片：alt、src、可选 `=宽x高` 尺寸语法（不写高则按比例）。
 *
 * **目的地两种写法都要认**：裸写 `a.png`，以及 CommonMark 的尖括号形式 `<a b.png>`
 * —— 后者是文件名带空格时唯一的写法，`markdown-lang.ts` 的 `SizedImage` 解析器
 * 也认领它（`SIZED_IMAGE` 里那半个 `<[^<>\n]*>`）。两边必须对得上：解析器给了节点、
 * 这里却读不出 src 的话，装饰层 `return` 掉、导出退回 `escapeHtml(raw)`，
 * 屏幕上和导出物里都是一行裸源码。
 *
 * 裸写那一半**允许空格**（`![图](我的 图.png)`）：`markdown-lang.ts` 的 `SpacedLink`
 * 已经把这种形状咬成 Image 节点了，这里读不出 src 的话，屏幕上会是「alt + 一串源码」——
 * 两边必须同时放宽。非贪婪 + 尾部的 `\s*\)$` 保证目的地不会把尺寸段和标题一起吃进去。
 *
 * 尖括号那半必须**单独一组**：写成 `<?([^)\s]+)>?` 的话，`[^)\s]+` 贪婪地把收尾的 `>`
 * 一起吃进 src（`<ab.png>` → `ab.png>`），拼出来的 `safe-file://` 找不到文件，图必裂。
 */
export function parseImage(text: string): {
  alt: string
  src: string
  width?: number
  height?: number
} | null {
  const m =
    /^!\[([^\]]*)\]\(\s*(?:<([^<>\n]*)>|([^)\n]+?))(?:\s+=[ \t]*(\d+)[xX](?:\s*(\d+))?)?(?:\s+["'(][^)]*)?\s*\)$/.exec(
      text
    )
  if (!m) return null
  const src = m[2] ?? m[3] ?? ''
  // `![图](<>)`：解析得出来但没有目的地。当成「不是图片」，编辑器与导出一致地留下源码
  if (!src) return null
  return {
    alt: m[1] ?? '',
    src,
    width: m[4] ? Number(m[4]) : undefined,
    height: m[5] ? Number(m[5]) : undefined
  }
}

function resolveSrc(src: string, dir: string | null): string | null {
  if (/^(https?:|data:|safe-file:)/i.test(src)) return src
  // 目录必须是绝对路径，否则拼出来的是 safe-file://localfoo/... 这种废 URL
  if (!dir || !dir.startsWith('/')) return null
  const path = src.startsWith('/') ? src : `${dir}/${src}`
  // encodeURI 不管 ? 和 #，但文件名里真可能有
  const encoded = encodeURI(path).replace(/[?#]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)
  return `safe-file://local${encoded}`
}
