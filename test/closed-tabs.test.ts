import { describe, expect, it } from 'vitest'
import { CLOSED_MAX, ClosedTabs, type ClosedTab } from '../src/renderer/ui/closed-tabs'

/** 第八节 7 重新打开关闭的标签：那个栈（读盘、建标签在 main.ts，原生专项另验） */

const tab = (path: string, cursor = 0, scroll = 0, readOnly = false): ClosedTab => ({ path, cursor, scroll, readOnly })

describe('ClosedTabs', () => {
  it('后关的先回来，带着光标、滚动与只读', () => {
    const s = new ClosedTabs()
    s.push(tab('/a.md', 10, 200))
    s.push(tab('/b.md', 3, 0, true))
    expect(s.pop()).toEqual(tab('/b.md', 3, 0, true))
    expect(s.pop()).toEqual(tab('/a.md', 10, 200))
    expect(s.pop()).toBeNull()
  })

  it('同一个路径关两遍只回来一份，位置是后一次的', () => {
    const s = new ClosedTabs()
    s.push(tab('/a.md', 1))
    s.push(tab('/b.md'))
    s.push(tab('/a.md', 9))
    expect(s.size).toBe(2)
    expect(s.pop()).toEqual(tab('/a.md', 9))
  })

  it('又开着了 / 进了废纸篓：从栈里摘掉，不会回来第二份', () => {
    const s = new ClosedTabs()
    s.push(tab('/a.md'))
    s.push(tab('/b.md'))
    s.forget('/b.md')
    expect(s.pop()?.path).toBe('/a.md')
    expect(s.size).toBe(0)
  })

  it('改名 / 搬走目录：路径按前缀整体重写', () => {
    const s = new ClosedTabs()
    s.push(tab('/w/notes/a.md'))
    s.push(tab('/w/notes.md'))
    s.retarget('/w/notes', '/w/archive')
    expect(s.pop()?.path).toBe('/w/notes.md') // 只认目录边界，不按裸前缀误伤
    expect(s.pop()?.path).toBe('/w/archive/a.md')
  })

  it(`最多记 ${CLOSED_MAX} 个，挤掉最老的`, () => {
    const s = new ClosedTabs()
    for (let i = 0; i < CLOSED_MAX + 5; i++) s.push(tab(`/${i}.md`))
    expect(s.size).toBe(CLOSED_MAX)
    let last: ClosedTab | null = null
    for (let x = s.pop(); x; x = s.pop()) last = x
    expect(last?.path).toBe('/5.md')
  })
})
