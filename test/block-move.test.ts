import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { moveBlock } from '../src/renderer/editor/block-move'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'

/**
 * ⌥↑/⌥↓ 搬块（0.2.x）。
 *
 * 夹具里用 `‸` 标光标（**不能用 `|`** —— 表格那几条里满是竖线），断言直接看搬完的
 * 整份文档：这条路上真正会错的是「哪几行算一块」和「空行留在哪儿」，
 * 只断言几个偏移量看不出来。光标也标在结果里，好一眼看出它跟没跟着那一块走。
 */
const CARET = '‸'

function stateOf(marked: string, ranges?: number[]): EditorState {
  const at = marked.indexOf(CARET)
  const doc = marked.replace(CARET, '')
  const state = EditorState.create({
    doc,
    selection: ranges
      ? EditorSelection.create(ranges.map((n) => EditorSelection.cursor(n)))
      : EditorSelection.cursor(at < 0 ? 0 : at),
    // 多光标那条不加这个 facet 的话，CM 会把选区收成一个 —— 测的东西当场消失
    extensions: [cursiveMarkdown(), EditorState.allowMultipleSelections.of(true)]
  })
  ensureSyntaxTree(state, doc.length, 5000)
  return state
}

/** 搬一次，回「搬完的文档 + 光标位置」；返回 null = 这条路让开（回退到按行搬） */
function move(marked: string, dir: 1 | -1): string | null {
  const state = stateOf(marked)
  const spec = moveBlock(state, dir)
  if (!spec) return null
  const next = state.update(spec).state
  const text = next.doc.toString()
  const at = next.selection.main.head
  return text.slice(0, at) + CARET + text.slice(at)
}

describe('搬的是块，不是行', () => {
  it('多行段落整段走，中间那个空行留在原地', () => {
    expect(move('第一段\n\n第二段甲\n第二段‸乙\n', -1)).toBe('第二段甲\n第二段‸乙\n\n第一段\n')
  })

  it('围栏代码块整块走 —— 按行搬会把 ``` 和代码拆开，图/高亮当场碎掉', () => {
    expect(move('前面\n\n```ts\nconst a = ‸1\n```\n\n后面\n', -1)).toBe(
      '```ts\nconst a = ‸1\n```\n\n前面\n\n后面\n'
    )
  })

  it('表格整张走（分隔行被单独挪走的话，表就不是表了）', () => {
    expect(move('| a | b |\n|---|---|\n| 1 | 2 |\n\n后面这‸段\n', -1)).toBe(
      '后面这‸段\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'
    )
  })

  it('光标停在表格中间时，搬的也是整张表', () => {
    expect(move('前面\n\n| a | b |\n|---|---|\n| 1 ‸| 2 |\n', -1)).toBe(
      '| a | b |\n|---|---|\n| 1 ‸| 2 |\n\n前面\n'
    )
  })

  it('告示块 / 引用整块走', () => {
    expect(move('一段\n\n> [!note]\n> 告‸示\n', -1)).toBe('> [!note]\n> 告‸示\n\n一段\n')
  })

  it('标题只是普通一块：与下一块换位', () => {
    expect(move('# 标‸题\n\n正文\n', 1)).toBe('正文\n\n# 标‸题\n')
  })

  it('光标停在行尾、行首都算数（`resolveInner` 在边界上只朝一个方向看）', () => {
    expect(move('# 甲\n\n# 乙‸\n', -1)).toBe('# 乙‸\n\n# 甲\n')
    expect(move('# 甲\n\n‸# 乙\n', -1)).toBe('‸# 乙\n\n# 甲\n')
  })
})

describe('列表：搬的是同级的那一项', () => {
  it('同级换位，子项跟着走', () => {
    expect(move('- 甲\n  - 甲一\n- 乙‸\n', -1)).toBe('- 乙‸\n- 甲\n  - 甲一\n')
  })

  it('嵌套项在自己那一层里换，不动外层', () => {
    expect(move('- 甲\n  - 甲一\n  - 甲‸二\n- 乙\n', -1)).toBe('- 甲\n  - 甲‸二\n  - 甲一\n- 乙\n')
  })

  it('有序列表换完要重编号 —— 编号留在原地，不跟着文字走', () => {
    expect(move('1. 一\n2. 二‸\n3. 三\n', -1)).toBe('1. 二‸\n2. 一\n3. 三\n')
    expect(move('1. 一‸\n2. 二\n3. 三\n', 1)).toBe('1. 二\n2. 一‸\n3. 三\n')
  })

  it('从 3 开始这种写法不被悄悄改掉（只换这两项的号）', () => {
    expect(move('3. 三\n4. 四‸\n5. 五\n', -1)).toBe('3. 四‸\n4. 三\n5. 五\n')
  })

  it('`1)` 这种分隔符照原样保留', () => {
    expect(move('1) 一\n2) 二‸\n', -1)).toBe('1) 二‸\n2) 一\n')
  })

  it('无序列表不碰标记', () => {
    expect(move('* 甲\n* 乙‸\n', -1)).toBe('* 乙‸\n* 甲\n')
  })
})

describe('边界', () => {
  it('到头了就原地不动，而不是把这一块的第一行抽出去', () => {
    const state = stateOf('# 标‸题\n\n正文\n')
    const spec = moveBlock(state, -1)
    expect(spec).not.toBeNull()
    expect(spec!.changes).toBeUndefined()
    expect(state.update(spec!).state.doc.toString()).toBe('# 标题\n\n正文\n')
  })

  it('front matter 不参与：它只在最顶上才成立', () => {
    // 正文往上搬，上面只有 front matter —— 原地不动
    expect(moveBlock(stateOf('---\ntitle: x\n---\n\n正‸文\n'), -1)!.changes).toBeUndefined()
    // 光标落在 front matter 里时整条路让开（回退到按行搬）
    expect(moveBlock(stateOf('---\ntit‸le: x\n---\n\n正文\n'), 1)).toBeNull()
  })

  it('多光标让开 —— 两个光标在不同块里时，「搬哪一块」没有说得通的答案', () => {
    expect(moveBlock(stateOf('一段\n\n二段\n', [1, 6]), -1)).toBeNull()
  })

  it('选区跨出块外也让开', () => {
    const doc = '一段\n\n二段\n'
    const state = EditorState.create({
      doc,
      selection: EditorSelection.single(0, doc.length),
      extensions: [cursiveMarkdown()]
    })
    ensureSyntaxTree(state, doc.length, 5000)
    expect(moveBlock(state, -1)).toBeNull()
  })

  it('光标停在两块之间的空行上：没有哪一块是它的，让开', () => {
    expect(moveBlock(stateOf('一段\n‸\n二段\n'), -1)).toBeNull()
  })

  it('紧挨着没有空行的两块，搬完还是紧挨着', () => {
    expect(move('# 甲\n# 乙‸\n', -1)).toBe('# 乙‸\n# 甲\n')
  })

  it('文末没有换行符也不掉字符', () => {
    expect(move('一段\n\n二‸段', -1)).toBe('二‸段\n\n一段')
  })
})
