import { describe, expect, it, vi } from 'vitest'
import {
  HEIGHT_STORE_KEY,
  HEIGHT_STORE_VERSION,
  browserStorage,
  heightsForLayout,
  loadHeightStore,
  packHeightStore,
  parseHeightStore,
  saveHeightStore,
  type StorageLike
} from '../src/renderer/editor/live-preview/height-store'

/** 一只够用的假存储；`fail` 用来复刻隐私模式/配额满那种「读也抛、写也抛」 */
function storage(initial: Record<string, string> = {}, fail = false): StorageLike & { data: Record<string, string> } {
  return {
    data: { ...initial },
    getItem(key) {
      if (fail) throw new Error('blocked')
      return this.data[key] ?? null
    },
    setItem(key, value) {
      if (fail) throw new Error('quota')
      this.data[key] = value
    }
  }
}

describe('高度记忆落盘：格式校验', () => {
  it('自己打包的那份能原样读回来', () => {
    const entries = new Map([
      ['img:["a.png",null,null]', 300],
      ['math:E=mc^2', 64]
    ])
    const raw = JSON.stringify(packHeightStore('l1', entries))
    expect(parseHeightStore(raw)).toEqual({
      v: HEIGHT_STORE_VERSION,
      layout: 'l1',
      entries: { 'img:["a.png",null,null]': 300, 'math:E=mc^2': 64 }
    })
  })

  it('空、坏 JSON、版本不符、形状不对 —— 一律当没有', () => {
    expect(parseHeightStore(null)).toBeNull()
    expect(parseHeightStore('')).toBeNull()
    expect(parseHeightStore('{ 不是 json')).toBeNull()
    expect(parseHeightStore('null')).toBeNull()
    expect(parseHeightStore('"字符串"')).toBeNull()
    // 上个版本写的（或将来变了字段）：直接弃旧，不做迁移
    expect(parseHeightStore(JSON.stringify({ v: 0, layout: 'l1', entries: { a: 1 } }))).toBeNull()
    expect(parseHeightStore(JSON.stringify({ v: HEIGHT_STORE_VERSION, entries: { a: 1 } }))).toBeNull()
    expect(parseHeightStore(JSON.stringify({ v: HEIGHT_STORE_VERSION, layout: '', entries: {} }))).toBeNull()
    expect(parseHeightStore(JSON.stringify({ v: HEIGHT_STORE_VERSION, layout: 'l1' }))).toBeNull()
  })

  it('被人手改过的条目挑得出来：非数字、NaN、0、负数都不进内存', () => {
    const raw = JSON.stringify({
      v: HEIGHT_STORE_VERSION,
      layout: 'l1',
      entries: { good: 120, str: '300', nan: null, zero: 0, neg: -5 }
    })
    expect(parseHeightStore(raw)?.entries).toEqual({ good: 120 })
  })
})

describe('高度记忆落盘：排版条件', () => {
  it('条件对得上才认那份高度', () => {
    const store = { v: HEIGHT_STORE_VERSION, layout: 'l1', entries: { a: 1 } }
    expect(heightsForLayout(store, 'l1')).toEqual({ a: 1 })
  })

  it('条件变了整份丢掉 —— 旧条件下的像素高度就是错的', () => {
    const store = { v: HEIGHT_STORE_VERSION, layout: 'l1', entries: { a: 1 } }
    expect(heightsForLayout(store, 'l2')).toEqual({})
    expect(heightsForLayout(null, 'l1')).toEqual({})
  })
})

describe('高度记忆落盘：上限与存储异常', () => {
  it('超过上限丢最旧的（Map 的插入序就是先进先出）', () => {
    const entries = new Map<string, number>()
    for (let i = 0; i < 6; i++) entries.set(`k${i}`, i + 1)
    const packed = packHeightStore('l1', entries, 3)
    expect(Object.keys(packed.entries)).toEqual(['k3', 'k4', 'k5'])
    expect(packed.entries.k3).toBe(4)
  })

  it('存储读不出来（隐私模式/被禁）时不抛，当作没有', () => {
    expect(loadHeightStore(storage({}, true))).toBeNull()
    expect(() => saveHeightStore(storage({}, true), packHeightStore('l1', new Map()))).not.toThrow()
    expect(loadHeightStore(undefined)).toBeNull()
    expect(() => saveHeightStore(undefined, packHeightStore('l1', new Map()))).not.toThrow()
  })

  it('写进去的键名固定、内容可再读回', () => {
    const s = storage()
    saveHeightStore(s, packHeightStore('l1', new Map([['a', 10]])))
    expect(Object.keys(s.data)).toEqual([HEIGHT_STORE_KEY])
    expect(heightsForLayout(loadHeightStore(s), 'l1')).toEqual({ a: 10 })
  })

  it('没有 localStorage 的环境（node 单测）读出 undefined 而不是炸', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(browserStorage()).toBeUndefined()
    vi.unstubAllGlobals()
  })
})
