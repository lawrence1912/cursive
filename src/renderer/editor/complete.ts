import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionSource
} from '@codemirror/autocomplete'
import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { calloutTypes } from './callout'
import { EMOJI } from './emoji'
import { collectHeadings, slugs } from './headings'
import { langOptions } from './live-preview/code'
import { slashIcon, slashSource } from './slash'

/**
 * 0.2.0 自动补全。
 *
 * `@codemirror/autocomplete` 一直在依赖里，但从头到尾只用了 `closeBrackets` ——
 * 补全本身一次都没挂。五个补全源的数据**全是现成的**，这里不新增任何一张表：
 * emoji 走 `emoji.ts` 的 `EMOJI`、告示块走 `callout.ts` 的类型表、
 * 代码语言走语言条那份 `langOptions()`、脚注与锚点现扫文档。
 * 「补全里有、渲染层却不认」这种漂移因此不可能发生。
 *
 * 第六个源是斜杠命令（`editor/slash.ts`，照 Notion 那套输入方式），单独一个文件 ——
 * 上面五个补的是**正在写的这一段文字**，它插的是**一个块**，落地要走 `fmt.ts` 那台引擎。
 *
 * 两条铁律在这里的落法：
 * - **输入法**（红线二）：每个源开头都挡 `view.compositionStarted`。触发字符虽然都是 ASCII，
 *   但中文连打时选字框和补全面板会叠在一起抢方向键 —— 组字期间一律不弹。
 * - **保存零损耗**（红线一）：补全只在用户按下确认那一刻改文档，不做任何后台改写。
 */

/** 面板最多列这么多条。再多就不是「补全」而是「翻列表」了 */
const MAX = 40

/**
 * 插入补全文本，并处理 `closeBrackets` 预先摆在光标右边的那半个括号。
 *
 * 这是**必须的**，不是锦上添花：`closeBrackets()` 让「敲 `[`」变成 `[]`，
 * 于是想写 `[!note]` 的人打到 `[!` 时文档里其实是 `[!]`。
 * 不管那个 `]`，补全出来就是 `[!note]]`。
 *
 * - `consume`：插入的文本**自带**收尾符（`[!note]` / `[^id]`）→ 把右边那个吃掉；
 * - `skip`：收尾符不属于这次插入（`](#锚点` 的 `)`）→ 跳过去，让光标落在链接外面。
 */
function applyWith(
  insert: string,
  closer: string,
  mode: 'consume' | 'skip'
): (view: EditorView, completion: Completion, from: number, to: number) => void {
  return (view, _completion, from, to) => {
    const after = view.state.sliceDoc(to, to + closer.length)
    const matched = closer !== '' && after === closer
    const end = matched && mode === 'consume' ? to + closer.length : to
    const caret = from + insert.length + (matched && mode === 'skip' ? closer.length : 0)
    view.dispatch({
      changes: { from, to: end, insert },
      selection: { anchor: caret },
      userEvent: 'input.complete'
    })
  }
}

/** 组字期间一律不弹（红线二）。每个源都从这儿起步 */
function blocked(cx: CompletionContext): boolean {
  return cx.view?.compositionStarted === true
}

// ---------------------------------------------------------------- emoji

/**
 * `:smile:` 短代码。
 *
 * **冒号后面至少要敲一个字**才弹，否则 `10:30:45`、`http://` 这类文本每写一个冒号
 * 都要被面板打断一次。冒号前面是字母数字的也不弹（`a:b` 不是短代码的形状）。
 */
const emojiSource: CompletionSource = (cx) => {
  if (blocked(cx)) return null
  const m = cx.matchBefore(/:[a-zA-Z0-9_+-]*/)
  if (!m) return null
  if (m.to - m.from < 2 && !cx.explicit) return null
  if (/[a-zA-Z0-9]/.test(cx.state.sliceDoc(Math.max(0, m.from - 1), m.from))) return null
  const options: Completion[] = Object.entries(EMOJI).map(([name, char]) => ({
    label: `:${name}:`,
    detail: char,
    // 插入的是**短代码**而不是那个字符：渲染层本来就把 `:smile:` 显示成 😄，
    // 而短代码在 GitHub / 别的编辑器里也认 —— 换成字符反倒把信息抹掉了
    apply: applyWith(`:${name}:`, '', 'consume')
  }))
  return { from: m.from, options, validFor: /^:[a-zA-Z0-9_+-]*$/ }
}

// ---------------------------------------------------------------- 告示块

/** `> [!` → 13 种告示块。只在引用行开头认，正文里的 `[!` 不是告示块 */
const calloutSource: CompletionSource = (cx) => {
  if (blocked(cx)) return null
  const m = cx.matchBefore(/\[!\w*/)
  if (!m) return null
  const line = cx.state.doc.lineAt(m.from)
  if (!/^\s*>\s*$/.test(line.text.slice(0, m.from - line.from))) return null
  const options: Completion[] = calloutTypes().map((spec) => ({
    label: `[!${spec.type}]`,
    detail: spec.label,
    type: 'keyword',
    apply: applyWith(`[!${spec.type}]`, ']', 'consume')
  }))
  return { from: m.from, options, validFor: /^\[!\w*$/ }
}

// ---------------------------------------------------------------- 脚注

const FOOTNOTE_DEF = /^\[\^([^\]]+)\]:\s*(.*)$/

/** 文档里已有的脚注定义。补全列的是「已经定义过的」—— 现编一个 id 不需要补全帮忙 */
function footnotes(cx: CompletionContext): Completion[] {
  const out: Completion[] = []
  const seen = new Set<string>()
  for (let i = 1; i <= cx.state.doc.lines; i++) {
    const m = FOOTNOTE_DEF.exec(cx.state.doc.line(i).text)
    if (!m || seen.has(m[1]!)) continue
    seen.add(m[1]!)
    out.push({
      label: `[^${m[1]!}]`,
      detail: m[2]!.slice(0, 40),
      type: 'variable',
      apply: applyWith(`[^${m[1]!}]`, ']', 'consume')
    })
  }
  return out
}

const footnoteSource: CompletionSource = (cx) => {
  if (blocked(cx)) return null
  const m = cx.matchBefore(/\[\^[^\]\s]*/)
  if (!m) return null
  // 定义行自己（`[^id]: 正文`）不补全：那儿要的是新 id，不是已有的
  if (FOOTNOTE_DEF.test(cx.state.doc.lineAt(m.from).text)) return null
  const options = footnotes(cx)
  return options.length ? { from: m.from, options, validFor: /^\[\^[^\]\s]*$/ } : null
}

// ---------------------------------------------------------------- 标题锚点

/**
 * `[文字](#` → 本文标题。锚点串走 `headings.ts` 的 `slugs()` ——
 * 和 `[TOC]`、大纲的「复制本节锚点」、导出 HTML 的 id 是同一份算法，
 * 补出来的链接点得动是因为它们本来就是同一个串。
 */
const anchorSource: CompletionSource = (cx) => {
  if (blocked(cx)) return null
  const m = cx.matchBefore(/#[^)\s#]*/)
  if (!m) return null
  if (cx.state.sliceDoc(Math.max(0, m.from - 2), m.from) !== '](') return null
  const items = collectHeadings(cx.state)
  if (!items.length) return null
  const ids = slugs(items)
  const options: Completion[] = items.map((h, i) => ({
    label: `#${ids[i]!}`,
    detail: `H${h.level} ${h.text}`,
    type: 'text',
    // `)` 不属于这次插入 —— 跳过去，光标落在链接外面，接着往下写就行
    apply: applyWith(`#${ids[i]!}`, ')', 'skip')
  }))
  return { from: m.from, options, validFor: /^#[^)\s#]*$/ }
}

// ---------------------------------------------------------------- 围栏语言

/**
 * ` ```ts ` → 语言名。候选就是语言条选择器那一份（`langOptions()`，
 * 只列真的会上色的语言），所以补完一定有颜色，不会补出一个死名字。
 *
 * `label` 用给人看的名字（TypeScript）、真正写进围栏的是 `write`（ts）：
 * 打 `ty` 要能找到 TypeScript，打 `ts` 也要能 —— 前者靠名字、后者靠 CM 的首字母匹配。
 */
const fenceLangSource: CompletionSource = (cx) => {
  if (blocked(cx)) return null
  const m = cx.matchBefore(/^(?:`{3,}|~{3,})[a-zA-Z0-9+#_.-]*/)
  if (!m) return null
  const fence = /^(`{3,}|~{3,})/.exec(m.text)![1]!
  // **起点落在围栏后面**：CM 拿 `from` 到光标这一段当过滤串，连 ``` 一起算的话
  // 打 `ty` 比的是 "```ty" 对 "TypeScript"，一条都匹配不上
  const options: Completion[] = langOptions()
    .filter((o) => o.write !== '')
    .map((o) => ({ label: o.name, detail: o.write, type: 'type', apply: o.write }))
  return {
    from: m.from + fence.length,
    options,
    validFor: /^[a-zA-Z0-9+#_.-]*$/
  }
}

/**
 * 六个源，按注册顺序。导出是为了让 `test/complete.test.ts` 能直接喂
 * `CompletionContext` 断言候选 —— 不导出的话只能去点面板，那就不是单测了。
 *
 * 触发字符两两不同（`:` / `[!` / `[^` / `](#` / 围栏 / 行首 `/`），
 * 所以同一时刻至多有一个源认领，顺序在这儿只是可读性。
 */
export const COMPLETION_SOURCES: CompletionSource[] = [
  emojiSource,
  calloutSource,
  footnoteSource,
  anchorSource,
  fenceLangSource,
  slashSource
]

export function cursiveCompletion(): Extension {
  return autocompletion({
    override: COMPLETION_SOURCES,
    // CM 自带的那一列图标是给**代码**补全用的（函数/类/变量各一个方块），
    // 而这里五个源补的全是同一种东西（一段文字），留着只是每行左边多一个没有信息量的方块。
    // 斜杠命令是例外 —— 它列的是十九种**不同的块**，图标于是有话可说：
    // 走 `addToOptions` 自己画（`slashIcon`），别的源返回 null，那一列压根不出现
    icons: false,
    addToOptions: [{ render: slashIcon, position: 20 }],
    maxRenderedOptions: MAX,
    closeOnBlur: true
  })
}
