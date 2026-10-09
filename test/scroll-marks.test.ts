import { describe, expect, it } from 'vitest'
import { markRuns } from '../src/renderer/editor/scroll-marks'

/** 一排一条的画法（每处命中折算成一排，去重）——合成段之后，展开回去必须正好是这些排 */
function rows(starts: number[], topOf: (pos: number) => number, total: number, height: number): number[] {
  return [...new Set(starts.map((p) => Math.round((topOf(p) / total) * height)))].sort((a, b) => a - b)
}

function expand(runs: [number, number][]): number[] {
  return runs.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i))
}

describe('滚动条上的查找刻度', () => {
  it('同一排合成一处，挨着的几排连成一段', () => {
    const tops = [30, 40, 50, 90, 91, 100, 200]
    expect(markRuns([0, 1, 2, 3, 4, 5, 6], (i) => tops[i]!, 1000, 100)).toEqual([[3, 5], [9, 10], [20, 20]])
  })

  it('命中密的时候刻度铺满整根滚动条（从前截在 400 条，下面四成一条都没有）', () => {
    // 照 measure.py 那份文档的形状：一万行、约四千处命中、28 万像素高，滚动条 652px
    const total = 282_000
    const height = 652
    const starts = Array.from({ length: 3948 }, (_, i) => i * 70)
    const topOf = (pos: number) => (pos / (3948 * 70)) * total
    const runs = markRuns(starts, topOf, total, height)
    expect(expand(runs)).toEqual(rows(starts, topOf, total, height))
    expect(runs[runs.length - 1]![1]).toBeGreaterThan(640)
    // 段数远少于排数：挨着的连成了一段，节点不随命中数涨
    expect(runs.length).toBeLessThan(20)
  })

  it('稀疏的命中一处一段，展开与一排一条完全相同', () => {
    const starts = [5, 900, 901, 4000, 12_000, 12_001, 30_000]
    const topOf = (pos: number) => pos * 3
    expect(expand(markRuns(starts, topOf, 100_000, 700))).toEqual(rows(starts, topOf, 100_000, 700))
  })
})
