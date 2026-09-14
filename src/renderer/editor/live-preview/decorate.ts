import { Facet, type EditorState, type Range, type Text } from '@codemirror/state'
import { Decoration, type DecorationSet, type EditorView } from '@codemirror/view'
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common'
import { calloutFolded, matchCallout, type CalloutMatch } from '../callout'
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
  FootnoteRefWidget,
  ImageWidget,
  MathWidget,
  RuleWidget
} from './widgets'

/** 当前文档所在目录，用来把 `![](assets/a.png)` 这种相对路径解析成可加载的 URL */
export const docDir = Facet.define<string | null, string | null>({
  combine: (values) => values[0] ?? null
})

const HIDE = Decoration.replace({})

/** 零长度的 replace 是无效装饰，会把 CodeMirror 的行渲染搞崩，统一在这里挡掉 */
function pushHide(ctx: Ctx, from: number, to: number): void {
  if (to > from) ctx.out.push(HIDE.range(from, to))
}
const lineCache = new Map<string, Decoration>()
function lineDeco(cls: string): Decoration {
  let d = lineCache.get(cls)
  if (!d) lineCache.set(cls, (d = Decoration.line({ class: cls })))
  return d
}
const markCache = new Map<string, Decoration>()
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

/** 返回 false 表示不再深入这个节点的子树 */
function visit(node: SyntaxNodeRef, ctx: Ctx): boolean | void {
  const { out, doc, reveal } = ctx
  const revealed = reveal.touches(node.from, node.to)

  switch (node.name) {
    // ---------- 块级：铺行样式 ----------
    case 'Frontmatter':
      addLines(ctx, node.from, node.to, 'cm-lp-frontmatter')
      return false

    case 'ATXHeading1':
    case 'ATXHeading2':
    case 'ATXHeading3':
    case 'ATXHeading4':
    case 'ATXHeading5':
    case 'ATXHeading6':
      addLines(ctx, node.from, node.to, `cm-lp-h${node.name.slice(-1)}`)
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

    case 'URL':
      // 只藏 [文字](链接) 里的链接，裸链接（Autolink）要留着
      if (!revealed && node.node.parent?.name === 'Link') {
        pushHide(ctx, node.from, node.to)
      }
      return

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
        Decoration.replace({ widget: new CheckboxWidget(checked) }).range(node.from, node.to)
      )
      return false
    }

    // ---------- 行内：只加样式 ----------
    case 'InlineCode':
      out.push(markDeco('cm-lp-inline-code').range(node.from, node.to))
      return

    case 'Link':
      out.push(markDeco('cm-lp-link').range(node.from, node.to))
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

/** 解析图片：alt、src、可选 `=宽x高` 尺寸语法（Typora 兼容，不写高则按比例） */
export function parseImage(text: string): {
  alt: string
  src: string
  width?: number
  height?: number
} | null {
  const m = /^!\[([^\]]*)\]\(\s*<?([^)\s]+)>?(?:\s+=[ \t]*(\d+)[xX](?:\s*(\d+))?)?(?:\s+["'(][^)]*)?\s*\)$/.exec(
    text
  )
  if (!m) return null
  return {
    alt: m[1] ?? '',
    src: m[2] ?? '',
    width: m[3] ? Number(m[3]) : undefined,
    height: m[4] ? Number(m[4]) : undefined
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
