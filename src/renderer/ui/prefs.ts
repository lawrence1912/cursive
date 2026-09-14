import type { AppearanceMode, BodyFont, PrefValues, UserTheme } from '../../shared/types'
import { applyI18n, setLang as setI18nLang, systemLang, t, type Key, type Lang } from '../i18n'
import { icon } from './icons'

// 形状定义在 `shared/types`（契约 v17 要把整份偏好当 IPC 载荷转发），这里原地再导出
export type { BodyFont, PrefValues }

const KEY = 'cursive.prefs'
/**
 * **必须是纯常量**。`lang` 这里用 `systemLang()`（只看系统）而不是 `detectLang()`（先看偏好）：
 * 后者会把「本次启动时存着的语言」当成默认值，于是「恢复默认」把语言恢复成了它自己，
 * 而且 DEFAULTS 会随存储而变 —— 一个名字叫 DEFAULTS 的东西不该有状态
 */
const DEFAULTS: PrefValues = {
  theme: 'system', font: 'serif', size: 16, leading: 1.75, column: 42, custom: null, lang: systemLang()
}
export const COLUMN_RANGE = { min: 30, max: 60 }

/**
 * 把「外面来的一份偏好」收敛成合法值。两个入口共用：localStorage 里那份（可能是上个版本
 * 写的、也可能被人手改过）和别的窗口广播来的那份（契约 v17）—— 各写一遍校验的话，
 * 以后加字段必定有一边忘了钳位。纯函数，`test/prefs.test.ts` 直接测。
 */
export function normalizePrefs(parsed: Partial<PrefValues>): PrefValues {
  return {
    theme: parsed.theme ?? DEFAULTS.theme,
    font: parsed.font ?? DEFAULTS.font,
    size: clamp(parsed.size ?? DEFAULTS.size, 13, 24),
    leading: clamp(parsed.leading ?? DEFAULTS.leading, 1.4, 2.4),
    column: clamp(parsed.column ?? DEFAULTS.column, COLUMN_RANGE.min, COLUMN_RANGE.max),
    custom: parsed.custom ?? null,
    // 有偏好但没记过 lang = 老用户，一直看的是中文，别在某次升级后突然给人翻成英文。
    // 与 i18n 的 `detectLang()` 同一条规则（那边靠 raw 非空走到同一个结果）
    lang: parsed.lang ?? 'zh'
  }
}

/** 自定义皮肤的落脚点，面板里要原样告诉用户 */
const THEMES_DIR = '~/Library/Application Support/cursive/themes'

/** 分段控件的选项。带 key 的走字典（跟着语言切）；只有 label 的写死 —— 语言选项各自以自身语言显示 */
interface SegOpt {
  val: string
  key?: Key
  label?: string
}
const THEME_OPTS: SegOpt[] = [
  { val: 'system', key: 'pf.theme.system' },
  { val: 'light', key: 'pf.theme.light' },
  { val: 'dark', key: 'pf.theme.dark' },
  { val: 'sepia', key: 'pf.theme.sepia' }
]
const FONT_OPTS: SegOpt[] = [
  { val: 'serif', key: 'pf.font.serif' },
  { val: 'sans', key: 'pf.font.sans' }
]
const LANG_OPTS: SegOpt[] = [
  { val: 'zh', label: '中文' },
  { val: 'en', label: 'English' }
]

/**
 * 主题 + 排版偏好。
 *
 * 主题解析在这里做完再落到 DOM —— CSS 侧只认 `data-theme="light|dark"` 两种确定状态，
 * 'system' 由 matchMedia 解析并跟随 OS 变化。这样暗色 token 只需要一份显式规则，
 * 不用在媒体查询里再抄一遍（base.css 里那份媒体查询只负责 JS 起来之前的首帧）。
 */
export class Prefs {
  private v: PrefValues
  private el: HTMLElement | null = null
  private lastFocus: HTMLElement | null = null
  private readonly mq = window.matchMedia('(prefers-color-scheme: dark)')

  /** 扫到的用户皮肤（P3-4）。启动时读一次就够 —— 加皮肤是「放个文件再重开」的动作 */
  private themes: UserTheme[] = []

  constructor(private readonly onApply: () => void) {
    this.v = this.load()
    this.mq.addEventListener('change', () => {
      if (this.v.theme === 'system') this.apply()
    })
  }

  /** 读 `themes/*.css` 并把选中的那份贴上。异步，起步时发一次即可 */
  async loadUserThemes(): Promise<void> {
    try {
      this.themes = await window.api.userThemes()
    } catch {
      this.themes = []
    }
    this.applyCustom()
    this.buildCustomRow()
  }

  /**
   * 自定义皮肤 = 一张**叠在最后**的样式表，不是替换。
   * 内置主题负责那套 token，用户 CSS 想改哪条改哪条 —— 只写 `--accent` 也成立。
   * 页面 CSP 是 `style-src 'self' 'unsafe-inline'`，`<style>` 元素本身是允许的。
   */
  private applyCustom(): void {
    const id = 'user-theme'
    document.getElementById(id)?.remove()
    const hit = this.themes.find((t) => t.name === this.v.custom)
    if (!hit) return
    const style = document.createElement('style')
    style.id = id
    style.textContent = hit.css
    document.head.appendChild(style)
  }

  get values(): PrefValues {
    return { ...this.v }
  }

  private load(): PrefValues {
    try {
      const raw = localStorage.getItem(KEY)
      if (!raw) return { ...DEFAULTS }
      return normalizePrefs(JSON.parse(raw) as Partial<PrefValues>)
    } catch {
      // 隐私模式 / 存储被禁：用默认值继续，不要让偏好把应用拖崩
      return { ...DEFAULTS }
    }
  }

  /**
   * 真相变了：**落盘 + 告诉别的窗口**（契约 v17）。全部改动都从这里过，两件事因此不可能漏一个。
   *
   * 为什么广播不能省：localStorage 是共享的**存储**、不是共享的**通知**，别的窗口那份内存副本
   * 是它启动时读的。而原生那半偏偏是 app 级的 —— `setAppearance` 设的 `NSApp.appearance`
   * 一次管所有窗口，于是 A 窗切深色，B 窗当场变成「标题栏是深的、正文是浅的」。
   * 存不下也照样广播：内存里的真相已经变了，别让一个坏掉的 localStorage 把别的窗口也拖住。
   */
  private commit(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.v))
    } catch {
      /* 存不下就算了 */
    }
    window.api.syncPrefs(this.v)
  }

  /** 解析成确定的明暗：sepia 算浅色一侧 */
  get resolved(): 'light' | 'dark' {
    if (this.v.theme === 'dark') return 'dark'
    if (this.v.theme === 'system') return this.mq.matches ? 'dark' : 'light'
    return 'light'
  }

  /** 标题栏那颗月亮按钮 / ⌃⌘D：在浅与深之间直接对切（不经过「跟随系统」） */
  toggleDark(): void {
    this.setTheme(this.resolved === 'dark' ? 'light' : 'dark')
  }

  setTheme(theme: AppearanceMode): void {
    this.v.theme = theme
    this.commit()
    this.apply()
    this.sync()
  }

  private set<K extends keyof PrefValues>(k: K, val: PrefValues[K]): void {
    this.v[k] = val
    this.commit()
    this.apply()
    this.sync()
  }

  setCustom(name: string | null): void {
    this.v.custom = name
    this.commit()
    this.applyCustom()
    this.sync()
  }

  /**
   * 界面语言：进偏好持久化，通知 i18n 订阅者（渲染层各处 chrome 重刷），
   * 并推给壳重建原生菜单/对话框（契约 v16）。
   */
  setLang(l: Lang): void {
    this.v.lang = l
    this.commit()
    setI18nLang(l)
    window.api.setLanguage(l)
    this.sync()
  }

  reset(): void {
    this.v = { ...DEFAULTS }
    this.applyCustom()
    this.commit()
    this.apply()
    // 语言一并回到系统默认 —— 推一遍（setLang 内部去重，没变就是空操作）
    setI18nLang(this.v.lang)
    window.api.setLanguage(this.v.lang)
    this.sync()
  }

  /** 把偏好落到 :root 的自定义属性上（内联样式优先级高于 base.css 的 :root） */
  private paint(): void {
    const root = document.documentElement
    // CSS 只认确定值：system 在这里解析掉，sepia 原样传（它自己就是一套确定的 token）
    root.dataset['theme'] = this.v.theme === 'system' ? (this.mq.matches ? 'dark' : 'light') : this.v.theme
    root.style.setProperty('--body-font', `var(--${this.v.font})`)
    root.style.setProperty('--body-size', `${this.v.size}px`)
    root.style.setProperty('--body-leading', String(this.v.leading))
    root.style.setProperty('--column', `${this.v.column}rem`)
  }

  /** `paint()` 之外再把**原生那半**同步过去。别的窗口广播来的那份走 `adopt()`，不经过这里 */
  apply(): void {
    this.paint()
    window.api.setAppearance(this.v.theme)
    // 字号/行距变了，CodeMirror 缓存的字符尺寸就过期了，必须让它重量一次
    this.onApply()
  }

  /**
   * 别的窗口改了偏好（契约 v17 的收端）。三条「不做」是这个方法的全部要害：
   *
   * - **不落盘**：发起的那个窗口已经写过同一份了；再写一遍轻则多余，重则把第三个窗口
   *   更新的那份盖回去。
   * - **不回广播**（所以走 `paint()` 而不是任何会 `commit()` 的路）：否则两个窗口互推转圈。
   * - **不推 `setAppearance`**：`NSApp.appearance` 是 app 级的，发起窗口推的时候整个应用的
   *   标题栏/红绿灯/NSAlert 就已经翻过去了 —— 这里补的正是它带不动的那半（本窗口的正文）。
   */
  adopt(values: PrefValues): void {
    const prevCustom = this.v.custom
    this.v = normalizePrefs(values)
    this.paint()
    // 皮肤**只在真的换了**才重贴：拖字号滑杆时广播是连发的（每个 input 事件一条），
    // 而 applyCustom 是「拆掉 <style> 再塞一份整 CSS 回去」—— 那是整页样式重算，
    // 一次拖动重算三十遍，另一个窗口当场卡给你看
    if (prevCustom !== this.v.custom) this.applyCustom()
    this.onApply()
    // setLang 内部去重：语言没变就是空操作，不会白重建一遍装饰
    setI18nLang(this.v.lang)
    // 设置面板可能正开着（两个窗口各开各的），控件要跟着回填。
    // sync() 全是程序性赋值，不会反过来激起 input/change 事件 —— 不存在两窗互推
    this.sync()
  }

  // ---------- 面板 ----------

  get open(): boolean {
    return this.el !== null && !this.el.hidden
  }

  toggle(): void {
    if (this.open) this.close()
    else this.show()
  }

  show(): void {
    this.lastFocus = document.activeElement as HTMLElement | null
    const el = this.el ?? this.build()
    el.hidden = false
    this.sync()
    el.querySelector<HTMLElement>('.pf-seg button')?.focus()
  }

  close(): void {
    if (!this.el) return
    this.el.hidden = true
    this.lastFocus?.focus()
  }

  private build(): HTMLElement {
    const el = document.createElement('div')
    el.id = 'prefs'
    el.innerHTML = `
      <div class="pf-backdrop"></div>
      <div class="pf-panel" role="dialog" aria-modal="true" aria-labelledby="pf-title">
        <div class="pf-head">
          <h2 id="pf-title" data-i18n="pf.title">${t('pf.title')}</h2>
          <button class="pf-close" aria-label="${t('pf.close')}" data-i18n-aria="pf.close">${icon('close')}</button>
        </div>
        ${this.segRow('lang', 'pf.lang', LANG_OPTS)}
        ${this.segRow('theme', 'pf.theme', THEME_OPTS)}
        ${this.segRow('font', 'pf.font', FONT_OPTS)}
        ${this.rangeRow('size', 'pf.size', 13, 24, 1, 'px')}
        ${this.rangeRow('leading', 'pf.leading', 1.4, 2.4, 0.05, '')}
        ${this.rangeRow('column', 'pf.column', COLUMN_RANGE.min, COLUMN_RANGE.max, 1, 'rem')}
        <div class="pf-row pf-custom"></div>
        <div class="pf-foot">
          <span class="pf-hint" data-i18n="pf.hint">${t('pf.hint')}</span>
          <button class="pf-reset" data-i18n="pf.reset">${t('pf.reset')}</button>
        </div>
      </div>
    `
    applyI18n(el)
    el.querySelector('.pf-backdrop')!.addEventListener('click', () => this.close())
    el.querySelector('.pf-close')!.addEventListener('click', () => this.close())
    el.querySelector('.pf-reset')!.addEventListener('click', () => this.reset())

    el.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') {
        e.stopPropagation()
        this.close()
      }
    })

    el.addEventListener('click', (e) => {
      const btn = (e.target as Element).closest<HTMLElement>('.pf-seg button')
      if (!btn) return
      const group = btn.closest<HTMLElement>('.pf-seg')!.dataset['key'] as 'lang' | 'theme' | 'font'
      const val = btn.dataset['val']!
      if (group === 'lang') this.setLang(val as Lang)
      else if (group === 'theme') this.setTheme(val as AppearanceMode)
      else this.set('font', val as BodyFont)
    })

    for (const input of el.querySelectorAll<HTMLInputElement>('input[type=range]')) {
      input.addEventListener('input', () => {
        const key = input.dataset['key'] as 'size' | 'leading' | 'column'
        this.set(key, Number(input.value))
      })
    }

    document.body.appendChild(el)
    this.el = el
    this.buildCustomRow()
    return el
  }

  /**
   * 「自定义样式」一行。面板可能先于 `userThemes()` 建好，所以这一行**单独重建** ——
   * 皮肤列表一到就把它刷一遍，而不是等下次开面板。
   */
  private buildCustomRow(): void {
    const row = this.el?.querySelector<HTMLElement>('.pf-custom')
    if (!row) return
    if (!this.themes.length) {
      row.innerHTML =
        `<span class="pf-label" data-i18n="pf.custom">${t('pf.custom')}</span>` +
        `<span class="pf-note" data-i18n="pf.customHint" ` +
        `data-i18n-args='${JSON.stringify({ dir: THEMES_DIR })}'>${t('pf.customHint', { dir: THEMES_DIR })}</span>`
      return
    }
    const opts = [`<option value="">${t('pf.none')}</option>`]
      .concat(this.themes.map((th) => `<option value="${th.name}">${th.name}</option>`))
      .join('')
    row.innerHTML =
      `<label class="pf-label" for="pf-custom" data-i18n="pf.custom">${t('pf.custom')}</label>` +
      `<select class="pf-select" id="pf-custom">${opts}</select>`
    applyI18n(row)
    const sel = row.querySelector<HTMLSelectElement>('select')!
    sel.value = this.v.custom ?? ''
    sel.addEventListener('change', () => this.setCustom(sel.value || null))
  }

  // ---------- 标题栏的栏宽浮层（P3-5 的第二个入口）----------

  /**
   * 右上角那颗按钮拉出来的栏宽滑杆。**与设置面板同一个值、同一条持久化** ——
   * 它只是把最常调的那一项拿到手边，不是另一套状态。
   */
  toggleColumn(anchor: HTMLElement): void {
    const exist = document.getElementById('col-pop')
    if (exist) {
      exist.remove()
      return
    }
    const pop = document.createElement('div')
    pop.id = 'col-pop'
    pop.innerHTML = `
      <div class="cp-row">
        <span class="cp-label" data-i18n="tb.column">${t('tb.column')}</span>
        <output class="cp-val">${this.v.column}rem</output>
      </div>
      <input type="range" min="${COLUMN_RANGE.min}" max="${COLUMN_RANGE.max}" step="1"
             value="${this.v.column}" aria-label="${t('tb.column')}" data-i18n-aria="tb.column" />
    `
    applyI18n(pop)
    document.body.appendChild(pop)
    const box = anchor.getBoundingClientRect()
    pop.style.top = `${box.bottom + 6}px`
    // 贴着窗口右沿弹出时要回折，否则浮层被切掉一半（同 ui/menu.ts）
    pop.style.left = `${Math.max(8, Math.min(box.left - 60, window.innerWidth - pop.offsetWidth - 8))}px`

    const input = pop.querySelector('input')!
    const out = pop.querySelector('output')!
    input.addEventListener('input', () => {
      this.set('column', Number(input.value))
      out.textContent = `${input.value}rem`
    })

    const dismiss = (ev: Event): void => {
      if (pop.contains(ev.target as Node) || anchor.contains(ev.target as Node)) return
      pop.remove()
      window.removeEventListener('mousedown', dismiss, true)
      window.removeEventListener('keydown', onKey, true)
    }
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        pop.remove()
        window.removeEventListener('mousedown', dismiss, true)
        window.removeEventListener('keydown', onKey, true)
      }
    }
    window.addEventListener('mousedown', dismiss, true)
    window.addEventListener('keydown', onKey, true)
    input.focus()
  }

  private segRow(key: string, labelKey: Key, options: SegOpt[]): string {
    const buttons = options
      .map((o) =>
        o.key !== undefined
          ? `<button type="button" role="radio" data-val="${o.val}" data-i18n="${o.key}">${t(o.key)}</button>`
          : `<button type="button" role="radio" data-val="${o.val}">${o.label}</button>`
      )
      .join('')
    return `
      <div class="pf-row">
        <span class="pf-label" data-i18n="${labelKey}">${t(labelKey)}</span>
        <div class="pf-seg" data-key="${key}" role="radiogroup" aria-label="${t(labelKey)}" data-i18n-aria="${labelKey}">${buttons}</div>
      </div>`
  }

  private rangeRow(key: string, labelKey: Key, min: number, max: number, step: number, unit: string): string {
    return `
      <div class="pf-row">
        <label class="pf-label" for="pf-${key}" data-i18n="${labelKey}">${t(labelKey)}</label>
        <input type="range" id="pf-${key}" data-key="${key}"
               min="${min}" max="${max}" step="${step}" data-unit="${unit}">
        <output class="pf-val" for="pf-${key}"></output>
      </div>`
  }

  /** 把当前值回填到控件上（面板没建过就什么都不做） */
  private sync(): void {
    if (!this.el) return
    for (const seg of this.el.querySelectorAll<HTMLElement>('.pf-seg')) {
      const key = seg.dataset['key'] as 'lang' | 'theme' | 'font'
      for (const btn of seg.querySelectorAll<HTMLElement>('button')) {
        const on = btn.dataset['val'] === this.v[key]
        btn.classList.toggle('is-on', on)
        btn.setAttribute('aria-checked', String(on))
      }
    }
    for (const input of this.el.querySelectorAll<HTMLInputElement>('input[type=range]')) {
      const key = input.dataset['key'] as 'size' | 'leading' | 'column'
      input.value = String(this.v[key])
      const out = this.el.querySelector<HTMLElement>(`output[for="pf-${key}"]`)
      if (out) out.textContent = `${this.v[key]}${input.dataset['unit'] ?? ''}`
    }
    // 皮肤下拉：本窗口自己改的时候它本来就对，这一句是给 adopt() 用的
    const custom = this.el.querySelector<HTMLSelectElement>('#pf-custom')
    if (custom) custom.value = this.v.custom ?? ''
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo
}
