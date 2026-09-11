import { describe, expect, it } from 'vitest'
import { cellSpan, parseTable } from '../src/renderer/editor/live-preview/widgets'

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
