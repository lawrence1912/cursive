import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { beforeAll, describe, expect, it } from 'vitest'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'
import { buildBlocks } from '../src/renderer/editor/live-preview/index'

// widgets.ts 的 currentTheme（mermaid 分支用）读 document.documentElement，
// node 测试环境补一个最小桩
beforeAll(() => {
  ;(globalThis as { document?: unknown }).document ??= {
    documentElement: { dataset: {} }
  }
})

function decos(doc: string, anchor?: number): string[] {
  const state = EditorState.create({
    doc,
    selection: anchor === undefined ? undefined : { anchor },
    extensions: [cursiveMarkdown()]
  })
  ensureSyntaxTree(state, doc.length, 5000)
  const out: string[] = []
  buildBlocks(state).between(0, doc.length, (f, t, v) => {
    const widget = (v.spec as { widget?: { constructor: { name: string } } }).widget
    out.push(`${f}-${t}:${widget?.constructor.name ?? '?'}`)
  })
  return out
}

describe('块级装饰（blockField 的纯函数，不依赖 DOM）', () => {
  it('DisplayMath → MathWidget 块级替换', () => {
    const doc = 'A\n\n$$\nx = 1\n$$\n'
    expect(decos(doc)).toEqual([`3-${doc.trimEnd().length}:MathWidget`])
  })

  it('光标进入数学块 → 回显源码，不再出 widget', () => {
    expect(decos('A\n\n$$\nx = 1\n$$\n', 8)).toEqual([])
  })

  it('Table → TableWidget；光标碰到同样回落', () => {
    const doc = '前文\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'
    expect(decos(doc)).toEqual([`4-${doc.trimEnd().length}:TableWidget`])
    // 光标落在表格行上 → 回显源码
    expect(decos(doc, 10)).toEqual([])
  })

  it('mermaid 代码块 → MermaidWidget；其它语言不换', () => {
    const doc = '图：\n\n```mermaid\nflowchart TD\n a-->b\n```'
    expect(decos(doc)).toEqual([`4-${doc.trimEnd().length}:MermaidWidget`])
    // 光标进入代码块 → 源码
    expect(decos(doc, 10)).toEqual([])
    // 非 mermaid 围栏不换 widget
    expect(decos('代码：\n\n```ts\nconst a = 1\n```')).toEqual([])
  })

  it('FootnoteDefinition → FootnoteDefWidget；光标进入回落', () => {
    const doc = '前文\n\n[^1]: 这是定义\n'
    expect(decos(doc)).toEqual([`4-${doc.trimEnd().length}:FootnoteDefWidget`])
    expect(decos(doc, 10)).toEqual([])
  })

  it('TocBlock → TocWidget，收集全文标题', () => {
    const doc = '目录：\n\n[TOC]\n\n# 一\n\n## 二\n'
    // TocBlock 只盖 [TOC] 那一行
    expect(decos(doc)).toEqual(['5-10:TocWidget'])
  })
})
