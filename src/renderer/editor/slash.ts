import type { Completion, CompletionSource } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import {
  ChangeSet,
  EditorSelection,
  type EditorState,
  type TransactionSpec
} from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { MenuAction } from '../../shared/types'
import { t, type Key } from '../i18n'
import { splitLabel } from '../ui/commands'
import { fuzzy } from '../ui/fuzzy'
import { icon, type IconName } from '../ui/icons'
import { formatActionOf, makeFormatSpec, type FormatSpec } from './fmt'

/**
 * 斜杠命令（`/callout`、`/table`、`/h2`…），照 Notion 那套输入方式。
 *
 * **一条斜杠命令只是一个 `fmt:*` MenuAction**，落地走的是 `fmt.ts` 那台引擎 ——
 * 与原生「格式」菜单、底部格式栏、快捷键、命令面板同一条路。于是幂等、多光标、
 * 一次 ⌘Z 撤回全都白拿，而「菜单能插的块斜杠插不了」这种漂移不可能发生。
 * 这里只回答三个它们不回答的问题：**什么时候弹**、**列哪些**、**光标落在哪**。
 *
 * 面板本身不自己造：复用 `complete.ts` 挂着的那套 `autocompletion()` ——
 * 上下选、回车插、Esc 关、滚动跟随、定位、组字期间不抢键，一件都不用重写，
 * 而且长相与 emoji / 告示块那几个源完全一致（浮层就该长一个样）。
 *
 * ## 什么时候弹：**斜杠前面只允许缩进**
 *
 * Notion 里 `/` 在块内任何位置都弹，这儿不行 —— 这是个 Markdown 编辑器，
 * `2026/09/16`、`src/renderer`、`and/or`、`http://` 全是正文里的常客，
 * 见一个斜杠弹一次面板，写路径会变成一件需要躲闪的事。
 *
 * 行首（含缩进）这条线还顺手把**落点**这件事也定死了：斜杠命令插的全是块级构件，
 * 而块级构件本来就只能从一行的开头长出来。列表项 `- /` 与引用行 `> /` 同样不认 ——
 * 在 `- ` 后面插一张表，结果是表格上面孤零零留着一个空的项目符号，
 * 而 Markdown 里「列表里的表格」本来就没有标准写法：**不弹比弹出来插错强**。
 *
 * 代码块 / 公式 / front matter 里一律不弹（`OPAQUE`）：那里面的 `/` 是内容。
 */

interface SlashItem {
  action: MenuAction
  /** 关键词（不带斜杠）。面板右边那一列显示成 `/table`，也是主要的匹配串 */
  key: string
  /**
   * 行首那颗图标。**与格式栏那份是同一个名字**（插入下拉的 `INSERT_META`、
   * 条子上的 `BLOCK`）—— 同一条命令在两处菜单里长同一个样，
   * 漂移由 `test/slash.test.ts` 的对账断言守着。只有标题六级是这里新画的（`ui/icons.ts`）
   */
  ic: IconName
  /**
   * 显示名走格式栏那份 `fb.*` —— 同一件事在原生菜单、格式栏、命令面板、
   * 这里必须是同一个名字，各写一份迟早有一处改了别处没改
   */
  labelKey: Key
  /** `fb.h` 的级数占位符 */
  args?: Record<string, number>
  /**
   * 显示名里没有的那些叫法，一并参与匹配。
   * **不进字典**：它们是关键词不是文案（同命令面板里快捷键那一列的道理），
   * 而且中英两种叫法同时留着才对 —— 界面语言是英文的人照样可能打 `/待办`
   */
  alias?: string
}

/**
 * 表序 = 只打了一个 `/` 时面板里的顺序（那一刻它是一份「菜单」而不是搜索结果）。
 * 按「一天里会用到几次」排，不按 `fmt.ts` 的定义顺序：标题和列表一天几十次，
 * 目录和脚注一篇一次。H4–H6 押到最后 —— 它们存在，但不该占着第一屏。
 *
 * 只收**块级**命令。粗体 / 斜体 / 行内代码这些开关不在这儿：斜杠触发点在行首，
 * 那儿还没有可套的文字，`/bold` 只会插出一对空的 `**`，而它们各自都有快捷键。
 */
const SLASH_ITEMS: SlashItem[] = [
  { action: 'fmt:h1', ic: 'h1', key: 'h1', labelKey: 'fb.h', args: { n: 1 }, alias: 'heading title 标题' },
  { action: 'fmt:h2', ic: 'h2', key: 'h2', labelKey: 'fb.h', args: { n: 2 }, alias: 'heading title 标题' },
  { action: 'fmt:h3', ic: 'h3', key: 'h3', labelKey: 'fb.h', args: { n: 3 }, alias: 'heading title 标题' },
  { action: 'fmt:ulist', ic: 'ulist', key: 'list', labelKey: 'fb.ulist', alias: 'bullet ul 列表' },
  { action: 'fmt:olist', ic: 'olist', key: 'number', labelKey: 'fb.olist', alias: 'ordered ol 列表 编号' },
  { action: 'fmt:task', ic: 'task', key: 'todo', labelKey: 'fb.task', alias: 'task checkbox 待办 清单' },
  { action: 'fmt:quote', ic: 'quote', key: 'quote', labelKey: 'fb.quote', alias: 'blockquote 引文' },
  { action: 'fmt:code-block', ic: 'code-block', key: 'code', labelKey: 'fb.codeBlock', alias: 'fence pre 代码' },
  { action: 'fmt:table', ic: 'table', key: 'table', labelKey: 'fb.table', alias: 'grid 表' },
  { action: 'fmt:hr', ic: 'hr', key: 'divider', labelKey: 'fb.hr', alias: 'hr rule line 横线' },
  { action: 'fmt:callout', ic: 'info', key: 'callout', labelKey: 'fb.callout', alias: 'admonition note 提示 告示' },
  { action: 'fmt:math-block', ic: 'sigma-box', key: 'math', labelKey: 'fb.mathBlock', alias: 'latex katex tex 数学' },
  { action: 'fmt:mermaid', ic: 'flow', key: 'mermaid', labelKey: 'fb.mermaid', alias: 'diagram chart graph 图表' },
  { action: 'fmt:image', ic: 'image', key: 'image', labelKey: 'fb.image', alias: 'img picture photo 图片' },
  { action: 'fmt:footnote', ic: 'footnote', key: 'footnote', labelKey: 'fb.footnote', alias: 'ref 注释' },
  { action: 'fmt:toc', ic: 'list', key: 'toc', labelKey: 'fb.toc', alias: 'outline contents 目录' },
  { action: 'fmt:h4', ic: 'h4', key: 'h4', labelKey: 'fb.h', args: { n: 4 }, alias: 'heading title 标题' },
  { action: 'fmt:h5', ic: 'h5', key: 'h5', labelKey: 'fb.h', args: { n: 5 }, alias: 'heading title 标题' },
  { action: 'fmt:h6', ic: 'h6', key: 'h6', labelKey: 'fb.h', args: { n: 6 }, alias: 'heading title 标题' }
]

/** 导出给单测对账（每条都得是 `fmt.ts` 认得的块级命令） */
export const SLASH_TABLE: readonly SlashItem[] = SLASH_ITEMS

/**
 * `/` 之后收的字符：字母、数字、汉字。
 * **空格一进来这次匹配就断了**，面板当场关掉 —— 与 Notion 一致，
 * 也是「我只是想写个斜杠」时最顺手的退出方式（另一条是 Esc）。
 */
const TOKEN = /\/[\p{L}\p{N}]*/u

/** 斜杠前面只允许缩进（见文件头） */
const INDENT_ONLY = /^[ \t]*$/

/**
 * 落在这些节点里就不弹。两类，理由不同：
 *
 * - **代码 / 公式 / front matter**：那里面的 `/` 是内容。`CodeBlock` 顺带管住了
 *   缩进代码块 —— 四个空格或一个 Tab 起头的行在 CommonMark 里就是代码，
 *   而 `INDENT_ONLY` 只看得见「前面是空白」，看不出这行已经不是正文了。
 * - **列表项 / 引用块**：`- /` 与 `> /` 前面的标记已经被 `INDENT_ONLY` 挡掉了，
 *   这里挡的是**续行** —— `- 项目` 下面缩进两格的那一行、以及引用块的懒续行，
 *   它们前面确实只有空白，但人在写的是同一个块。在那儿插一张表，
 *   表会从列表/引用里掉出来，而原来那个块还剩个空壳。
 *
 * 节点名是实测出来的（front matter 里是 `Frontmatter` 而不是 `FrontmatterContent`：
 * 里面那截由 YAML 解析器接管，链上先是它自己的 `Document`/`Stream`）。
 */
const OPAQUE = new Set([
  'FencedCode',
  'CodeBlock',
  'CodeText',
  'InlineCode',
  'DisplayMath',
  'InlineMath',
  'Frontmatter',
  'ListItem',
  'Blockquote'
])

function opaque(state: EditorState, pos: number): boolean {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (OPAQUE.has(n.name)) return true
  }
  return false
}

/**
 * 一次插入 = **一个事务**：先删掉 `/关键词`，再把格式命令那份改动接在后面
 * （`ChangeSet.compose`）。分两次 dispatch 的话 ⌘Z 要按两下 ——
 * 第一下撤掉刚插进来的块，第二下才把 `/table` 这几个字还回来，中间那一态谁都不想要。
 *
 * 导出给单测：这是本文件里唯一会改文档的一段，而它不依赖视图。
 */
export function slashSpec(
  state: EditorState,
  action: MenuAction,
  from: number,
  to: number
): TransactionSpec {
  const line = state.doc.lineAt(from)
  // **连缩进一起吃掉**（`from` 到行首那一段按触发规则只可能是空白）：
  // 留着的话 `fmt.ts` 会把标记插在缩进**前面** —— `  /h1` 变成 `#   `，
  // 两个空格从行首挪到了 `#` 后面。而块级骨架也要求落在一行干净的空行上。
  const start = line.from
  // 选区必须**显式**摆到删除点上：`makeFormatSpec` 读的是 `state.selection`，
  // 而这里的入参是 `from`/`to`，两者只在「调用方恰好把光标放在那儿」时才一致 ——
  // 靠那个巧合的话，同一个函数在单测里插出来的位置和编辑器里不是同一个地方
  const cut = state.update({
    changes: { from: start, to },
    selection: EditorSelection.cursor(start)
  })
  const fmt = makeFormatSpec(cut.state, action)
  const changes = cut.changes.compose(ChangeSet.of(fmt.changes, cut.state.doc.length))
  return {
    changes,
    selection: caret(state, changes, line.number, action, fmt),
    effects: fmt.effects,
    userEvent: 'input.complete'
  }
}

/**
 * 光标落在哪。
 *
 * **插入类照用骨架自己定的落点** —— 表头第一格、公式块中间那一空行、图片 url 的括号里，
 * 那是 `fmt.ts` 里 `skeletonOf` 一处定义的东西，这里没有理由另说一套。
 *
 * **行级类（标题 / 引用 / 列表 / 任务 / 代码块）必须自己算**：`makeFormatSpec` 给的落点是
 * 「把原选区映射过去」，而斜杠命令的原选区恰好压在**行首**，`# ` 又正是插在行首 ——
 * 映射出来的光标会停在 `#` 前面，接着打字打出来的是 `文字# `。
 *
 * 算法是**按行号数**，不是把位置映射过去：这几个命令都不会在原行之前多塞行，
 * 唯一的例外是代码块 —— 开围栏另起一行插在前面，原来那一行于是顺延成第 n+1 行
 * （也正是围栏中间那一空行）。而映射这条路在这里走不通：删掉 `/code` 再在同一点
 * 插入开闭两道围栏，composed 之后那是一次**替换**，`mapPos` 在替换的起点上
 * 不看 assoc，一律落回替换点 —— 光标会停在开围栏前面。
 */
function caret(
  state: EditorState,
  changes: ChangeSet,
  lineNo: number,
  action: MenuAction,
  fmt: FormatSpec
): EditorSelection {
  const op = formatActionOf(action)
  if (op?.kind === 'insert') return fmt.selection
  const doc = changes.apply(state.doc)
  const at = Math.min(lineNo + (op?.kind === 'fence' ? 1 : 0), doc.lines)
  return EditorSelection.single(doc.line(at).to)
}

/**
 * 带图标的候选。`Completion` 上没有「图标」这一项（CM 自己那套 `type` 走的是
 * 预置的代码补全图标，`icons: false` 已经关掉了），所以自己挂一个字段 ——
 * 别的补全源不带它，渲染器读不到就什么都不画。
 */
interface SlashCompletion extends Completion {
  ic: IconName
}

/**
 * 行首那颗图标。挂进 `autocompletion({ addToOptions })`，位置 20（CM 的标签是 50、
 * 右列是 80，所以 20 就是最左边那一格）。
 *
 * **返回 null 就什么都不加** —— emoji / 告示块 / 脚注 / 锚点 / 围栏语言那五个源
 * 没有图标，它们的行照旧是「文字 + 右列」，不会平白多出一列空白。
 */
export function slashIcon(completion: Completion): HTMLElement | null {
  const name = (completion as Partial<SlashCompletion>).ic
  if (!name) return null
  const el = document.createElement('span')
  el.className = 'cm-slash-ic'
  el.innerHTML = icon(name)
  return el
}

/**
 * 候选。**每次查询现算** —— 显示名要跟着界面语言走，缓存一份的话切完语言
 * 面板里还是旧文字（`langOptions()` / `commandItems()` 都踩过同一个坑）。
 */
function rank(query: string): Completion[] {
  const hits: { score: number; option: Completion }[] = []
  for (const item of SLASH_ITEMS) {
    const label = splitLabel(t(item.labelKey, item.args)).label
    const hit = fuzzy(query, `${item.key} ${label}${item.alias ? ` ${item.alias}` : ''}`)
    if (!hit) continue
    const option: SlashCompletion = {
      label,
      // 右边那一列（`.cm-completionDetail`，压淡右对齐）摆关键词 ——
      // 与命令面板拿这一列摆快捷键是同一个位置、同一个意思：**斜杠词就是这条命令的快捷键**
      detail: `/${item.key}`,
      ic: item.ic,
      apply: applyOf(item.action)
    }
    hits.push({ score: hit.score, option })
  }
  // 只打了一个 `/` 时保持表序：那一刻每条的得分都一样，按分排只会让顺序看起来随机
  if (query) hits.sort((a, b) => b.score - a.score)
  return hits.map((h) => h.option)
}

/**
 * 命中的字加粗。查的是**显示名**，所以 `/cal` 匹配到的是关键词那一段、
 * 「告示块」三个字上一个粗体都没有 —— 这与命令面板一致（那边 `key` 是
 * 「名字 + 快捷键」，落在名字之外的下标一律丢掉）：**加粗只用来解释「为什么这条排在这儿」，
 * 解释不了就什么都不画**，而不是去粗一个对不上的字。
 *
 * CM 要的是成对的 `[起, 止]`，相邻的并成一段（省掉一串只有一个字的 `<span>`）。
 */
function marks(query: string, label: string): number[] {
  const hit = query ? fuzzy(query, label) : null
  if (!hit) return []
  const out: number[] = []
  for (const p of hit.positions) {
    if (out.length && out[out.length - 1] === p) out[out.length - 1] = p + 1
    else out.push(p, p + 1)
  }
  return out
}

function applyOf(action: MenuAction) {
  return (view: EditorView, _completion: Completion, from: number, to: number): void => {
    view.dispatch(slashSpec(view.state, action, from, to))
  }
}

export const slashSource: CompletionSource = (cx) => {
  // 组字期间一律不弹（红线二）。`/` 是 ASCII，但中文连打时选字框和补全面板会叠在一起抢方向键
  if (cx.view?.compositionStarted === true) return null
  const m = cx.matchBefore(TOKEN)
  if (!m) return null
  const line = cx.state.doc.lineAt(m.from)
  if (!INDENT_ONLY.test(line.text.slice(0, m.from - line.from))) return null
  if (opaque(cx.state, cx.pos)) return null
  const query = m.text.slice(1)
  const options = rank(query)
  // 一条都不剩就**收摊**（`/usr` 打到第二个字母时就是这样），而不是留一个空面板杵在那儿
  if (!options.length) return null
  return {
    from: m.from,
    options,
    // 筛选与排序自己来（`rank`）：CM 那套只比 `label`，
    // 而这里要让 `/cal` 和 `/告示` 都能找到「告示块」—— 关键词、显示名、别名是三个串。
    // 用的是命令面板 / 快速打开那同一个打分器（`ui/fuzzy.ts`），
    // 同一条查询在三处的行为因此一致
    filter: false,
    getMatch: (c) => marks(query, c.label)
  }
}
