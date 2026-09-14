import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { focusRange } from '../src/renderer/editor/writing-modes'

/** 取 [from,to) 的文本，方便直接断言「亮的是哪一段」 */
function focused(doc: string, anchor: number, head = anchor): string {
  const state = EditorState.create({ doc, selection: { anchor, head } })
  const r = focusRange(state)
  return doc.slice(r.from, r.to)
}

const DOC = ['第一段第一行', '第一段第二行', '', '第二段', '', '第三段第一行', '第三段第二行'].join(
  '\n'
)

describe('专注模式的专注单元', () => {
  it('光标在段中 → 亮整段（空行为界）', () => {
    expect(focused(DOC, 3)).toBe('第一段第一行\n第一段第二行')
    expect(focused(DOC, DOC.indexOf('第三段第二行'))).toBe('第三段第一行\n第三段第二行')
  })

  it('光标在段末行 → 仍然是整段，不是半段', () => {
    expect(focused(DOC, DOC.indexOf('第一段第二行') + 3)).toBe('第一段第一行\n第一段第二行')
  })

  it('光标停在空行上 → 只亮那一行（本来也没东西可亮）', () => {
    expect(focused(DOC, DOC.indexOf('\n\n') + 1)).toBe('')
  })

  it('选区跨段 → 亮到两端各自的段落边界', () => {
    const from = DOC.indexOf('第一段第二行') + 2
    const to = DOC.indexOf('第二段') + 1
    expect(focused(DOC, from, to)).toBe('第一段第一行\n第一段第二行\n\n第二段')
  })

  it('文档首尾不越界', () => {
    expect(focused('只有一行', 0)).toBe('只有一行')
    expect(focused('', 0)).toBe('')
  })

  it('整段超长时扫描有上限（不会为了找段首把整篇文档扫一遍）', () => {
    // 1000 行不带空行：上下各最多扫 400 行，亮的段落因此被截断在 801 行以内
    const long = Array.from({ length: 1000 }, (_, i) => `行${i}`).join('\n')
    const state = EditorState.create({ doc: long, selection: { anchor: long.length >> 1 } })
    const r = focusRange(state)
    const lines = state.doc.sliceString(r.from, r.to).split('\n').length
    expect(lines).toBeLessThanOrEqual(801)
    expect(lines).toBeGreaterThan(700)
  })
})
