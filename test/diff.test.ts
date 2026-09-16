import { describe, expect, it } from 'vitest'
import { collapse, diffLines, diffStat, splitLines } from '../src/renderer/editor/diff'

/** 紧凑写法：`=甲` 相同、`+甲` 新增、`-甲` 删除 */
function sketch(oldText: string, newText: string): string[] {
  return diffLines(oldText, newText).map(
    (r) => ({ same: '=', add: '+', del: '-' })[r.kind] + r.text
  )
}

describe('splitLines', () => {
  it('末尾的换行是行结束符，不算一条空行', () => {
    expect(splitLines('甲\n乙\n')).toEqual(['甲', '乙'])
    expect(splitLines('甲\n乙')).toEqual(['甲', '乙'])
  })

  it('空文本 = 零行', () => {
    expect(splitLines('')).toEqual([])
  })

  it('文档里真有的空行要留着', () => {
    expect(splitLines('甲\n\n乙\n')).toEqual(['甲', '', '乙'])
  })
})

describe('逐行差异', () => {
  it('完全相同 → 全是 same', () => {
    expect(sketch('甲\n乙\n', '甲\n乙\n')).toEqual(['=甲', '=乙'])
  })

  it('中间改一行 → 删在增前面（读起来是「原来这样 → 现在那样」）', () => {
    expect(sketch('甲\n乙\n丙\n', '甲\n乙2\n丙\n')).toEqual(['=甲', '-乙', '+乙2', '=丙'])
  })

  it('纯新增', () => {
    expect(sketch('甲\n', '甲\n乙\n')).toEqual(['=甲', '+乙'])
  })

  it('纯删除', () => {
    expect(sketch('甲\n乙\n', '甲\n')).toEqual(['=甲', '-乙'])
  })

  it('从空文档写起 / 全删光', () => {
    expect(sketch('', '甲\n')).toEqual(['+甲'])
    expect(sketch('甲\n', '')).toEqual(['-甲'])
  })

  it('整段搬家能认出公共行（LCS 不是逐行硬比）', () => {
    expect(sketch('甲\n乙\n丙\n', '乙\n丙\n甲\n')).toEqual(['-甲', '=乙', '=丙', '+甲'])
  })

  it('行号两套：旧版一套、新版一套，新增行没有旧行号', () => {
    const rows = diffLines('甲\n乙\n', '甲\n新\n乙\n')
    expect(rows.map((r) => [r.kind, r.oldLine, r.newLine])).toEqual([
      ['same', 1, 1],
      ['add', undefined, 2],
      ['same', 2, 3]
    ])
  })

  it('统计只数增删', () => {
    expect(diffStat(diffLines('甲\n乙\n丙\n', '甲\n乙2\n丙\n丁\n'))).toEqual({ added: 2, removed: 1 })
  })
})

describe('掐头去尾（长文档上不硬算整表）', () => {
  it('几千行里改一处，结果仍然精确', () => {
    const base = Array.from({ length: 4000 }, (_, i) => `第 ${i} 行`).join('\n')
    const changed = base.replace('第 2000 行', '第 2000 行（改过）')
    const rows = diffLines(base, changed)
    expect(diffStat(rows)).toEqual({ added: 1, removed: 1 })
    expect(rows.length).toBe(4001)
  })

  it('两边都超过 DP 上限 → 退化成整段替换，不卡住', () => {
    const a = Array.from({ length: 1500 }, (_, i) => `a${i}`).join('\n')
    const b = Array.from({ length: 1500 }, (_, i) => `b${i}`).join('\n')
    const rows = diffLines(a, b)
    expect(diffStat(rows)).toEqual({ added: 1500, removed: 1500 })
  })
})

describe('折叠相同段', () => {
  it('改动上下各留三行，中间折成一条', () => {
    const old = Array.from({ length: 20 }, (_, i) => `L${i}`).join('\n')
    const now = old.replace('L10', 'L10改')
    const chunks = collapse(diffLines(old, now))
    // 21 行：L0-L9 相同、-L10、+L10改、L11-L19 相同。
    // 改动落在第 10、11 条上，各留 ±3 → 保住 7..14 这 8 条；前面折 7 条、后面折 6 条
    expect(chunks.map((c) => (c.skipped ? `skip${c.skipped}` : `rows${c.rows.length}`))).toEqual([
      'skip7',
      'rows8',
      'skip6'
    ])
  })

  it('全是相同行 → 整份折成一条', () => {
    const same = 'a\nb\nc\n'
    expect(collapse(diffLines(same, same))).toEqual([{ skipped: 3, rows: [] }])
  })

  it('折叠不丢改动行', () => {
    const old = Array.from({ length: 50 }, (_, i) => `L${i}`).join('\n')
    const now = old.replace('L5', 'X').replace('L40', 'Y')
    const chunks = collapse(diffLines(old, now))
    const kept = chunks.flatMap((c) => c.rows).filter((r) => r.kind !== 'same')
    expect(kept.map((r) => r.text).sort()).toEqual(['L40', 'L5', 'X', 'Y'])
  })
})
