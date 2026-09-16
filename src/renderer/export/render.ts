import type { EditorState, Text } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import { classHighlighter, highlightTree } from '@lezer/highlight'
import { matchCallout } from '../editor/callout'
import { EMOJI } from '../editor/emoji'
import { collectHeadings, slugs } from '../editor/headings'
import { INLINE_MARKS } from '../editor/inline-text'
import { autolinkUrl, collectRefs, linkDest, refKey, safeUrl } from '../editor/link'
import { fenceParts, langLabel } from '../editor/live-preview/code'
import { calloutAt, parseImage } from '../editor/live-preview/decorate'
import { katexNow } from '../editor/live-preview/widgets'
import { type CellToken, type TableData, tableDataAt } from '../editor/live-preview/table'
import { resolveCodeLang } from '../editor/markdown-lang'
import { parsedTree } from '../editor/syntax'
import { t } from '../i18n'
import { icon } from '../ui/icons'

/**
 * P4-1 导出 HTML —— 全文渲染成语义 HTML。
 *
 * **和实时预览共用同一棵语法树**（`parsedTree` + `markdown-lang.ts` 的方言）。
 * 这是本模块唯一重要的架构约束：编辑器只渲染视口、导出渲染全文，两条路径对
 * 同一段 markdown 必须是同一种理解。所以这里一处小解析器都不写 ——
 * 图片走 `parseImage`、告示块走 `calloutAt`/`matchCallout`、表格走 `tableDataAt`、
 * 围栏走 `fenceParts`/`langLabel`、行内标记表走 `INLINE_MARKS`、
 * 标题与锚点走 `headings.ts` 的 `collectHeadings`/`slugs`。
 * `test/export.test.ts` 拿 `buildBlocks()` 的块级装饰和这里的产出逐块对账，守住这条线。
 *
 * 三个**有意为之**的差异（都写在 ROADMAP / CONTEXT 里）：
 *   1. **数学走 MathML**（不是编辑器里的 KaTeX HTML）—— HTML 那条路要 katex.css
 *      外加 1 MB 字体才不走样，塞进「单文件导出」不划算；MathML 浏览器原生排版，零依赖。
 *   2. **裸 HTML 原样转义**（`<div>` 显示成字面量）—— 编辑器就是这么显示的，
 *      所见即所得；顺带也就没有「导出的文件被文档里的脚本接管」这回事。
 *   3. **折叠态一律摊开**：告示块折起来是阅读姿势，不是文档内容。
 *
 * 本文件是**纯函数**（不碰 DOM、不碰网络），所以能在 node 里单测。
 * mermaid 那步天生要浏览器，留成占位符交给 `export/index.ts`。
 */

export interface ExportOpts {
  /** 文档所在目录，图片相对路径解析用；未命名文档是 null */
  dir?: string | null
  /** 取不到一级标题时的兜底标题（一般是文件名） */
  title?: string
}

/** 一个等着浏览器渲染的 mermaid 块（见本文件顶部注释第 3 段） */
export interface MermaidBlock {
  id: string
  src: string
  /** `html` 里当前占着位的那段（渲染失败就是最终形态），按字符串原样替换 */
  placeholder: string
}

export interface RenderResult {
  html: string
  title: string
  mermaid: MermaidBlock[]
}

interface Ctx {
  state: EditorState
  doc: Text
  dir: string | null
  /** 标题节点起点 → 锚点 id */
  slugOf: Map<number, string>
  /** 链接引用定义 `[ref]: url`（小写标签 → URL） */
  refs: Map<string, string>
  /** 已经发过号的脚注引用：同一个 label 只有第一处带 id，回跳才有唯一落点 */
  seenRefs: Set<string>
  mermaid: MermaidBlock[]
}

// ---------- 转义 ----------

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!)
}

/** 属性值。和正文同一套转义，单独留个名字是为了读代码时一眼看出这是属性位 */
function attr(text: string): string {
  return escapeHtml(text)
}

// ---------- 数学 ----------

/**
 * KaTeX → MathML。`throwOnError: false` 同编辑器：公式写错只该难看，不能让整份导出崩掉。
 *
 * katex 是懒加载的（P4-6②），而这里身处一整棵同步递归、变不成异步 —— 由入口
 * `export/index.ts` 先 `await loadKatex()` 保证它在手。真没到手也只退化成 `<code>`，
 * 不让一份导出栽在这上面。
 */
export function renderMathML(tex: string, display: boolean): string {
  const katex = katexNow()
  if (!katex) return `<code>${escapeHtml(tex)}</code>`
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: false,
      output: 'mathml'
    })
  } catch {
    return `<code>${escapeHtml(tex)}</code>`
  }
}

// ---------- 代码高亮 ----------

/**
 * 围栏语言 → 已加载的解析器。**挑解析器用的是 `resolveCodeLang`**，
 * 和编辑器上色、和语言条上显示的名字是同一条路（见 `markdown-lang.ts` 的注释）。
 * 语言还没加载完就退回纯文本 —— 调用方应当先 `loadCodeLangs()`。
 */
function highlightCode(src: string, lang: string): string {
  const parser = lang ? resolveCodeLang(lang)?.support?.language.parser : null
  if (!parser) return escapeHtml(src)
  let out = ''
  let pos = 0
  highlightTree(parser.parse(src), classHighlighter, (from, to, classes) => {
    if (from > pos) out += escapeHtml(src.slice(pos, from))
    out += `<span class="${attr(classes)}">${escapeHtml(src.slice(from, to))}</span>`
    pos = to
  })
  return out + escapeHtml(src.slice(pos))
}

/** 文档里用到的围栏语言（mermaid 不算 —— 它走图，不走高亮） */
export function collectCodeLangs(state: EditorState): string[] {
  const langs = new Set<string>()
  parsedTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode') return
      const fence = fenceParts(state.doc, node.node)
      if (fence?.lang && fence.lang !== 'mermaid') langs.add(fence.lang)
      return false
    }
  })
  return [...langs]
}

/**
 * 预加载这些语言的解析器。`language-data` 是按需 import 的，不等它加载完就渲染，
 * 代码块会整块没有颜色 —— 编辑器里不明显（用户滚到那儿时早加载好了），
 * 导出是一锤子买卖，必须先等。加载失败的语言退回纯文本，不影响其余部分。
 */
export async function loadCodeLangs(langs: string[]): Promise<void> {
  await Promise.all(
    langs.map(async (lang) => {
      try {
        await resolveCodeLang(lang)?.load()
      } catch {
        /* 这门语言就没有颜色，仅此而已 */
      }
    })
  )
}

// ---------- 行内 ----------

/** 子节点之间的空隙 = 纯文本 */
function text(ctx: Ctx, from: number, to: number): string {
  return to > from ? escapeHtml(ctx.doc.sliceString(from, to)) : ''
}

/** 渲染 [from,to) 这段行内内容：子节点各自成形，空隙按纯文本走 */
function inline(ctx: Ctx, node: SyntaxNode, from = node.from, to = node.to): string {
  let out = ''
  let pos = from
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.to <= from) continue
    if (child.from >= to) break
    out += text(ctx, pos, child.from)
    out += inlineNode(ctx, child)
    pos = Math.max(pos, child.to)
  }
  return out + text(ctx, pos, to)
}

const INLINE_TAG: Record<string, string> = {
  Emphasis: 'em',
  StrongEmphasis: 'strong',
  Strikethrough: 'del',
  Highlight: 'mark',
  Superscript: 'sup',
  Subscript: 'sub',
  InlineCode: 'code'
}

function inlineNode(ctx: Ctx, node: SyntaxNode): string {
  const name = node.name
  // 语法标记统一藏掉（这张表是唯一真相，表格格内片段与大纲标题文本共用它）。
  // 引用块的 `>` 会出现在段落内部（续行），列表标记则由 listItem 自己消化
  if (INLINE_MARKS.has(name) || name === 'QuoteMark' || name === 'ListMark') return ''

  const tag = INLINE_TAG[name]
  if (tag) return `<${tag}>${inline(ctx, node)}</${tag}>`

  switch (name) {
    case 'Link':
      return renderLink(ctx, node)
    case 'Autolink': {
      const url = node.getChild('URL')
      return url ? anchor(ctx.doc.sliceString(url.from, url.to)) : inline(ctx, node)
    }
    case 'URL':
      // 裸链接（GFM autolink）。`[文字](url)` 里那个 URL 的父节点是 Link，走不到这里
      return anchor(ctx.doc.sliceString(node.from, node.to))
    case 'Image':
      return renderImage(ctx, node)
    case 'Escape':
      // `\*` → 只脱反斜杠，被转义的字符照常出现
      return text(ctx, node.from + 1, node.to)
    case 'Entity':
      // 已经是 HTML 实体（`&amp;`），再转义一次就成了字面量
      return ctx.doc.sliceString(node.from, node.to)
    case 'HardBreak':
      return '<br>'
    case 'Emoji': {
      const char = EMOJI[ctx.doc.sliceString(node.from + 1, node.to - 1)]
      return char ? `<span class="emoji">${escapeHtml(char)}</span>` : text(ctx, node.from, node.to)
    }
    case 'InlineMath': {
      const raw = ctx.doc.sliceString(node.from, node.to)
      const delim = raw.startsWith('$$') ? 2 : 1
      const tex = raw.slice(delim, Math.max(delim, raw.length - delim))
      return tex.trim() ? renderMathML(tex, false) : text(ctx, node.from, node.to)
    }
    case 'FootnoteRef':
      return renderFootnoteRef(ctx, node)
    case 'Comment':
      // HTML 注释原样留着：它在输出里本来就是看不见的
      return ctx.doc.sliceString(node.from, node.to)
    case 'HTMLTag':
      // 裸 HTML 一律转义（见本文件顶部第 2 条）
      return text(ctx, node.from, node.to)
    default:
      return inline(ctx, node)
  }
}

function anchor(url: string, label = url): string {
  // 裸邮箱 / `www.` 开头的自己不带 scheme —— 补协议走 `editor/link.ts` 那一份，
  // 编辑器里 ⌘+点击同一个裸链接时用的就是这个函数，两边不会各补各的
  const href = safeUrl(url) ? autolinkUrl(url) : null
  if (!href) return escapeHtml(label)
  return `<a href="${attr(href)}">${escapeHtml(label)}</a>`
}

function renderLink(ctx: Ctx, node: SyntaxNode): string {
  // 链接文字 = 第一个 `[` 之后到 `]` 之前
  let close: SyntaxNode | null = null
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === 'LinkMark' && ctx.doc.sliceString(c.from, c.to) === ']') {
      close = c
      break
    }
  }
  const body = inline(ctx, node, node.from + 1, close ? close.from : node.to)
  // 行内写法读 URL 子节点、引用写法查定义表 —— 与编辑器里 ⌘+点击同一个 `linkDest`
  const raw = linkDest(ctx.doc, node, () => ctx.refs)
  if (!raw) return body
  const href = safeUrl(raw)
  if (!href) return body
  const title = node.getChild('LinkTitle')
  const tip = title ? ctx.doc.sliceString(title.from + 1, title.to - 1) : ''
  return `<a href="${attr(href)}"${tip ? ` title="${attr(tip)}"` : ''}>${body}</a>`
}

/** `[ref]` / `[ref][]` → 定义里的地址；没有这条定义返回空串 */
function refUrl(ctx: Ctx, label: string): string {
  return ctx.refs.get(refKey(label)) ?? ''
}

function renderImage(ctx: Ctx, node: SyntaxNode): string {
  const raw = ctx.doc.sliceString(node.from, node.to)
  const parsed = parseImage(raw)
  // `![图][ref]` 这类引用式写法 parseImage 认不了，补一条查定义
  const label = node.getChild('LinkLabel')
  const src = parsed?.src ?? (label ? refUrl(ctx, ctx.doc.sliceString(label.from, label.to)) : '')
  if (!src) return escapeHtml(raw)
  const alt = parsed?.alt ?? inlineAlt(ctx, node)
  const href = safeUrl(src)
  if (!href) return escapeHtml(raw)
  let size = ''
  if (parsed?.width) size += ` width="${parsed.width}"`
  if (parsed?.height) size += ` height="${parsed.height}"`
  // 本地图片：src 用文档里写的那个相对路径（导出文件放在文档旁边就能直接看），
  // 另挂一个绝对路径 —— 壳侧「嵌入图片」勾上时按它读盘换成 data: URI。
  // **图片字节不过 IPC 桥**（判断 3）：渲染层只负责写清楚去哪儿取。
  const abs = absPath(ctx, href)
  return `<img src="${attr(href)}"${abs ? ` data-abs="${attr(abs)}"` : ''} alt="${attr(alt)}"${size}>`
}

/** `![带 **格式** 的说明]` 的纯文本形态 */
function inlineAlt(ctx: Ctx, node: SyntaxNode): string {
  let close: SyntaxNode | null = null
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === 'LinkMark' && ctx.doc.sliceString(c.from, c.to) === ']') {
      close = c
      break
    }
  }
  return close ? ctx.doc.sliceString(node.from + 2, close.from) : ''
}

/** 相对路径 → 绝对路径（不做百分号解码：壳侧读盘时按 scheme handler 同款逐级解码） */
function absPath(ctx: Ctx, src: string): string | null {
  if (/^[a-zA-Z][\w+.-]*:/.test(src)) return null
  if (src.startsWith('/')) return src
  if (!ctx.dir || !ctx.dir.startsWith('/')) return null
  return `${ctx.dir}/${src}`
}

function renderFootnoteRef(ctx: Ctx, node: SyntaxNode): string {
  const label = /^\[\^([^\s\]]+)\]$/.exec(ctx.doc.sliceString(node.from, node.to))?.[1]
  if (!label) return text(ctx, node.from, node.to)
  // 同一个 label 引用多次时只有第一处带 id：回跳链接需要唯一落点
  const first = !ctx.seenRefs.has(label)
  ctx.seenRefs.add(label)
  const id = first ? ` id="fnref-${attr(label)}"` : ''
  return `<sup class="footnote-ref"${id}><a href="#fn-${attr(label)}">${escapeHtml(label)}</a></sup>`
}

// ---------- 块级 ----------

function blocks(ctx: Ctx, parent: SyntaxNode, from = parent.from, to = parent.to): string {
  let out = ''
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.to <= from) continue
    if (child.from >= to) break
    out += block(ctx, child)
  }
  return out
}

const HEADING_RE = /^(ATXHeading|SetextHeading)([1-6])$/

function block(ctx: Ctx, node: SyntaxNode): string {
  const name = node.name
  // 引用块的 `>` 是 Blockquote 的**直接子节点**（和里面的块平级），不挡掉会各自成一段
  if (name === 'QuoteMark' || INLINE_MARKS.has(name)) return ''

  const heading = HEADING_RE.exec(name)
  if (heading) {
    const level = heading[2]
    const id = ctx.slugOf.get(node.from) ?? ''
    return `<h${level} id="${attr(id)}">${inline(ctx, node).trim()}</h${level}>\n`
  }

  switch (name) {
    // yamlFrontmatter 把正文包成了内层 Document（没有 front matter 时同样包）
    case 'Document':
      return blocks(ctx, node)

    case 'Frontmatter':
      return `<pre class="frontmatter">${text(ctx, node.from, node.to).trimEnd()}</pre>\n`

    case 'Paragraph':
      return `<p>${inline(ctx, node).trim()}</p>\n`

    case 'Blockquote':
      return renderQuote(ctx, node)

    case 'BulletList':
      return `<ul>\n${listItems(ctx, node)}</ul>\n`

    case 'OrderedList': {
      const first = node.firstChild?.getChild('ListMark')
      const start = first ? parseInt(ctx.doc.sliceString(first.from, first.to), 10) : 1
      const attrs = Number.isFinite(start) && start !== 1 ? ` start="${start}"` : ''
      return `<ol${attrs}>\n${listItems(ctx, node)}</ol>\n`
    }

    case 'FencedCode':
      return renderFence(ctx, node)

    case 'CodeBlock': {
      // 缩进代码块：CodeText 之间的空隙是那四个缩进空格，跳过它们正好拼回原文
      let src = ''
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.name === 'CodeText') src += ctx.doc.sliceString(c.from, c.to)
      }
      return `<figure class="code"><pre><code>${escapeHtml(src)}</code></pre></figure>\n`
    }

    case 'HorizontalRule':
      return '<hr>\n'

    case 'Table':
      return renderTable(ctx, node)

    case 'DisplayMath': {
      const raw = ctx.doc.sliceString(node.from, node.to)
      const tex = raw.slice(2, Math.max(2, raw.length - 2))
      if (!tex.trim()) return `<p>${escapeHtml(raw)}</p>\n`
      return `<div class="math-block">${renderMathML(tex, true)}</div>\n`
    }

    case 'FootnoteDefinition':
      return renderFootnoteDefs(ctx, node)

    case 'TocBlock':
      return renderToc(ctx)

    case 'LinkReference':
      // 定义本身不是给人读的内容（地址已经并进了引用它的那些链接里）
      return ''

    case 'CommentBlock':
      return `${ctx.doc.sliceString(node.from, node.to)}\n`

    case 'HTMLBlock':
      return `<pre class="raw-html">${text(ctx, node.from, node.to).trimEnd()}</pre>\n`

    default:
      return `<p>${inline(ctx, node)}</p>\n`
  }
}

/** 引用块：是告示块就出卡片，否则出 blockquote */
function renderQuote(ctx: Ctx, node: SyntaxNode): string {
  const cal = calloutAt(ctx.doc, node)
  if (!cal) return `<blockquote>\n${blocks(ctx, node)}</blockquote>\n`

  // 首段第一行是 `[!type] 可选标题`：标记消化成卡片头，这一行剩下的字是标题
  let head: SyntaxNode | null = null
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === 'Paragraph') {
      head = c
      break
    }
  }
  const mark = head?.firstChild
  if (!head || mark?.name !== 'CalloutMark') return `<blockquote>\n${blocks(ctx, node)}</blockquote>\n`

  const headLine = ctx.doc.lineAt(mark.from)
  const titleFrom = Math.min(skipSpaces(ctx.doc, mark.to), headLine.to)
  const custom = inline(ctx, head, titleFrom, Math.min(headLine.to, head.to)).trim()
  const title = custom || escapeHtml(cal.label)

  // 卡片正文 = 首段剩下的部分 + 引用块里其余的块
  let body = ''
  if (head.to > headLine.to) body += `<p>${inline(ctx, head, headLine.to + 1, head.to).trim()}</p>\n`
  for (let c = head.nextSibling; c; c = c.nextSibling) body += block(ctx, c)

  // 折叠态不带进导出（`[!note]-` 是阅读姿势，不是文档内容）
  return (
    `<div class="callout callout-${attr(cal.tone)}">\n` +
    `<div class="callout-head">${icon(cal.icon)}<span>${title}</span></div>\n` +
    (body ? `<div class="callout-body">\n${body}</div>\n` : '') +
    '</div>\n'
  )
}

function skipSpaces(doc: Text, pos: number): number {
  const line = doc.lineAt(pos)
  let end = pos
  while (end < line.to && doc.sliceString(end, end + 1) === ' ') end++
  return end
}

function listItems(ctx: Ctx, list: SyntaxNode): string {
  let out = ''
  for (let item = list.firstChild; item; item = item.nextSibling) {
    if (item.name !== 'ListItem') continue
    out += listItem(ctx, item)
  }
  return out
}

/**
 * 列表项。第一段**不包 `<p>`** —— 紧凑列表（绝大多数）才不会每一项都撑开一行；
 * 第二段起照常成段，松散列表于是也对。任务项换成禁用的真复选框（同编辑器）。
 */
function listItem(ctx: Ctx, item: SyntaxNode): string {
  let out = ''
  let cls = ''
  let firstPara = true
  for (let c = item.firstChild; c; c = c.nextSibling) {
    if (c.name === 'ListMark' || c.name === 'QuoteMark') continue
    if (c.name === 'Task') {
      const marker = c.getChild('TaskMarker')
      const checked = marker
        ? ctx.doc.sliceString(marker.from, marker.to).toLowerCase().includes('x')
        : false
      cls = ' class="task"'
      out += `<input type="checkbox" disabled${checked ? ' checked' : ''}> `
      out += inline(ctx, c, marker ? skipSpaces(ctx.doc, marker.to) : c.from, c.to)
      firstPara = false
      continue
    }
    if (c.name === 'Paragraph' && firstPara) {
      out += inline(ctx, c)
      firstPara = false
      continue
    }
    out += block(ctx, c)
  }
  return `<li${cls}>${out}</li>\n`
}

function renderFence(ctx: Ctx, node: SyntaxNode): string {
  const fence = fenceParts(ctx.doc, node)
  if (!fence) return `<figure class="code"><pre><code>${text(ctx, node.from, node.to)}</code></pre></figure>\n`

  if (fence.lang === 'mermaid' && fence.body.trim()) {
    const id = `cursive-mmd-${ctx.mermaid.length}`
    // 占位就是「渲染失败」的最终形态：保留源码，和编辑器里 mermaid 出错时一致
    const placeholder = `<pre class="mermaid-src" data-mmd="${id}">${escapeHtml(fence.body)}</pre>`
    ctx.mermaid.push({ id, src: fence.body, placeholder })
    return `<figure class="mermaid" id="${id}">${placeholder}</figure>\n`
  }

  const label = fence.lang ? `<figcaption>${escapeHtml(langLabel(fence.lang))}</figcaption>` : ''
  return (
    `<figure class="code">${label}` +
    `<pre><code>${highlightCode(fence.body, fence.lang)}</code></pre></figure>\n`
  )
}

function renderTable(ctx: Ctx, node: SyntaxNode): string {
  // 结构与格内片段都走 tableDataAt —— 和编辑器那张真表格是同一份数据
  const data = tableDataAt(ctx.state, node.from, node.to)
  if (!data) return `<p>${inline(ctx, node)}</p>\n`

  const cell = (tag: string, row: number, col: number, value: string): string => {
    const align = data.aligns[col] ?? 'left'
    const style = align === 'left' ? '' : ` style="text-align:${align}"`
    return `<${tag}${style}>${cellHtml(data, row, col, value)}</${tag}>`
  }

  let out = '<div class="table-wrap">\n<table>\n<thead><tr>'
  data.header.forEach((v, i) => {
    out += cell('th', 0, i, v)
  })
  out += '</tr></thead>\n<tbody>\n'
  data.rows.forEach((row, r) => {
    out += '<tr>'
    data.header.forEach((_, i) => {
      out += cell('td', r + 1, i, row[i] ?? '')
    })
    out += '</tr>\n'
  })
  return out + '</tbody>\n</table>\n</div>\n'
}

/** 格内行内语法：片段由 `cellTokens` 采自文档的语法树（同编辑器），这里只负责套标签 */
function cellHtml(data: TableData, row: number, col: number, value: string): string {
  const tokens = data.rich?.[row]?.[col]
  if (!tokens) return escapeHtml(value)
  return tokens.map(tokenHtml).join('')
}

function tokenHtml(tok: CellToken): string {
  let inner = tok.tex ? renderMathML(tok.tex, false) : escapeHtml(tok.text)
  for (const tag of [...tok.tags].reverse()) {
    const open = tag === 'a' && tok.href ? `<a href="${attr(safeUrl(tok.href) ?? '')}">` : `<${tag}>`
    inner = `${open}${inner}</${tag}>`
  }
  return inner
}

/**
 * 脚注定义。一个 `FootnoteDefinition` 节点可能装着**连续几条**定义
 * （解析器按空行收尾，中间不断行），所以这里按 `[^label]:` 切开。
 */
function renderFootnoteDefs(ctx: Ctx, node: SyntaxNode): string {
  const start = node.from
  const raw = ctx.doc.sliceString(node.from, node.to)
  const items: { label: string; from: number; to: number }[] = []
  let offset = 0
  for (const line of raw.split('\n')) {
    const m = /^\[\^([^\s\]]+)\]:[ \t]*/.exec(line)
    if (m) {
      items.push({ label: m[1]!, from: start + offset + m[0].length, to: start + offset + line.length })
    } else if (items.length) {
      // 续行并进上一条
      items[items.length - 1]!.to = start + offset + line.length
    }
    offset += line.length + 1
  }
  if (!items.length) return `<p>${inline(ctx, node)}</p>\n`

  let out = '<div class="footnotes">\n<ol>\n'
  for (const item of items) {
    const body = inline(ctx, node, item.from, item.to).trim()
    out +=
      `<li id="fn-${attr(item.label)}"><span class="footnote-label">${escapeHtml(item.label)}</span> ` +
      `${body} <a class="footnote-back" href="#fnref-${attr(item.label)}">&#8617;</a></li>\n`
  }
  return out + '</ol>\n</div>\n'
}

/** `[TOC]` → 目录。条目与大纲同一份取数（`collectHeadings`），锚点与标题同一份 slug */
function renderToc(ctx: Ctx): string {
  const items = collectHeadings(ctx.state)
  if (!items.length) return ''
  let out = `<nav class="toc">\n<div class="toc-title">${escapeHtml(t('w.toc'))}</div>\n<ul>\n`
  for (const h of items) {
    const id = ctx.slugOf.get(h.pos) ?? ''
    out += `<li style="padding-left:${(h.level - 1) * 14 + 6}px"><a href="#${attr(id)}">${escapeHtml(h.text)}</a></li>\n`
  }
  return out + '</ul>\n</nav>\n'
}

// ---------- 入口 ----------

/**
 * 文档 → HTML 正文片段（不含 `<html>` 外壳，那一层在 `export/index.ts`）。
 * 纯函数：单测直接拿它和 `buildBlocks()` 对账。
 */
export function renderBody(state: EditorState, opts: ExportOpts = {}): RenderResult {
  const headings = collectHeadings(state)
  const ids = slugs(headings)
  const slugOf = new Map<number, string>()
  headings.forEach((h, i) => slugOf.set(h.pos, ids[i] || `section-${i + 1}`))

  const ctx: Ctx = {
    state,
    doc: state.doc,
    dir: opts.dir ?? null,
    slugOf,
    refs: collectRefs(state),
    seenRefs: new Set(),
    mermaid: []
  }

  const html = blocks(ctx, parsedTree(state).topNode)
  const title = headings.find((h) => h.level === 1)?.text || opts.title || t('app.untitled')
  return { html, title, mermaid: ctx.mermaid }
}
