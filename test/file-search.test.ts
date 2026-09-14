import { describe, expect, it } from 'vitest'
import { relativeDir } from '../src/renderer/ui/file-search'

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
