import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { changeListIndent, listInfo } from '../src/renderer/editor/list-ops'

function apply(doc: string, dir: 1 | -1, anchor = 0): EditorState | null {
  const s = EditorState.create({ doc, selection: { anchor } })
  const spec = changeListIndent(s, dir)
  return spec ? s.update(spec).state : null
}

describe('P2-3 列表升降级', () => {
  it('Tab 缩进无序项', () => {
    expect(apply('- 项', 1)?.doc.toString()).toBe('  - 项')
  })

  it('⇧Tab 减少缩进（不越过行首）', () => {
    expect(apply('    - 项', -1)?.doc.toString()).toBe('  - 项')
    expect(apply('- 项', -1)?.doc.toString()).toBe('- 项')
  })

  it('非列表行不接管（返回 null，交回 indentWithTab）', () => {
    expect(apply('普通文字', 1)).toBeNull()
  })

  it('任务项也支持缩进', () => {
    expect(apply('- [ ] todo', 1)?.doc.toString()).toBe('  - [ ] todo')
  })
})

describe('P2-3 有序列表重编号', () => {
  it('缩进后整段重编号 1..n', () => {
    const doc = '3. c\n\n1. a\n5. b'
    // 选中后两项（同一有序段），Tab 缩进并重编号
    const s = EditorState.create({ doc, selection: { anchor: doc.length } })
    const out = s.update(changeListIndent(s, 1)!).state
    expect(out.doc.toString()).toBe('3. c\n\n  1. a\n  2. b')
  })

  it('减少缩进同样重编号', () => {
    const doc = '- x\n  1. a\n  1. b'
    const s = EditorState.create({ doc, selection: { anchor: doc.length } })
    const out = s.update(changeListIndent(s, -1)!).state
    expect(out.doc.toString()).toBe('- x\n1. a\n2. b')
  })

  it('保留 ) 分隔符风格', () => {
    const doc = '1) a\n1) b'
    const s = EditorState.create({ doc, selection: { anchor: doc.length } })
    const out = s.update(changeListIndent(s, 1)!).state
    expect(out.doc.toString()).toBe('  1) a\n  2) b')
  })
})

describe('listInfo', () => {
  it('识别有序/无序/缩进', () => {
    expect(listInfo('- a')).toMatchObject({ indent: 0, ordered: false })
    expect(listInfo('  12. b')).toMatchObject({ indent: 2, ordered: true })
    expect(listInfo('# 标题')).toBeNull()
  })
})
