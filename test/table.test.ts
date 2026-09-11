import { describe, expect, it } from 'vitest'
import { parseTable } from '../src/renderer/editor/live-preview/widgets'

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
