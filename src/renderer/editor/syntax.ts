import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { Tree } from '@lezer/common'

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
export function parsedTree(state: EditorState, upto = state.doc.length): Tree {
  return ensureSyntaxTree(state, upto) ?? syntaxTree(state)
}
