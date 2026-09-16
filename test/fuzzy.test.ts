import { describe, expect, it } from 'vitest'
import { fuzzy, fuzzyPath } from '../src/renderer/ui/fuzzy'

/** 按分数排完序的名字，方便断言「谁该排在前面」 */
function rank(query: string, names: string[], scorer = fuzzy): string[] {
  return names
    .map((n) => ({ n, hit: scorer(query, n) }))
    .filter((x) => x.hit !== null)
    .sort((a, b) => b.hit!.score - a.hit!.score)
    .map((x) => x.n)
}

describe('子序列匹配', () => {
  it('顺序必须对得上 —— 乱序不算命中', () => {
    expect(fuzzy('mdl', 'markdown-lang')).not.toBeNull()
    expect(fuzzy('lmd', 'markdown-lang')).toBeNull()
  })

  it('不区分大小写', () => {
    expect(fuzzy('TS', 'typescript')).not.toBeNull()
  })

  it('空查询命中一切（面板空着时列全部）', () => {
    expect(fuzzy('', '随便什么')).toEqual({ score: 0, positions: [] })
  })

  it('查询比目标长，直接否', () => {
    expect(fuzzy('abcdef', 'abc')).toBeNull()
  })

  it('positions 指着真正命中的那几个字', () => {
    expect(fuzzy('ab', 'xaxb')?.positions).toEqual([1, 3])
  })

  it('查询里的空格是分段符，不参与匹配', () => {
    expect(fuzzy('fmt 表', 'fmt表格')).not.toBeNull()
  })
})

describe('排序偏好', () => {
  it('连着的排在散开的前面', () => {
    expect(rank('abc', ['a-b-c-x', 'abcx'])[0]).toBe('abcx')
  })

  it('词首命中排在词中前面', () => {
    expect(rank('ml', ['normal', 'markdown-lang'])[0]).toBe('markdown-lang')
  })

  it('同样命中时短的排前面', () => {
    expect(rank('api', ['api.md', 'api-reference-v2.md'])[0]).toBe('api.md')
  })

  it('中文逐字匹配（每个字都是词首）', () => {
    expect(fuzzy('告示', '告示块')).not.toBeNull()
    expect(rank('公式', ['行内公式', '公式块'])[0]).toBe('公式块')
  })
})

describe('路径打分', () => {
  it('文件名命中压过目录命中 —— 查 test 要先给出叫 test 的文件', () => {
    const got = rank('test', ['test/fixtures/callout.md', 'src/test.md'], fuzzyPath)
    expect(got[0]).toBe('src/test.md')
  })

  it('目录段照样能匹配（`ui/fu` 找得到 ui/fuzzy.ts）', () => {
    expect(fuzzyPath('ui/fu', 'src/renderer/ui/fuzzy.ts')).not.toBeNull()
  })

  it('命中在文件名上时，下标是整条路径的坐标', () => {
    const path = 'a/bc.md'
    const hit = fuzzyPath('bc', path)!
    expect(hit.positions.map((i) => path[i])).toEqual(['b', 'c'])
  })

  it('长路径末尾的精确命中不该被距离惩罚压死', () => {
    const deep = 'a/very/deeply/nested/folder/chain/here/notes.md'
    expect(fuzzyPath('notes', deep)).not.toBeNull()
    expect(rank('notes', [deep, 'no-thing-else-s.md'], fuzzyPath)[0]).toBe(deep)
  })
})
