import { readFileSync } from 'node:fs'
import { history, redo, undo } from '@codemirror/commands'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'
import {
  activeCellAt,
  cellPos,
  cellSpan,
  cellTokens,
  deleteCol,
  deleteRow,
  deleteTable,
  displayWidth,
  escapeCell,
  insertColAt,
  insertRowAfter,
  parseTable,
  setAlign,
  tableDataAt,
  TableWidget,
  tidyTable,
  writeCell,
  cellPasteText,
  setTableEdit,
  tableEditAt,
  tableEditField
} from '../src/renderer/editor/live-preview/table'

describe('parseTable：GFM 管道表格', () => {
  it('基础解析 + 对齐', () => {
    const t = parseTable(['| 左 | 中 | 右 |', '| :-- | :---: | --: |', '| a | b | c |'].join('\n'))
    expect(t).not.toBeNull()
    expect(t!.header).toEqual(['左', '中', '右'])
    expect(t!.aligns).toEqual(['left', 'center', 'right'])
    expect(t!.rows).toEqual([['a', 'b', 'c']])
  })

  it('首尾竖线可省略；多行 body', () => {
    const t = parseTable(['a | b', '--- | ---', '1 | 2', '3 | 4'].join('\n'))
    expect(t!.header).toEqual(['a', 'b'])
    expect(t!.rows).toEqual([
      ['1', '2'],
      ['3', '4']
    ])
  })

  it('单元格里的 \\| 转义不会被切列', () => {
    const t = parseTable(['a | b', '--- | ---', 'x\\|y | z'].join('\n'))
    expect(t!.rows[0]).toEqual(['x|y', 'z'])
  })

  it('分隔行不合法 → null', () => {
    expect(parseTable(['a | b', '不是分隔行', '1 | 2'].join('\n'))).toBeNull()
  })

  it('只有一行 → null', () => {
    expect(parseTable('| a | b |')).toBeNull()
  })
})

describe('cellSpan：点单元格 → 源码里那一格的区间', () => {
  const at = (line: string, i: number): string => {
    const s = cellSpan(line, i)
    return s ? line.slice(s.from, s.to) : '<null>'
  }

  it('首尾带竖线', () => {
    const line = '| 左对齐 | 居中 | 右对齐 |'
    expect(at(line, 0)).toBe('左对齐')
    expect(at(line, 1)).toBe('居中')
    expect(at(line, 2)).toBe('右对齐')
  })

  it('首尾竖线省略 + 前导空格', () => {
    const line = '  a | bb | ccc'
    expect(at(line, 0)).toBe('a')
    expect(at(line, 1)).toBe('bb')
    expect(at(line, 2)).toBe('ccc')
  })

  it('空格恰好落在格的文字上（区间要对得上原串偏移）', () => {
    const line = '| **粗体** | `code` | d |'
    const s = cellSpan(line, 1)!
    expect(line.slice(s.from, s.to)).toBe('`code`')
    expect(line[s.from - 1]).toBe(' ')
  })

  it('空单元格 → 空区间（光标停在格中）', () => {
    const line = '| a |  | c |'
    const s = cellSpan(line, 1)!
    expect(s.from).toBe(s.to)
    expect(line.slice(0, s.from)).toBe('| a |  ')
  })

  it('\\| 转义不算列边界', () => {
    const line = '| x\\|y | z |'
    expect(at(line, 0)).toBe('x\\|y')
    expect(at(line, 1)).toBe('z')
  })

  it('越界 → null', () => {
    expect(cellSpan('| a | b |', 5)).toBeNull()
  })
})

// ---------- 就地编辑：源码改写（纯函数，不碰 DOM） ----------

// 手工对齐过的表，专门用来验证「改一格不会顺手把别的列重排」
const DOC = [
  '# 表格',
  '',
  '| 左对齐   | 居中 | 右对齐 |',
  '| :------- | :--: | -----: |',
  '| a        | b    | c      |',
  ''
].join('\n')
const TF = DOC.indexOf('| 左对齐')

function st(doc = DOC, anchor = 0): EditorState {
  return EditorState.create({ doc, selection: { anchor } })
}

function applied(state: EditorState, spec: TransactionSpec | null): string {
  expect(spec).not.toBeNull()
  return state.update(spec!).state.doc.toString()
}

function lineWith(doc: string, needle: string): string {
  return doc.split('\n').find((l) => l.includes(needle)) ?? ''
}

describe('cellPos：行列 → 源码区间', () => {
  it('表头 = 第 0 行，正文第 n 行跳过分隔行', () => {
    const s = st()
    const at = (row: number, col: number): string => {
      const p = cellPos(s, TF, row, col)!
      return s.doc.sliceString(p.from, p.to)
    }
    expect(at(0, 0)).toBe('左对齐')
    expect(at(0, 2)).toBe('右对齐')
    expect(at(1, 0)).toBe('a')
    expect(at(1, 2)).toBe('c')
  })

  it('行不存在 → null', () => {
    expect(cellPos(st(), TF, 9, 0)).toBeNull()
  })
})

describe('writeCell：只动那一格', () => {
  it('别的列 padding 一个字节不改', () => {
    const s = st()
    const out = applied(s, writeCell(s, TF, 1, 0, 'a2'))
    expect(lineWith(out, 'a2')).toBe('| a2        | b    | c      |')
    // 表头和分隔行原样
    expect(out).toContain('| 左对齐   | 居中 | 右对齐 |')
    expect(out).toContain('| :------- | :--: | -----: |')
  })

  it('管道符要转义，换行压成空格', () => {
    const s = st()
    const out = applied(s, writeCell(s, TF, 1, 1, 'x|y\nz'))
    expect(lineWith(out, 'x')).toContain('x\\|y z')
  })

  it('破行（这一行格子不够）→ 先补竖线再写', () => {
    const doc = ['| h1 | h2 | h3 |', '| --- | --- | --- |', '| a |'].join('\n')
    const s = st(doc)
    const out = applied(s, writeCell(s, 0, 1, 2, 'z'))
    expect(out.split('\n')[2]).toBe('| a |  | z |')
  })

  it('空格子写进去是 `| x |`，不是 `|   x|`', () => {
    const s = st()
    const blank = applied(s, writeCell(s, TF, 1, 1, ''))
    const s2 = EditorState.create({ doc: blank })
    expect(lineWith(applied(s2, writeCell(s2, TF, 1, 1, 'x')), 'x')).toBe(
      '| a        | x | c      |'
    )
  })

  it('光标落在新文本里的同一个偏移上', () => {
    const s = st()
    const spec = writeCell(s, TF, 1, 0, 'abc', 2)!
    const next = s.update(spec).state
    expect(next.doc.sliceString(next.selection.main.head - 2, next.selection.main.head)).toBe('ab')
  })
})

describe('insertRowAfter：照抄首尾竖线风格', () => {
  it('末行后面加一行空格子，光标进第一格', () => {
    const s = st()
    const spec = insertRowAfter(s, TF, 1)!
    const next = s.update(spec).state
    const row = next.doc.line(6)
    expect(row.text).toBe('|   |   |   |')
    // 光标落在新行第一格里（空格子的区间是竖线之间那段空白收缩成的零长点）
    expect(next.doc.sliceString(row.from, next.selection.main.head)).toBe('|   ')
  })

  it('只有表头时，新行要落在分隔行之后（不能插进表头和分隔行中间）', () => {
    const doc = ['| h1 | h2 |', '| --- | --- |'].join('\n')
    const s = st(doc)
    const next = s.update(insertRowAfter(s, 0, 0)!).state
    expect(next.doc.toString()).toBe('| h1 | h2 |\n| --- | --- |\n|   |   |')
  })

  it('源码没有首尾竖线时不硬加', () => {
    const doc = ['a | b', '--- | ---', '1 | 2'].join('\n')
    const s = st(doc)
    const next = s.update(insertRowAfter(s, 0, 1)!).state
    expect(next.doc.line(4).text).toBe('   |   ')
  })
})

describe('activeCellAt：选区 → 哪一格', () => {
  it('正文格 + 格内偏移', () => {
    const data = parseTable(DOC.slice(TF))!
    const head = DOC.indexOf('b', TF) + 1
    expect(activeCellAt(st(DOC, head), TF, data)).toEqual({ row: 1, col: 1, offset: 1 })
  })

  it('光标在分隔行上算表头', () => {
    const data = parseTable(DOC.slice(TF))!
    const head = DOC.indexOf('| :-------') + 3
    expect(activeCellAt(st(DOC, head), TF, data)?.row).toBe(0)
  })
})

describe('escapeCell', () => {
  it('换行压成空格、管道符转义、首尾去空白', () => {
    expect(escapeCell('  a|b\nc  ')).toBe('a\\|b c')
  })
})

// ---------- 结构改写：增删行列 / 对齐 / 整理（P2-6 工具栏的后端） ----------

function lines(doc: string): string[] {
  return doc.split('\n')
}

describe('insertColAt：插一列，别的列 padding 不动', () => {
  it('插在中间：分隔行补 ---，其余列原样', () => {
    const s = st()
    const out = lines(applied(s, insertColAt(s, TF, 1, 1)))
    expect(out[2]).toBe('| 左对齐   |   | 居中 | 右对齐 |')
    expect(out[3]).toBe('| :------- | --- | :--: | -----: |')
    expect(out[4]).toBe('| a        |   | b    | c      |')
  })

  it('光标落进新格子', () => {
    const s = st()
    const next = s.update(insertColAt(s, TF, 1, 1)!).state
    const row = next.doc.line(5)
    expect(next.doc.sliceString(row.from, next.selection.main.head)).toBe('| a        |   ')
  })

  it('追加到末尾：原来的尾边界成了分隔符，再补一根新尾边界', () => {
    const s = st()
    const out = lines(applied(s, insertColAt(s, TF, 3, 1)))
    expect(out[2]).toBe('| 左对齐   | 居中 | 右对齐 |   |')
    expect(out[3]).toBe('| :------- | :--: | -----: | --- |')
    expect(out[4]).toBe('| a        | b    | c      |   |')
  })

  it('没有尾边界竖线的写法，追加时补一根（否则空的末格根本不可表达）', () => {
    const doc = ['a | b', '--- | ---', '1 | 2'].join('\n')
    const s = st(doc)
    const out = lines(applied(s, insertColAt(s, 0, 2, 1)))
    expect(out[0]).toBe('a | b |   |')
    expect(out[2]).toBe('1 | 2 |   |')
    expect(parseTable(out.join('\n'))!.header).toEqual(['a', 'b', ''])
  })
})

describe('deleteCol', () => {
  it('删中间列，连它右边的分隔符一起走', () => {
    const s = st()
    const out = lines(applied(s, deleteCol(s, TF, 1)))
    expect(out[2]).toBe('| 左对齐   | 右对齐 |')
    expect(out[3]).toBe('| :------- | -----: |')
    expect(out[4]).toBe('| a        | c      |')
  })

  it('删末列，连它左边的分隔符一起走', () => {
    const s = st()
    expect(lines(applied(s, deleteCol(s, TF, 2)))[4]).toBe('| a        | b    |')
  })

  it('删首列', () => {
    const s = st()
    expect(lines(applied(s, deleteCol(s, TF, 0)))[4]).toBe('| b    | c      |')
  })

  it('只剩一列 → 拒绝（那就不是表格了）', () => {
    const s = st(['| h |', '| --- |', '| x |'].join('\n'))
    expect(deleteCol(s, 0, 0)).toBeNull()
  })
})

describe('deleteRow', () => {
  it('删正文行，不留空行', () => {
    const s = st()
    expect(applied(s, deleteRow(s, TF, 1))).toBe(
      ['# 表格', '', '| 左对齐   | 居中 | 右对齐 |', '| :------- | :--: | -----: |', ''].join('\n')
    )
  })

  it('表头删不得', () => {
    expect(deleteRow(st(), TF, 0)).toBeNull()
  })
})

describe('setAlign：只改分隔行，格子宽度不变', () => {
  it('左 → 右：冒号是从破折号里换出来的', () => {
    const s = st()
    const out = lines(applied(s, setAlign(s, TF, 0, 'right')))
    expect(out[3]).toBe('| -------: | :--: | -----: |')
    expect(out[2]).toBe('| 左对齐   | 居中 | 右对齐 |')
  })

  it('居中', () => {
    const s = st()
    expect(lines(applied(s, setAlign(s, TF, 2, 'center')))[3]).toBe('| :------- | :--: | :----: |')
  })

  it('已经是这个对齐 → 不发事务', () => {
    expect(setAlign(st(), TF, 1, 'center')).toBeNull()
  })
})

describe('tidyTable：显式的「整理对齐」', () => {
  it('中英混排按显示宽度补齐（CJK 算两列）', () => {
    const s = st()
    expect(lines(applied(s, tidyTable(s, TF)))).toEqual([
      '# 表格',
      '',
      '| 左对齐 | 居中 | 右对齐 |',
      '| :----- | :--: | -----: |',
      '| a      | b    | c      |',
      ''
    ])
  })

  it('幂等：整理过的表再整理一次不发事务', () => {
    const s = st()
    const once = applied(s, tidyTable(s, TF))
    expect(tidyTable(st(once), TF)).toBeNull()
  })

  it('没写对齐的 --- 不会被塞进冒号', () => {
    const doc = ['| h | hh |', '| --- | :-: |', '| x | y |'].join('\n')
    const s = st(doc)
    expect(lines(applied(s, tidyTable(s, 0)))).toEqual([
      '| h   | hh  |',
      '| --- | :-: |',
      '| x   | y   |'
    ])
  })

  it('光标留在同一格', () => {
    const s = st()
    const next = s.update(tidyTable(s, TF, 1, 1)!).state
    const line = next.doc.lineAt(next.selection.main.head)
    expect(line.text.slice(next.selection.main.head - line.from)).toBe('b    | c      |')
  })
})

describe('deleteTable', () => {
  it('整块连同换行一起走', () => {
    const s = st()
    expect(applied(s, deleteTable(s, TF))).toBe('# 表格\n\n')
  })
})

describe('displayWidth', () => {
  it('CJK / 全角算两列', () => {
    expect(displayWidth('ab')).toBe(2)
    expect(displayWidth('左对齐')).toBe(6)
    expect(displayWidth('中a')).toBe(3)
  })
})

// ---------- 格内行内语法（渲染态里 `**粗体**` 就是粗体） ----------

const RICH = [
  '| **粗体** | `代码` | 纯文本 |',
  '| --- | --- | --- |',
  '| [链接](https://a.b) | :smile: | x\\|y |'
].join('\n')

function richState(doc = RICH): EditorState {
  const state = EditorState.create({ doc, extensions: [cursiveMarkdown()] })
  expect(ensureSyntaxTree(state, doc.length, 5000), '解析超时').not.toBeNull()
  return state
}

describe('cellTokens：片段取自文档自己的语法树', () => {
  it('强调：标记藏起来，只留内容，偏移指回源码', () => {
    const s = richState()
    const pos = cellPos(s, 0, 0, 0)!
    expect(cellTokens(s, pos.from, pos.to)).toEqual([{ text: '粗体', at: 2, tags: ['strong'] }])
  })

  it('链接：文字留下、URL 进 href（DOM 里不写 href，见 renderTokens）', () => {
    const s = richState()
    const pos = cellPos(s, 0, 1, 0)!
    expect(cellTokens(s, pos.from, pos.to)).toEqual([
      { text: '链接', at: 1, tags: ['a'], href: 'https://a.b' }
    ])
  })

  it('emoji 短代码换成字符', () => {
    const s = richState()
    const pos = cellPos(s, 0, 1, 1)!
    const tokens = cellTokens(s, pos.from, pos.to)
    expect(tokens).toHaveLength(1)
    expect(tokens[0]!.text).not.toContain(':')
  })

  it('转义的 \\| 只藏反斜杠', () => {
    const s = richState()
    const pos = cellPos(s, 0, 1, 2)!
    expect(cellTokens(s, pos.from, pos.to).map((t) => t.text).join('')).toBe('x|y')
  })
})

describe('tableDataAt：只给真有语法的格子存片段', () => {
  it('纯文本格子是 null（绝大多数格子都走这条）', () => {
    const s = richState()
    const data = tableDataAt(s, 0, RICH.length)!
    expect(data.rich![0]![2]).toBeNull()
    expect(data.rich![0]![0]).not.toBeNull()
    expect(data.rich![0]![1]![0]!.tags).toEqual(['code'])
  })

  it('结构不合法时和 parseTable 一样返回 null', () => {
    const s = richState('| a | b |')
    expect(tableDataAt(s, 0, 9)).toBeNull()
  })
})

describe('estimatedHeight：CM 高度图靠它估这一块有多高', () => {
  const widget = (rows: number): TableWidget =>
    new TableWidget(
      {
        aligns: ['left', 'left'],
        header: ['a', 'b'],
        rows: Array.from({ length: rows }, () => ['x', 'y'])
      },
      false,
      null
    )

  // 不给这个数（WidgetType 默认 -1）时 CM 按「一行」算：100 行的表在高度图里只有
  // 一行高 → 滚动条不对、表格块被判在视口外永远不渲染，而且**每次点格子/敲字**
  // 高度图都会先塌回这个估值，估矮了那一帧文档就短一截，视口被甩到文末。
  it('按行数给出数量级正确的估值（不是一行）', () => {
    const one = widget(1).estimatedHeight
    const hundred = widget(100).estimatedHeight
    expect(one).toBeGreaterThan(40)
    expect(hundred).toBeGreaterThan(2000)
    // 线性：每多一行就多一个行高
    expect(hundred - one).toBe((widget(2).estimatedHeight - one) * 99)
  })

  it('表头也占一行', () => {
    expect(widget(0).estimatedHeight).toBeGreaterThan(0)
  })
})

/**
 * 0.4.0 还的第二条账：**格内粘贴**。
 *
 * 事件那一半（`paste` → turndown → execCommand）是 DOM，进不了 node 测试；
 * 这一半是「粘进来的 Markdown 该变成格子里的哪一串」——
 * 而 Markdown 的表格行放不下换行，这条判断错了就是默默吞掉别人的内容。
 */
describe('格内粘贴的文本', () => {
  it('单行原样（`|` 的转义归 escapeCell，那是写回文档那一步的事）', () => {
    expect(cellPasteText('一段文字')).toEqual({ text: '一段文字', lines: 1 })
  })

  it('多行并成一行，并把行数报出来（调用方据此说一句）', () => {
    expect(cellPasteText('第一行\n第二行\n第三行')).toEqual({ text: '第一行 第二行 第三行', lines: 3 })
  })

  it('CRLF 与空行：空行丢掉，不留双空格', () => {
    expect(cellPasteText('甲\r\n\r\n乙')).toEqual({ text: '甲 乙', lines: 2 })
  })

  it('整段是空白 → 空串（调用方据此什么都不插）', () => {
    expect(cellPasteText('  \n\n \t ')).toEqual({ text: '', lines: 0 })
  })
})

/**
 * 「`/table` 插出来的表格显示源码」那条（0.4.0 修）。
 *
 * 新表是靠 `setTableEdit` 才以渲染态出现的（光标就在第一格里）。从前编辑态
 * 「文档一变或选区一动就清」—— 而插完之后必然还有别的事务（滚动、聚焦、按一下键），
 * 编辑态当场没了，光标却还在表里，于是整张表回落成源码。
 */
describe('表格编辑态什么时候退出', () => {
  const doc = '正文\n\n| a | b |\n| --- | --- |\n| c | d |\n'
  const from = doc.indexOf('| a')
  const make = () =>
    EditorState.create({ doc, extensions: [cursiveMarkdown(), tableEditField] }).update({
      selection: { anchor: from + 2 },
      effects: setTableEdit.of(from)
    }).state

  it('光标还在表里 —— 随便来一个带选区的事务也留着', () => {
    const state = make()
    expect(tableEditAt(state)).toBe(from)
    const next = state.update({ selection: { anchor: from + 3 } }).state
    expect(tableEditAt(next), '撑不过下一个事务的话，新插的表当场变回源码').toBe(from)
  })

  it('光标离开这张表 —— 退出编辑态（这条是原本就对的，别改坏）', () => {
    const next = make().update({ selection: { anchor: 1 } }).state
    expect(tableEditAt(next)).toBeNull()
  })

  it('表被整段删掉 —— 编辑态跟着没（不留悬空的位置）', () => {
    const next = make().update({ changes: { from: 2, to: doc.length }, selection: { anchor: 2 } })
      .state
    expect(tableEditAt(next)).toBeNull()
  })

  it('在格子里改字（writeCell 那条路）照旧留在编辑态', () => {
    const state = make()
    const next = state.update(writeCell(state, from, 0, 0, 'aa', 2)!).state
    expect(tableEditAt(next)).toBe(from)
  })
})

/**
 * 「回车加一行之后 ⌘Z 没反应」那条（0.4.0 修）。
 *
 * 真正的病根在 ⌘Z 的**去路**（见 `test/commands.test.ts` 的「撤销这条键盘入口」）：
 * 从前它落进 WebKit 自己那套 DOM 编辑撤销栈，而表格一改结构就把整张表的格子重建了 ——
 * 栈顶那条记录指着的元素当场没了，它既不派事件也不做事。
 *
 * 这一组守的是另一半：**表格这边每个动作都得是「一次 dispatch = 一步撤销」**，
 * 而且撤完要逐字节回到原样。撤销的去路修好之后，这一半才有意义。
 */
describe('表格里的撤销：一个动作一步，撤完逐字节回到原样', () => {
  const withHistory = (doc = DOC): EditorState =>
    EditorState.create({ doc, extensions: [cursiveMarkdown(), history(), tableEditField] })

  /** 跑一次改写 → ⌘Z，返回三份文本给调用方对账 */
  function round(
    run: (s: EditorState) => TransactionSpec | null,
    doc = DOC
  ): { before: string; after: string; undone: string } {
    let state = withHistory(doc)
    const before = state.doc.toString()
    const spec = run(state)
    expect(spec, '这个动作压根没发出事务').not.toBeNull()
    state = state.update(spec!).state
    const after = state.doc.toString()
    expect(undo({ state, dispatch: (tr) => void (state = tr.state) }), '撤销命令自己就没跑').toBe(
      true
    )
    return { before, after, undone: state.doc.toString() }
  }

  const ops: [string, (s: EditorState) => TransactionSpec | null][] = [
    ['下插行', (s) => insertRowAfter(s, TF, 1)],
    ['删行', (s) => deleteRow(s, TF, 1)],
    ['插列', (s) => insertColAt(s, TF, 1, 1)],
    ['删列', (s) => deleteCol(s, TF, 1)],
    ['整列对齐', (s) => setAlign(s, TF, 0, 'right')],
    ['整理对齐', (s) => tidyTable(s, TF)],
    ['删整张表', (s) => deleteTable(s, TF)],
    ['改一格', (s) => writeCell(s, TF, 1, 0, 'a2')]
  ]

  for (const [name, run] of ops) {
    it(`${name}：改了 → 一步撤回原样`, () => {
      const { before, after, undone } = round(run)
      expect(after, '这个动作什么都没改，后面那条断言就是空的').not.toBe(before)
      expect(undone).toBe(before)
    })
  }

  it('撤销之后还留在编辑态 —— 否则 ⌘Z 一按表格就回落源码', () => {
    let state = withHistory().update({ effects: setTableEdit.of(TF) }).state
    state = state.update(insertRowAfter(state, TF, 1)!).state
    expect(tableEditAt(state)).toBe(TF)
    undo({ state, dispatch: (tr) => void (state = tr.state) })
    expect(tableEditAt(state), '撤销事务不带 setTableEdit，靠的是 isHistory 那条分支').toBe(TF)
  })

  it('连打归并成一步（一个字符一步的话撤销栈没法用）', () => {
    let state = withHistory()
    for (const text of ['a2', 'a23']) state = state.update(writeCell(state, TF, 1, 0, text)!).state
    expect(state.doc.toString()).toContain('| a23 ')
    undo({ state, dispatch: (tr) => void (state = tr.state) })
    expect(state.doc.toString()).toBe(DOC)
  })

  it('⌘Z 只撤掉刚加的那一行，不把前面打的字一起吞掉', () => {
    let state = withHistory()
    state = state.update(writeCell(state, TF, 1, 0, 'a2')!).state
    const typed = state.doc.toString()
    state = state.update(insertRowAfter(state, TF, 1)!).state
    expect(state.doc.toString()).not.toBe(typed)
    undo({ state, dispatch: (tr) => void (state = tr.state) })
    expect(state.doc.toString(), '两笔并成一步的话，这里会一路退回打字之前').toBe(typed)
  })

  it('重做把撤掉的那一行拿回来', () => {
    let state = withHistory()
    state = state.update(insertRowAfter(state, TF, 1)!).state
    const added = state.doc.toString()
    undo({ state, dispatch: (tr) => void (state = tr.state) })
    expect(state.doc.toString()).toBe(DOC)
    redo({ state, dispatch: (tr) => void (state = tr.state) })
    expect(state.doc.toString()).toBe(added)
  })
})

/**
 * 表格是文档**最后一行**（结尾没有换行）时的增删 —— 这条路上所有「连着换行一起删」
 * 的写法都得换个方向，越界一个字符就是把正文的最后一个字吃掉。
 */
describe('表格贴着文档末尾（没有结尾换行）', () => {
  const doc = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n')
  const tail = (): EditorState => EditorState.create({ doc })

  it('删最后一行：连它前面那个换行一起走，不留空行', () => {
    const s = tail()
    expect(applied(s, deleteRow(s, 0, 1))).toBe('| a | b |\n| --- | --- |')
  })

  it('在最后一行后面加一行', () => {
    const s = tail()
    expect(applied(s, insertRowAfter(s, 0, 1))).toBe(`${doc}\n|   |   |`)
  })

  it('删整张表：文档空了，也没有多余的换行', () => {
    const s = tail()
    expect(applied(s, deleteTable(s, 0))).toBe('')
  })
})

/** 破行（GFM 允许某一行的格子数与表头对不上）—— 增删列不许把它当成规整的表来算 */
describe('破行的表', () => {
  const doc = ['| a | b | c |', '| --- | --- | --- |', '| 1 |', '| x | y | z |'].join('\n')
  const ragged = (): EditorState => EditorState.create({ doc })

  it('删中间那一列：格子不够的那一行原样放过', () => {
    const out = lines(applied(ragged(), deleteCol(ragged(), 0, 1)))
    expect(out[2]).toBe('| 1 |')
    expect(out[3]).toBe('| x | z |')
  })

  it('追加一列：短行也补得出那一格（否则新列在这行根本不可表达）', () => {
    const s = ragged()
    const out = lines(applied(s, insertColAt(s, 0, 3, 0)))
    expect(parseTable(out.join('\n'))!.header).toHaveLength(4)
    expect(out[2]).toBe('| 1 |   |')
  })

  it('往破行里写超出它列数的那一格 → 先把竖线补够', () => {
    const s = ragged()
    expect(lines(applied(s, writeCell(s, 0, 1, 2, 'z')))[2]).toBe('| 1 |  | z |')
  })
})

/**
 * 格子的焦点环：**必须是 outline，不能是 inset box-shadow**（0.4.0 修）。
 *
 * `border-collapse: collapse` 下，合并出来的那条横线归**表格**画，排在
 * 「格子背景 + 内阴影」之后 —— 环的上边被上一行那条边框整条盖掉，
 * 左/右/下都在，只有上边没有（同一帧两格对照量过：内阴影写法上沿 0/58 个强调色
 * 像素，outline 写法 58/58）。CSS 里没法为这件事写运行时断言，所以按规则扫源码。
 */
describe('单元格焦点环', () => {
  // 注释里正说着「不能用 inset box-shadow」，先剥掉，否则扫的是说明而不是规则
  const css = readFileSync(
    new URL('../src/renderer/themes/live-preview.css', import.meta.url),
    'utf8'
  ).replace(/\/\*[\s\S]*?\*\//g, '')
  const rule =
    css
      .split('}')
      .map((block) => `${block}}`)
      .find((block) => /\.cm-lp-tableview t[hd]:focus\s*[,{]/.test(block) && !block.includes('::')) ??
    ''

  it('确实找得到那条规则（改了选择器就得回来改这条测试）', () => {
    expect(rule).not.toBe('')
  })

  it('用 outline 画，并且 offset 收进格子里', () => {
    expect(rule).toMatch(/outline:\s*1px solid var\(--accent\)/)
    expect(rule).toMatch(/outline-offset:\s*-1px/)
  })

  it('不许退回 inset box-shadow（上边会被合并边框整条盖掉）', () => {
    expect(rule).not.toMatch(/box-shadow/)
  })
})
