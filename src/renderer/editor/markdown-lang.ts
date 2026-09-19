import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown'
import { yamlFrontmatter } from '@codemirror/lang-yaml'
import { LanguageDescription, type LanguageSupport } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { tags as t } from '@lezer/highlight'
import {
  GFM,
  type BlockContext,
  type InlineContext,
  type LeafBlock,
  type Line,
  type MarkdownConfig
} from '@lezer/markdown'

/** @lezer/markdown 未导出 BlockResult，这里按上游定义补一份 */
type BlockResult = boolean | null
import { CALLOUT_SHAPE } from './callout'
import { EMOJI } from './emoji'

/**
 * cursive 的 markdown 方言：CommonMark + GFM + YAML front matter + 数学 + 方言补齐。
 *
 * 刻意不用 `markdownLanguage` —— 它在 GFM 之外还塞了上下标和 emoji 扩展，
 * 会和本文件自己的上下标/emoji 实现打架。这里用 commonmarkLanguage 打底、
 * 显式只加 GFM，再叠本文件的 math 与 extras 两层扩展。
 */
export function cursiveMarkdown(): LanguageSupport {
  return yamlFrontmatter({
    content: markdown({
      base: commonmarkLanguage,
      extensions: [...GFM, math, extras],
      codeLanguages: resolveCodeLang
    })
  })
}

/**
 * 围栏上的语言名 → 解析器。**上色用的这一次解析，和代码块条子上显示的名字
 * 必须是同一次**（`live-preview/code.ts` 的 langLabel 也调它）——
 * 两边各判各的，迟早会出现「条子写着 Python、整块却是纯文本色」。
 *
 * 在 language-data 自带的 `matchLanguageName` 之上补一条**后缀兜底**：
 * `py` / `yml` / `rs` / `kt` 这些最常写的简称在 language-data 里只登记成
 * 扩展名、没进 alias，名字匹配一概认不出来 —— ```py 因此整块没有颜色。
 */
export function resolveCodeLang(info: string): LanguageDescription | null {
  const name = info.trim().toLowerCase()
  if (!name) return null
  return (
    LanguageDescription.matchLanguageName(languages, name, true) ??
    LanguageDescription.matchFilename(languages, `x.${name}`)
  )
}

// ---------- 数学公式（P1-1）----------
//
// 规则收紧到 pandoc tex_math_dollars 一档，防中文文档里的货币符号被吃：
//   开定界符后必须紧跟非空白；闭定界符前必须非空白、后不能是数字。
//   （「共计$5，优惠$2」里第二个 $ 后面是数字 → 不是公式；
//     「$5 和 $8」里第二个 $ 前面是空格 → 也不是。）
// 行内 $ / $$ 不跨行；跨行的 $$…$$ 走块级 parser。

const DOLLAR = 36
const NEWLINE = 10

function isSpace(code: number): boolean {
  return code === -1 ? false : /\s/.test(String.fromCharCode(code))
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57
}

/** 从 pos+len 往右找合法的闭定界符，返回其起点；找不到返回 -1 */
function findInlineClose(
  cx: InlineContext,
  pos: number,
  len: number,
  delim: number,
  noDigitAfter: boolean
): number {
  for (let i = pos + len; i < cx.end; i++) {
    const ch = cx.char(i)
    if (ch === NEWLINE) return -1 // 行内语法不跨行
    if (ch !== delim) continue
    // 闭定界符长度必须与开定界符一致：$$…$$ 配对，$…$ 配对。
    // 不校验的话 '$x$$y' 会把闭 $ 的终点算到行外去，内联装饰跨行直接把 CM 搞崩
    if (len === 2 ? cx.char(i + 1) !== delim : cx.char(i + 1) === delim) continue
    if (isSpace(cx.char(i - 1))) continue // 闭定界符前不能是空白
    if (noDigitAfter && isDigit(cx.char(i + len))) continue // 闭定界符后不能是数字（$10 那种）
    return i
  }
  return -1
}

function parseInlineMath(cx: InlineContext, next: number, pos: number): number {
  if (next !== DOLLAR) return -1
  // $$ 优先于 $：紧挨的第二个 $ 也存在时按 2 字符定界符算
  const len = cx.char(pos + 1) === DOLLAR ? 2 : 1
  const after = cx.char(pos + len)
  if (after === -1 || isSpace(after) || after === DOLLAR) return -1
  const close = findInlineClose(cx, pos, len, DOLLAR, true)
  if (close < 0) return -1
  const end = close + len
  return cx.addElement(
    cx.elt('InlineMath', pos, end, [
      cx.elt('MathMark', pos, pos + len),
      cx.elt('MathMark', close, end)
    ])
  )
}

/**
 * 块级数学：首行以 $$ 开，遇到「以 $$ 结尾且 $ 前非空白」的行闭合；
 * 中间夹空行 / 到文档尾还没闭合 → 不是数学块，回落成普通段落。
 * 全部逻辑放 finish()（照抄 GFM TableParser 的形态）：段落是逐行累积的，
 * finish 拿到的 leaf.content 就是完整内容，一次判断最省心。
 */
class DisplayMathParser {
  nextLine(_cx: BlockContext, _line: Line, _leaf: LeafBlock): boolean {
    return false // 继续累积，闭合判断留给 finish
  }

  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    const lines = leaf.content.split('\n')
    const first = lines[0].trimEnd()
    if (!first.startsWith('$$')) return false

    // 单行闭合：$$…$$，开定界符后与闭定界符前都必须是非空白
    if (lines.length === 1) {
      if (first.length < 4 || !first.endsWith('$$')) return false
      const body = first.slice(2, -2)
      if (!body || /^\s/.test(body) || /\s$/.test(body)) return false
      cx.addLeafElement(leaf, cx.elt('DisplayMath', leaf.start, leaf.start + leaf.content.length))
      return true
    }

    // 多行：首行必须是裸 $$，末行以 $$ 收（或整行就是 $$）
    if (first !== '$$') return false
    const last = lines[lines.length - 1].trimEnd()
    const closes = last === '$$' || (last.endsWith('$$') && !/\s$/.test(last.slice(0, -2)))
    if (!closes) return false
    cx.addLeafElement(leaf, cx.elt('DisplayMath', leaf.start, leaf.start + leaf.content.length))
    return true
  }
}

const math: MarkdownConfig = {
  defineNodes: [
    { name: 'InlineMath' },
    { name: 'MathMark', style: t.processingInstruction },
    { name: 'DisplayMath', block: true, style: t.special(t.string) }
  ],
  parseInline: [{ name: 'Math', parse: parseInlineMath }],
  parseBlock: [
    {
      name: 'DisplayMath',
      // 抢在 SetextHeading 之前：否则 $$\nx\n$$ 下面的 --- 之类会把段落吃成标题
      before: 'SetextHeading',
      leaf: (_cx, leaf) => (/^\$\$/.test(leaf.content) ? new DisplayMathParser() : null)
    }
  ]
}

// ---------- 方言补齐（P1-3）：高亮 / 上下标 / emoji / 脚注 / TOC ----------
//
// 上下标用 ^ ~ 单字符定界符，与数学公式不冲突：math 的元素内容是原子的，
// $e^{-x^2}$ 里的 ^ 根本不会进入行内解析（这正是当初弃用 markdownLanguage 的原因）。
// 单 ~ 也安全：GFM 删除线要求恰好 ~~，单 ~ 会落到这里的 Subscript。

const EQUALS = 61
const CARET = 94
const TILDE = 126
const COLON = 58
const BANG = 33
const LBRACKET = 91
const CARET2 = 94
const RBRACKET = 93
const LPAREN = 40

/**
 * 尺寸图片的形状：`![alt](目的地 =宽x高)`，目的地可以写成 `<a b.png>`。
 * 只在行内解析阶段用一次，跟 `CALLOUT_SHAPE` 一样单独摆在上面，方便对着源码改。
 */
const SIZED_IMAGE = /^!\[([^\]\n]*)\]\([ \t]*(<[^<>\n]*>|[^\s()]+)([ \t]+=[ \t]*\d+[xX]\d*)[ \t]*\)/

/**
 * 目的地**带空格**的本地链接 / 图片：`[部署手册](VPS 从 0 到 1 部署.md)`、`![图](我的 图.png =600x400)`。
 * 组：1 `!`、2 链接文字、3 `(` 后的空白、4 目的地、5 尺寸段、6 标题前的空白、7 标题。
 */
const SPACED_LINK =
  /^(!?)\[([^\]\n]*)\]\(([ \t]*)([^()\n]*?)([ \t]+=[ \t]*\d+[xX]\d*)?([ \t]*)(["'][^"'\n]*["'])?[ \t]*\)/

/** 目的地要「看得出是个文件」才放宽：`/` 结尾，或 `.后缀` 且后缀首字母是字母 */
const FILE_TAIL = /(?:\/|\.[A-Za-z][A-Za-z0-9]{0,7})$/

/** 成对单字符定界符（^…^ / ~…~）的通用行内解析器 */
function makePairedParser(
  name: string,
  node: string,
  mark: string,
  delim: number
): { name: string; parse: (cx: InlineContext, next: number, pos: number) => number } {
  return {
    name,
    parse(cx, next, pos) {
      if (next !== delim) return -1
      const first = cx.char(pos + 1)
      if (first === -1 || isSpace(first) || first === delim) return -1
      for (let i = pos + 1; i < cx.end; i++) {
        const ch = cx.char(i)
        if (ch === NEWLINE) return -1
        if (ch !== delim) continue
        if (isSpace(cx.char(i - 1))) continue // 闭定界符前不能是空白
        return cx.addElement(
          cx.elt(node, pos, i + 1, [
            cx.elt(mark, pos, pos + 1),
            cx.elt(mark, i, i + 1)
          ])
        )
      }
      return -1
    }
  }
}

/** ==高亮==：与 math 同款的双字符定界符扫描（内容不跨行） */
function parseHighlight(cx: InlineContext, next: number, pos: number): number {
  if (next !== EQUALS || cx.char(pos + 1) !== EQUALS) return -1
  const after = cx.char(pos + 2)
  if (after === -1 || isSpace(after) || after === EQUALS) return -1
  const close = findInlineClose(cx, pos, 2, EQUALS, false)
  if (close < 0) return -1
  const end = close + 2
  return cx.addElement(
    cx.elt('Highlight', pos, end, [
      cx.elt('HighlightMark', pos, pos + 2),
      cx.elt('HighlightMark', close, end)
    ])
  )
}

/** :smile: → emoji。表里没有的短代码一律保持字面量（时间 10:30:45 不受影响） */
function parseEmoji(cx: InlineContext, next: number, pos: number): number {
  if (next !== COLON) return -1
  let end = pos + 1
  while (end < cx.end) {
    const ch = cx.char(end)
    if (ch === COLON) break
    if (ch === NEWLINE) return -1
    if (!/[a-zA-Z0-9_+-]/.test(String.fromCharCode(ch))) return -1
    end++
  }
  if (end >= cx.end || end === pos + 1) return -1
  if (!EMOJI[cx.slice(pos + 1, end)]) return -1
  return cx.addElement(cx.elt('Emoji', pos, end + 1))
}

/** [^label] 脚注引用。必须抢在 Link 之前，否则 [ 被链接解析器拿走 */
function parseFootnoteRef(cx: InlineContext, next: number, pos: number): number {
  if (next !== LBRACKET || cx.char(pos + 1) !== CARET2) return -1
  let end = pos + 2
  while (end < cx.end) {
    const ch = cx.char(end)
    if (ch === RBRACKET) break
    if (ch === NEWLINE || isSpace(ch)) return -1
    end++
  }
  if (end >= cx.end || end === pos + 2) return -1
  return cx.addElement(cx.elt('FootnoteRef', pos, end + 1))
}

/** 块级定义的通用形态：首行认领，finish 时整体落元素（照抄 DisplayMathParser） */
function makeLineStartParser(test: (content: string) => boolean, node: string) {
  return class {
    nextLine(_cx: BlockContext, _line: Line, _leaf: LeafBlock): boolean {
      return false
    }
    finish(cx: BlockContext, leaf: LeafBlock): boolean {
      if (!test(leaf.content)) return false
      cx.addLeafElement(leaf, cx.elt(node, leaf.start, leaf.start + leaf.content.length))
      return true
    }
  }
}

/** [TOC]（单行）块 */
const TocParser = makeLineStartParser((c) => /^\[\s*toc\s*\]$/i.test(c.trim()), 'TocBlock')

/**
 * 脚注定义行 `[^label]: 正文` 的形状 —— **全仓库唯一一份**。
 *
 * 标签行首起算、**不含空白**（`[^a b]:` 不是定义），冒号后的空格并进 `m[0]`，
 * 于是 `m[0].length` 就是正文起点、`m[1]` 是标签。用它的四处：
 * 本文件的块解析、`live-preview/widgets.ts` 的 `footnoteLabels`、
 * `export/render.ts` 的定义切分、`complete.ts` 的 `[^` 补全源。
 *
 * 四处口径必须是同一条，否则会漏出「补全列出来的定义解析器不认」这种缝：
 * 补全那份原来写的是 `[^\]]+`（标签里允许空格），列出来的 `[^a b]` 插进正文
 * 既没有定义可跳，也换不出角标。
 */
export const FOOTNOTE_DEF = /^\[\^([^\s\]]+)\]:[ \t]*/

/**
 * 脚注定义 [^label]: 内容。
 * 必须用 eager parse 抢在 LinkReference 之前 —— 「[^1]: 文字」同时是合法的
 * 链接引用定义形状，等段落累积完再认领就来不及了。定义内容到**空行或下一条定义**
 * 为止（多行续行是 GitHub 规则的简化版）。
 *
 * 「下一条定义也收尾」是补出来的：人写脚注的常态是几条连着摞在文末、中间不空行，
 * 只认空行的话它们会合成**一个**节点，而装饰层一个节点只画一行
 * （`FootnoteDefWidget` 的折叠语义），后面那几条在编辑器里整条看不见 ——
 * `test/fixtures/dialect.md` 自己就是这个形状。逐条出节点之后，
 * 编辑器、导出、`findFootnoteDef` 三处看到的定义数目才是同一个。
 */
function parseFootnoteDef(cx: BlockContext, line: Line): BlockResult {
  if (!FOOTNOTE_DEF.test(line.text.slice(line.pos))) return false
  const from = cx.lineStart + line.pos
  for (;;) {
    const peeked = cx.peekLine()
    if (!peeked || !peeked.trim() || FOOTNOTE_DEF.test(peeked)) break
    cx.nextLine()
  }
  const end = cx.lineStart + line.text.length
  cx.addElement(cx.elt('FootnoteDefinition', from, end))
  // 必须把当前行推过定义块，否则 parsedPos 不前进，解析器原行重试直到超时
  cx.nextLine()
  return true
}

/**
 * `[!danger]` 告示块标记（P1-6）。和脚注同一个坑，而且更凶：`[!danger]` 正好是
 * 合法的 shortcut 链接引用形状，不抢在 Link 前面，整行会被渲染成一个
 * 蓝色带下划线的坏链接 —— 比裸源码更让人困惑。
 *
 * 唯一的闸门是「段落的第一个字符」（`pos === cx.offset`）—— 类型认不认识不在这里判：
 * 打错一个字母就掉回坏链接是最糟的失败方式，不如一律认领成 CalloutMark，
 * 由装饰层决定是渲染成卡片（类型在表里）还是原样显示（不在表里，仍是普通引用）。
 * 「必须在引用块里」那一半也归装饰层 —— 行内解析器看不到块上下文
 * （decorate.ts 的 CalloutMark 分支要求父节点链上有 Blockquote）。
 */
function parseCalloutMark(cx: InlineContext, next: number, pos: number): number {
  if (next !== LBRACKET || cx.char(pos + 1) !== BANG || pos !== cx.offset) return -1
  const m = CALLOUT_SHAPE.exec(cx.slice(pos, Math.min(cx.end, pos + 32)))
  if (!m) return -1
  return cx.addElement(cx.elt('CalloutMark', pos, pos + m[0].length))
}

/**
 * `![alt](图.png =600x400)`：宽高尺寸语法。
 *
 * 为什么内置的 Image 解析器认不了它：CommonMark 里链接目的地不能带空格，`=600x400`
 * 也不是合法的链接标题（标题必须引号/括号包裹）。于是内置解析器只把 `![alt]` 认成
 * shortcut 形状的 Image，后面那串 `(…)` 原样落进正文 —— 装饰层拿到的切片对不上
 * `parseImage`，屏幕上就是「alt + 一串源码」。这里补一条更靠前的行内解析器认领它。
 *
 * 节点形状**与内置图片完全一致**（`LinkMark` + `URL` + 尺寸标记 + 括号标记），
 * 因此装饰（decorate.ts 的 Image 分支）、导出（parseImage）、大纲取词（plainInline）、
 * 表格格内（cellTokens）都不必为它各加一条分支 —— 它们看到的仍然是一张图片。
 * 尺寸段单独叫 `SizeMark`，是为了让「只取人看的文字」的那几处把它一起藏掉。
 */
/**
 * 把一条图片源码的尺寸改写成 `=宽x高`（原来没有就插在目的地后面）。0.2.x 拖角改尺寸用。
 *
 * **认不出就回 null，调用方原样不动。** 挡掉的主要是**带标题**的那种
 * （`![图](a.png "说明")`）：`SIZED_IMAGE` 不接受尺寸后面还跟标题，内置解析器又不接受
 * 目的地后面跟 `=600x400`，硬写进去的结果是两边都不认、整条退回裸源码。
 * 宁可这一下拖不动，也不能把一张好好的图写坏。
 *
 * 除了尺寸那一段，其余字节一个都不碰 —— 尖括号目的地、`![]` 空 alt、多余空格
 * 都按用户写的样子留着（保存零损耗那条红线的同一个分寸）。
 */
export function withImageSize(text: string, width: number, height: number): string | null {
  const m = IMAGE_FOR_SIZE.exec(text)
  if (!m) return null
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  return `${m[1]} =${w}x${h})`
}

/** 与 `SIZED_IMAGE` 同一个形状，只是尺寸那段可有可无、且锚住整条 */
const IMAGE_FOR_SIZE =
  /^(!\[[^\]\n]*\]\([ \t]*(?:<[^<>\n]*>|[^\s()]+))(?:[ \t]+=[ \t]*\d+[xX]\d*)?[ \t]*\)$/

function parseSizedImage(cx: InlineContext, next: number, pos: number): number {
  if (next !== BANG) return -1
  // 切一段有上界的出来（同 `parseCalloutMark`）：`cx.end` 是整个块的末尾，
  // 一个长段落里每遇到一个 `!` 就复制一遍全段 = O(n²)。一张图的
  // `![alt](目的地 =宽x高)` 写到 512 字节已经离谱，够用
  const m = SIZED_IMAGE.exec(cx.slice(pos, Math.min(cx.end, pos + 512)))
  if (!m) return -1
  const [raw = '', alt = '', dest = '', size = ''] = m
  const marks = (b: number, e: number) => cx.elt('LinkMark', b, e)
  const altEnd = pos + 2 + alt.length
  const destStart = altEnd + 2
  const sizeStart = destStart + dest.length
  return cx.addElement(
    cx.elt('Image', pos, pos + raw.length, [
      marks(pos, pos + 2), // ![
      marks(altEnd, altEnd + 1), // ]
      marks(altEnd + 1, altEnd + 2), // (
      cx.elt('URL', destStart, sizeStart),
      cx.elt('SizeMark', sizeStart, sizeStart + size.length),
      marks(sizeStart + size.length, sizeStart + size.length + 1) // )
    ])
  )
}

/**
 * 目的地带空格的链接 / 图片（0.2.0 链接跳转的后续）。
 *
 * CommonMark 的链接目的地不能带空格 —— 得写成 `<我的 文件.md>` 或 `我的%20文件.md`。
 * 不这么写的话整段落进正文：连 `Link` 节点都没有，于是不上色、点不动、导出也不是链接。
 * 而**带空格的文件名正是中文笔记最常见的样子**：本仓库作者在自己的 vault 里连试六种
 * 写法（版本历史里一条不落地记着），最后把文件改了名才算完 —— 这不是用户的错，是方言太严。
 *
 * 放宽的边界钉死在「看得出是个文件」上，而不是「括号里有东西就算链接」：
 *   · 目的地里**必须真有空格** —— 没空格的内置解析器自己认得，轮不到这儿；
 *   · **不能带协议**（`http://a b` 本来就不是合法地址，放宽它只会把错误藏起来）；
 *   · **不能是 `<…>` 写法**（那是内置的地盘，重复认领等于两个解析器抢同一段）；
 *   · **必须以 `/` 或 `.后缀` 结尾**（只看 `#` 之前那半截，锚点不算），且后缀首字母是
 *     字母 —— 于是 `[备注](见 下文)`、
 *     `[版本](见 v1.2)` 都不会被误认成链接。误认比不认更糟：正文里平白多出一条蓝线。
 *
 * 节点形状**与内置完全一致**（`LinkMark` + `URL` + 可选 `SizeMark`/`LinkTitle` + 括号标记），
 * 所以装饰、导出、大纲取词、表格格内四条路都不必为它加分支 —— 它们看到的就是一条链接。
 *
 * **已知取舍**：链接文字里的行内语法不再解析（`[**粗**](我的 文件.md)` 的星号以字面量
 * 示人）—— 与 `SizedImage` 同款。换来的是不去动 lezer 的分隔符栈：那条路要自己配对
 * 方括号，配错一次就是一棵坏树，而这种链接的文字九成九是一句大白话。
 */
function parseSpacedLink(cx: InlineContext, next: number, pos: number): number {
  if (next !== LBRACKET && next !== BANG) return -1
  const open = next === BANG ? pos + 1 : pos
  if (next === BANG && cx.char(open) !== LBRACKET) return -1
  // 先用两个字符挡一下再切片：任务项 `- [ ]`、脚注 `[^1]` 这些形状满文档都是，
  // 每撞上一个就复制 512 字节 + 跑一遍正则，纯属白花（同 parseSizedImage 的上界理由）
  let close = -1
  for (let i = open + 1; i < cx.end && i < open + 256; i++) {
    const ch = cx.char(i)
    if (ch === NEWLINE) return -1
    if (ch === RBRACKET) {
      close = i
      break
    }
  }
  if (close < 0 || cx.char(close + 1) !== LPAREN) return -1

  const m = SPACED_LINK.exec(cx.slice(pos, Math.min(cx.end, pos + 512)))
  if (!m) return -1
  const [raw = '', bang = '', label = '', lead = '', dest = '', size = '', gap = '', title = ''] = m
  // 没空格 = 内置解析器的活；`<…>` 同理。带协议的地址里出现空格只能是写错了
  if (!/\s/.test(dest) || dest.startsWith('<')) return -1
  if (/^[a-zA-Z][\w+.-]*:/.test(dest)) return -1
  // 「像不像文件」只看 `#` 之前那半截 —— `我的 笔记.md#小节` 的后缀在锚点前面
  if (!FILE_TAIL.test(dest.split('#')[0] ?? '')) return -1
  // 尺寸段只对图片有意义，链接后面跟一段 `=600x400` 就当它不是这种链接
  if (size && !bang) return -1

  const marks = (b: number, e: number) => cx.elt('LinkMark', b, e)
  const labelEnd = pos + bang.length + 1 + label.length
  const destStart = labelEnd + 2 + lead.length
  const destEnd = destStart + dest.length
  const titleStart = destEnd + size.length + gap.length
  const end = pos + raw.length
  const kids = [
    marks(pos, pos + bang.length + 1), // `[` 或 `![`
    marks(labelEnd, labelEnd + 1), // ]
    marks(labelEnd + 1, labelEnd + 2), // (
    cx.elt('URL', destStart, destEnd)
  ]
  if (size) kids.push(cx.elt('SizeMark', destEnd, destEnd + size.length))
  if (title) kids.push(cx.elt('LinkTitle', titleStart, titleStart + title.length))
  kids.push(marks(end - 1, end)) // )
  return cx.addElement(cx.elt(bang ? 'Image' : 'Link', pos, end, kids))
}

const extras: MarkdownConfig = {
  defineNodes: [
    { name: 'Highlight', style: t.emphasis },
    { name: 'HighlightMark', style: t.processingInstruction },
    { name: 'Superscript', style: t.special(t.string) },
    { name: 'SuperscriptMark', style: t.processingInstruction },
    { name: 'Subscript', style: t.special(t.string) },
    { name: 'SubscriptMark', style: t.processingInstruction },
    { name: 'Emoji', style: t.content },
    { name: 'FootnoteRef', style: t.link },
    { name: 'FootnoteDefinition', block: true },
    { name: 'TocBlock', block: true },
    { name: 'CalloutMark', style: t.processingInstruction },
    { name: 'SizeMark', style: t.processingInstruction }
  ],
  parseInline: [
    { name: 'SizedImage', before: 'Image', parse: parseSizedImage },
    makePairedParser('Superscript', 'Superscript', 'SuperscriptMark', CARET),
    makePairedParser('Subscript', 'Subscript', 'SubscriptMark', TILDE),
    { name: 'Highlight', parse: parseHighlight },
    { name: 'Emoji', parse: parseEmoji },
    { name: 'FootnoteRefParser', before: 'Link', parse: parseFootnoteRef },
    { name: 'CalloutMarkParser', before: 'Link', parse: parseCalloutMark },
    // 排在脚注 / 告示块之后：它们认的 `[^1]`、`[!note]` 后面都没有 `(…)`，
    // 本来也撞不上；顺序写明白是为了改动时一眼看出谁先挑走哪种形状
    { name: 'SpacedLink', before: 'Link', parse: parseSpacedLink }
  ],
  parseBlock: [
    {
      name: 'FootnoteDefinition',
      before: 'LinkReference',
      parse: parseFootnoteDef
    },
    {
      name: 'TocBlock',
      before: 'SetextHeading',
      leaf: (_cx, leaf) => (/^\[\s*toc\s*\]$/i.test(leaf.content) ? new TocParser() : null)
    }
  ]
}
