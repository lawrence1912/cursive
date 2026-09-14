import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { beforeAll, describe, expect, it } from 'vitest'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'
import { setTableEdit, tableEditField } from '../src/renderer/editor/live-preview/table'
import { buildBlocks } from '../src/renderer/editor/live-preview/index'

// widgets.ts 的 currentTheme（mermaid 分支用）读 document.documentElement，
// node 测试环境补一个最小桩
beforeAll(() => {
  ;(globalThis as { document?: unknown }).document ??= {
    documentElement: { dataset: {} }
  }
})

function decos(doc: string, anchor?: number, editAt?: number): string[] {
  let state = EditorState.create({
    doc,
    selection: anchor === undefined ? undefined : { anchor },
    extensions: [cursiveMarkdown(), tableEditField]
  })
  if (editAt !== undefined) state = state.update({ effects: setTableEdit.of(editAt) }).state
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

  it('就地编辑中的表格：光标落在表格行上也不回落源码', () => {
    const doc = '前文\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'
    // 没进编辑态：老规矩，光标碰到就回显源码
    expect(decos(doc, 10)).toEqual([])
    // tableEditField 指向这张表 → reveal 判定对它失效，widget 照常出
    expect(decos(doc, 10, 4)).toEqual([`4-${doc.trimEnd().length}:TableWidget`])
    // 指向别的位置不算数
    expect(decos(doc, 10, 0)).toEqual([])
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

  // 打开文件那一刻 CM 只解析前 3000 字（Work.InitViewport），而 ensureSyntaxTree
  // 推进的是 ParseContext、**不回填 syntaxTree(state) 那份快照** —— 老代码在这里
  // 会拿半截树建 widget：一张 100 行的表首开只画到跨过 3000 字的那一行，点一下
  // （任何事务都会刷新快照）又突然长全，视口跟着乱跳。
  it('首开长文档：表格不因半截树被截断（不预先 ensure，复刻打开文件）', () => {
    const rows = Array.from({ length: 150 }, (_, i) => `| 第${i + 1}行 | 数据数据数据数据 | 备注备注 |`)
    const doc = `# 标题\n\n| 甲 | 乙 | 丙 |\n| --- | --- | --- |\n${rows.join('\n')}\n`
    expect(doc.length).toBeGreaterThan(3000) // 不跨过 3000 字就测不到这个坑
    const state = EditorState.create({ doc, extensions: [cursiveMarkdown(), tableEditField] })

    const out: { from: number; to: number; rows: number }[] = []
    buildBlocks(state).between(0, doc.length, (from, to, v) => {
      const w = (v.spec as { widget?: { data?: { rows: unknown[] } } }).widget
      out.push({ from, to, rows: w?.data?.rows.length ?? -1 })
    })
    expect(out).toEqual([{ from: 6, to: doc.trimEnd().length, rows: 150 }])
  })
})
