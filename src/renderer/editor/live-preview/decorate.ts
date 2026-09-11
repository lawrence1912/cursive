import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { Facet, type Range, type Text } from '@codemirror/state'
import { Decoration, type DecorationSet, type EditorView } from '@codemirror/view'
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common'
import { Reveal, revealScope } from './reveal'
import { BulletWidget, CheckboxWidget, ImageWidget, RuleWidget } from './widgets'

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
  doc: Text
  reveal: Reveal
  dir: string | null
  /** 当前可视区间，行级装饰只在这个范围内铺，避免为屏幕外的长代码块白干 */
  visFrom: number
  visTo: number
}

export function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const ctx: Ctx = {
    out: [],
    doc: state.doc,
    reveal: new Reveal(state, state.facet(revealScope)),
    dir: state.facet(docDir),
    visFrom: 0,
    visTo: 0
  }
  // parse 是异步分块的：只用 syntaxTree(state) 的话，首次打开长文档时
  // 深处的节点拿不到树，装饰会缺失直到用户交互触发重建。
  // 这里把可视范围强制同步解析到位（有界：不超视口 + 1KB 余量）。
  const ranges = view.visibleRanges
  const visEnd = ranges.length ? ranges[ranges.length - 1].to : state.doc.length
  const tree =
    ensureSyntaxTree(state, Math.min(visEnd + 1000, state.doc.length)) ?? syntaxTree(state)

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

    case 'Blockquote':
      addLines(ctx, node.from, node.to, 'cm-lp-quote')
      return

    case 'FencedCode':
      addLines(ctx, node.from, node.to, 'cm-lp-code')
      return

    case 'Table': {
      // 真表格渲染在 index.ts 的 tableField（块级装饰必须走 StateField）。
      // 这里只负责「光标碰到 → 回显管道符源码」的行样式。
      if (revealed) addLines(ctx, node.from, node.to, 'cm-lp-table')
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
      // 只藏行内代码的反引号；围栏 ``` 保留可见（藏了会剩个空行更难看）
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

    // ---------- 行内：换成组件 ----------
    case 'Image': {
      if (revealed) return
      const parsed = parseImage(doc.sliceString(node.from, node.to))
      if (!parsed) return
      const src = resolveSrc(parsed.src, ctx.dir)
      if (!src) return
      out.push(
        Decoration.replace({ widget: new ImageWidget(src, parsed.alt) }).range(node.from, node.to)
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

function parseImage(text: string): { alt: string; src: string } | null {
  const m = /^!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^)]*)?\s*\)$/.exec(text)
  return m ? { alt: m[1] ?? '', src: m[2] ?? '' } : null
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
