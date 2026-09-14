import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { expandOnEnter, expandTableOnEnter } from '../src/renderer/editor/input-rules'
import { setTableEdit } from '../src/renderer/editor/live-preview/table'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'

function run(doc: string, caret = doc.length): EditorState | null {
  const s = EditorState.create({
    doc,
    selection: { anchor: caret },
    extensions: [cursiveMarkdown()]
  })
  ensureSyntaxTree(s, doc.length, 5000)
  const spec = expandOnEnter(s)
  return spec ? s.update(spec).state : null
}

describe('P2-2 表格骨架', () => {
  it('| a | b | + 回车 → 补分隔行 + 空数据行，光标进第一格', () => {
    const out = run('| a | b |')
    expect(out?.doc.toString()).toBe('| a | b |\n| --- | --- |\n|     |     |')
    const head = out!.selection.main.head
    expect(out!.doc.lineAt(head).text.startsWith('| ')).toBe(true)
    expect(out!.doc.lineAt(head).number).toBe(3)
  })

  it('已是分隔行不再补', () => {
    expect(run('|---|---|')).toBeNull()
    expect(expandTableOnEnter(EditorState.create({ doc: '|---|---|', selection: { anchor: 9 } }))).toBeNull()
  })

  it('顺手进就地编辑态：新表格直接以渲染态出现', () => {
    const doc = '前文\n\n| a | b |'
    const spec = expandTableOnEnter(
      EditorState.create({ doc, selection: { anchor: doc.length } })
    )
    const effects = [spec!.effects].flat()
    expect(effects.some((e) => e?.is(setTableEdit) && e.value === 4)).toBe(true)
  })

  it('非表格文本不触发', () => {
    expect(run('普通文字')).toBeNull()
    expect(run('|单列|')).toBeNull()
  })

  it('光标不在行尾不触发', () => {
    expect(run('| a | b |', 2)).toBeNull()
  })
})

describe('P2-2 围栏骨架', () => {
  it('```ts + 回车 → 补空行 + 闭合围栏，光标停中间', () => {
    const out = run('```ts')
    expect(out?.doc.toString()).toBe('```ts\n\n```')
    expect(out!.selection.main.head).toBe(6) // 空行行首
  })

  it('已闭合的围栏不再补', () => {
    expect(run('```ts\ncode\n```', 5)).toBeNull()
  })

  it('波浪线围栏同样处理', () => {
    expect(run('~~~').doc.toString()).toBe('~~~\n\n~~~')
  })

  it('普通行不触发', () => {
    expect(run('hello')).toBeNull()
  })
})
