import { describe, expect, it } from 'vitest'
import {
  SESSION_MAX,
  SESSION_VERSION,
  loadSession,
  packSession,
  parseSession,
  planRestore,
  saveSession,
  sessionKey,
  type SessionTab,
  type StorageLike
} from '../src/renderer/ui/session'

/**
 * 会话恢复的纯函数（`ui/session.ts`）。
 *
 * 这一层要经得起**手改过的、上个版本写的、根本不是 JSON 的**那串东西 —— 它在
 * localStorage 里，谁都能动。原则与 `height-store` 那份一样：**认不出就当没有**，
 * 宁可回到「只开双击的那份文档」，也不要拿半截数据摆出一排空壳标签。
 */
function memory(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v)
  }
}

const tab = (path: string, scroll = 0, cursor = 0): SessionTab => ({ path, scroll, cursor })

describe('会话的读写', () => {
  it('存进去能原样读回来', () => {
    const store = memory()
    const s = packSession([tab('/a.md', 120, 30), tab('/b.md')], 1)
    saveSession(store, '/root', s)
    expect(loadSession(store, '/root')).toEqual(s)
  })

  it('按工作区根分组 —— 换个根就读不到', () => {
    const store = memory()
    saveSession(store, '/root', packSession([tab('/a.md')], 0))
    expect(loadSession(store, '/other')).toBeNull()
    expect([...store.map.keys()]).toEqual([sessionKey('/root')])
  })

  it('一个标签都不剩 = 没有会话', () => {
    const store = memory()
    saveSession(store, '/root', packSession([tab('/a.md')], 0))
    saveSession(store, '/root', packSession([], 0))
    expect(loadSession(store, '/root')).toBeNull()
  })

  it('没有存储（隐私模式 / 被策略禁掉）不炸', () => {
    expect(loadSession(undefined, '/root')).toBeNull()
    expect(() => saveSession(undefined, '/root', packSession([tab('/a.md')], 0))).not.toThrow()
  })
})

describe('认不出就当没有', () => {
  it.each([
    ['空', null],
    ['不是 JSON', '{{{'],
    ['不是对象', '42'],
    ['版本对不上', JSON.stringify({ v: SESSION_VERSION + 1, tabs: [tab('/a.md')], active: 0 })],
    ['tabs 不是数组', JSON.stringify({ v: SESSION_VERSION, tabs: '/a.md', active: 0 })],
    ['tabs 是空的', JSON.stringify({ v: SESSION_VERSION, tabs: [], active: 0 })],
    ['每一条都没有路径', JSON.stringify({ v: SESSION_VERSION, tabs: [{ scroll: 1 }], active: 0 })]
  ])('%s', (_name, raw) => {
    expect(parseSession(raw as string | null)).toBeNull()
  })

  it('坏掉的只是其中几条：留下好的那些', () => {
    const raw = JSON.stringify({
      v: SESSION_VERSION,
      tabs: [{ path: '/a.md', scroll: 10, cursor: 5 }, { path: 42 }, null, { path: '/b.md' }],
      active: 3
    })
    const s = parseSession(raw)!
    expect(s.tabs.map((t) => t.path)).toEqual(['/a.md', '/b.md'])
    // active 指向的是原来那份清单的下标，越界就退回第一个 —— 恢复出来总得有个活动标签
    expect(s.active).toBe(0)
  })

  it('坐标是 NaN / 负数 / 字符串一律当 0（别拿它去 scrollTop）', () => {
    const raw = JSON.stringify({
      v: SESSION_VERSION,
      tabs: [{ path: '/a.md', scroll: -5, cursor: 'x' }],
      active: 0
    })
    expect(parseSession(raw)!.tabs[0]).toEqual({ path: '/a.md', scroll: 0, cursor: 0 })
  })
})

describe('上限', () => {
  it('超了留最后那些，活动标签的下标跟着搬', () => {
    const many = Array.from({ length: SESSION_MAX + 5 }, (_, i) => tab(`/f${i}.md`))
    const s = packSession(many, many.length - 1)
    expect(s.tabs).toHaveLength(SESSION_MAX)
    expect(s.tabs[0]!.path).toBe('/f5.md')
    expect(s.active).toBe(SESSION_MAX - 1)
  })

  it('活动标签正好被截掉就退回第一个', () => {
    const many = Array.from({ length: SESSION_MAX + 5 }, (_, i) => tab(`/f${i}.md`))
    expect(packSession(many, 0).active).toBe(0)
  })
})

/**
 * 恢复计划（`planRestore`）。两条最要紧的规矩在这儿被钉住：
 * **已经开着的不再开一遍**、**双击进来的那份文档不会被挤下去**。
 * 后一条要是破了，症状是「从 Finder 双击一个文件，打开之后停在上次那个文件上」。
 */
describe('恢复计划', () => {
  const saved = packSession([tab('/a.md'), tab('/b.md'), tab('/c.md')], 1)

  it('全都没开过：按会话的顺序开，落在会话的活动标签上', () => {
    expect(planRestore(saved, [], false)).toEqual({
      open: ['/a.md', '/b.md', '/c.md'],
      focus: '/b.md'
    })
  })

  it('已经开着的那份不再开一遍', () => {
    expect(planRestore(saved, ['/b.md'], false).open).toEqual(['/a.md', '/c.md'])
  })

  it('带着文件启动（双击 / argv）：落点交回给那份文档，会话不抢', () => {
    expect(planRestore(saved, ['/b.md'], true)).toEqual({
      open: ['/a.md', '/c.md'],
      focus: null
    })
  })

  it('活动标签下标越界时退回第一个（`parseSession` 夹过一次，这儿再兜一次）', () => {
    const broken = { v: SESSION_VERSION, tabs: [tab('/a.md')], active: 7 }
    expect(planRestore(broken, [], false).focus).toBe('/a.md')
  })
})
