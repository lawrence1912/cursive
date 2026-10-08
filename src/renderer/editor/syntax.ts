import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { IterMode, NodeProp, type Tree } from '@lezer/common'

/**
 * 同一个 state 上的结果记在这儿。`ensureSyntaxTree` **不是**「解析过了就空操作」：
 * 它每次都把 ParseContext 的视口改成 [0, upto] 再改回去，而视口一动、只要撞上
 * 被跳过的区间（嵌套语言的代码块就会留下这种区间），CM 就 cutFragments + reset，
 * 下一句 work() 于是真的重新解析一遍。3600 行的文档实测一次 5ms，而
 * `collectHeadings`/`cellTokens` 是**每个标题、每个格子**各调一次的 ——
 * 201 个标题的文档上，这一层缓存把 collectHeadings 从 844ms 压到 2ms。
 *
 * 只记 ensure 成功那一次：state 不可变，解析到 upto 的树就不会再变；
 * ensure 超时（返回 null，只能退回旧快照）的那次不记，免得把半截树钉死。
 */
const treeCache = new WeakMap<EditorState, { upto: number; tree: Tree }>()

/**
 * 取「已经解析到 upto 的语法树」——**ensure 之后必须用它的返回值**。
 *
 * CM6 的坑：`ensureSyntaxTree` 推的是语言字段里那份可变的 ParseContext，而
 * `syntaxTree(state)` 读的是 `LanguageState` 构造时钉下的快照（`field.tree`），
 * 快照要等下一个事务才刷新。于是「ensure 完再 syntaxTree」看着天经地义，拿到的
 * 却还是 ensure 之前那棵半截树 —— 上游的 `forceParsing` 正因为这个，才要在两者
 * 不等时补发一个空事务。
 *
 * 而「半截」有多短是写死的：打开文件那一刻只解析前 3000 字（CM 的
 * `Work.InitViewport`）。一份 5.6KB 的文档里那张 100 行的表格首开只画到第 44 行、
 * 点一下又突然长全导致视口乱跳，就是这么来的（3000 字正好落在第 44 行上）。
 *
 * 预算花光（默认 50ms）时退回快照：有多少画多少，剩下的等后台 parse 推进后，
 * 由 `blockField` 的「树换了就重建」补上。
 */
/**
 * 一棵树**真解析到哪儿** —— 不是 `tree.length`（2026-10-08，第八节 16 的根因）。
 *
 * `cursiveMarkdown()` 外面套着 `yamlFrontmatter`，那是一层 `parseMixed`：外层一棵小语法
 * （`Document → Frontmatter? Body`），整篇 Markdown 挂在 `Body` 上、front matter 里的
 * YAML 挂在 `FrontmatterContent` 上。一次事务的 20ms 预算（CM 的 `Work.Apply`）没解析完
 * 全文时，CM 用 `takeTree()` 把解析停在半路 —— 外层那棵小语法往往早就解析完了，
 * **长度就是全文**，挂在 Body 上的正文却只到停下的地方（停点 Lezer 记在顶层一个没导出的
 * `stoppedInner` 属性上）。实测 911 字的 kitchen-sink：外层 911，正文只到 232。
 * 拿 `tree.length` 当进度，后半篇就整段不见了，而且**看着完好**：导出的 HTML 停在引用块
 * 后面、大纲只剩前三个标题、表格公式不出现 —— 整篇替换（外部重载、探针收尾）一块碎片都
 * 复用不上，机器一忙就撞上。
 *
 * 按挂载点自己的长度算：挂上了，正文就到 `挂载点.from + 内层树长度`；该挂而没挂上
 * （外层解析途中就停了 —— `startInner` 不进停点之后的节点），这一段一个字都没解析。
 * 只走外层那棵小语法（`IgnoreMounts`），几个节点的事；同一棵树记一次。
 * 没套 `parseMixed` 的语言（单测里的 `markdown()`）没有挂载点，就是 `tree.length`。
 */
const NESTED = new Set(['Body', 'FrontmatterContent'])
const extentCache = new WeakMap<Tree, number>()

export function parsedExtent(tree: Tree): number {
  const hit = extentCache.get(tree)
  if (hit !== undefined) return hit
  let end = tree.length
  tree.iterate({
    mode: IterMode.IgnoreMounts,
    enter: (node) => {
      if (node.from >= end) return false
      const mount = node.tree?.prop(NodeProp.mounted)
      if (mount && !mount.overlay) {
        const reach = node.from + mount.tree.length
        if (reach < node.to) end = Math.min(end, reach)
        return false
      }
      if (NESTED.has(node.name)) {
        if (node.to > node.from) end = Math.min(end, node.from)
        return false
      }
      return undefined
    }
  })
  extentCache.set(tree, end)
  return end
}

/**
 * 已经解析出来、且覆盖到 upto 的那棵树 —— **一点解析都不会触发**，没有就是 null。
 * 给「文档一个字没变、只有选区动了」那条路用（`live-preview` 的 `patchBlocks`）：
 * 文档没变，上一个 state 的树位置一一对应，原样就能用；而在那儿重新 ensure 一次，
 * 3600 行的文档上就是 5ms —— 每移动一次光标都付，正是要躲开的那笔。
 */
export function knownTree(state: EditorState, upto = state.doc.length): Tree | null {
  const hit = treeCache.get(state)
  return hit && hit.upto >= upto ? hit.tree : null
}

/**
 * 把一棵**已知覆盖到 upto 的**树记到另一个 state 名下。只有一种正当用法：
 * 文档一个字没改（只有选区/效应变了），上一个 state 的树对新 state 一样成立。
 * 不记的话，增量那条路每走一步就断一次线 —— 新 state 没人给它 ensure 过，
 * 下一次移动光标只能退回全量重建，于是「快一次、慢一次」地来回跳。
 */
export function rememberTree(state: EditorState, tree: Tree, upto: number): void {
  const hit = treeCache.get(state)
  if (!hit || hit.upto < upto) treeCache.set(state, { upto, tree })
}

/**
 * **导出专用：不接受半截树**（0.2.x）。
 *
 * `parsedTree` 的最后一句是「ensure 超预算就退回快照」—— 对屏幕上的消费者这是对的：
 * 有多少画多少，后台 parse 推进到了自然会补上。可**导出这条路只有一次机会**，
 * 少的那一截不是暂时没画出来，而是**交出去的那份文件里没有的内容**，而且没人会发现
 * （产物看着完好，只是短了一半）。真摔过：探针里偶发地只导出文档的前三分之一
 * （kitchen-sink 1005 字的文档，正文停在代码围栏之前）。
 *
 * 默认那 50ms 是给**每一次按键**定的预算；一次导出是一次性动作，给它 5 秒不心疼
 * （`ensureSyntaxTree` 的 timeout 单位是毫秒，同 `code.ts` 那处）。
 * 确保到手之后记进同一份缓存，随后 `renderBody` 里的每一次 `parsedTree` 都直接命中。
 *
 * 仍然可能拿不到全长（真的超大文档 + 真的 5 秒不够）—— 那时返回手上最长的那棵，
 * 与从前一样，但那已经是另一个数量级的问题。
 */
export function primeTree(state: EditorState, timeout = 5000): Tree {
  const want = state.doc.length
  const hit = treeCache.get(state)
  if (hit && hit.upto >= want) return hit.tree
  const tree = ensureSyntaxTree(state, want, timeout) ?? syntaxTree(state)
  rememberTree(state, tree, Math.min(parsedExtent(tree), want))
  return tree
}

export function parsedTree(state: EditorState, upto = state.doc.length): Tree {
  const hit = treeCache.get(state)
  if (hit && hit.upto >= upto) return hit.tree
  /*
   * **快照已经盖住要的这一段就直接用它，不 ensure。**
   *
   * 上面那段说的是「ensure 完别读快照」，这里说的是反过来的一半：**先看快照够不够长**。
   * 够长的时候那一发 ensure 是白付的，而且一点都不便宜 —— `ensureSyntaxTree` 每次都
   * 把 ParseContext 的视口改成 [0, upto] 再改回去，而视口一动、只要撞上被跳过的区间
   * （嵌套语言的代码块就会留下这种区间），CM 就 cutFragments + reset，下一句 work()
   * 于是真的重新解析一遍。代价实测：1 万行、每 20 段掺一个 ```ts 的文档，**每按一个键
   * 12.5ms**；同一份文档把 ```ts 去掉只要 2.2ms —— 差的那 10ms 全是这个 reset。
   * 而每次按键之后快照的覆盖率实测中位数是 **100%**（CM 自己在每个事务里就把改动那一段
   * 重新解析好了），也就是说这 10ms 绝大多数时候买不到任何东西。
   *
   * **为什么快照当得起**：`parsedExtent` 量的是这棵树真解析到哪儿，`>= upto` 意味着
   * 这一段是真解析过的、不是占位。**量的不能是 `tree.length`** —— 这里从前就是这么写的，
   * 而外层那层 `yamlFrontmatter`（parseMixed）停在半路时长度照样是全文，正文只到一半
   * （见 `parsedExtent`）：快照于是被当成整棵收下、记进缓存，导出、大纲、块级装饰
   * 全跟着少了后半篇。至于代码块里嵌套语言的内层树（overlay 挂载）可能还没做 ——
   * 本仓库没有一个 `parsedTree` 的消费者读它：块级装饰、大纲、表格取数、行内文本、
   * 链接引用、导出全都只看**Markdown 的块结构**（导出的代码高亮是自己 `parser.parse(src)`
   * 另起一棵树，编辑器里的则走 CM 自带的高亮器、读的本来就是这份快照）。
   *
   * 不够长（打开文件那一刻只解析前 3000 字）才落到下面真 ensure —— 那正是上面那段
   * 记的坑，`test/block.test.ts`「首开长文档」守着它。
   */
  const snap = syntaxTree(state)
  const reach = parsedExtent(snap)
  if (reach >= upto) {
    treeCache.set(state, { upto: reach, tree: snap })
    return snap
  }
  const tree = ensureSyntaxTree(state, upto)
  if (!tree) return snap
  treeCache.set(state, { upto, tree })
  return tree
}
