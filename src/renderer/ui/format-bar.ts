import { HEADING_ACTIONS, INSERT_ACTIONS } from '../editor/fmt'
import { applyI18n, t, type Key } from '../i18n'
import type { MenuAction } from '../../shared/types'
import { icon, type IconName } from './icons'
import { keyOf } from './shortcuts'

/**
 * P2-8 底部悬浮格式栏。
 *
 * 只是 `fmt.ts` 那张命令表的**第三个入口** —— 另外两个是原生「格式」菜单和快捷键。
 * 这里一行编辑逻辑都没有：点按钮 = 派一个 `fmt:*` MenuAction，和菜单走完全同一条路，
 * 于是幂等、多光标、一次 ⌘Z 撤回全都白拿。
 *
 * 形态：贴编辑区底部居中悬浮的胶囊条（不是常驻顶栏，也不是选中才浮出的气泡）——
 * 标题 / 引用 / 列表这些**只要光标就能用**的行级命令，气泡形态根本够不着。
 * 位置**贴着状态栏坐**：条子盖在正文上，离底越近，被它压住的正文就越少。
 *
 * **两级显隐**：视图菜单那个开关管「有没有这条工具栏」（`is-hidden`，连手柄一起收），
 * 条子右端那颗折角管「摊开还是收起」（`is-collapsed`，只剩一颗手柄贴在原地）——
 * 后者是常用动作（写几段就想把底下这条让开），不该每次都去翻菜单。
 *
 * 三个必须记住的点：
 *   1. 条子上 `mousedown` 一律 `preventDefault()`，否则焦点从编辑器跑到按钮上，
 *      选区没了，命令作用的位置就错了。
 *   2. 它盖在正文上，所以要给编辑器的滚动留出等高的下边距（`setup.ts` 的
 *      `bottomOverlay`），不然光标打到底部会躲到条子后面。
 *   3. **开关与插入分开摆**（P2-9）：条子上那一排全是开关，点亮 = 当前生效；
 *      插入类收进右端「插入」下拉 —— 它们永远不会点亮，平铺进同一排会让人以为坏了，
 *      而且条子已经是 `overflow-x:auto`，再多八颗窄窗口就只能横着滚。
 */

/** 摊开时占多高（条子 42 + 下沿 6 + 一点呼吸），给 scrollMargins 用 */
export const FORMAT_BAR_SPACE = 52

/** 收起时只剩一颗手柄，让出的边距跟着缩 —— 否则收起来了正文底下还空着一条 */
export const FORMAT_BAR_COLLAPSED_SPACE = 30

interface Btn {
  action: MenuAction
  name: IconName
  labelKey: Key
}

/** 强调类标记：都是「给一段文字套个壳」 */
const EMPHASIS: Btn[] = [
  { action: 'fmt:bold', name: 'bold', labelKey: 'fb.bold' },
  { action: 'fmt:italic', name: 'italic', labelKey: 'fb.italic' },
  { action: 'fmt:underline', name: 'underline', labelKey: 'fb.underline' },
  { action: 'fmt:strikethrough', name: 'strike', labelKey: 'fb.strike' },
  { action: 'fmt:highlight', name: 'highlight', labelKey: 'fb.highlight' }
]

/** 其余行内：各自是一种独立的内容类型，不是强调 */
const INLINE: Btn[] = [
  { action: 'fmt:code-inline', name: 'code', labelKey: 'fb.code' },
  { action: 'fmt:superscript', name: 'sup', labelKey: 'fb.sup' },
  { action: 'fmt:subscript', name: 'sub', labelKey: 'fb.sub' },
  { action: 'fmt:math-inline', name: 'sigma', labelKey: 'fb.mathInline' },
  { action: 'fmt:link', name: 'link', labelKey: 'fb.link' }
]

const BLOCK: Btn[] = [
  { action: 'fmt:quote', name: 'quote', labelKey: 'fb.quote' },
  { action: 'fmt:ulist', name: 'ulist', labelKey: 'fb.ulist' },
  { action: 'fmt:olist', name: 'olist', labelKey: 'fb.olist' },
  { action: 'fmt:task', name: 'task', labelKey: 'fb.task' },
  { action: 'fmt:code-block', name: 'code-block', labelKey: 'fb.codeBlock' }
]

/** 块类型下拉里的条目；正文排第一。右边那颗键帽取自菜单那份（`ui/shortcuts.ts`） */
const BLOCK_KINDS: { action: MenuAction; labelKey: Key; args?: Record<string, number> }[] = [
  { action: 'fmt:p', labelKey: 'fb.p' },
  ...HEADING_ACTIONS.map((action, i) => ({
    action: action as MenuAction,
    labelKey: 'fb.h' as Key,
    args: { n: i + 1 }
  }))
]

/**
 * 插入下拉的图标与文案。**顺序的真相在 `fmt.ts` 的 `INSERT_ACTIONS`**，这里只补 UI 的那一半；
 * 写成 Record 是为了让「fmt.ts 加了一条插入命令、这里忘了配」当场 typecheck 不过
 */
const INSERT_META: Record<(typeof INSERT_ACTIONS)[number], { name: IconName; labelKey: Key }> = {
  'fmt:table': { name: 'table', labelKey: 'fb.table' },
  'fmt:image': { name: 'image', labelKey: 'fb.image' },
  'fmt:hr': { name: 'hr', labelKey: 'fb.hr' },
  'fmt:math-block': { name: 'sigma-box', labelKey: 'fb.mathBlock' },
  'fmt:callout': { name: 'info', labelKey: 'fb.callout' },
  'fmt:mermaid': { name: 'flow', labelKey: 'fb.mermaid' },
  'fmt:footnote': { name: 'footnote', labelKey: 'fb.footnote' },
  'fmt:toc': { name: 'list', labelKey: 'fb.toc' }
}

const INSERT = INSERT_ACTIONS.map((action) => ({ action, ...INSERT_META[action] }))

/*
 * 插入下拉最底下那行小字（第八节 14）：这几样在空行开头打 `/` 也插得出来（`editor/slash.ts`）。
 * 斜杠菜单是插块最快的那条路，却只有碰巧在行首打过斜杠的人才知道 —— 而翻开这份下拉的人
 * 正是想插一块东西的人，在这儿说一句正合适。`aria-hidden`：role=menu 里只该有菜单项，
 * 这行字是给眼睛看的捷径，不是一个能选的条目。
 */

/**
 * 「这条格式命令配哪颗图标」的一览。**由上面那几张表现算**，不另列一份 ——
 * 斜杠命令菜单（`editor/slash.ts`）列的是同一批块，两处必须长同一个样，
 * 而它需要的只是这一层映射，不该把整条工具栏也拖过去。
 * 对账断言在 `test/slash.test.ts`：哪边改了图标、另一边没跟上，当场变红。
 */
export const FORMAT_ICONS: Partial<Record<MenuAction, IconName>> = Object.fromEntries(
  [...EMPHASIS, ...INLINE, ...BLOCK, ...INSERT].map((b) => [b.action, b.name])
)

/** 条目当前语言下的显示名（标题 N 带编号占位符） */
function kindLabel(k: { labelKey: Key; args?: Record<string, number> }): string {
  return k.args ? t(k.labelKey, k.args) : t(k.labelKey)
}

type MenuId = 'pick' | 'insert'

export class FormatBar {
  readonly el: HTMLElement
  private readonly nameEl: HTMLElement
  private readonly menus: Record<MenuId, HTMLElement>
  private readonly triggers: Record<MenuId, HTMLButtonElement>
  private open: MenuId | null = null

  constructor(
    private readonly run: (action: MenuAction) => void,
    /** 收起/展开之后回调一次：持久化和滚动下边距归 main.ts 管 */
    private readonly onCollapsedChange?: () => void
  ) {
    this.el = document.createElement('div')
    this.el.id = 'format-bar'
    this.el.setAttribute('role', 'toolbar')
    this.el.setAttribute('aria-label', t('fb.toolbar'))
    this.el.setAttribute('data-i18n-aria', 'fb.toolbar')
    this.el.innerHTML = `
      <div class="fb-menu fb-menu-pick" role="menu" hidden>${BLOCK_KINDS.map(
        (k) =>
          `<button type="button" role="menuitem" class="fb-kind" data-action="${k.action}">` +
          `<span class="fb-kind-tick">${icon('check')}</span>` +
          `<span class="fb-kind-name" data-i18n="${k.labelKey}"${k.args ? ` data-i18n-args='${JSON.stringify(k.args)}'` : ''}>${kindLabel(k)}</span><kbd>${keyOf(k.action) ?? ''}</kbd></button>`
      ).join('')}</div>
      <div class="fb-menu fb-menu-insert" role="menu" hidden>${INSERT.map(
        (m) =>
          `<button type="button" role="menuitem" class="fb-kind fb-item" data-action="${m.action}">` +
          `<span class="fb-item-ic">${icon(m.name)}</span>` +
          `<span class="fb-kind-name" data-i18n="${m.labelKey}">${t(m.labelKey)}</span>` +
          `<kbd>${keyOf(m.action) ?? ''}</kbd></button>`
      ).join('')}<p class="fb-menu-tip" aria-hidden="true" data-i18n="fb.slashTip">${t('fb.slashTip')}</p></div>
      <div class="fb-bar">
        <button type="button" class="fb-pick" aria-haspopup="menu" aria-expanded="false"
                aria-label="${t('fb.pick')}" data-i18n-aria="fb.pick"
                title="${t('fb.pickTitle')}" data-i18n-title="fb.pickTitle">
          ${icon('pilcrow')}<span class="fb-pick-name">${kindLabel(BLOCK_KINDS[0]!)}</span>${icon('chevron-down')}
        </button>
        <i class="fb-sep"></i>
        ${EMPHASIS.map(btnHTML).join('')}
        <i class="fb-sep"></i>
        ${INLINE.map(btnHTML).join('')}
        <i class="fb-sep"></i>
        ${BLOCK.map(btnHTML).join('')}
        <i class="fb-sep"></i>
        <button type="button" class="fb-pick fb-ins" aria-haspopup="menu" aria-expanded="false"
                aria-label="${t('fb.insert')}" data-i18n-aria="fb.insert"
                title="${t('fb.insertTitle')}" data-i18n-title="fb.insertTitle">
          ${icon('plus')}<span data-i18n="fb.insert">${t('fb.insert')}</span>${icon('chevron-down')}
        </button>
        <i class="fb-sep"></i>
        <button type="button" class="fb-btn fb-fold" aria-expanded="true"
                aria-label="${t('fb.collapse')}" data-i18n-aria="fb.collapse"
                title="${t('fb.collapse')}" data-i18n-title="fb.collapse">${icon('chevron-down')}</button>
      </div>
      <button type="button" class="fb-handle" aria-expanded="false"
              aria-label="${t('fb.expand')}" data-i18n-aria="fb.expand"
              title="${t('fb.expand')}" data-i18n-title="fb.expand">${icon('chevron-up')}</button>
    `
    applyI18n(this.el)
    this.menus = {
      pick: this.el.querySelector('.fb-menu-pick')!,
      insert: this.el.querySelector('.fb-menu-insert')!
    }
    this.triggers = {
      pick: this.el.querySelector('.fb-pick:not(.fb-ins)')!,
      insert: this.el.querySelector('.fb-ins')!
    }
    this.nameEl = this.el.querySelector('.fb-pick-name')!

    // 焦点必须留在编辑器里：一旦跑到按钮上，选区就没了，命令作用的位置也就错了
    this.el.addEventListener('mousedown', (e) => e.preventDefault())

    this.el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      // 折角与手柄是同一个开关的两半：摊开时在条子右端，收起后就是那颗手柄本身
      if (target.closest('.fb-fold, .fb-handle')) {
        this.setCollapsed(!this.collapsed)
        this.onCollapsedChange?.()
        return
      }
      if (target.closest('.fb-ins')) return this.setMenuOpen(this.open === 'insert' ? null : 'insert')
      if (target.closest('.fb-pick')) return this.setMenuOpen(this.open === 'pick' ? null : 'pick')
      const btn = target.closest<HTMLElement>('[data-action]')
      if (!btn) return
      this.setMenuOpen(null)
      this.run(btn.dataset['action'] as MenuAction)
    })

    // 点到别处收起下拉（按下就收，别等 click —— 那会跟编辑器的 mousedown 抢顺序）
    document.addEventListener('mousedown', (e) => {
      if (!this.el.contains(e.target as Node)) this.setMenuOpen(null)
    })
  }

  get visible(): boolean {
    return !this.el.classList.contains('is-hidden')
  }

  toggle(): void {
    this.el.classList.toggle('is-hidden')
    if (!this.visible) this.setMenuOpen(null)
  }

  setVisible(on: boolean): void {
    this.el.classList.toggle('is-hidden', !on)
    if (!on) this.setMenuOpen(null)
  }

  /** 收起 = 条子换成一颗手柄。与 `visible` 正交：菜单关掉时手柄也不留 */
  get collapsed(): boolean {
    return this.el.classList.contains('is-collapsed')
  }

  setCollapsed(on: boolean): void {
    this.el.classList.toggle('is-collapsed', on)
    if (on) this.setMenuOpen(null)
  }

  /**
   * 点亮当前生效的格式；块类型下拉顺带显示当前块名。
   * 插入类也带 `data-action`，但它们永远不在 `on` 里 —— 那一组不是开关。
   */
  setState(on: Set<MenuAction>): void {
    for (const btn of this.el.querySelectorAll<HTMLElement>('[data-action]')) {
      btn.classList.toggle('is-on', on.has(btn.dataset['action'] as MenuAction))
    }
    const kind = BLOCK_KINDS.find((k) => on.has(k.action)) ?? BLOCK_KINDS[0]!
    const label = kindLabel(kind)
    if (this.nameEl.textContent !== label) this.nameEl.textContent = label
    this.triggers.pick.classList.toggle('is-on', kind.action !== 'fmt:p')
  }

  /**
   * 只读（第八节 5）：条子留在原处（藏起来的话滚动下边距跟着跳一下），改格式的按钮全部置灰 ——
   * 点了也落不进文档（`editor/read-only.ts` 那道闸），与其让人点了没反应，不如一眼看出
   * 这会儿改不了。折角 / 手柄照常能用：收不收条子与改不改文档无关。
   */
  setReadOnly(on: boolean): void {
    // 每次挪光标都会问一遍（`syncFormatBar`），没变就别去碰那二十颗按钮
    if (this.el.classList.contains('is-ro') === on) return
    this.el.classList.toggle('is-ro', on)
    for (const btn of this.el.querySelectorAll<HTMLButtonElement>('.fb-bar button:not(.fb-fold)')) {
      btn.disabled = on
    }
    if (on) this.setMenuOpen(null)
  }

  /** 两个下拉互斥：开一个就关另一个（它们挨着，同时张开会叠在一起） */
  private setMenuOpen(which: MenuId | null): void {
    this.open = which
    for (const id of ['pick', 'insert'] as const) {
      const isOpen = which === id
      this.menus[id].hidden = !isOpen
      this.triggers[id].setAttribute('aria-expanded', String(isOpen))
      this.triggers[id].classList.toggle('is-open', isOpen)
    }
  }
}

function btnHTML(b: Btn): string {
  const label = t(b.labelKey)
  return (
    `<button type="button" class="fb-btn" data-action="${b.action}" ` +
    `title="${label}" data-i18n-title="${b.labelKey}" ` +
    `aria-label="${label}" data-i18n-aria="${b.labelKey}">${icon(b.name)}</button>`
  )
}
