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
  cellPasteText
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
