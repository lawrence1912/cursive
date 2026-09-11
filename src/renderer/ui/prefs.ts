import type { AppearanceMode } from '../../shared/types'
import { icon } from './icons'

export type BodyFont = 'serif' | 'sans'

export interface PrefValues {
  theme: AppearanceMode
  font: BodyFont
  /** 正文字号 px */
  size: number
  /** 行距倍数 */
  leading: number
  /** 栏宽 rem */
  column: number
}

const KEY = 'typmd.prefs'
const DEFAULTS: PrefValues = { theme: 'system', font: 'serif', size: 16, leading: 1.75, column: 42 }

const FONT_LABEL: Record<BodyFont, string> = { serif: '衬线', sans: '无衬线' }
const THEME_LABEL: Record<AppearanceMode, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色'
}

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

  constructor(private readonly onApply: () => void) {
    this.v = this.load()
    this.mq.addEventListener('change', () => {
      if (this.v.theme === 'system') this.apply()
    })
  }

  get values(): PrefValues {
    return { ...this.v }
  }

  private load(): PrefValues {
    try {
      const raw = localStorage.getItem(KEY)
      if (!raw) return { ...DEFAULTS }
      const parsed = JSON.parse(raw) as Partial<PrefValues>
      return {
        theme: parsed.theme ?? DEFAULTS.theme,
        font: parsed.font ?? DEFAULTS.font,
        size: clamp(parsed.size ?? DEFAULTS.size, 13, 24),
        leading: clamp(parsed.leading ?? DEFAULTS.leading, 1.4, 2.4),
        column: clamp(parsed.column ?? DEFAULTS.column, 30, 60)
      }
    } catch {
      // 隐私模式 / 存储被禁：用默认值继续，不要让偏好把应用拖崩
      return { ...DEFAULTS }
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.v))
    } catch {
      /* 存不下就算了 */
    }
  }

  setTheme(theme: AppearanceMode): void {
    this.v.theme = theme
    this.persist()
    this.apply()
    this.sync()
  }

  private set<K extends keyof PrefValues>(k: K, val: PrefValues[K]): void {
    this.v[k] = val
    this.persist()
    this.apply()
    this.sync()
  }

  reset(): void {
    this.v = { ...DEFAULTS }
    this.persist()
    this.apply()
    this.sync()
  }

  /** 把偏好落到 :root 的自定义属性上（内联样式优先级高于 base.css 的 :root） */
  apply(): void {
    const root = document.documentElement
    const resolved = this.v.theme === 'system' ? (this.mq.matches ? 'dark' : 'light') : this.v.theme
    root.dataset['theme'] = resolved
    root.style.setProperty('--body-font', `var(--${this.v.font})`)
    root.style.setProperty('--body-size', `${this.v.size}px`)
    root.style.setProperty('--body-leading', String(this.v.leading))
    root.style.setProperty('--column', `${this.v.column}rem`)
    window.api.setAppearance(this.v.theme)
    // 字号/行距变了，CodeMirror 缓存的字符尺寸就过期了，必须让它重量一次
    this.onApply()
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
          <h2 id="pf-title">设置</h2>
          <button class="pf-close" aria-label="关闭设置">${icon('close')}</button>
        </div>
        ${this.segRow('theme', '主题', THEME_LABEL)}
        ${this.segRow('font', '正文字体', FONT_LABEL)}
        ${this.rangeRow('size', '字号', 13, 24, 1, 'px')}
        ${this.rangeRow('leading', '行距', 1.4, 2.4, 0.05, '')}
        ${this.rangeRow('column', '栏宽', 30, 60, 1, 'rem')}
        <div class="pf-foot">
          <span class="pf-hint">改动即时生效并自动记住</span>
          <button class="pf-reset">恢复默认</button>
        </div>
      </div>
    `
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
      const group = btn.closest<HTMLElement>('.pf-seg')!.dataset['key'] as 'theme' | 'font'
      const val = btn.dataset['val']!
      if (group === 'theme') this.setTheme(val as AppearanceMode)
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
    return el
  }

  private segRow(key: string, label: string, labels: Record<string, string>): string {
    const buttons = Object.entries(labels)
      .map((pair) => `<button type="button" role="radio" data-val="${pair[0]}">${pair[1]}</button>`)
      .join('')
    return `
      <div class="pf-row">
        <span class="pf-label">${label}</span>
        <div class="pf-seg" data-key="${key}" role="radiogroup" aria-label="${label}">${buttons}</div>
      </div>`
  }

  private rangeRow(key: string, label: string, min: number, max: number, step: number, unit: string): string {
    return `
      <div class="pf-row">
        <label class="pf-label" for="pf-${key}">${label}</label>
        <input type="range" id="pf-${key}" data-key="${key}"
               min="${min}" max="${max}" step="${step}" data-unit="${unit}">
        <output class="pf-val" for="pf-${key}"></output>
      </div>`
  }

  /** 把当前值回填到控件上（面板没建过就什么都不做） */
  private sync(): void {
    if (!this.el) return
    for (const seg of this.el.querySelectorAll<HTMLElement>('.pf-seg')) {
      const key = seg.dataset['key'] as 'theme' | 'font'
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
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo
}
