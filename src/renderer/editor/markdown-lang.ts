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

/**
 * 尺寸图片的形状：`![alt](目的地 =宽x高)`，目的地可以写成 `<a b.png>`。
 * 只在行内解析阶段用一次，跟 `CALLOUT_SHAPE` 一样单独摆在上面，方便对着源码改。
 */
const SIZED_IMAGE = /^!\[([^\]\n]*)\]\([ \t]*(<[^<>\n]*>|[^\s()]+)([ \t]+=[ \t]*\d+[xX]\d*)[ \t]*\)/

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
 * 脚注定义 [^label]: 内容。
 * 必须用 eager parse 抢在 LinkReference 之前 —— 「[^1]: 文字」同时是合法的
 * 链接引用定义形状，等段落累积完再认领就来不及了。定义内容到空行为止
 * （多行续行是 GitHub 规则的简化版）。
 */
function parseFootnoteDef(cx: BlockContext, line: Line): BlockResult {
  if (!/^\[\^[^\s\]]+\]:/.test(line.text.slice(line.pos))) return false
  const from = cx.lineStart + line.pos
  for (;;) {
    const peeked = cx.peekLine()
    if (!peeked || !peeked.trim()) break
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
    { name: 'CalloutMarkParser', before: 'Link', parse: parseCalloutMark }
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
