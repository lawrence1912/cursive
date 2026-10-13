import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
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

  it('老偏好里没有 customOff（0.3.0 T4 新增）→ 不停用，一切照旧', () => {
    expect(normalizePrefs({}).customOff).toBe(false)
    expect(normalizePrefs({ customOff: true }).customOff).toBe(true)
    // 非布尔值一律当 false：这个开关只该由那条菜单项拨动，坏数据不许把皮肤停掉
    expect(normalizePrefs({ customOff: 'yes' as unknown as boolean }).customOff).toBe(false)
  })

  it('老偏好里没有 previewTabs（随预览标签新增）→ 开着；只认明说的 false', () => {
    expect(normalizePrefs({}).previewTabs).toBe(true)
    expect(normalizePrefs({ previewTabs: false }).previewTabs).toBe(false)
    // 坏数据当开：单击预览就是眼下的行为，关掉它只该由设置面板那一行来拨
    expect(normalizePrefs({ previewTabs: 'no' as unknown as boolean }).previewTabs).toBe(true)
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
    const calls = { setAppearance: 0, setLanguage: 0, setImageDir: 0, syncPrefs: 0, writes: 0 }
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
        // 契约 v31（0.4.0 图片落脚）：窗口级的，apply 与 adopt 都要推
        setImageDir: () => calls.setImageDir++,
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

  it('别的窗口改了图片落脚，这个窗口也要推给自己的壳（契约 v31 是窗口级的）', () => {
    const { prefs, calls } = harness()
    const before = calls.setImageDir
    prefs.adopt({ ...prefs.values, imageDir: 'root' })
    expect(prefs.values.imageDir).toBe('root')
    expect(calls.setImageDir, 'Finder 拖入那条路压根不经过渲染层，壳得知道').toBe(before + 1)
  })

  it('adopt 进来的越界值照样钳住', () => {
    const { prefs } = harness()
    prefs.adopt({ ...prefs.values, size: 999 })
    expect(prefs.values.size).toBe(24)
  })

  /**
   * 0.3.0 T4 的安全出口。要守的是**「停用」这件事本身要活过重开**：
   * 皮肤把界面弄花之后，人要的是「先让它别花着」，而不是「这次别花、下次重开再花一遍」。
   */
  it('停用皮肤：落盘 + 广播，再按一次回到启用', () => {
    const { prefs, calls } = harness()
    const before = { ...calls }
    expect(prefs.values.customOff).toBe(false)

    expect(prefs.toggleCustomOff(), '返回的是新状态').toBe(true)
    expect(prefs.values.customOff).toBe(true)
    expect(calls.writes, '进偏好，不是会话级').toBe(before.writes + 1)
    expect(calls.syncPrefs, '别的窗口也花着，得跟着摘').toBe(before.syncPrefs + 1)

    expect(prefs.toggleCustomOff()).toBe(false)
    expect(prefs.values.customOff).toBe(false)
  })

  it('选的是哪一张皮肤不会被「停用」忘掉 —— 改好 CSS 之后要回得去', () => {
    const { prefs } = harness()
    prefs.setCustom('my-skin')
    prefs.toggleCustomOff()
    expect(prefs.values.custom, '停用只管叠不叠，不管选的是谁').toBe('my-skin')
  })
})

/**
 * 关掉「单击预览」时把开着的那格转正（`main.ts` 的 `syncPreview`），挂在偏好回调上 ——
 * 而那个回调**启动时就跑一次**（`prefs.apply()`），比 `let tabs` 的声明还早。那一下碰 `tabs`
 * 就是 TDZ，整条启动路径当场抛、页面一片空白；自检时偏好通常开着、走不到那一支，
 * 探针跑绿也看不出来（CONTEXT「已踩坑」：模块级 `let` 与启动序列的先后）。
 */
describe('syncPreview 与启动序列的先后', () => {
  const main = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8')

  it('previewWas 排在偏好之前、初值 null（= 还没 apply 过）', () => {
    const decl = main.indexOf('let previewWas: boolean | null = null')
    expect(decl).toBeGreaterThan(0)
    expect(decl).toBeLessThan(main.indexOf('const prefs = new Prefs('))
  })

  it('碰 tabs 之前先认出「开 → 关」：启动那一下 previewWas 还是 null，碰不到', () => {
    const at = main.indexOf('function syncPreview()')
    const fn = main.slice(at, main.indexOf('\n}', at))
    const touch = fn.split('\n').filter((l) => /\btabs\b/.test(l) && !/^\s*(\/\/|\*)/.test(l))
    expect(touch.length).toBeGreaterThan(0)
    for (const l of touch) expect(l, '这一行没先问 was === true').toContain('was === true')
  })
})
