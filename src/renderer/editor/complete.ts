import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource
} from '@codemirror/autocomplete'
import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { basename, relativeLink } from '../../shared/path'
import { calloutTypes } from './callout'
import { docDir } from './doc-dir'
import { LATEX_COMMANDS, latexCaret, latexInsert } from './latex'
import { parsedTree } from './syntax'
import { EMOJI } from './emoji'
import { collectHeadings, slugs } from './headings'
import { langOptions } from './live-preview/code'
import { FOOTNOTE_DEF } from './markdown-lang'
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

/**
 * 文档里已有的脚注定义。补全列的是「已经定义过的」—— 现编一个 id 不需要补全帮忙。
 * 定义的形状走 `markdown-lang.ts` 那份 `FOOTNOTE_DEF`：这里本来自带一份
 * `[^\]]+`（标签里允许空格），比解析器松，列出来的 `[^a b]` 插进正文既没定义可跳、
 * 也换不出角标 —— 补全只该列解析器认的东西。
 */
function footnotes(cx: CompletionContext): Completion[] {
  const out: Completion[] = []
  const seen = new Set<string>()
  for (let i = 1; i <= cx.state.doc.lines; i++) {
    const text = cx.state.doc.line(i).text
    const m = FOOTNOTE_DEF.exec(text)
    if (!m || seen.has(m[1]!)) continue
    seen.add(m[1]!)
    out.push({
      label: `[^${m[1]!}]`,
      detail: text.slice(m[0].length, m[0].length + 40),
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

// ---------------------------------------------------------------- 链接目的地（0.4.0 F3）

/** 目的地里有空格就写成 `<…>` —— 与拖图 / 粘贴截图插进来的那条路同一个形状 */
function linkDest(rel: string): string {
  return /\s/.test(rel) ? `<${rel}>` : rel
}

/**
 * `](` → **工作区里的文件名**（0.4.0 F3 的第六个源）。
 *
 * 「⌘+点击本地 `.md` 开标签」0.2.0 就在那儿了，而「链接得先写对才点得动」这条路上
 * **写的那一半一直没人管** —— 靠人自己记住文件名怎么拼，而中文笔记的文件名十个有九个
 * 带空格（当初放宽 `SpacedLink` 是为了**读**，没帮上写）。
 *
 * 索引与快速打开共用（契约 v21 的 `listFiles`），**不新增任何一张表、任何一条通道**；
 * 也不缓存 —— 同 ⌘T 那条的理由：缓存要跟着新建/改名/拖动/删除/外部变更一起失效，
 * 换来的只是省掉几十毫秒。`validFor` 让这一趟每次触发只走一次，之后是 CM 在本地过滤。
 */
const linkFileSource: CompletionSource = (cx) => {
  if (blocked(cx)) return null
  const m = cx.matchBefore(/\]\([^)\s]*/)
  if (!m) return null
  const typed = m.text.slice(2)
  if (typed.startsWith('#')) return null // 本文锚点归 anchorSource
  if (/^[a-z][a-z0-9+.-]*:/i.test(typed)) return null // 已经在写 http: / mailto:
  // **不认领的那几条都要同步回 null**：写成 async 的话，「不该弹」也会回一个
  // Promise，而调用方（与 test/complete.test.ts）分不清「不弹」和「等着」
  return linkFiles(cx, m.from)
}

async function linkFiles(cx: CompletionContext, at: number): Promise<CompletionResult | null> {
  const root = await window.api.workspaceRoot()
  if (!root) return null
  const files = await window.api.listFiles(root)
  const dir = cx.state.facet(docDir) ?? root
  if (!files.length) return null
  // **不把当前文档排掉**：state 上只有目录（`docDir`），没有自己的路径 ——
  // 为了少列一条候选去给七处 `createState` 加一个 facet 不划算，而「链到自己」
  // 顶多是一条没用的候选，不是错
  const options: Completion[] = files.map((p) => {
    const rel = relativeLink(dir, p)
    return {
      label: rel,
      detail: basename(p),
      type: 'text',
      // 同一个目录里的排前面：写链接时十有八九指的是手边这几份
      boost: rel.includes('/') ? 0 : 1,
      apply: applyWith(linkDest(rel), ')', 'skip')
    }
  })
  return { from: at + 2, options, validFor: /^[^)\s]*$/ }
}

// ---------------------------------------------------------------- 公式命令（0.4.0 F3）

/** 光标是不是落在公式里。`$` 不是命令、`\` 才是 —— 但只在公式节点里认 */
function inMath(cx: CompletionContext): boolean {
  // **`parsedTree` 而不是 `syntaxTree`**：刚打出来的 `$x + \al` 那一行，
  // `syntaxTree` 的快照多半还没跟上（CM 的 parse 是异步分块的），
  // 于是「光标在不在公式里」当场答错 —— 表现是「公式里打反斜杠不弹」
  for (
    let n: SyntaxNode | null = parsedTree(cx.state).resolveInner(cx.pos, -1);
    n;
    n = n.parent
  ) {
    if (n.name === 'InlineMath' || n.name === 'DisplayMath') return true
  }
  return false
}

/**
 * `\alpha` → 公式命令（0.4.0 F3 的第七个源）。
 *
 * **只在公式节点里触发**：正文里的 `\` 多半是转义（`\*`、`\_`），弹一张希腊字母表
 * 纯属打扰。候选表在 `editor/latex.ts`（KaTeX 不对外暴露它自己那张，理由写在那儿），
 * 而这里**一个 katex 实例都不碰** —— 补全不该把 261 KB 拽回主 chunk。
 */
const latexSource: CompletionSource = (cx) => {
  if (blocked(cx)) return null
  const m = cx.matchBefore(/\\[a-zA-Z]*/)
  if (!m || !inMath(cx)) return null
  const options: Completion[] = LATEX_COMMANDS.map((c) => ({
    label: c.cmd,
    detail: c.hint,
    type: 'text',
    // 带占位大括号的（`\frac{}{}`）插完把光标放进第一对里 —— 不然还得自己按两下左键
    apply: (view: EditorView, _c: Completion, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: latexInsert(c) },
        selection: { anchor: from + latexCaret(c) },
        userEvent: 'input.complete'
      })
    }
  }))
  return { from: m.from, options, validFor: /^\\[a-zA-Z]*$/ }
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
  linkFileSource,
  latexSource,
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
