import { history, undo } from '@codemirror/commands'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'
import { pasteGrid, tableEditField } from '../src/renderer/editor/live-preview/table'
import { clipboardGrid, parseTsv } from '../src/renderer/editor/table-paste'

/**
 * 第八节 9：往表格里粘 Excel / Numbers 复制来的几行几列。
 * 两半都是纯函数：剪贴板 → 一块矩形数据（`table-paste.ts`），矩形数据 → 一个事务（`pasteGrid`）。
 */

describe('剪贴板里是不是一块矩形数据', () => {
  it('TSV：制表符分格、换行分行；结尾那个换行不多出一行', () => {
    expect(parseTsv('a\tb\nc\td\n')).toEqual([['a', 'b'], ['c', 'd']])
    expect(parseTsv('a\tb\r\nc\td')).toEqual([['a', 'b'], ['c', 'd']])
    // 空格子留着位置
    expect(parseTsv('a\t\tc\n')).toEqual([['a', '', 'c']])
  })

  it('带引号的格子里可以有换行、制表符，"" 是一个引号；格子中间的引号照原样', () => {
    expect(parseTsv('"第一行\n第二行"\tb\n"有\t制表"\t"说 ""你好"""\n')).toEqual([
      ['第一行\n第二行', 'b'],
      ['有\t制表', '说 "你好"']
    ])
    expect(parseTsv('5" 屏幕\tx\n')).toEqual([['5" 屏幕', 'x']])
  })

  it('有制表符 → 是；只复制了一列（没有制表符）但 HTML 只是一张表 → 也是', () => {
    expect(clipboardGrid('a\tb\nc\td\n', null)).toEqual([['a', 'b'], ['c', 'd']])
    const sheet = '<html><head><style>td{}</style></head><body><!--StartFragment--><table><tr><td>a</td></tr><tr><td>b</td></tr></table><!--EndFragment--></body></html>'
    expect(clipboardGrid('a\nb\n', sheet)).toEqual([['a'], ['b']])
    // 只复制了一格：1×1，交给调用方取那一格的字
    expect(clipboardGrid('abc\n', '<table><tr><td>abc</td></tr></table>')).toEqual([['abc']])
  })

  it('普通多行文字、网页上图文表混排的一段：不是（照旧并成一行）', () => {
    expect(clipboardGrid('第一行\n第二行\n', null)).toBeNull()
    expect(clipboardGrid('第一行\n第二行', '<p>第一行</p><p>第二行</p>')).toBeNull()
    expect(clipboardGrid('说明\na\nb', '<p>说明</p><table><tr><td>a</td></tr><tr><td>b</td></tr></table>')).toBeNull()
  })

  it('参差不齐的行补成一样宽', () => {
    expect(clipboardGrid('a\tb\tc\nd\n', null)).toEqual([['a', 'b', 'c'], ['d', '', '']])
  })
})

describe('按矩形填进表格（pasteGrid）', () => {
  const table = ['前言', '', '| 甲 | 乙 | 丙 |', '| --- | --- | --- |', '| 1 | 2 | 3 |', '| 4 | 5 | 6 |', '', '后记'].join('\n')

  function stateOf(doc: string): EditorState {
    const state = EditorState.create({ doc, extensions: [cursiveMarkdown(), history(), tableEditField] })
    ensureSyntaxTree(state, doc.length, 5000)
    return state
  }

  function paste(doc: string, row: number, col: number, grid: string[][]) {
    let state = stateOf(doc)
    const before = state.doc.toString()
    const spec = pasteGrid(state, doc.indexOf('| 甲'), row, col, grid)
    expect(spec).not.toBeNull()
    state = state.update(spec!).state
    const after = state.doc.toString()
    const caret = state.selection.main.head
    undo({ state, dispatch: (tr) => void (state = tr.state) })
    return { before, after, caret, undone: state.doc.toString() }
  }

  it('在表格里面：只换目标格子那一段，别的字节一个不动；一次撤销全部恢复', () => {
    const r = paste(table, 1, 1, [['x', 'y'], ['z', 'w']])
    expect(r.after).toBe(table.replace('| 1 | 2 | 3 |', '| 1 | x | y |').replace('| 4 | 5 | 6 |', '| 4 | z | w |'))
    expect(r.undone).toBe(r.before)
    // 光标落在起点那一格（第 1 行第 1 格）的末尾
    expect(r.after.slice(0, r.caret).endsWith('| 1 | x')).toBe(true)
  })

  it('行不够往下补：补出来的行带首尾竖线，列数跟着表', () => {
    const r = paste(table, 2, 0, [['a', 'b'], ['c', 'd'], ['e', 'f']])
    const lines = r.after.split('\n')
    expect(lines.slice(2, 8)).toEqual([
      '| 甲 | 乙 | 丙 |', '| --- | --- | --- |', '| 1 | 2 | 3 |', '| a | b | 6 |', '| c | d |   |', '| e | f |   |'
    ])
    // 表格后面的空行与「后记」原样
    expect(lines.slice(8)).toEqual(['', '后记'])
    expect(r.undone).toBe(r.before)
  })

  it('列不够往右补：表头补空格子、分隔行补 ---、每一行都补', () => {
    const r = paste(table, 1, 2, [['x', 'y', 'z']])
    const lines = r.after.split('\n').slice(2, 6)
    expect(lines).toEqual([
      '| 甲 | 乙 | 丙 |   |   |',
      '| --- | --- | --- | --- | --- |',
      '| 1 | 2 | x | y | z |',
      '| 4 | 5 | 6 |   |   |'
    ])
    expect(r.undone).toBe(r.before)
  })

  it('从表头那一行起贴也行；填进去的竖线转义、换行压成空格', () => {
    const r = paste(table, 0, 0, [['A|B', '第一行\n第二行']])
    expect(r.after.split('\n')[2]).toBe('| A\\|B | 第一行 第二行 | 丙 |')
  })

  it('没有首尾竖线的表：补列照「追加列」的写法；补出来的行带首尾竖线（不带的写法装不下空的首格）', () => {
    const bare = ['甲 | 乙', '--- | ---', '1 | 2', ''].join('\n')
    let state = stateOf(bare)
    const spec = pasteGrid(state, 0, 1, 1, [['x', 'y'], ['z', 'w']])
    state = state.update(spec!).state
    expect(state.doc.toString().split('\n').slice(0, 4)).toEqual([
      '甲 | 乙 |   |', '--- | --- | --- |', '1 | x | y |', '|   | z | w |'
    ])
  })

  it('空格子里贴进字：落成「| x |」而不是贴着竖线', () => {
    const doc = ['| 甲 | 乙 |', '| --- | --- |', '|  |  |', ''].join('\n')
    let state = stateOf(doc)
    state = state.update(pasteGrid(state, 0, 1, 0, [['x', 'y']])!).state
    expect(state.doc.line(3).text).toBe('| x | y |')
  })
})
