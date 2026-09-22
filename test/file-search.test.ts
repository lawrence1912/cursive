import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildTargets, hitKey, relativeDir, toggleOpt } from '../src/renderer/ui/file-search'
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

/**
 * 两层开关（0.4.1 修）：**人自己按出来的那套**（存偏好）与**这一次临时生效的那套**
 * （点 front matter 里的标签带出来的那条正则）。
 *
 * 从前只有一层：`search(query, opts)` 直接 `this.opts = {...this.opts, ...opts}`。
 * 于是 `regex:true` 关掉面板也不还原，而他下一次随手点任何一颗开关，
 * `saveOpts()` 就把混进去的那一位**一起写进了 localStorage** —— 点一次标签，
 * 人工搜索从此默认按正则。面板那半是 DOM（node 环境里造不出来），所以这里扫的是
 * 那条边界本身：临时的那套**碰不到** `this.opts`，而落盘的只有 `this.opts`。
 * 真机那半在 `release.sh` 的 `tagProbe.restored`（关掉面板，那颗 `.*` 回到原样）。
 */
describe('临时开关不许污染人工搜索', () => {
  const src = readFileSync(new URL('../src/renderer/ui/file-search.ts', import.meta.url), 'utf8')
  const method = (name: string): string => {
    const at = src.indexOf(`\n  ${name}(`)
    expect(at, `没找着 ${name}`).toBeGreaterThan(0)
    return src.slice(at, src.indexOf('\n  }', at))
  }

  it('外面塞进来的那套只进 once，不碰 this.opts', () => {
    const body = method('search')
    expect(body).toContain('this.once = opts ?? null')
    expect(body, '合进 this.opts 就等于改了他存着的偏好').not.toContain('this.opts =')
  })

  it('搜的时候用的是「生效的那套」', () => {
    expect(src).toContain('window.api.searchFiles(this.token, this.root, query, this.effectiveOpts())')
    expect(src).toContain('return { ...this.opts, ...this.once }')
  })

  it('落盘的只有 this.opts —— once 永远不进 localStorage', () => {
    const body = method('private saveOpts')
    expect(body).toContain('JSON.stringify(this.opts)')
    expect(body).not.toContain('effectiveOpts')
  })

  it('关面板 / 清空，临时那套就作废', () => {
    expect(method('hide')).toContain('this.once = null')
    expect(method('private clear')).toContain('this.once = null')
  })

  it('按钮显示的是生效的那套（所见即所搜）', () => {
    expect(method('private syncOpts')).toContain('const eff = this.effectiveOpts()')
  })

  it('点开关走的是那个纯函数', () => {
    const at = src.indexOf(".querySelector('.fs-opts')!.addEventListener")
    const handler = src.slice(at, src.indexOf('})', at))
    expect(handler).toContain('toggleOpt(this.opts, this.once, key)')
  })
})

/**
 * 点一颗开关时**翻的是他看得见的那一颗**（0.4.1 修的第二版）。
 *
 * 第一版是「人一按就把临时那套整个作废，然后翻 `this.opts` 里那一位」——
 * 于是标签搜索临时把 `.*` 打开之后，他再点那颗**亮着**的按钮：`opts.regex` 从
 * false 翻成 true，生效值还是 true，**按钮纹丝不动**，而 `saveOpts()` 顺手把
 * `regex: true` 写进了他的偏好 —— 一次点击，两件事全反了。
 */
describe('点一颗开关', () => {
  const OFF = { caseSensitive: false, wholeWord: false, regex: false } as const

  it('临时开着的那颗，点一下就该灭 —— 而且不许把 true 写进偏好', () => {
    const r = toggleOpt({ ...OFF }, { regex: true }, 'regex')
    expect({ ...r.opts, ...r.once }.regex, '生效值必须变成 false').toBe(false)
    expect(r.opts.regex, '他存着的那位本来就是 false，点完还是 false').toBe(false)
  })

  it('他自己开着的那颗，点一下同样是灭', () => {
    const r = toggleOpt({ ...OFF, regex: true }, null, 'regex')
    expect(r.opts.regex).toBe(false)
  })

  it('灭着的点亮', () => {
    expect(toggleOpt({ ...OFF }, null, 'caseSensitive').opts.caseSensitive).toBe(true)
  })

  it('只作废这一颗的临时值，别的留着 —— 点「Aa」不该把那条正则退回字面量', () => {
    const r = toggleOpt({ ...OFF }, { regex: true, wholeWord: false }, 'caseSensitive')
    expect(r.opts.caseSensitive).toBe(true)
    expect(r.once).toEqual({ regex: true, wholeWord: false })
    expect({ ...r.opts, ...r.once }.regex).toBe(true)
  })

  it('临时那套空了就回 null（省得空对象一直挂着）', () => {
    expect(toggleOpt({ ...OFF }, { regex: true }, 'regex').once).toBeNull()
    expect(toggleOpt({ ...OFF }, null, 'regex').once).toBeNull()
  })

  it('不改传进来的那两个对象（调用方靠返回值赋值）', () => {
    const opts = { ...OFF }
    const once = { regex: true }
    toggleOpt(opts, once, 'regex')
    expect(opts).toEqual(OFF)
    expect(once).toEqual({ regex: true })
  })
})
