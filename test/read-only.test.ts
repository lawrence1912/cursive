import { readFileSync } from 'node:fs'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { makeFormatSpec } from '../src/renderer/editor/fmt'
import { levelChangeSpec, collectHeadings } from '../src/renderer/editor/headings'
import { blockField, livePreview } from '../src/renderer/editor/live-preview/index'
import { Reveal } from '../src/renderer/editor/live-preview/reveal'
import { adoptTableAtCursor, tableEditAt, writeCell } from '../src/renderer/editor/live-preview/table'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'
import { readOnlyConf, readOnlyExt, readOnlyHost } from '../src/renderer/editor/read-only'

/**
 * 第八节 5：只读阅读模式（编辑器这一层）。窗口那一层（状态栏、标签锁、菜单的勾、会话）
 * 在下面扫 main.ts 的接线；真窗口里的打字 / 粘贴 / 勾选由原生专项跑（`test/native-flow.js`）。
 */

beforeAll(() => {
  // widgets.ts 的 currentTheme（mermaid 分支用）读 document.documentElement（同 block.test.ts）
  ;(globalThis as { document?: unknown }).document ??= { documentElement: { dataset: {} } }
})

afterEach(() => {
  readOnlyHost.blocked = null
})

const DOC = '# 标题\n\n正文一段。\n\n- [ ] 待办\n\n| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n'

function make(doc: string, readOnly: boolean, anchor?: number): EditorState {
  return EditorState.create({
    doc,
    selection: anchor === undefined ? undefined : { anchor },
    extensions: [cursiveMarkdown(), livePreview(), readOnlyConf.of(readOnlyExt(readOnly))]
  })
}

describe('那道闸：程序化的改动落不进只读文档', () => {
  it('格式命令（⌘B）：文档一个字不变，选区照样合法，闸报一声', () => {
    let blocked = 0
    readOnlyHost.blocked = () => void blocked++
    const state = make(DOC, true, 9)
    const after = state.update(makeFormatSpec(state, 'fmt:bold')).state
    expect(after.doc.eq(state.doc)).toBe(true)
    expect(after.selection.main.head).toBeLessThanOrEqual(after.doc.length)
    expect(blocked).toBe(1)
  })

  it('任务勾选 / 表格写格 / 大纲降级 —— 三种 widget 与面板发的改动同样挡住', () => {
    const state = make(DOC, true)
    const box = DOC.indexOf('[ ]')
    expect(state.update({ changes: { from: box + 1, to: box + 2, insert: 'x' } }).state.doc.eq(state.doc)).toBe(true)
    ensureSyntaxTree(state, state.doc.length, 5000)
    const table = DOC.indexOf('| 甲')
    const cell = writeCell(state, table, 1, 0, '改了')!
    expect(cell).not.toBeNull()
    expect(state.update(cell).state.doc.eq(state.doc)).toBe(true)
    const h = collectHeadings(state)[0]!
    const demote = levelChangeSpec(state, h, 2)!
    expect(state.update(demote).state.doc.eq(state.doc)).toBe(true)
  })

  it('不改文档的事务照常（挪光标、折叠这类「看的人此刻的状态」）—— 闸一声不吭', () => {
    let blocked = 0
    readOnlyHost.blocked = () => void blocked++
    const state = make(DOC, true)
    const after = state.update({ selection: { anchor: 5 } }).state
    expect(after.selection.main.head).toBe(5)
    expect(blocked).toBe(0)
  })

  it('退出只读之后恢复正常编辑', () => {
    const state = make(DOC, true)
    const editable = state.update({ effects: readOnlyConf.reconfigure(readOnlyExt(false)) }).state
    expect(editable.readOnly).toBe(false)
    const after = editable.update(makeFormatSpec(editable, 'fmt:bold')).state
    expect(after.doc.eq(editable.doc)).toBe(false)
  })

  it('可编辑的文档上没有这道闸', () => {
    let blocked = 0
    readOnlyHost.blocked = () => void blocked++
    const state = make(DOC, false)
    const after = state.update({ changes: { from: 0, insert: 'x' } }).state
    expect(after.doc.toString()).toBe('x' + DOC)
    expect(blocked).toBe(0)
  })
})

describe('渲染效果钉住', () => {
  it('光标落在表格里也不翻回源码（回显区间为空），表格以不可编辑的那一份出现', () => {
    const inTable = DOC.indexOf('| 1') + 2
    const state = make(DOC, true, inTable)
    expect(new Reveal(state, 'line').ranges).toEqual([])
    expect(new Reveal(state, 'block').ranges).toEqual([])
    const widgets: { name: string; readOnly?: boolean; editing?: boolean }[] = []
    state.field(blockField).between(0, state.doc.length, (_f, _t, v) => {
      const w = (v.spec as { widget?: { constructor: { name: string }; readOnly?: boolean; editing?: boolean } }).widget
      if (w) widgets.push({ name: w.constructor.name, readOnly: w.readOnly, editing: w.editing })
    })
    expect(widgets).toEqual([{ name: 'TableWidget', readOnly: true, editing: false }])
  })

  it('打开时光标就在表里：只读不进就地编辑态（那会把一格翻成源码、格子变成可编辑的孤岛）', () => {
    const state = make('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n', true, 2)
    expect(tableEditAt(adoptTableAtCursor(state))).toBeNull()
    // 对照：可编辑时照旧进编辑态
    const editable = make('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n', false, 2)
    expect(tableEditAt(adoptTableAtCursor(editable))).not.toBeNull()
  })

  it('切只读是一次 reconfigure（文档、选区都没动）—— 块级装饰照样整份重建', () => {
    const inTable = DOC.indexOf('| 1') + 2
    const editable = make(DOC, false, 0)
    const ro = editable.update({ effects: readOnlyConf.reconfigure(readOnlyExt(true)) }).state
    let flag: boolean | undefined
    ro.field(blockField).between(0, ro.doc.length, (_f, _t, v) => {
      const w = (v.spec as { widget?: { readOnly?: boolean } }).widget
      if (w && 'readOnly' in w) flag = w.readOnly
    })
    expect(flag).toBe(true)
    expect(inTable).toBeGreaterThan(0)
  })
})

describe('窗口那一层的接线（扫 main.ts）', () => {
  const src = readFileSync('src/renderer/main.ts', 'utf8')
  const fn = (name: string): string => {
    const at = src.indexOf(`function ${name}(`)
    expect(at, name).toBeGreaterThan(-1)
    const body = src.slice(at)
    return body.slice(0, body.indexOf('\n}\n'))
  }

  it('外部重载换整份 state 时把只读原样带过去（别人改了文件，锁不该被悄悄撤掉）', () => {
    expect(fn('adoptDisk')).toContain('readOnly: (live ? view.state : tab.state).readOnly')
  })

  it('会话存与恢复都带只读', () => {
    expect(fn('currentSession')).toContain('readOnly: true')
    expect(fn('restoreSession')).toContain("readOnly: st?.readOnly === true")
  })

  it('关标签时只读这一位进关闭栈，重开时原样带回来（第八节 7）', () => {
    expect(fn('closeTab')).toContain('readOnly: t.state.readOnly')
    expect(fn('reopenClosedTab')).toContain('readOnly: entry.readOnly')
  })

  it('回滚、LaTeX 格式化在只读时先说一声，不接着报「已完成」', () => {
    expect(fn('openHistory')).toMatch(/if \(view\.state\.readOnly\) \{\s*readOnlyHost\.blocked\?\.\(\)\s*return/)
    expect(src).toMatch(/case 'fmt:latex-format': \{[\s\S]{0,300}if \(view\.state\.readOnly\) \{\s*readOnlyHost\.blocked\?\.\(\)/)
  })
})
