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
  // **引号是 YAML 的语法，不是标签的一部分**（0.4.1 修）：`"运维"`、`'运维'`、`运维`
  // 是同一颗标签，而 YAML 里这三种写法混着用是常态（带空格或冒号的标签必须加引号）。
  // 连着引号去搜的话它们互相都找不到 —— 搜 `"foo"` 既搜不到 `foo`，也搜不到块序列
  // 里的 `- foo`。认的是树上那个 `QuotedLiteral`，**不是「首尾看着像引号」**：
  // 撇号在标签正文里也可能是内容的一部分（`don't`）
  const value = item.firstChild?.name === 'QuotedLiteral' ? unquote(text) : text
  return value || null
}

/**
 * YAML 的引号标量 → 它的值。
 *
 * 双引号那种与 JSON 的字符串语法几乎一模一样（`\"` `\\` `\uXXXX`），所以直接交给
 * `JSON.parse`；它认不出来的（YAML 独有的 `\x41` 这类）就退回「去掉两端引号的原文」
 * —— 宁可搜得糙一点，也不能在点一颗标签时抛出去。
 * 单引号那种只有一条转义规则：两个连着的 `''` 表示一个 `'`。
 */
function unquote(text: string): string {
  const q = text[0]
  if (q !== '"' && q !== "'") return text
  // 没收尾的引号（人正打到一半）：只去头，别把最后一个真字符当成引号切掉
  const body = text.length > 1 && text.endsWith(q) ? text.slice(1, -1) : text.slice(1)
  if (q === '"') {
    try {
      return JSON.parse(text) as string
    } catch {
      return body
    }
  }
  return body.replace(/''/g, "'")
}

/**
 * 一颗标签 → 一条跨文件搜索的正则。
 *
 * 形状是 `(?<=[\[,\s])(?:裸|'单引号'|"双引号")(?=[\],\s]|$)` —— 「前面是 `[`、`,`
 * 或空白，后面是 `]`、`,`、空白或行尾」，中间是**同一个值的三种 YAML 写法**。
 *
 * **为什么是三条而不是「两边各放一个可选引号」**：`tagAt` 交过来的是**解过码的值**
 * （`'don''t'` → `don't`、`"a\"b"` → `a"b`），而搜的是**别的文件里的原文** ——
 * 拿解码后的值去配原文，一遇到转义就对不上。所以这里反过来**再编码回去**：
 * 单引号那种把 `'` 写成 `''`，双引号那种把 `\` 与 `"` 各加一道反斜杠，然后三条并起来。
 * 顺带比可选引号那版精确：`"运维` 这种引号没配对的不再算命中。
 *
 * **覆盖到哪儿为止，是一个有意画下的界**：`"\u8fd0\u7ef4"`（整串写成 Unicode 转义）
 * 解出来同样是「运维」，但这条式子匹配不到那份**原文**。要覆盖它得把每个字都拆成
 * 「字本身 | `\uXXXX`」的分支（十六进制还得大小写都认），于是一颗两字标签的式子长成
 * `"(?:运|\\u8[fF][dD]0)(?:维|\\u7[eE][fF]f)"` —— 而这条式子是**要摆进搜索框给人看、
 * 给人接着改的**（README 里写着，也是「不建索引」那条口径的另一半）。为了一种几乎只有
 * 生成器才会写出来的写法，把所有人每次看见的式子变成这样，不划算。换行、制表符那类
 * 只能靠转义表达的标签同理 —— 而且跨文件搜索本来就是按行走的。
 * `test/frontmatter.test.ts` 里有一条把这个界钉着，免得日后被当成 bug 顺手改掉。
 *
 * 三种写法**都得认**，因为它们在别的文件里随时会出现：标签带空格或冒号时 YAML 就
 * 要求加引号，而点中的这一颗自己带不带引号是另一回事。
 *
 * **为什么不用 `\b`**：壳侧跑的是 ICU（`NSRegularExpression`），那里的 `\w` 把汉字
 * 算作词字符，所以 `\b` 对中文标签不像在 JS 里那样完全失效 —— 但它**认不得引号**，
 * 而这条式子的活儿正是「认出 YAML 的分隔符」。再说也不能只按 `\w` 走：`c++`、`C#`
 * 这类以非词字符收尾的标签，尾巴上那个 `\b` 一条都匹配不到（整词开关因此对标签
 * 搜索是明确关掉的）。
 *
 * 它也**不锚在 `tags:` 那一行上**：块序列的标签各自单独一行，锚上去就全漏了。
 * 代价是正文里用空格分开的西文词（「一台 VPS 很快」）会一并搜到 —— 这是一次搜索，
 * 不是一次查询，搜索框里那条式子明明白白摆着，看着不顺手可以当场改。
 */
export function tagQuery(tag: string): string {
  const esc = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const forms = [
    esc(tag),
    `'${esc(tag.replace(/'/g, "''"))}'`,
    `"${esc(tag.replace(/\\/g, '\\\\').replace(/"/g, '\\"'))}"`
  ]
  return `(?<=[\\[,\\s])(?:${forms.join('|')})(?=[\\],\\s]|$)`
}

/** ⌘+点击落在标签上：交给 `tagHost` 去搜。回「接住了没有」 */
export function followTag(state: EditorState, pos: number): boolean {
  const tag = tagAt(state, pos)
  if (!tag || !tagHost.search) return false
  tagHost.search(tag, tagQuery(tag))
  return true
}
