import { ChangeSet } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { NAV_MAX, NavHistory, sameDoc, type NavSpot } from '../src/renderer/ui/nav-history'

/** 第八节 6 后退 / 前进的记录本身（跳过去那一下在 main.ts，原生专项另验） */

const at = (tabId: number, path: string | null, pos: number, top = pos): NavSpot => ({ tabId, path, pos, top })

describe('NavHistory：浏览器那一套', () => {
  it('从 A 跳到 B 的标题：后退回到 A 的原位置，再前进回到 B', () => {
    const nav = new NavHistory()
    const a = at(1, '/a.md', 120, 80)
    const b = at(2, '/b.md', 300)
    nav.record(a, b)
    expect(nav.canBack(b)).toBe(true)
    expect(nav.canForward(b)).toBe(false)
    expect(nav.back(b)).toEqual(a)
    expect(nav.canForward(a)).toBe(true)
    expect(nav.forward(a)).toEqual(b)
  })

  it('同文档跳转同样适用', () => {
    const nav = new NavHistory()
    nav.record(at(1, '/a.md', 10), at(1, '/a.md', 500))
    expect(nav.back(at(1, '/a.md', 500))).toEqual(at(1, '/a.md', 10))
    expect(nav.forward(at(1, '/a.md', 10))).toEqual(at(1, '/a.md', 500))
  })

  it('离开之前刷新当前这一格：落点之后往下读了一段，前进回来回到读到的地方', () => {
    const nav = new NavHistory()
    nav.record(at(1, '/a.md', 10), at(2, '/b.md', 300))
    // 在 B 里往下读到 900 才后退
    expect(nav.back(at(2, '/b.md', 900, 860))).toEqual(at(1, '/a.md', 10))
    expect(nav.forward(at(1, '/a.md', 10))).toEqual(at(2, '/b.md', 900, 860))
  })

  it('后退之后再跳一次：往后那一截作废', () => {
    const nav = new NavHistory()
    nav.record(at(1, '/a.md', 0), at(2, '/b.md', 0))
    nav.record(at(2, '/b.md', 0), at(3, '/c.md', 0))
    nav.back(at(3, '/c.md', 0))
    nav.record(at(2, '/b.md', 5), at(4, '/d.md', 0))
    expect(nav.canForward(at(4, '/d.md', 0))).toBe(false)
    expect(nav.back(at(4, '/d.md', 0))).toEqual(at(2, '/b.md', 5))
    expect(nav.back(at(2, '/b.md', 5))).toEqual(at(1, '/a.md', 0))
  })

  it('人自己切了标签（不记）再后退：先回到切走之前的那一格，而不是跳过它', () => {
    const nav = new NavHistory()
    nav.record(at(1, '/a.md', 0), at(2, '/b.md', 40))
    // 点标签去了 X（不算跳转），在 X 里按后退
    const x = at(9, '/x.md', 7)
    expect(nav.canBack(x)).toBe(true)
    expect(nav.back(x)).toEqual(at(2, '/b.md', 40))
    // 再前进回到 X
    expect(nav.forward(at(2, '/b.md', 40))).toEqual(x)
  })

  it('后退之后人自己去了别处：前进那一截作废，按钮跟着灰', () => {
    const nav = new NavHistory()
    nav.record(at(1, '/a.md', 0), at(2, '/b.md', 0))
    nav.back(at(2, '/b.md', 0))
    expect(nav.canForward(at(1, '/a.md', 0))).toBe(true)
    expect(nav.canForward(at(7, '/z.md', 0))).toBe(false)
    expect(nav.forward(at(7, '/z.md', 0))).toBeNull()
  })

  it('原地不动不算一次跳转（点了光标本来就在的那个标题）', () => {
    const nav = new NavHistory()
    nav.record(at(1, '/a.md', 3), at(1, '/a.md', 3))
    expect(nav.canBack(at(1, '/a.md', 3))).toBe(false)
    expect(nav.back(at(1, '/a.md', 3))).toBeNull()
  })

  it('没有记录时两颗都灰，按下去返回 null', () => {
    const nav = new NavHistory()
    expect(nav.canBack(at(1, null, 0))).toBe(false)
    expect(nav.canForward(at(1, null, 0))).toBe(false)
    expect(nav.back(at(1, null, 0))).toBeNull()
    expect(nav.forward(at(1, null, 0))).toBeNull()
  })

  it(`最多记 ${NAV_MAX} 格，砍的是最老的`, () => {
    const nav = new NavHistory()
    for (let i = 0; i < NAV_MAX + 10; i++) nav.record(at(1, '/a.md', i), at(1, '/a.md', i + 1))
    let here = at(1, '/a.md', NAV_MAX + 10)
    let steps = 0
    for (let s = nav.back(here); s; s = nav.back(here)) {
      here = s
      steps++
    }
    expect(steps).toBe(NAV_MAX - 1)
    expect(here.pos).toBe(11)
  })
})

describe('NavHistory：跟着文档与标签走', () => {
  it('改文档：记在这个标签名下的位置跟着挪', () => {
    const nav = new NavHistory()
    nav.record(at(1, '/a.md', 100, 90), at(1, '/a.md', 400))
    // 在文首插 10 个字
    nav.map(1, ChangeSet.of([{ from: 0, insert: '0123456789' }], 1000))
    expect(nav.back(at(1, '/a.md', 410))).toEqual(at(1, '/a.md', 110, 100))
  })

  it('别的标签的改动不碰它', () => {
    const nav = new NavHistory()
    nav.record(at(1, '/a.md', 100), at(2, '/b.md', 0))
    nav.map(2, ChangeSet.of([{ from: 0, insert: 'xx' }], 50))
    expect(nav.back(at(2, '/b.md', 2))).toEqual(at(1, '/a.md', 100))
  })

  it('标签关了又开（id 换了）：按路径认回来，之后的映射接得上', () => {
    const nav = new NavHistory()
    nav.record(at(1, '/a.md', 100), at(2, '/b.md', 0))
    nav.rebind('/a.md', 7)
    nav.map(7, ChangeSet.of([{ from: 0, insert: 'xx' }], 500))
    expect(nav.back(at(2, '/b.md', 0))).toEqual(at(7, '/a.md', 102))
  })

  it('改名 / 搬走目录：路径按前缀整体重写', () => {
    const nav = new NavHistory()
    nav.record(at(1, '/w/notes/a.md', 0), at(2, '/w/b.md', 0))
    nav.retarget('/w/notes', '/w/archive')
    expect(nav.back(at(2, '/w/b.md', 0))?.path).toBe('/w/archive/a.md')
  })

  it('无路径的草稿关了：它那几格删掉，后退不会停在一个打不开的地方', () => {
    const nav = new NavHistory()
    nav.record(at(1, '/a.md', 0), at(5, null, 30)) // 跳进草稿
    nav.record(at(5, null, 30), at(2, '/b.md', 0)) // 再跳出去
    nav.forgetTab(5)
    expect(nav.back(at(2, '/b.md', 0))).toEqual(at(1, '/a.md', 0))
    expect(nav.back(at(1, '/a.md', 0))).toBeNull()
  })

  it('sameDoc：同一个标签，或者同一个路径', () => {
    expect(sameDoc({ tabId: 1, path: null }, { tabId: 1, path: '/a.md' })).toBe(true)
    expect(sameDoc({ tabId: 1, path: '/a.md' }, { tabId: 2, path: '/a.md' })).toBe(true)
    expect(sameDoc({ tabId: 1, path: null }, { tabId: 2, path: null })).toBe(false)
  })
})
