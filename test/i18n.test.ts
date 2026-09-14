import { afterEach, describe, expect, it } from 'vitest'
import { detectLang, getLang, setLang, systemLang, t } from '../src/renderer/i18n'
import { en } from '../src/renderer/i18n/en'
import { zh } from '../src/renderer/i18n/zh'
import { createState } from '../src/renderer/editor/setup'

describe('i18n 字典', () => {
  it('en 与 zh 的键集合完全一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('两份字典都没有空文案', () => {
    for (const dict of [zh, en]) {
      for (const [k, v] of Object.entries(dict)) {
        expect(v.trim().length, `${k} 是空的`).toBeGreaterThan(0)
      }
    }
  })

  it('占位符在两份字典里成对出现', () => {
    const slots = (s: string): string[] => (s.match(/\{(\w+)\}/g) ?? []).sort()
    for (const k of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(slots(en[k]), `${k} 的占位符不一致`).toEqual(slots(zh[k]))
    }
  })

  // `cm.*` 那几条走的是 CodeMirror 的 `state.phrase(key, n)`，占位符是 `$` 不是 `{n}`——
  // 上一条正则看不见它，漏一个 `$` 就会让读屏把数字整个吞掉
  it('CodeMirror 的 $ 占位符在两份字典里也成对出现', () => {
    const dollars = (s: string): number => (s.match(/\$/g) ?? []).length
    for (const k of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(dollars(en[k]), `${k} 的 $ 占位符不一致`).toBe(dollars(zh[k]))
    }
  })
})

describe('t()', () => {
  it('默认语言是中文（node 测试环境无 navigator/localStorage）', () => {
    expect(getLang()).toBe('zh')
    expect(t('app.untitled')).toBe('未命名')
  })

  it('占位符替换', () => {
    expect(t('status.saved', { time: '09:30' })).toBe('已保存 09:30')
    expect(t('tab.close', { title: 'a.md' })).toBe('关闭 a.md')
  })

  it('切换语言后取英文文案，占位符照常工作', () => {
    // node 里没有 document，setLang 跳过 DOM 更新但语言本身切得动
    setLang('en')
    expect(t('app.untitled')).toBe('Untitled')
    expect(t('status.saved', { time: '09:30' })).toBe('Saved 09:30')
    setLang('zh') // 还原，别影响其他用例（模块级单例）
    expect(t('app.untitled')).toBe('未命名')
  })
})

describe('detectLang()', () => {
  it('node 环境（无 localStorage / navigator）回退中文', () => {
    expect(detectLang()).toBe('zh')
  })
})

/**
 * 「恢复默认」要的是**系统语言**，而 `detectLang()` 会先读偏好 —— 拿它当 DEFAULTS.lang
 * 等于把「本次启动时存着的语言」当默认值，恢复默认于是恢复了个寂寞（ui/prefs.ts）。
 * 这条不写死语言，只断言「systemLang 不随偏好动、detectLang 随偏好动」。
 */
describe('systemLang() 不看偏好', () => {
  const g = globalThis as { localStorage?: unknown }
  const stub = (lang: string): void => {
    g.localStorage = {
      getItem: (k: string) => (k === 'cursive.prefs' ? JSON.stringify({ lang }) : null)
    }
  }
  afterEach(() => {
    delete g.localStorage
  })

  it('偏好里存什么，systemLang 都给同一个答案；detectLang 则跟着变', () => {
    stub('en')
    const sysWithEn = systemLang()
    expect(detectLang()).toBe('en')
    stub('zh')
    expect(systemLang()).toBe(sysWithEn)
    expect(detectLang()).toBe('zh')
  })
})

/**
 * CodeMirror 查找的读屏播报走 `EditorState.phrases` facet，而 facet 的值是**建 state 时
 * 钉进配置里**的。写成 `{ 'current match': t(...) }` 的话，切完语言已经开着的标签
 * （尤其是冻结的那些）还在念旧文案；setup.ts 因此把它写成取值器。
 */
describe('查找播报跟着界面语言走', () => {
  afterEach(() => setLang('zh'))

  it('state 建好之后再切语言，phrase 也跟着换', () => {
    const state = createState('hello')
    expect(state.phrase('current match')).toBe('当前匹配')
    expect(state.phrase('Replaced $ matches', 3)).toBe('已替换 3 处')
    setLang('en')
    expect(state.phrase('current match')).toBe('current match')
    expect(state.phrase('Replaced $ matches', 3)).toBe('Replaced 3 matches')
  })
})
