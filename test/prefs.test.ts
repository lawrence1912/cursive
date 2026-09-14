import { afterEach, describe, expect, it } from 'vitest'
import { getLang, setLang } from '../src/renderer/i18n'
import { COLUMN_RANGE, normalizePrefs, Prefs } from '../src/renderer/ui/prefs'

describe('normalizePrefs', () => {
  it('缺字段回默认值；缺 lang 按老用户算（中文）', () => {
    const v = normalizePrefs({})
    expect(v.theme).toBe('system')
    expect(v.font).toBe('serif')
    expect(v.custom).toBeNull()
    expect(v.lang).toBe('zh')
  })

  it('超范围的数值钳回区间', () => {
    expect(normalizePrefs({ size: 99 }).size).toBe(24)
    expect(normalizePrefs({ size: 1 }).size).toBe(13)
    expect(normalizePrefs({ leading: 9 }).leading).toBe(2.4)
    expect(normalizePrefs({ column: 1 }).column).toBe(COLUMN_RANGE.min)
    expect(normalizePrefs({ column: 999 }).column).toBe(COLUMN_RANGE.max)
  })

  it('压根不是数字的（坏 JSON / 被人手改过）落到下界而不是崩掉', () => {
    expect(normalizePrefs({ size: '20' as unknown as number }).size).toBe(13)
    expect(normalizePrefs({ leading: NaN }).leading).toBe(1.4)
  })

  it('返回的是新对象 —— adopt() 之后还要往 this.v 上写，不能与来源共用一份', () => {
    const src = { size: 18 }
    const out = normalizePrefs(src)
    expect(out).not.toBe(src as unknown as typeof out)
  })
})

/**
 * 契约 v17 的收端不变量。这三条「不做」错一条，症状都不轻：
 * 回落盘会把第三个窗口更新的那份盖回去；回广播是两窗互推转圈；
 * 重推 setAppearance 则是替一件 app 级的事再做一遍（NSApp.appearance 早就翻好了）。
 *
 * `Prefs` 认 window/document/localStorage 三个全局，这里给最小桩 —— 单测环境是 node。
 */
describe('Prefs.adopt（契约 v17）', () => {
  const g = globalThis as Record<string, unknown>

  function harness(): {
    prefs: Prefs
    calls: { setAppearance: number; setLanguage: number; syncPrefs: number; writes: number }
    theme: () => string | undefined
  } {
    const calls = { setAppearance: 0, setLanguage: 0, syncPrefs: 0, writes: 0 }
    let store: string | null = null
    const root = {
      lang: '',
      dataset: {} as Record<string, string>,
      style: { setProperty: () => undefined }
    }
    g['localStorage'] = {
      getItem: () => store,
      setItem: (_k: string, v: string) => {
        store = v
        calls.writes++
      }
    }
    g['document'] = {
      documentElement: root,
      getElementById: () => null,
      querySelectorAll: () => []
    }
    g['window'] = {
      matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
      api: {
        setAppearance: () => calls.setAppearance++,
        setLanguage: () => calls.setLanguage++,
        syncPrefs: () => calls.syncPrefs++
      }
    }
    return { prefs: new Prefs(() => undefined), calls, theme: () => root.dataset['theme'] }
  }

  afterEach(() => {
    delete g['localStorage']
    delete g['document']
    delete g['window']
    setLang('zh') // i18n 是模块级单例，adopt 会拨动它
  })

  it('自己改 = 落盘 + 广播', () => {
    const { prefs, calls } = harness()
    prefs.setTheme('dark')
    expect(calls.writes).toBe(1)
    expect(calls.syncPrefs).toBe(1)
  })

  it('adopt 落色但不落盘、不回广播、不重推 setAppearance', () => {
    const { prefs, calls, theme } = harness()
    prefs.setTheme('dark')
    const before = { ...calls }

    prefs.adopt({ ...prefs.values, theme: 'sepia', size: 20 })

    expect(theme()).toBe('sepia')
    expect(prefs.values.size).toBe(20)
    expect(calls.writes, '不该再写一遍 localStorage').toBe(before.writes)
    expect(calls.syncPrefs, '不该把收到的再播回去').toBe(before.syncPrefs)
    expect(calls.setAppearance, 'NSApp.appearance 是 app 级的，发起窗口已经推过').toBe(
      before.setAppearance
    )
  })

  it('adopt 带来的语言变化会拨动 i18n，但不再推一遍 setLanguage', () => {
    const { prefs, calls } = harness()
    const before = calls.setLanguage
    prefs.adopt({ ...prefs.values, lang: 'en' })
    expect(getLang()).toBe('en')
    expect(calls.setLanguage, '菜单栏是 app 级的，发起窗口推过了').toBe(before)
  })

  it('adopt 进来的越界值照样钳住', () => {
    const { prefs } = harness()
    prefs.adopt({ ...prefs.values, size: 999 })
    expect(prefs.values.size).toBe(24)
  })
})
