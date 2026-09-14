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

  it('事件表里没登记的事件名会当场炸 —— 加事件时别只加订阅口', () => {
    const { emit } = loadBridge()
    // listeners 是张写死的表，`_emit` 直接 `listeners[event]`：漏登记就是 undefined。
    // 与其在运行时静默丢事件，不如让这条测试先响
    expect(() => emit('prefs:not-a-real-event', {})).toThrow()
  })
})
