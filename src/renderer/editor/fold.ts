import { MapMode, StateEffect, StateField, type EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { collectHeadings, type Heading } from './headings'
import { parsedTree } from './syntax'

/**
 * 折叠一节（0.4.0 F1）与折叠一条列表（0.4.1）。
 *
 * 长文里最常用的一种聚焦是「把写完的三节收起来，只留正在写的这一节」。
 * 现有的两条路都不是这件事：**专注模式**压暗的是段落，长度一点没减；
 * **大纲折叠**折的是目录那一侧，正文照旧整篇摊着。
 *
 * **两种可折的东西共用同一个 StateField**：一节的身份是标题节点起点，一条列表的
 * 身份是 `ListItem` 起点，都是「文档里的一个位置」，映射、展开、脏区三套逻辑
 * 一字不差。分两个字段的话，「落点掉进折叠区就当场展开」那条收口要写两遍，
 * 而 `live-preview` 的增量重建也要把两份折叠区并起来算 —— 那是两处必然漂移的地方。
 *
 * 三条规矩，都是判断 4（编辑器里的「态」一律不写回文档）的直接后果：
 * - 状态**照抄 `calloutFoldField`**：一个 StateField 存「哪些标题折着」，
 *   存的是标题节点起点，文档一改跟着 changes 映射，标题被删掉就丢弃；
 * - **不写回文档**，所以折叠态不进导出物、不进保存、⌘Z 也不管它（它不是一次编辑）；
 * - **与大纲折叠各存各的**：一个是导航态、一个是编辑态。联动之后「在大纲里收起来
 *   看看结构」会顺手改掉正文的显示，而那正是人**不想**发生的事。
 *
 * 范围算法不新写：`collectHeadings` 早就按「到下一个同级或更高级标题为止」算好了
 * `end`（大纲、`[TOC]`、章节跟随高亮共用那一份），这里只是把它折起来。
 */

/** 折叠开关，值是标题节点（或 `ListItem` 节点）的起点 */
export const toggleSectionFold = StateEffect.define<number>()

/** 折起来之后真正被藏掉的那一段（首行**不**在内） */
export interface FoldSpan {
  /** 标题节点 / `ListItem` 起点，也是这条折叠的身份 */
  pos: number
  /** 首行末尾 —— 连着换行符一起藏，下面几行才会并进首行那一行 */
  from: number
  /** 本节最后一行的行尾（不含它后面那个换行，否则下一个标题会被吸上来） */
  to: number
}

export const sectionFoldField = StateField.define<Set<number>>({
  create: () => new Set(),
  update(value, tr) {
    if (tr.docChanged) {
      const next = new Set<number>()
      for (const pos of value) {
        const mapped = tr.changes.mapPos(pos, 1, MapMode.TrackDel)
        if (mapped !== null) next.add(mapped)
      }
      value = next
    }
    let toggled = false
    for (const effect of tr.effects) {
      if (!effect.is(toggleSectionFold)) continue
      const next = new Set(value)
      if (!next.delete(effect.value)) next.add(effect.value)
      value = next
      toggled = true
    }
    if (!value.size || toggled) return value
    // **落点掉进折起来的那一节 = 当场展开它。** 查找跳转、⌘G、大纲点击、跨文件搜索、
    // ⌘D 多光标……每一条路都可能把光标送进藏起来的正文里，而「光标在一段看不见的
    // 文字里」之后每一次打字都是在改看不见的东西。与其在每条跳转路上各记一次，
    // 不如在这儿收口（`toggled` 那一下除外：折叠命令自己会把光标先挪到标题行上）
    const hits = new Set<number>()
    // **边界是 (from, to]**，不是闭区间：`from` 就是标题行的行尾，光标停在那儿是
    // 站在标题上、不在藏起来的正文里。写成闭区间的话，折叠命令把光标挪到标题行之后，
    // 下一个带选区的事务（滚动、状态栏跟随、随便什么）当场就把它展开了 ——
    // 表现是「菜单点了没反应」，而那正是这一条最容易自己骗自己的地方
    const inside = (from: number, to: number, s: FoldSpan): boolean =>
      to > s.from && from <= s.to
    if (tr.selection) {
      const spans = spansOf(tr.state, value)
      for (const r of tr.state.selection.ranges)
        for (const s of spans) if (inside(r.from, r.to, s)) hits.add(s.pos)
    }
    if (tr.docChanged) {
      // 改到了藏起来的正文（替换全部、外部重载、跨文件替换落回本文档）同样展开：
      // 改了什么都看不见，比没折叠还糟
      const spans = spansOf(tr.state, value)
      tr.changes.iterChangedRanges((_fa, _ta, from, to) => {
        for (const s of spans) if (inside(from, to, s)) hits.add(s.pos)
      })
    }
    if (!hits.size) return value
    const next = new Set(value)
    for (const pos of hits) next.delete(pos)
    return next
  }
})

/** 这一节 / 这一条此刻折着没有 */
export function sectionFolded(state: EditorState, pos: number): boolean {
  return state.field(sectionFoldField, false)?.has(pos) === true
}

/**
 * 折起来的那些节。**嵌套的只留外层** —— 里外两条跨行替换装饰重叠时 CM 直接报错，
 * 而外层已经把里层整段盖住了（判断 2 那个老坑第一次真的撞上两条跨行装饰）。
 */
export function foldedSpans(state: EditorState): FoldSpan[] {
  const set = state.field(sectionFoldField, false)
  if (!set?.size) return []
  return spansOf(state, set)
}

function spansOf(state: EditorState, set: Set<number>): FoldSpan[] {
  const out: FoldSpan[] = []
  // **按文档序遍历**，外层才会排在里层前面 —— 下面那条「外层已经盖住就别再出一条」
  // 靠的就是这个顺序（标题的外层 pos 更小，父列表项的 pos 也更小）
  for (const pos of [...set].sort((a, b) => a - b)) {
    const span = spanAt(state, pos)
    // 外层已经盖住的就别再出一条（里层那条会与外层重叠）
    if (span && !out.some((s) => span.from >= s.from && span.from < s.to)) out.push(span)
  }
  return out
}

/** `pos` 上那个可折的东西能折起来的那一段：先当标题问一次，再当列表项问一次 */
export function spanAt(state: EditorState, pos: number): FoldSpan | null {
  const h = collectHeadings(state).find((x) => x.pos === pos)
  if (h) return spanOf(state, h)
  const item = listItemAt(state, pos)
  return item && item.from === pos ? itemSpan(state, item) : null
}

/** 一节能折起来的那一段；只有标题行、没有正文就回 null（没东西可折） */
export function spanOf(state: EditorState, h: Heading): FoldSpan | null {
  const head = state.doc.lineAt(h.headEnd)
  if (h.end <= head.to) return null
  // `h.end` 是**下一个标题的起点**，直接用它会把那个换行也吃掉 —— 下一个标题会被
  // 吸到折叠行的尾巴上。退到前一行的行尾
  const to = state.doc.lineAt(Math.max(head.to, h.end - 1)).to
  return to > head.to ? { pos: h.pos, from: head.to, to } : null
}

/**
 * 一条列表项能折起来的那一段：首行之后到本条最后一行。
 * 只有首行、没有子项 / 续行的（`- 单独一条`）回 null —— 没东西可折。
 */
export function itemSpan(state: EditorState, item: SyntaxNode): FoldSpan | null {
  const head = state.doc.lineAt(item.from)
  if (item.to <= head.to) return null
  // 同 spanOf：退一格再取行，免得把本条末尾那个换行也吃进去（下一条会被吸上来）
  const to = state.doc.lineAt(Math.max(head.to, item.to - 1)).to
  return to > head.to ? { pos: item.from, from: head.to, to } : null
}

/** 罩着 `pos` 的 `ListItem`，由内而外。不在列表里就是空的 */
function itemChain(state: EditorState, pos: number): SyntaxNode[] {
  const out: SyntaxNode[] = []
  let node: SyntaxNode | null = parsedTree(state).resolveInner(pos, 1)
  for (; node; node = node.parent) if (node.name === 'ListItem') out.push(node)
  return out
}

/** 最里面那个罩着 `pos` 的 `ListItem` */
function listItemAt(state: EditorState, pos: number): SyntaxNode | null {
  return itemChain(state, pos)[0] ?? null
}

/** 落在 `pos` 上的那一节（嵌套时取最里面那一层）。标题行本身算它自己那一节 */
export function sectionAt(state: EditorState, pos: number): Heading | null {
  let found: Heading | null = null
  for (const h of collectHeadings(state)) {
    if (h.pos > pos) break
    if (pos < h.end) found = h
  }
  return found
}

/**
 * `pos` 上该折的是哪一个 —— **由内而外，最近的那一层说了算**。
 *
 * 光标停在一条带子项的列表里，人想折的是那一条，不是它所在的整节（同 Obsidian）。
 * 所以先从最里层的 `ListItem` 往外找第一条折得动的，都找不到才退回小节。
 * 要折整节就把光标挪到标题行上 —— 标题行不在任何列表项里，这条链是空的。
 */
function targetAt(state: EditorState, pos: number): FoldSpan | null {
  for (const item of itemChain(state, pos)) {
    const span = itemSpan(state, item)
    if (span) return span
  }
  const h = sectionAt(state, pos)
  return h ? spanOf(state, h) : null
}

/**
 * 折 / 展开 `pos` 落在的那一节或那一条列表。回「有没有动」——
 * 手边没有折得动的东西时不动，调用方据此说一句。
 *
 * **折的时候顺手把光标挪到首行上**：不挪的话光标就留在了刚藏起来的正文里，
 * 而 `sectionFoldField` 那条「落点掉进折叠区就展开」会当场把它又展开 ——
 * 看起来就是「点了没反应」。
 */
export function toggleFoldAt(view: EditorView, pos: number): boolean {
  const state = view.state
  const span = targetAt(state, pos)
  if (!span) return false
  const folding = !sectionFolded(state, span.pos)
  const inside = state.selection.ranges.some((r) => r.to > span.from && r.from <= span.to)
  view.dispatch({
    effects: toggleSectionFold.of(span.pos),
    ...(folding && inside ? { selection: { anchor: span.from } } : {})
  })
  return true
}
