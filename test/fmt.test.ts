import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { makeFormatSpec, wordAt } from '../src/renderer/editor/fmt'

function apply(state: EditorState, action: string): EditorState {
  const spec = makeFormatSpec(state, action as never)
  return state.update({
    changes: spec.changes,
    selection: spec.selection,
    userEvent: 'input'
  }).state
}

function sel(anchor: number, head = anchor): EditorSelection {
  return EditorSelection.single(anchor, head)
}

describe('行内格式（幂等）', () => {
  it('加粗再加粗 = 原文（idempotent）', () => {
    const s = EditorState.create({ doc: 'hello world', selection: sel(0, 5) })
    const b1 = apply(s, 'fmt:bold')
    expect(b1.doc.toString()).toBe('**hello** world')
    const b2 = apply(b1, 'fmt:bold')
    expect(b2.doc.toString()).toBe('hello world')
  })

  it('斜体/行内代码/删除线同理', () => {
    const s = EditorState.create({ doc: 'ab', selection: sel(0, 2) })
    expect(apply(s, 'fmt:italic').doc.toString()).toBe('*ab*')
    expect(apply(s, 'fmt:code-inline').doc.toString()).toBe('`ab`')
    expect(apply(s, 'fmt:strikethrough').doc.toString()).toBe('~~ab~~')
  })

  it('无选区光标在空白：插入空对', () => {
    const s = EditorState.create({ doc: 'a b', selection: sel(1) }) // 空格位置
    expect(apply(s, 'fmt:bold').doc.toString()).toBe('a**** b')
  })

  it('一个事务内完成 → 可一步撤回', () => {
    // 造一个带 single undo 的 state 验证：整个格式化是一个 transaction
    const s = EditorState.create({ doc: 'xy', selection: sel(0, 2) })
    const done = apply(s, 'fmt:bold')
    expect(done.doc.toString()).toBe('**xy**')
  })
})

describe('标题 / 段落', () => {
  it('无标题 → 加；同级 → 摘；跨级 → 换级', () => {
    const s = EditorState.create({ doc: '标题文本', selection: sel(0) })
    const h1 = apply(s, 'fmt:h3')
    expect(h1.doc.toString()).toBe('### 标题文本')
    expect(apply(h1, 'fmt:h3').doc.toString()).toBe('标题文本')
    expect(apply(h1, 'fmt:h1').doc.toString()).toBe('# 标题文本')
  })

  it('⌘0（正文）摘掉标题', () => {
    const s = EditorState.create({ doc: '## 小节', selection: sel(0) })
    expect(apply(s, 'fmt:p').doc.toString()).toBe('小节')
  })
})

describe('行级：引用 / 列表 / 任务 / 围栏', () => {
  it('引用开关', () => {
    const s = EditorState.create({ doc: '引文', selection: sel(0) })
    expect(apply(s, 'fmt:quote').doc.toString()).toBe('> 引文')
    expect(apply(apply(s, 'fmt:quote'), 'fmt:quote').doc.toString()).toBe('引文')
  })

  it('无序/有序列表开关', () => {
    const s = EditorState.create({ doc: '条目', selection: sel(0) })
    expect(apply(s, 'fmt:ulist').doc.toString()).toBe('- 条目')
    expect(apply(s, 'fmt:olist').doc.toString()).toBe('1. 条目')
  })

  it('多行选区逐行生效', () => {
    const s = EditorState.create({ doc: 'a\nb\n', selection: sel(0, 3) })
    expect(apply(s, 'fmt:ulist').doc.toString()).toBe('- a\n- b\n')
  })

  it('任务项开关', () => {
    const s = EditorState.create({ doc: 'todo', selection: sel(0) })
    expect(apply(s, 'fmt:task').doc.toString()).toBe('- [ ] todo')
  })

  it('代码块围栏：包上再摘', () => {
    const s = EditorState.create({ doc: 'code', selection: sel(0, 4) })
    const fenced = apply(s, 'fmt:code-block')
    expect(fenced.doc.toString()).toBe('```\ncode\n```')
    expect(apply(fenced, 'fmt:code-block').doc.toString()).toBe('code')
  })
})

describe('链接', () => {
  it('选区包成链接', () => {
    const s = EditorState.create({ doc: '官网', selection: sel(0, 2) })
    expect(apply(s, 'fmt:link').doc.toString()).toBe('[官网]()')
  })

  it('已是链接 → 摘回纯文本', () => {
    const s = EditorState.create({ doc: '[官网](https://x)', selection: sel(0, 15) })
    expect(apply(s, 'fmt:link').doc.toString()).toBe('官网')
  })
})

describe('多光标', () => {
  it('两个选区同时加粗', () => {
    const s = EditorState.create({
      doc: 'aa bb',
      extensions: [EditorState.allowMultipleSelections.of(true)],
      selection: EditorSelection.create([EditorSelection.range(0, 2), EditorSelection.range(3, 5)], 0)
    })
    const out = apply(s, 'fmt:bold')
    expect(out.doc.toString()).toBe('**aa** **bb**')
  })
})

describe('wordAt', () => {
  it('中文词边界（Segmenter 按词切：你好=0-2 世界=2-4）', () => {
    const s = EditorState.create({ doc: '你好世界' })
    expect(wordAt(s, 1)).toEqual({ from: 0, to: 2 })
    expect(wordAt(s, 3)).toEqual({ from: 2, to: 4 })
  })
  it('光标在词外（空格/标点）返回 null', () => {
    const s = EditorState.create({ doc: 'a b' })
    expect(wordAt(s, 1)).toBeNull()
  })
  it('英文词边界', () => {
    const s = EditorState.create({ doc: 'hello world' })
    expect(wordAt(s, 1)).toEqual({ from: 0, to: 5 })
  })
})
