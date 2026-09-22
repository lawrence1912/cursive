import type { Snapshot } from '../../shared/types'
import { applyI18n, localeOf, t } from '../i18n'
import { diffView, escapeHtml } from './diff-view'
import { icon } from './icons'

/**
 * 0.2.0 版本历史。
 *
 * 对抗的是一件很具体的事：**改崩了一段，而撤销栈已经翻篇了**。
 * 自动保存让这件事更常见 —— 文件早就写下去了，⌘Z 也退不回那一版。
 *
 * 形态是整窗浮层（左边版本列表、右边差异），不是侧栏第三块面板：
 * 差异要并排读，侧栏那点宽度撑不住；而它又是「偶尔打开、看完就走」的东西，
 * 不值得常驻一块地方。
 *
 * 三件事**有意不做**：
 * - 不做分支、不做命名版本 —— 那是版本控制系统的活，这里只要「退回去」；
 * - 不比对两个历史版本，永远拿「当前文档」当右侧 —— 想看的从来是「我离那一版差多少」；
 * - 恢复走一次普通编辑（整份替换），因此 ⌘Z 能撤销、保存零损耗那条红线也不受影响。
 */

/** 恢复时把整份文档替换掉；由 main.ts 接到编辑器上 */
export type RestoreFn = (content: string) => void

export class History {
  readonly el: HTMLElement
  private readonly listEl: HTMLElement
  private readonly diffEl: HTMLElement
  private readonly emptyEl: HTMLElement
  private readonly restoreBtn: HTMLButtonElement

  private items: Snapshot[] = []
  private path: string | null = null
  private current = ''
  private picked: string | null = null
  private pickedText: string | null = null
  private lastFocus: HTMLElement | null = null
  private unbindEscape: (() => void) | null = null

  constructor(private readonly restore: RestoreFn) {
    this.el = document.createElement('div')
    this.el.id = 'history'
    this.el.hidden = true
    this.el.innerHTML = `
      <div class="hi-backdrop"></div>
      <div class="hi-box" role="dialog" aria-modal="true" aria-labelledby="hi-title">
        <div class="hi-head">
          <h2 id="hi-title" data-i18n="hi.title">${t('hi.title')}</h2>
          <button class="hi-close" aria-label="${t('hi.close')}" data-i18n-aria="hi.close">${icon('close')}</button>
        </div>
        <div class="hi-body">
          <div class="hi-list" role="listbox" aria-label="${t('hi.versions')}" data-i18n-aria="hi.versions"></div>
          <div class="hi-right">
            <div class="hi-diff"></div>
            <div class="hi-empty" data-i18n="hi.pick">${t('hi.pick')}</div>
          </div>
        </div>
        <div class="hi-foot">
          <span class="hi-hint" data-i18n="hi.hint">${t('hi.hint')}</span>
          <button class="hi-restore" disabled data-i18n="hi.restore">${t('hi.restore')}</button>
        </div>
      </div>
    `
    applyI18n(this.el)
    this.listEl = this.el.querySelector('.hi-list')!
    this.diffEl = this.el.querySelector('.hi-diff')!
    this.emptyEl = this.el.querySelector('.hi-empty')!
    this.restoreBtn = this.el.querySelector('.hi-restore')!

    this.el.querySelector('.hi-backdrop')!.addEventListener('click', () => this.close())
    this.el.querySelector('.hi-close')!.addEventListener('click', () => this.close())
    this.listEl.addEventListener('click', (e) => {
      const row = (e.target as Element).closest<HTMLElement>('.hi-row')
      if (row) void this.pick(row.dataset['id']!)
    })
    this.restoreBtn.addEventListener('click', () => {
      if (this.pickedText === null) return
      const text = this.pickedText
      this.close()
      this.restore(text)
    })
    document.body.appendChild(this.el)
  }

  get visible(): boolean {
    return !this.el.hidden
  }

  /**
   * 开面板。`path` 是当前文档的路径 —— 未命名文档没有历史
   * （它归 scratch 管，那是崩溃恢复，不是版本）。
   */
  async open(path: string | null, current: string): Promise<void> {
    this.path = path
    this.current = current
    this.picked = null
    this.pickedText = null
    this.restoreBtn.disabled = true
    this.lastFocus = document.activeElement as HTMLElement | null
    this.el.hidden = false
    this.bindEscape()
    this.diffEl.textContent = ''
    this.emptyEl.hidden = false
    this.emptyEl.textContent = t(path ? 'hi.pick' : 'hi.unnamed')
    this.items = path ? await window.api.snapshotList(path) : []
    // 一条版本都没有时，话由**左边那列**说就够了 —— 右边再说一遍同样的话，
    // 一张空面板上就有两处文字在重复同一件事
    this.emptyEl.hidden = this.items.length === 0
    this.paintList()
  }

  close(): void {
    if (this.el.hidden) return
    this.el.hidden = true
    this.unbindEscape?.()
    this.unbindEscape = null
    this.lastFocus?.focus()
  }

  /** Esc 走 window 捕获 —— 与命令面板同一个理由（浮层的关闭键属于整个窗口） */
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

  private paintList(): void {
    if (!this.items.length) {
      this.listEl.innerHTML = `<div class="hi-none">${escapeHtml(t(this.path ? 'hi.none' : 'hi.unnamed'))}</div>`
      return
    }
    // **秒不能省**：连着改两下就是同一分钟里的两份快照，只到分钟的话列表上
    // 会出现几行一模一样的时间，根本分不出点哪一条
    const fmt = new Intl.DateTimeFormat(localeOf(), {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
    })
    this.listEl.innerHTML = this.items
      .map((s, i) => {
        const when = fmt.format(new Date(s.savedAt))
        // 第一条是最近一次保存，给个标记 —— 它多半就是磁盘上此刻那一份
        const tag = i === 0 ? `<span class="hi-tag">${escapeHtml(t('hi.latest'))}</span>` : ''
        return (
          `<div class="hi-row" role="option" aria-selected="false" data-id="${escapeHtml(s.id)}">` +
          `<span class="hi-when">${escapeHtml(when)}${tag}</span>` +
          `<span class="hi-size">${kb(s.bytes)}</span></div>`
        )
      })
      .join('')
  }

  private async pick(id: string): Promise<void> {
    if (!this.path) return
    this.picked = id
    for (const row of this.listEl.querySelectorAll<HTMLElement>('.hi-row')) {
      const on = row.dataset['id'] === id
      row.classList.toggle('is-on', on)
      row.setAttribute('aria-selected', String(on))
    }
    const text = await window.api.snapshotRead(this.path, id)
    // 读回来之前用户可能又点了别的一条：晚到的结果不许盖掉新选中的那份
    if (this.picked !== id) return
    if (text === null) {
      this.pickedText = null
      this.restoreBtn.disabled = true
      this.diffEl.textContent = ''
      this.emptyEl.hidden = false
      this.emptyEl.textContent = t('hi.gone')
      return
    }
    this.pickedText = text
    this.restoreBtn.disabled = text === this.current
    this.paintDiff(text)
  }

  private paintDiff(oldText: string): void {
    // 版面归 `diff-view.ts`（外部修改冲突那块面板用的是同一份）—— 这里只管空态那句话
    const d = diffView(oldText, this.current)
    this.emptyEl.hidden = d.html !== ''
    if (!this.emptyEl.hidden) {
      this.emptyEl.textContent = t('hi.same')
      this.diffEl.textContent = ''
      return
    }
    this.diffEl.innerHTML = d.html
  }
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}
