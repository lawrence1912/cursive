import type { EditorState, TransactionSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { t } from '../i18n'
import { count } from '../../shared/wordcount'
import type { MenuAction } from '../../shared/types'
import { makeFormatSpec } from './fmt'
import { plainInline } from './inline-text'
import { parsedTree } from './syntax'

export interface Heading {
  /** 1–6 */
  level: number
  /** 给人看的标题文字：`#`、setext 下划线、行内语法全部剥掉 */
  text: string
  /** 标题节点起点，用来跳转与「当前章节」判定；也是各种操作的身份 */
  pos: number
  /** 标题节点**自身**的结束（setext 含第二行的下划线） */
  headEnd: number
  /** 本节结束 = 下一个同级或更高级标题的起点（没有就是文末）。含所有下级小节 */
  end: number
  /** setext 写法（`标题` + `=====`）。升降级要另走一条路，ATX 那套加减 `#` 对它无效 */
  setext: boolean
}

/** 带每节字数的标题，大纲面板用（`[TOC]` 不需要，就不让它白算一遍全文） */
export interface Section extends Heading {
  /** 本节正文字数（不含标题这一行本身；含下级小节） */
  words: number
}

/**
 * 标题节点名 —— **全仓库唯一一份**。除了这里取数，`live-preview/index.ts` 的增量重建
 * 也要拿它判「这次改动有没有动到标题」：动到了就得把整份目录（`[TOC]` 烘的是全文
 * 标题表）重算，脏区那条路盖不住。两处口径必须是同一条，否则会漏出「改了标题、
 * 目录没跟上」这种只在长文档上偶发的缝。
 */
export const HEADING_RE = /^(ATXHeading|SetextHeading)([1-6])$/

/**
 * 全文标题表 —— 大纲、`[TOC]`、章节跟随高亮**共用这一份取数**。
 *
 * 曾经是两份：大纲在 main.ts 用正则剥 `#`，`[TOC]` 在 widgets.ts 只认 ATXHeading。
 * 于是同一份文档两个目录对不上（setext 标题 `[TOC]` 里根本看不到），而大纲里的
 * setext 标题还拖着第二行的 `=====`、行内语法是裸源码。合并之后这三处不可能再漂移。
 *
 * 树没解析完就取数会漏掉文档深处的标题（CM 的 parse 是异步分块的，CONTEXT.md 里
 * 记过同款坑的行级版和块级版），所以这里自己 ensure —— `parsedTree` 兼管
 * 「ensure 完别再读旧快照」那一层（见 `editor/syntax.ts`），已经解析过时是空操作。
 */
/**
 * 同一个 state 上的结果记在这儿。一次大纲刷新里这份取数会被要好几遍 ——
 * 大纲面板一次、文档里每个 `[TOC]` 各一次、`](#` 那个补全源一次、章节跟随高亮一次；
 * 而它是**全文走一遍树、每个标题再摘一次纯文本**（3600 个标题实测 20ms 上下）。
 * state 不可变，同一个 state 的标题表不会变，所以记一次就够。
 *
 * **别改返回的数组**：它是共享的。要加工就像 `sections()` 那样 map 出新对象。
 */
const headingCache = new WeakMap<EditorState, Heading[]>()

export function collectHeadings(state: EditorState): Heading[] {
  const hit = headingCache.get(state)
  if (hit) return hit
  const out: Heading[] = []
  const tree = parsedTree(state)
  tree.iterate({
    from: 0,
    to: state.doc.length,
    enter: (node) => {
      const m = HEADING_RE.exec(node.name)
      if (!m) return
      // setext 的 `=====` 与 ATX 的首尾 `#` 都是 HeaderMark，由 plainInline 一并剥掉；
      // 剩下的换行（setext 是两行一个节点）压成空格
      const text = plainInline(state, node.from, node.to).replace(/\s+/g, ' ').trim()
      out.push({
        level: Number(m[2]),
        text: text || t('hd.empty'),
        pos: node.from,
        headEnd: node.to,
        end: state.doc.length, // 回扫时补
        setext: m[1] === 'SetextHeading'
      })
      return false
    }
  })
  // 本节范围 = 到下一个**同级或更高级**标题为止（下级小节算在自己身上）
  for (let i = 0; i < out.length; i++) {
    const next = out.slice(i + 1).find((h) => h.level <= out[i]!.level)
    out[i]!.end = next ? next.pos : state.doc.length
  }
  // **半截树上的结果不记**：文档大到一次 ensure 解析不完时，这一份只有前半截的标题，
  // 而下一次问同一个 state 时 ensure 可能就成功了 —— 记下来等于把「只有半截目录」钉死
  if (tree.length >= state.doc.length) headingCache.set(state, out)
  return out
}

/** 给每节补上字数。全文切片相加 = 扫一遍全文，所以只在（防抖过的）大纲刷新时调 */
export function sections(state: EditorState, items = collectHeadings(state)): Section[] {
  return items.map((h) => ({
    ...h,
    words: count(state.doc.sliceString(h.headEnd, h.end)).words
  }))
}

/** 视口顶部所在行 → 它之前最近的一个标题（滚动跟随高亮）。items 必须按 pos 升序 */
export function headingBefore(items: Heading[], pos: number): number | null {
  let found: number | null = null
  for (const h of items) {
    if (h.pos > pos) break
    found = h.pos
  }
  return found
}

/**
 * GitHub 风格锚点：小写、去标点、空格换 `-`，重名依次加 `-1` `-2`。
 * CJK 原样保留（`\p{L}` 收得住），和 GitHub / VS Code 预览的行为一致。
 */
export function slugs(items: { text: string }[]): string[] {
  const seen = new Map<string, number>()
  return items.map((h) => {
    const base = h.text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .replace(/ +/g, '-')
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n ? `${base}-${n}` : base
  })
}

/**
 * 把一整节（标题 + 它名下的所有内容）搬到另一个标题之前，`beforePos` 为 null = 搬到文末。
 *
 * **这是大纲里唯一会改文档的操作**，必须过「保存零损耗」那条红线：搬完只是同一批字节
 * 换了个顺序，总量一个不多一个不少。两个边界情况都会破坏这一点，所以单独处理：
 *   · 搬走的是**文末那一节**（不带收尾换行）→ 连它前面那个换行一起搬，补到搬过去的末尾；
 *   · 搬到**不带收尾换行的文末** → 把这一节自己的收尾换行挪到最前面当分隔。
 * 两种都是「换行换了个位置」，字节数不变。
 */
export function moveSectionSpec(
  state: EditorState,
  items: Heading[],
  fromPos: number,
  beforePos: number | null
): TransactionSpec | null {
  const src = items.find((h) => h.pos === fromPos)
  if (!src) return null
  const len = state.doc.length
  const dst = beforePos === null ? len : beforePos
  // 落点在自己身上或自己内部 → 什么都不做（拖拽时挡不住，这里兜底）
  if (dst >= src.pos && dst <= src.end) return null

  const text = state.doc.sliceString(src.pos, src.end)
  let from = src.pos
  let insert = text
  if (!text.endsWith('\n')) {
    // 文末那一节：src.pos 一定不是 0（不然整篇就这一节，上面已经返回 null）
    from = src.pos - 1
    insert = `${text}\n`
  } else if (dst === len && state.doc.sliceString(len - 1, len) !== '\n') {
    insert = `\n${text.slice(0, -1)}`
  }

  const removed = src.end - from
  // 往后搬：删除发生在落点之前，落点整体左移；往前搬：落点在删除之前，不受影响
  const landed = dst > src.end ? dst - removed : dst
  return {
    changes: [{ from, to: src.end }, { from: dst, insert }],
    // 只滚动、不动选区：光标该留在用户原来编辑的地方
    effects: EditorView.scrollIntoView(Math.min(landed, len - removed + insert.length), {
      y: 'start',
      yMargin: 12
    })
  }
}

/**
 * 升/降级。ATX 直接借 `fmt.ts` 的 `fmt:h1…h6` —— 与菜单、格式栏同一条命令表；
 * setext 没法表达 3 级以上，按级别分两条路：
 *   · 目标 1/2 级：只换下划线字符（`=` ↔ `-`），长度不动 —— 字节数都不变；
 *   · 目标 3–6 级：整块换成 ATX 写法（下划线那行没地方放了，只能收掉）。
 */
export function levelChangeSpec(
  state: EditorState,
  h: Heading,
  level: number
): TransactionSpec | null {
  if (level < 1 || level > 6 || level === h.level) return null
  if (!h.setext) {
    // 借 fmt.ts 那条路：先造一个「光标停在这个标题上」的临时 state，
    // 算出来的 changes 基于同一份文档，可以直接 dispatch 给真正的 view
    const at = state.update({ selection: { anchor: h.pos } }).state
    return makeFormatSpec(at, `fmt:h${level}` as MenuAction)
  }
  const rule = state.doc.lineAt(h.headEnd)
  if (level <= 2) {
    return {
      changes: { from: rule.from, to: rule.to, insert: (level === 1 ? '=' : '-').repeat(rule.text.length) }
    }
  }
  const title = state.doc.sliceString(h.pos, state.doc.lineAt(h.pos).to)
  return { changes: { from: h.pos, to: rule.to, insert: `${'#'.repeat(level)} ${title}` } }
}

/** 在本节末尾插一个同级标题，并把「新标题」四个字选中 —— 接着打字就是改名 */
export function newSiblingSpec(state: EditorState, h: Heading): TransactionSpec {
  const len = state.doc.length
  const atEnd = h.end >= len
  const title = t('hd.new')
  const lead = atEnd && len > 0 && state.doc.sliceString(len - 1, len) !== '\n' ? '\n' : ''
  const prefix = `${lead}${'#'.repeat(h.level)} `
  const from = Math.min(h.end, len)
  return {
    changes: { from, insert: `${prefix}${title}${atEnd ? '\n' : '\n\n'}` },
    selection: { anchor: from + prefix.length, head: from + prefix.length + title.length },
    scrollIntoView: true
  }
}
