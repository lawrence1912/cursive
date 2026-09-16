import { t, type Key } from '../i18n'
import { fuzzy, fuzzyPath, type FuzzyHit } from './fuzzy'
import { icon } from './icons'

/**
 * 0.2.0 命令面板 / 快速打开 —— **一个组件，两种内容**。
 *
 * 分不开：两者的交互一模一样（输入筛选、上下选、回车执行、Esc 关），
 * 差别只在「条目从哪儿来」。写两份的话，滚动跟随、回折、空态这些细节
 * 迟早在一边修好、另一边还留着。
 *
 * 面板本身不认识任何命令，只认 `PaletteItem.run`：
 * - 命令面板把 `run` 接到 `handleMenu(action)` 上 —— 与原生菜单**同一条路**，
 *   于是「菜单里有、面板里没有」这种漂移不可能发生；
 * - 快速打开把 `run` 接到 `openPath`。
 */

export interface PaletteItem {
  label: string
  /** 右侧那一列：快捷键，或文件所在目录 */
  hint?: string
  /** 参与匹配的串。默认就是 `label` */
  key?: string
  /**
   * `label` 在 `key` 里的起始下标，默认 0。
   *
   * 两者常常不是同一个串：文件条目的 `key` 是整条相对路径、`label` 只是文件名，
   * 命令条目的 `key` 是「名字 + 快捷键」。打分给出的下标是相对 `key` 的，
   * 不做这一次平移就会把粗体标到错的字上（甚至标到 label 之外）。
   */
  labelAt?: number
  /** 按路径打分（文件名权重高于目录，见 fuzzy.ts） */
  path?: boolean
  run: () => void | Promise<void>
}

/** 最多画这么多行。4000 条文件全画出来只会让第一次按键卡住 —— 没人会翻到第 51 条 */
const RENDER_LIMIT = 50

interface Scored {
  item: PaletteItem
  hit: FuzzyHit
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

/**
 * 把命中的字加粗。**必须自己转义**：这里拼的是 innerHTML，而条目文字里有
 * 用户的文件名 —— 一个叫 `<img onerror=…>.md` 的文件不该变成一次脚本执行。
 */
function highlight(text: string, positions: number[]): string {
  if (!positions.length) return escapeHtml(text)
  const hit = new Set(positions)
  let out = ''
  let inMark = false
  for (let i = 0; i < text.length; i++) {
    const on = hit.has(i)
    if (on !== inMark) {
      out += on ? '<b>' : '</b>'
      inMark = on
    }
    out += escapeHtml(text[i]!)
  }
  return out + (inMark ? '</b>' : '')
}

export class Palette {
  readonly el: HTMLElement
  private readonly input: HTMLInputElement
  private readonly listEl: HTMLElement
  private readonly emptyEl: HTMLElement

  private items: PaletteItem[] = []
  private shown: Scored[] = []
  private cursor = 0
  private emptyKey: Key = 'pl.noMatch'
  /** 关闭后焦点还给谁 —— 面板是临时的，用完必须把光标还回编辑器 */
  private lastFocus: HTMLElement | null = null
  /** 开着时挂在 window 上的那颗 Esc（见 `bindEscape`），关掉时要摘干净 */
  private unbindEscape: (() => void) | null = null

  constructor() {
    this.el = document.createElement('div')
    this.el.id = 'palette'
    this.el.hidden = true
    this.el.innerHTML = `
      <div class="pl-backdrop"></div>
      <div class="pl-box" role="dialog" aria-modal="true">
        <div class="pl-head">
          <span class="pl-icon">${icon('search')}</span>
          <input class="pl-input" type="text" autocomplete="off" spellcheck="false"
                 role="combobox" aria-expanded="true" aria-controls="pl-list" />
        </div>
        <div class="pl-list" id="pl-list" role="listbox"></div>
        <div class="pl-empty" hidden></div>
      </div>
    `
    this.input = this.el.querySelector('.pl-input')!
    this.listEl = this.el.querySelector('.pl-list')!
    this.emptyEl = this.el.querySelector('.pl-empty')!

    this.el.querySelector('.pl-backdrop')!.addEventListener('click', () => this.close())
    this.input.addEventListener('input', () => this.refilter())
    this.input.addEventListener('keydown', (e) => this.onKey(e))
    // 点条目：走 mousedown 而不是 click —— click 之前输入框会先失焦，
    // 而失焦要关面板（同 ui/menu.ts 那条「捕获阶段」的理由）
    this.listEl.addEventListener('mousedown', (e) => {
      const row = (e.target as Element).closest<HTMLElement>('.pl-row')
      if (!row) return
      e.preventDefault()
      this.cursor = Number(row.dataset['i'])
      this.accept()
    })
    document.body.appendChild(this.el)
  }

  get visible(): boolean {
    return !this.el.hidden
  }

  /** 开面板。文案在开的那一刻现取 —— 面板是临时的，不需要跟着 langchange 重刷 */
  open(items: PaletteItem[], placeholder: string, emptyKey: Key): void {
    this.items = items
    this.emptyKey = emptyKey
    this.lastFocus = document.activeElement as HTMLElement | null
    this.input.value = ''
    this.input.placeholder = placeholder
    this.input.setAttribute('aria-label', placeholder)
    this.el.hidden = false
    this.bindEscape()
    this.refilter()
    this.input.focus()
  }

  /**
   * Esc 走 **window 捕获**，而不是只挂在输入框上。
   *
   * 输入框那一份挡不住「焦点已经不在它身上」的情况 —— 鼠标在列表里点一下、
   * 或者别的什么把焦点收走了，面板就按不掉了。`ui/menu.ts` 的右键菜单是同一个做法，
   * 理由也一样：浮层的关闭键属于**整个窗口**，不属于浮层里的某个控件。
   *
   * 捕获阶段是必须的：编辑器自己也吃 Esc（关查找面板），等冒泡就轮不到了。
   */
  private bindEscape(): void {
    this.unbindEscape?.()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.stopPropagation()
      this.close()
    }
    window.addEventListener('keydown', onKey, true)
    this.unbindEscape = () => window.removeEventListener('keydown', onKey, true)
  }

  close(): void {
    if (this.el.hidden) return
    this.el.hidden = true
    this.unbindEscape?.()
    this.unbindEscape = null
    this.items = []
    this.shown = []
    this.listEl.textContent = ''
    this.lastFocus?.focus()
  }

  private onKey(e: KeyboardEvent): void {
    // 组字期间方向键归输入法（红线二）：中文查询时选字框正用着上下键
    if (e.isComposing) return
    // Esc 归 `bindEscape` 那颗 window 捕获键管，这里不再重复处理
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault()
      this.move(1)
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault()
      this.move(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      this.accept()
    }
  }

  private move(delta: number): void {
    if (!this.shown.length) return
    this.cursor = (this.cursor + delta + this.shown.length) % this.shown.length
    this.paintCursor()
  }

  private accept(): void {
    const pick = this.shown[this.cursor]
    if (!pick) return
    // 先关再跑：`run` 多半要把焦点放进编辑器，关面板会把焦点抢回 lastFocus，
    // 顺序反了的话光标最后落在面板刚消失的位置上
    this.close()
    void pick.item.run()
  }

  private refilter(): void {
    const q = this.input.value.trim()
    const scored: Scored[] = []
    for (const item of this.items) {
      const key = item.key ?? item.label
      const hit = item.path ? fuzzyPath(q, key) : fuzzy(q, key)
      if (hit) scored.push({ item, hit })
    }
    // 空查询保持原序（命令面板按菜单顺序、文件按路径序），有查询才按分排。
    // `sort` 在 V8 上是稳定的，同分的条目于是仍按原序
    if (q) scored.sort((a, b) => b.hit.score - a.hit.score)
    this.shown = scored.slice(0, RENDER_LIMIT)
    this.cursor = 0
    this.paint()
  }

  private paint(): void {
    if (!this.shown.length) {
      this.listEl.textContent = ''
      this.emptyEl.textContent = t(this.emptyKey)
      this.emptyEl.hidden = false
      return
    }
    this.emptyEl.hidden = true
    this.listEl.innerHTML = this.shown
      .map((s, i) => {
        // 下标从 `key` 的坐标系挪到 `label` 的，落在 label 之外的丢掉
        const at = s.item.labelAt ?? 0
        const local = s.hit.positions
          .map((p) => p - at)
          .filter((p) => p >= 0 && p < s.item.label.length)
        const hint = s.item.hint ? `<span class="pl-hint">${escapeHtml(s.item.hint)}</span>` : ''
        return (
          `<div class="pl-row" role="option" data-i="${i}" aria-selected="false">` +
          `<span class="pl-label">${highlight(s.item.label, local)}</span>${hint}</div>`
        )
      })
      .join('')
    this.paintCursor()
  }

  private paintCursor(): void {
    const rows = this.listEl.querySelectorAll<HTMLElement>('.pl-row')
    rows.forEach((row, i) => {
      const on = i === this.cursor
      row.classList.toggle('is-on', on)
      row.setAttribute('aria-selected', String(on))
      if (on) row.scrollIntoView({ block: 'nearest' })
    })
  }
}
