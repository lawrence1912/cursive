import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import type { PrefValues } from '../src/shared/types'

/**
 * `window.api` 那座桥是**嵌在 Swift 字符串字面量里的 JS**（`shell-swift/main.swift` 的
 * `BRIDGE_JS`）—— `swiftc` 只把它当一串字符，写错了不响；TypeScript 更看不见它，
 * `shared/types.ts` 里的 `CursiveApi` 是一份**宣称**，不是被检查的实现。
 * 于是这里把那段字符串抠出来，在 vm 沙箱里真的跑一遍。
 *
 * 沙箱是必须的：桥开头那个 IIFE 会改写 `console.error` / `console.warn` 往原生转发，
 * 直接 eval 到测试进程里等于把 vitest 的输出也劫了。
 */
function loadBridge(): { api: Record<string, unknown>; emit: (e: string, p: unknown) => void; posted: { method: string; args: unknown[] }[] } {
  const swift = readFileSync(new URL('../shell-swift/main.swift', import.meta.url), 'utf8')
  const head = swift.indexOf('let BRIDGE_JS = """')
  expect(head, 'BRIDGE_JS 不在了？抠取的锚点要跟着改').toBeGreaterThan(-1)
  const from = swift.indexOf('\n', head) + 1
  const js = swift.slice(from, swift.indexOf('\n"""', from))

  const posted: { method: string; args: unknown[] }[] = []
  const win: Record<string, unknown> = {
    addEventListener: () => undefined,
    webkit: { messageHandlers: { shell: { postMessage: (m: { method: string; args: unknown[] }) => posted.push(m) } } }
  }
  const sandbox = { window: win, console: { error: () => undefined, warn: () => undefined } }
  runInContext(js, createContext(sandbox))
  return {
    api: win['api'] as Record<string, unknown>,
    emit: win['__shellEmit'] as (e: string, p: unknown) => void,
    posted
  }
}

const SAMPLE: PrefValues = {
  theme: 'dark', font: 'sans', size: 18, leading: 2, column: 50, custom: null, lang: 'en'
}

describe('BRIDGE_JS', () => {
  it('整段是合法 JS，跑完挂得出 window.api', () => {
    const { api, emit } = loadBridge()
    expect(typeof api).toBe('object')
    expect(typeof emit).toBe('function')
  })

  it('syncPrefs 把整份偏好原样 post 给原生（契约 v17 的发端）', () => {
    const { api, posted } = loadBridge()
    void (api['syncPrefs'] as (v: PrefValues) => Promise<void>)(SAMPLE)
    const hit = posted.find((m) => m.method === 'syncPrefs')
    expect(hit, 'postMessage 里没有 syncPrefs').toBeDefined()
    expect(hit!.args[0]).toEqual(SAMPLE)
  })

  it('onPrefsChanged 收得到 prefs:changed，退订之后就不再收（契约 v17 的收端）', () => {
    const { api, emit } = loadBridge()
    const seen: PrefValues[] = []
    const off = (api['onPrefsChanged'] as (fn: (v: PrefValues) => void) => () => void)((v) => seen.push(v))
    emit('prefs:changed', SAMPLE)
    expect(seen).toEqual([SAMPLE])
    off()
    emit('prefs:changed', SAMPLE)
    expect(seen, '退订之后不该再收到').toHaveLength(1)
  })

  /**
   * 契约对账（0.2.x 补）。`CursiveApi` 是一份**宣称**，`BRIDGE_JS` 是嵌在 Swift 字符串里的
   * 实现，壳侧那个 switch 是第三处 —— 三处各写一遍，漏一处的后果各不相同：
   * 桥里漏 = `window.api.x is not a function`；壳里漏 = promise 永远不 resolve（最难查的一种）。
   * 于是把三份名单摆在一起比。加一条新通道（这一轮的 `restoreItem` 就是）时，
   * 少写任何一处，这两条测试当场变红。
   */
  it('契约里宣称的每个方法，桥上都真的有', () => {
    const { api } = loadBridge()
    const src = readFileSync(new URL('../src/shared/types.ts', import.meta.url), 'utf8')
    const body = src.slice(src.indexOf('export interface CursiveApi'))
    const declared = [...body.matchAll(/^ {2}([a-zA-Z]\w*)\s*\(/gm)].map((m) => m[1]!)
    expect(declared.length, '解析没抠到东西？锚点要跟着改').toBeGreaterThan(30)
    expect(declared.filter((name) => typeof api[name] !== 'function')).toEqual([])
    // 反过来也要：桥上多出来的方法没人在契约里写，类型层就看不见它
    const extra = Object.keys(api).filter((k) => !k.startsWith('_') && !declared.includes(k))
    expect(extra).toEqual([])
  })

  it('桥上每个 call() 在壳侧都有对应的 case —— 少一条就是「promise 永远不 resolve」', () => {
    const swift = readFileSync(new URL('../shell-swift/main.swift', import.meta.url), 'utf8')
    const head = swift.indexOf('let BRIDGE_JS = """')
    const from = swift.indexOf('\n', head) + 1
    const js = swift.slice(from, swift.indexOf('\n"""', from))
    const called = [...new Set([...js.matchAll(/call\('([^']+)'/g)].map((m) => m[1]!))]
    expect(called.length).toBeGreaterThan(30)
    // `case "save", "saveAs":` 这种一行两个的也要认，所以按行抠引号里的名字
    const handled = new Set<string>()
    for (const line of swift.split('\n')) {
      if (!line.trim().startsWith('case "')) continue
      for (const m of line.matchAll(/"([A-Za-z]\w*)"/g)) handled.add(m[1]!)
    }
    expect(called.filter((name) => !handled.has(name))).toEqual([])
  })

  it('事件表里没登记的事件名会当场炸 —— 加事件时别只加订阅口', () => {
    const { emit } = loadBridge()
    // listeners 是张写死的表，`_emit` 直接 `listeners[event]`：漏登记就是 undefined。
    // 与其在运行时静默丢事件，不如让这条测试先响
    expect(() => emit('prefs:not-a-real-event', {})).toThrow()
  })
})
