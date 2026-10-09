import { describe, expect, it } from 'vitest'
import { compileScope, globToRegex, inScope, parsePatterns } from '../src/renderer/ui/search-scope'

/**
 * 第八节 11：跨文件搜索的包含 / 排除条件。规则只在 `ui/search-scope.ts` 写一处，
 * 壳侧按同样的几行套用编译好的正则 —— 这里钉住「人写的模式到底认哪些路径」。
 */

const scope = (include: string, exclude = '') => compileScope(include, exclude)

describe('包含 / 排除的路径模式', () => {
  it('逗号（中英文）、换行分隔；空的丢掉', () => {
    expect(parsePatterns(' *.md, drafts，docs/**\n\n , ')).toEqual(['*.md', 'drafts', 'docs/**'])
  })

  it('不带斜杠的模式认任何一层：文件名或者某一层文件夹', () => {
    const s = scope('', 'drafts')
    expect(inScope('drafts/a.md', s)).toBe(false)
    expect(inScope('notes/drafts/a.md', s)).toBe(false)
    // 只是名字里带着 drafts 的不算
    expect(inScope('drafts-old/a.md', s)).toBe(true)
    expect(inScope('my-drafts.md', s)).toBe(true)
    // 文件夹本身也认得出来（壳据此整棵跳过）
    expect(inScope('notes/drafts', s)).toBe(false)
  })

  it('* 只在一节里通配，** 跨节，? 一个字符', () => {
    expect(inScope('a/b/c.md', scope('*.md'))).toBe(true)
    expect(inScope('a/b/c.txt', scope('*.md'))).toBe(false)
    expect(inScope('src/a.md', scope('src/*.md'))).toBe(true)
    expect(inScope('src/sub/a.md', scope('src/*.md'))).toBe(false)
    expect(inScope('src/sub/a.md', scope('src/**/*.md'))).toBe(true)
    expect(inScope('src/a.md', scope('src/**/*.md'))).toBe(true)
    expect(inScope('ch1.md', scope('ch?.md'))).toBe(true)
    expect(inScope('ch10.md', scope('ch?.md'))).toBe(false)
  })

  it('认到一个文件夹，底下的一并算；中间带斜杠的从范围的根算起，末尾的斜杠不算', () => {
    for (const p of ['docs', 'docs/', 'docs/**', './docs/**', '**/docs/**']) {
      const s = scope(p)
      expect(inScope('docs/a.md', s), p).toBe(true)
      expect(inScope('docs/x/y.md', s), p).toBe(true)
      expect(inScope('other/a.md', s), p).toBe(false)
    }
    // 深层的同名：不带斜杠（末尾的不算）与 `**/` 开头的认，从根算起的不认
    for (const p of ['docs', 'docs/', '**/docs/**']) expect(inScope('notes/docs/a.md', scope(p)), p).toBe(true)
    for (const p of ['docs/**', './docs/**']) expect(inScope('notes/docs/a.md', scope(p)), p).toBe(false)
    expect(inScope('notes/docs/a.md', scope('docs/api'))).toBe(false)
    expect(inScope('docs/api/a.md', scope('docs/api'))).toBe(true)
  })

  it('包含与排除一起：先排除，再要求至少命中一条包含', () => {
    const s = scope('*.md, *.txt', 'archive, *.draft.md')
    expect(inScope('a.md', s)).toBe(true)
    expect(inScope('b/c.txt', s)).toBe(true)
    expect(inScope('archive/a.md', s)).toBe(false)
    expect(inScope('x.draft.md', s)).toBe(false)
    expect(inScope('a.markdown', s)).toBe(false)
  })

  it('正则里的特殊字符原样当字面量；写坏了的当没写', () => {
    expect(inScope('a+b (1).md', scope('a+b (1).md'))).toBe(true)
    expect(inScope('aab (1).md', scope('a+b (1).md'))).toBe(false)
    expect(globToRegex('/')).toBeNull()
    expect(globToRegex('**')).toBeNull()
    expect(scope(' , / ,**')).toEqual({ include: [], exclude: [] })
    // 没写条件 = 全都在范围里
    expect(inScope('anything/at/all.md', scope('', ''))).toBe(true)
  })

  it('编出来的正则在壳侧（ICU）也成立：只用到两边语义一致的那几样', () => {
    for (const p of ['*.md', 'drafts', 'docs/**', 'src/**/*.md', 'ch?.md', 'a+b (1).md']) {
      const re = globToRegex(p)!
      // 不许出现 JS 与 ICU 理解不同的写法：命名组、lookbehind、\d 这类缩写、Unicode 属性
      expect(re).not.toMatch(/\(\?<|\\[dDwWsSpP]/)
    }
  })
})
