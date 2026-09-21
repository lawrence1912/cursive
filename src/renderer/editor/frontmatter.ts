import type { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import { parsedTree } from './syntax'

/**
 * front matter 里的标签 —— 认它、以及把它翻成一条跨文件搜索（0.4.1）。
 *
 * **这里不建索引，也不存任何一张表。** 「哪些文件带这个标签」这件事，工作区搜索
 * （⇧⌘F，壳侧流式扫盘、支持正则）本来就答得了；缺的只是「点一下」这个动作。
 * 于是这一层只做翻译：把一颗标签翻成一条**人能看懂、也能自己接着改**的正则，
 * 塞进那个搜索框里。索引、标签面板、`tag:a AND tag:b` 那一套是笔记库的东西，
 * 与 `[[wikilink]]` + 反向链接同属 ROADMAP 第三节那张「有意不做」的表。
 */

/** 拿到标签之后由谁去搜 —— 编辑器层不认识侧栏，`main.ts` 在启动时接上 */
export const tagHost: { search?: (tag: string, query: string) => void } = {}

/**
 * `pos` 落在 front matter 的某一颗标签上吗？是就回那颗标签的原文。
 *
 * 认的是**语法树**（`Frontmatter > Stream > … > FlowSequence/BlockSequence > Item`）
 * 而不是 `.cm-lp-fm-tag` 这个类：类名是装饰层的实现细节，点击不该绑在它身上
 *（同 `link.ts` 那条 ⌘+点击的口径）。顺带，光标正落在那一行时装饰是撤掉的，
 * 但语法树还在 —— 认树就不必操心此刻是渲染态还是回显态。
 */
export function tagAt(state: EditorState, pos: number): string | null {
  let node: SyntaxNode | null = parsedTree(state).resolveInner(pos, 1)
  let item: SyntaxNode | null = null
  let inFrontmatter = false
  for (; node; node = node.parent) {
    if (node.name === 'Item' && !item) item = node
    if (node.name === 'Frontmatter') inFrontmatter = true
  }
  if (!item || !inFrontmatter) return null
  const seq = item.parent?.name
  if (seq !== 'FlowSequence' && seq !== 'BlockSequence') return null
  const text = state.doc.sliceString(item.from, item.to).trim()
  return text || null
}

/**
 * 一颗标签 → 一条跨文件搜索的正则。
 *
 * 形状是 `(?<=[\[,\s])标签(?=[\],\s]|$)` —— 「前面是 `[`、`,` 或空白，后面是 `]`、`,`、
 * 空白或行尾」。两种 YAML 写法一条式子全覆盖：`tags: [VPS, 运维]` 里逗号空格分隔，
 * 块序列 `  - 运维` 里前面是空格、后面就是行尾。
 *
 * **为什么不用 `\b`**：那是按 `\w` 算的词边界，而中文标签两侧本来就没有 `\w` ——
 * `\b运维\b` 在 `[VPS, 运维]` 上一个都匹配不到。反过来，这条式子对中文正文天然友好：
 * 「运维」夹在中文句子里没有分隔符，不会被当成命中。
 *
 * 它也**不锚在 `tags:` 那一行上**：块序列的标签各自单独一行，锚上去就全漏了。
 * 代价是正文里用空格分开的西文词（「一台 VPS 很快」）会一并搜到 —— 这是一次搜索，
 * 不是一次查询，搜索框里那条式子明明白白摆着，看着不顺手可以当场改。
 */
export function tagQuery(tag: string): string {
  const safe = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return `(?<=[\\[,\\s])${safe}(?=[\\],\\s]|$)`
}

/** ⌘+点击落在标签上：交给 `tagHost` 去搜。回「接住了没有」 */
export function followTag(state: EditorState, pos: number): boolean {
  const tag = tagAt(state, pos)
  if (!tag || !tagHost.search) return false
  tagHost.search(tag, tagQuery(tag))
  return true
}
