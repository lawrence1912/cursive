import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readFailKind, readFailSticky } from '../src/renderer/ui/read-error'

/**
 * 「这份文件为什么打不开」（第八节 4，契约 v35）。
 *
 * 要守的是两件事：**四种失败说四句不同的话**（从前全是同一句「读不到文件」），
 * 以及**那三条打开文件的路都真的接住了它** —— 从前文件树与搜索结果点一下压根没有
 * catch，点开一个 GBK 编码的 .md 屏幕上什么都不会发生。
 */

describe('壳侧回来的那个类别', () => {
  const err = (m: string): Error => new Error(m)

  it('四类各自认得出来', () => {
    expect(readFailKind(err('notUtf8|/a/b.md'))).toBe('notUtf8')
    expect(readFailKind(err('notFound|/a/b.md'))).toBe('notFound')
    expect(readFailKind(err('denied|/a/b.md'))).toBe('denied')
    expect(readFailKind(err('io|/a/b.md'))).toBe('io')
  })

  it('路径里有竖线也不影响 —— 只认第一根之前那一段', () => {
    expect(readFailKind(err('notFound|/a/怪|名字.md'))).toBe('notFound')
  })

  it('认不出来一律当 io：将来多一类、或者别处随手抛一个 Error，都不许让那句话消失', () => {
    expect(readFailKind(err('boom'))).toBe('io')
    expect(readFailKind(err('someNewKind|/a.md'))).toBe('io')
    expect(readFailKind('不是 Error')).toBe('io')
    expect(readFailKind(undefined)).toBe('io')
  })

  it('不会自己好的那两类才黏住', () => {
    expect(readFailSticky('notUtf8')).toBe(true)
    expect(readFailSticky('denied')).toBe(true)
    // 找不到：刷一下树就知道了；IO：下一次可能就好了 —— 都不该在状态栏上赖着不走
    expect(readFailSticky('notFound')).toBe(false)
    expect(readFailSticky('io')).toBe(false)
  })
})

describe('接线', () => {
  const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
  const main = read('src/renderer/main.ts')

  it('三条打开文件的路都接住了失败，而且走同一句话', () => {
    for (const fn of ['async function openPath(', 'async function openHit(', 'async function openDocLink(']) {
      const at = main.indexOf(fn)
      expect(at, `${fn} 不见了`).toBeGreaterThan(0)
      const body = main.slice(at, main.indexOf('\n}\n', at))
      expect(body, `${fn} 里那句 read 没人接`).toContain('openFailed(')
    }
  })

  it('四类各有各的文案与下一步', () => {
    const at = main.indexOf('function openFailed(')
    const body = main.slice(at, main.indexOf('\n}\n', at))
    for (const k of ['open.notUtf8', 'open.notFound', 'open.denied', 'open.io']) {
      expect(body).toContain(k)
    }
    expect(body, 'IO 那一类给重试').toContain("kind === 'io' && retry")
    expect(body, '找不到 → 刷新它所在那一级').toContain('note.refreshTree')
    expect(body, '不是 UTF-8 / 没权限 → 把人送到文件门口').toContain('note.reveal')
    expect(body).toContain('sticky: readFailSticky(kind)')
  })

  it('sticky 的消息没有计时器，而且给得出「让它走」的办法', () => {
    const note = read('src/renderer/ui/note.ts')
    const at = note.indexOf('if (opts.sticky)')
    expect(at).toBeGreaterThan(0)
    expect(note).toContain('note.dismiss')
    // 那句 return 必须排在 setTimeout 之前
    expect(note.indexOf('if (opts.sticky) return')).toBeLessThan(note.indexOf('timer = window.setTimeout'))
  })

  it('导出在渲染层这一侧断了也要说话，并且不自散', () => {
    const at = main.indexOf('function exportFailed(')
    const body = main.slice(at, main.indexOf('\n}\n', at))
    expect(body).toContain('note.exportFailed')
    expect(body).toContain('sticky: true')
    expect(body).toContain('status.retry')
    // 两条导出路径都接上了
    expect(main.slice(main.indexOf("case 'file:export-html'"))).toContain('exportFailed(e,')
    expect(main.slice(main.indexOf("case 'file:export-png'"))).toContain('exportFailed(e,')
  })

  it('壳侧分类的顺序不能换（契约 v35）', () => {
    const swift = read('shell-swift/main.swift')
    const at = swift.indexOf('private func readFailKind(')
    expect(at).toBeGreaterThan(0)
    const body = swift.slice(at, swift.indexOf('\n    }\n', at))
    // 先认我们自己抛的那个域 —— 一个存在且可读的 GBK 文件否则会被归成 io
    expect(body.indexOf('cursive.io')).toBeLessThan(body.indexOf('fileExists'))
    expect(body.indexOf('fileExists')).toBeLessThan(body.indexOf('isReadableFile'))
    // 回的是「类别 | 路径」，一个字的文案都不带
    expect(swift).toContain('reject(id, "\\(readFailKind(rp, error))|\\(rp)")')
  })
})
