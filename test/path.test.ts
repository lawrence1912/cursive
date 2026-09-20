import { describe, expect, it } from 'vitest'
import { relativeLink, resolvePath } from '../src/shared/path'

/**
 * 0.4.0 F3：链接补全插进去的那条相对路径。
 *
 * 它与 `resolvePath` 必须互为逆 —— 补出来的链接**得点得动**，而点击那条路
 * （`editor/link.ts`）走的就是 `resolvePath`。这一条是这个函数存在的全部理由，
 * 所以每个用例都顺手往回解一次。
 */
describe('relativeLink', () => {
  const back = (from: string, to: string): string => resolvePath(from, relativeLink(from, to))

  it('同一个目录 = 裸文件名', () => {
    expect(relativeLink('/w/notes', '/w/notes/别的文档.md')).toBe('别的文档.md')
    expect(back('/w/notes', '/w/notes/别的文档.md')).toBe('/w/notes/别的文档.md')
  })

  it('下一层 = 带目录段', () => {
    expect(relativeLink('/w', '/w/sub/a.md')).toBe('sub/a.md')
    expect(back('/w', '/w/sub/a.md')).toBe('/w/sub/a.md')
  })

  it('上一层 / 隔壁目录 = 退到 ..', () => {
    expect(relativeLink('/w/a', '/w/b.md')).toBe('../b.md')
    expect(relativeLink('/w/a/deep', '/w/b/c.md')).toBe('../../b/c.md')
    expect(back('/w/a/deep', '/w/b/c.md')).toBe('/w/b/c.md')
  })

  it('一段前缀都不共享（不同卷）→ 原样回绝对路径，不写一串 ../..', () => {
    expect(relativeLink('/Volumes/A/x', '/Users/me/y.md')).toBe('/Users/me/y.md')
  })

  it('名字里有空格照样算得对（调用方负责写成 <…>）', () => {
    expect(relativeLink('/w', '/w/我的 笔记.md')).toBe('我的 笔记.md')
    expect(back('/w', '/w/我的 笔记.md')).toBe('/w/我的 笔记.md')
  })
})
