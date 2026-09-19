import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { Tree } from '@lezer/common'

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
  rememberTree(state, tree, Math.min(tree.length, want))
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
   * **为什么快照当得起**：`tree.length` 就是这棵树真解析到哪儿（`takeTree()` 把树停在
   * `parsedPos` 上），所以 `>= upto` 意味着这一段是真解析过的、不是占位。至于嵌套语言
   * 的内层挂载可能还没做 —— 本仓库没有一个 `parsedTree` 的消费者读它：块级装饰、大纲、
   * 表格取数、行内文本、链接引用、导出全都只看**外层块结构**（导出的代码高亮是自己
   * `parser.parse(src)` 另起一棵树，编辑器里的则走 CM 自带的高亮器、读的本来就是这份快照）。
   *
   * 不够长（打开文件那一刻只解析前 3000 字）才落到下面真 ensure —— 那正是上面那段
   * 记的坑，`test/block.test.ts`「首开长文档」守着它。
   */
  const snap = syntaxTree(state)
  if (snap.length >= upto) {
    treeCache.set(state, { upto: snap.length, tree: snap })
    return snap
  }
  const tree = ensureSyntaxTree(state, upto)
  if (!tree) return syntaxTree(state)
  treeCache.set(state, { upto, tree })
  return tree
}
