import { applyI18n, t } from '../i18n'
import { diffView } from './diff-view'
import { icon } from './icons'

/**
 * 外部修改冲突（第八节 2）。
 *
 * 场景只有一个，但它每天都在发生：**另一个编辑器、同步工具、或者自己的另一个窗口
 * 改了同一个文件，而我这边还有没保存的修改。** 从前这件事走一个原生两按钮弹窗
 * （「重新载入」／「保留我的版本」），有两处不对：
 *
 * ① **看不见自己在选什么**。两个按钮各丢掉一份内容，而人手上没有任何依据 ——
 *    磁盘上改的是一个错别字还是整整一章？「重新载入」到底会失去什么？
 * ② **没有「都留着」这条路**。而它才是绝大多数人真正想要的：把我的另存一份，
 *    原文件留给那边。
 *
 * 所以换成这块浮层：**差异摆在正中间**（与版本历史同一份版面，见 `diff-view.ts`），
 * 三颗按钮各自写明**要丢掉什么**，另加一条「稍后再说」—— 关掉不等于解决，
 * 冲突继续挂在那个标签上，那个文件的自动保存也继续停着（`main.ts` 的 `Tab.conflict`）。
 *
 * **不是原生弹窗还有一个好处**：`NSAlert.runModal()` 会把无人值守的 E2E 直接卡死，
 * 从前这条路因此一次都没被自检跑过（探针只走得到「干净标签静默重载」那一支）。
 */

/** 三条出路。`later` 不在这儿 —— 那是「关掉面板」，不是一个决定 */
export type ConflictChoice = 'reload' | 'keep' | 'saveAs'

export interface ConflictOpen {
  /** 文件名（只用来说话） */
  name: string
  /** 磁盘上此刻那一份 */
  disk: string
  /** 我手上这一份 */
  mine: string
  pick: (choice: ConflictChoice) => void
}

export class Conflict {
  readonly el: HTMLElement
  private readonly diffEl: HTMLElement
  private readonly emptyEl: HTMLElement
  private readonly bodyEl: HTMLElement
  private pick: ((choice: ConflictChoice) => void) | null = null
  private lastFocus: HTMLElement | null = null
  private unbindEscape: (() => void) | null = null

  constructor() {
    this.el = document.createElement('div')
    this.el.id = 'conflict'
    this.el.hidden = true
    // 版面与版本历史共用一套 `.hi-*`：同一件事（看两份差在哪儿）在这个应用里只有一个长相
    this.el.innerHTML = `
      <div class="hi-backdrop"></div>
      <div class="hi-box" role="dialog" aria-modal="true" aria-labelledby="cf-title">
        <div class="hi-head">
          <h2 id="cf-title" data-i18n="cf.title">${t('cf.title')}</h2>
          <button class="hi-close" aria-label="${t('cf.later')}" data-i18n-aria="cf.later">${icon('close')}</button>
        </div>
        <p class="cf-body"></p>
        <div class="hi-right">
          <div class="hi-diff"></div>
          <div class="hi-empty" hidden></div>
        </div>
        <div class="hi-foot">
          <span class="hi-hint" data-i18n="cf.hint">${t('cf.hint')}</span>
          <span class="cf-acts">
            <button class="hi-alt" data-pick="reload" data-i18n="cf.reload">${t('cf.reload')}</button>
            <button class="hi-alt" data-pick="keep" data-i18n="cf.keep">${t('cf.keep')}</button>
            <button class="hi-restore" data-pick="saveAs" data-i18n="cf.saveAs">${t('cf.saveAs')}</button>
          </span>
        </div>
      </div>
    `
    applyI18n(this.el)
    this.diffEl = this.el.querySelector('.hi-diff')!
    this.emptyEl = this.el.querySelector('.hi-empty')!
    this.bodyEl = this.el.querySelector('.cf-body')!

    // **背景点击不等于关掉**：另外两块浮层（版本历史、命令面板）点背景就走，
    // 因为那两件事随时可以再来一次。这一件不行 —— 关掉之后冲突还在，而人会以为
    // 「刚才那下已经处理过了」。要走得点那颗写着「稍后再说」的 ×
    this.el.querySelector('.hi-close')!.addEventListener('click', () => this.close())
    this.el.querySelector('.cf-acts')!.addEventListener('click', (e) => {
      const btn = (e.target as Element).closest<HTMLElement>('button[data-pick]')
      if (!btn) return
      const choice = btn.dataset['pick'] as ConflictChoice
      const run = this.pick
      this.close()
      run?.(choice)
    })
    document.body.appendChild(this.el)
  }

  get visible(): boolean {
    return !this.el.hidden
  }

  open(o: ConflictOpen): void {
    this.pick = o.pick
    this.bodyEl.textContent = t('cf.body', { name: o.name })
    // 老的那份是**磁盘上那一份**，新的是我手上这一份：于是 `−` 是「那边有而我这儿没有」，
    // `+` 是「我改出来的」。脚注那句 `cf.hint` 说的就是这个约定
    const d = diffView(o.disk, o.mine)
    this.emptyEl.hidden = d.html !== ''
    this.emptyEl.textContent = t('cf.same')
    this.diffEl.innerHTML = d.html
    if (this.el.hidden) this.lastFocus = document.activeElement as HTMLElement | null
    this.el.hidden = false
    this.bindEscape()
    // 焦点落在「另存我的版本…」上：三颗里唯一一颗**谁都不丢**的
    this.el.querySelector<HTMLElement>('button[data-pick="saveAs"]')?.focus()
  }

  close(): void {
    if (this.el.hidden) return
    this.el.hidden = true
    this.pick = null
    this.unbindEscape?.()
    this.unbindEscape = null
    this.lastFocus?.focus()
  }

  /** Esc = 稍后再说（与版本历史同一条路：浮层的关闭键属于整个窗口） */
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
}
