import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  calloutFoldField,
  matchCallout,
  toggleCalloutFold
} from '../src/renderer/editor/callout'
import { calloutAt } from '../src/renderer/editor/live-preview/decorate'
import { buildBlocks } from '../src/renderer/editor/live-preview/index'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'

// widgets.ts 的 currentTheme（mermaid 分支）读 document.documentElement，node 环境补个桩
beforeAll(() => {
  ;(globalThis as { document?: unknown }).document ??= { documentElement: { dataset: {} } }
})

function stateOf(doc: string, anchor = 0): EditorState {
  const state = EditorState.create({
    doc,
    selection: { anchor },
    extensions: [cursiveMarkdown(), calloutFoldField]
  })
  ensureSyntaxTree(state, doc.length, 5000)
  return state
}

/** 文档里第 n 个（默认第一个）引用块节点 */
function quote(state: EditorState, nth = 0): SyntaxNode {
  const found: SyntaxNode[] = []
  syntaxTree(state).iterate({
    enter: (n) => {
      if (n.name === 'Blockquote') found.push(n.node)
    }
  })
  expect(found.length, '没找到引用块').toBeGreaterThan(nth)
  return found[nth]!
}

/** blockField 出的装饰，格式 `from-to:WidgetName`（同 block.test.ts） */
function blocks(state: EditorState): string[] {
  const out: string[] = []
  buildBlocks(state).between(0, state.doc.length, (f, t, v) => {
    const widget = (v.spec as { widget?: { constructor: { name: string } } }).widget
    out.push(`${f}-${t}:${widget?.constructor.name ?? '?'}`)
  })
  return out
}

describe('告示块 Callout 的类型表（P1-6）', () => {
  it('别名大小写不敏感，GitHub 那五个也落在同一张表里', () => {
    expect(matchCallout('[!DANGER]')?.type).toBe('danger')
    expect(matchCallout('[!error]')?.tone).toBe('danger')
    expect(matchCallout('[!Note]')?.label).toBe('笔记')
    // GitHub：NOTE / TIP / IMPORTANT / WARNING / CAUTION
    expect(matchCallout('[!IMPORTANT]')?.type).toBe('tip')
    expect(matchCallout('[!CAUTION]')?.type).toBe('warning')
    expect(matchCallout('[!WARNING]')?.tone).toBe('warn')
    // Obsidian 的别名
    expect(matchCallout('[!tldr]')?.type).toBe('abstract')
    expect(matchCallout('[!faq]')?.type).toBe('question')
    expect(matchCallout('[!done]')?.type).toBe('success')
  })

  it('表里没有的类型一律不认，`[` 也必须顶在最前面', () => {
    expect(matchCallout('[!xyz]')).toBeNull()
    expect(matchCallout('[!]')).toBeNull()
    expect(matchCallout('[^1]')).toBeNull()
    expect(matchCallout('正文 [!note]')).toBeNull()
  })

  it('折叠标记：`-` 默认折、`+` 默认展开、不写就没有三角', () => {
    expect(matchCallout('[!note]')).toMatchObject({ foldable: false, folded: false, length: 7 })
    expect(matchCallout('[!note]-')).toMatchObject({ foldable: true, folded: true, length: 8 })
    expect(matchCallout('[!note]+')).toMatchObject({ foldable: true, folded: false, length: 8 })
  })
})

describe('告示块判定（引用块 → 告示块）', () => {
  it('首个内容子节点是 CalloutMark 才算告示块', () => {
    const s = stateOf('> [!tip] 顺手的做法\n> 正文\n')
    expect(calloutAt(s.doc, quote(s))?.tone).toBe('tip')
    const plain = stateOf('> 只是一句普通引用\n')
    expect(calloutAt(plain.doc, quote(plain))).toBeNull()
    // 第二行才出现的 [!note] 不算
    const late = stateOf('> 第一行\n> [!note] 第二行\n')
    expect(calloutAt(late.doc, quote(late))).toBeNull()
    // 形状对、类型表里没有 → 不成卡片（解析器仍会认领这个 `[`，见 dialect.test.ts）
    const unknown = stateOf('> [!xyz] 随便写\n')
    expect(calloutAt(unknown.doc, quote(unknown))).toBeNull()
  })

  it('嵌套 `> > [!note]` 只有里层那块算告示块，不递归', () => {
    const s = stateOf('> > [!warning] 当心\n')
    expect(calloutAt(s.doc, quote(s, 0))).toBeNull() // 外层
    expect(calloutAt(s.doc, quote(s, 1))?.tone).toBe('warn') // 里层
  })
})

describe('告示块折叠（状态不写回文档）', () => {
  const folded = '正文\n\n> [!note]-\n> 被折起来的内容\n> 还有一行\n'
  /** 块起点 / 首行末尾：位置都从文档算，别写死数字 */
  const at = (doc: string) => doc.indexOf('>')
  const headEnd = (doc: string) => doc.indexOf('\n', at(doc))
  const pill = (doc: string) => `${headEnd(doc)}-${doc.trimEnd().length}:CalloutFoldWidget`

  it('`[!note]-` 默认折起：正文整段换成一颗药丸', () => {
    // 从首行末尾（连着换行符）一直吃到块尾
    expect(blocks(stateOf(folded))).toEqual([pill(folded)])
  })

  it('光标进到块里就展开 —— 折起来的源码没法编辑', () => {
    expect(blocks(stateOf(folded, 20))).toEqual([])
  })

  it('不写 `-` / `+` 的告示块永远不折（没有三角，折了就打不开）', () => {
    expect(blocks(stateOf('正文\n\n> [!note]\n> 内容\n'))).toEqual([])
  })

  it('只有一行的告示块没东西可折', () => {
    expect(blocks(stateOf('正文\n\n> [!note]-\n'))).toEqual([])
  })

  it('toggle 翻转默认态：`+` 折起来、`-` 展开', () => {
    const open = '正文\n\n> [!note]+\n> 内容\n'
    let s = stateOf(open)
    expect(blocks(s)).toEqual([])
    s = s.update({ effects: toggleCalloutFold.of(at(open)) }).state
    expect(blocks(s)).toEqual([pill(open)])
    // 再翻一次回到展开
    s = s.update({ effects: toggleCalloutFold.of(at(open)) }).state
    expect(blocks(s)).toEqual([])
  })

  it('文档一改，折叠态跟着 changes 映射，不靠行号', () => {
    let s = stateOf(folded)
    expect(s.field(calloutFoldField).size).toBe(0)
    // 手动展开（集合里装的是「与默认态相反」的那些块）
    s = s.update({ effects: toggleCalloutFold.of(at(folded)) }).state
    expect([...s.field(calloutFoldField)]).toEqual([at(folded)])
    // 在前面插一段：记下的块起点要跟着往后挪，行号会错它不会
    const head = '开头加一段\n\n'
    s = s.update({ changes: { from: 0, insert: head } }).state
    expect([...s.field(calloutFoldField)]).toEqual([at(folded) + head.length])
    expect(blocks(s)).toEqual([]) // 仍然是展开的
    // 整块删掉：映射不过去就丢弃，不留幽灵条目
    s = s.update({ changes: { from: 0, to: s.doc.length } }).state
    expect([...s.field(calloutFoldField)]).toEqual([])
  })

  it('折叠不碰文档：翻来翻去，源码一个字节不变', () => {
    let s = stateOf(folded)
    for (let i = 0; i < 3; i++)
      s = s.update({ effects: toggleCalloutFold.of(at(folded)) }).state
    expect(s.doc.toString()).toBe(folded)
  })
})
