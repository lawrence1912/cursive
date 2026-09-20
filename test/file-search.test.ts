import { describe, expect, it } from 'vitest'
import { buildTargets, hitKey, relativeDir } from '../src/renderer/ui/file-search'
import type { SearchHit } from '../src/shared/types'

/**
 * P3-2：搜索结果里每个文件后面那一小段目录。看着是装饰，实际是「同名文件哪个是哪个」
 * 的唯一线索，所以三种情况都得对：就在树根下、在子目录里、以及两边 `/private` 不一致。
 */
describe('relativeDir', () => {
  it('就在树根下时什么都不显示', () => {
    expect(relativeDir('/Users/me/notes/a.md', '/Users/me/notes')).toBe('')
  })

  it('子目录只显示相对的那一段', () => {
    expect(relativeDir('/Users/me/notes/2026/q3/a.md', '/Users/me/notes')).toBe('2026/q3')
  })

  it('/private 前缀两边不一致也认得出同一个目录', () => {
    // macOS 上 /tmp 是 /private/tmp 的软链：树根从 argv 来、命中从枚举器来，很容易一边带一边不带
    expect(relativeDir('/private/tmp/notes/a.md', '/tmp/notes')).toBe('')
    expect(relativeDir('/tmp/notes/sub/a.md', '/private/tmp/notes')).toBe('sub')
  })

  it('太长的中间段从左边截，尾巴留着', () => {
    const out = relativeDir(`/root/${'seg/'.repeat(12)}a.md`, '/root')
    expect(out.startsWith('…')).toBe(true)
    expect(out.endsWith('seg')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(31)
  })

  it('没有树根时退化成整条目录（仍然从左边截）', () => {
    expect(relativeDir('/a/b/c.md', null)).toBe('/a/b')
  })

  it('路径开头那个斜杠不会被挪走', () => {
    // 曾用 direction: rtl 让 text-overflow 把省略号放前面，结果双向重排把 `/` 甩到了行尾
    expect(relativeDir('/a/b/c.md', null).startsWith('/')).toBe(true)
  })
})

/**
 * 0.4.0 F2 跨文件替换：**送给壳的那份清单**。
 *
 * 改盘那一半在壳里（指纹、快照、逐字校验），而这一半决定「改哪些处」——
 * 送错一条就是改错一个文件，所以这几行值得单独盯着。
 */
describe('替换清单（契约 v30）', () => {
  const hit = (over: Partial<SearchHit> = {}): SearchHit => ({
    path: '/w/a.md',
    line: 3,
    col: 5,
    length: 2,
    text: '前面 术语 后面',
    textCol: 3,
    ...over
  })

  it('原文按 textCol 从展示串里切出来 —— 壳侧靠它逐字校验', () => {
    const out = buildTargets([{ path: '/w/a.md', hits: [hit()] }], new Set())
    expect(out).toEqual([{ path: '/w/a.md', hits: [{ line: 3, col: 5, length: 2, match: '术语' }] }])
  })

  it('勾掉的那些不许出现在清单里（所见即所改）', () => {
    const groups = [{ path: '/w/a.md', hits: [hit(), hit({ line: 9 })] }]
    const out = buildTargets(groups, new Set([hitKey(0, 0)]))
    expect(out[0]!.hits.map((h) => h.line)).toEqual([9])
  })

  it('一个文件的命中被勾光了，这个文件就整个不送（壳那边省一次读写）', () => {
    const groups = [
      { path: '/w/a.md', hits: [hit()] },
      { path: '/w/b.md', hits: [hit({ path: '/w/b.md' })] }
    ]
    const out = buildTargets(groups, new Set([hitKey(0, 0)]))
    expect(out.map((t) => t.path)).toEqual(['/w/b.md'])
  })

  it('一处都没剩 = 空清单（调用方据此不发这一趟）', () => {
    expect(buildTargets([{ path: '/w/a.md', hits: [hit()] }], new Set([hitKey(0, 0)]))).toEqual([])
  })

  it('前面截断过的窗口（带前导 …）也切得对', () => {
    const out = buildTargets(
      [{ path: '/w/a.md', hits: [hit({ text: '…很长的前文 术语 后面', textCol: 7 })] }],
      new Set()
    )
    expect(out[0]!.hits[0]!.match).toBe('术语')
  })
})
