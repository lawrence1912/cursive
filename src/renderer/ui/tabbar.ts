import { getLang, t } from '../i18n'
import { icon } from './icons'

/** 拖拽重排的最小位移。与大纲、文件树同一档 —— 小了会把「手抖的点击」当成拖拽 */
const DRAG_SLOP = 4

export interface TabItem {
  id: number
  title: string
  dirty: boolean
  /** 磁盘文件被外部修改且本标签有未保存改动 */
  stale?: boolean
}

/**
 * 把 `id` 挪到 `before` 之前（`before === null` = 挪到末尾）。
 *
 * **顺序语义单独拿出来当纯函数**：拖拽那一半是 DOM（阈值、落点线、松手），
 * 这一半是「挪完之后是什么顺序」，`test/tabbar.test.ts` 直接测它。
 * 两个边界都在这儿收：落在自己身上 = 原地不动；落点在这一刻已经不在表里
 * （拖到一半那个标签被外部变更关掉了）= 整个作废，不去猜用户想放哪儿。
 */
export function reorderIds(ids: number[], id: number, before: number | null): number[] {
  if (!ids.includes(id) || before === id) return ids
  const rest = ids.filter((x) => x !== id)
  if (before === null) return [...rest, id]
  const at = rest.indexOf(before)
  if (at < 0) return ids
  return [...rest.slice(0, at), id, ...rest.slice(at)]
}

/** 顶部标签栏：点击激活、× 关闭、中键关闭、右键菜单、拖拽重排。标签状态变化时重建。 */
export class TabBar {
  readonly el: HTMLElement
  private signature = ''

  /**
   * 右键菜单此刻作用在哪个标签（画高亮用）。**存 id 而不是直接加 class**：
   * `render()` 在标签状态变化时会重建全部子元素（自动保存落盘也会触发一次），
   * 加在 DOM 上的标记会被悄悄冲掉，菜单还开着、高亮却没了
   */
  private contextId: number | null = null

  /** 正在拖的那个标签。同 `contextId`，**存 id 不存元素** —— 拖到一半也会 `render()` */
  private dragId: number | null = null

  /** 落点线。不是 flex 子项（绝对定位，出流），所以它不参与标签的等分 */
  private readonly dropEl: HTMLElement

  /** 拖完那一下的 click 要吞掉，否则松手 = 顺带激活了落点处的标签 */
  private swallowClick = false

  constructor(
    private readonly onActivate: (id: number) => void,
    private readonly onClose: (id: number) => void,
    /** 右键：由 main.ts 建菜单 —— 标签的顺序语义（左边/右边/其他）是它那边的事 */
    private readonly onContext?: (id: number, e: MouseEvent) => void,
    /** 拖拽重排：`before === null` = 放到末尾。顺序的真相在 main.ts 的 `tabs` 里 */
    private readonly onReorder?: (id: number, before: number | null) => void
  ) {
    this.el = document.createElement('div')
    this.el.id = 'tabbar'

    this.dropEl = document.createElement('div')
    this.dropEl.className = 'tab-drop'
    this.dropEl.hidden = true
    this.el.appendChild(this.dropEl)

    this.el.addEventListener('click', (e) => {
      if (this.swallowClick) {
        this.swallowClick = false
        return
      }
      const tab = (e.target as HTMLElement).closest<HTMLElement>('.tab-item')
      if (!tab) return
      const id = Number(tab.dataset['id'])
      // 关闭键里现在是 SVG，e.target 可能是 <svg> 或 <path> —— 必须用 closest
      if ((e.target as Element).closest('.tab-close')) {
        e.stopPropagation()
        this.onClose(id)
        return
      }
      this.onActivate(id)
    })
    this.el.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return
      const tab = (e.target as HTMLElement).closest<HTMLElement>('.tab-item')
      if (tab) this.onClose(Number(tab.dataset['id']))
    })
    this.el.addEventListener('contextmenu', (e) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>('.tab-item')
      if (!tab || !this.onContext) return
      // 不挡的话 WebKit 会弹它自己那份（「重新载入」之类），和应用毫无关系
      e.preventDefault()
      // **不激活**：右键只是「对这个标签发个命令」，不是切过去（同 Chrome / VS Code）
      this.onContext(Number(tab.dataset['id']), e)
    })
    this.el.addEventListener('mousedown', (e) => this.onMouseDown(e))
  }

  /** 菜单开在哪个标签上（null = 收起）。高亮由 `render()` 一并画，见 `contextId` */
  markContext(id: number | null): void {
    this.contextId = id
    for (const el of this.el.querySelectorAll<HTMLElement>('.tab-item')) {
      el.classList.toggle('is-context', Number(el.dataset['id']) === id)
    }
  }

  render(tabs: TabItem[], activeId: number): void {
    // 连续输入时标签标题和脏标记通常没变；重建后立刻测量宽度会强制布局。
    const signature = JSON.stringify([getLang(), activeId, tabs.map((tab) =>
      [tab.id, tab.title, tab.dirty, tab.stale === true])])
    if (signature === this.signature) return
    this.signature = signature
    const frag = document.createDocumentFragment()
    for (const tab of tabs) {
      const el = document.createElement('div')
      el.className =
        'tab-item' +
        (tab.id === activeId ? ' is-active' : '') +
        (tab.id === this.contextId ? ' is-context' : '') +
        (tab.id === this.dragId ? ' is-dragging' : '')
      el.dataset['id'] = String(tab.id)
      el.title = tab.title

      const title = document.createElement('span')
      title.className = 'tab-title'
      title.textContent = tab.title
      el.appendChild(title)

      if (tab.dirty) {
        const dot = document.createElement('span')
        dot.className = 'tab-dirty'
        el.appendChild(dot)
      }
      if (tab.stale) {
        const warn = document.createElement('span')
        warn.className = 'tab-stale'
        warn.innerHTML = icon('warn')
        warn.title = t('tab.stale')
        el.appendChild(warn)
      }

      const close = document.createElement('button')
      close.className = 'tab-close'
      close.setAttribute('aria-label', t('tab.close', { title: tab.title }))
      close.innerHTML = icon('close')
      el.appendChild(close)

      frag.appendChild(el)
    }
    // 落点线排在最前面，一起重挂 —— 它是 `this.el` 的孩子，replaceChildren 会连它一起换掉
    this.el.replaceChildren(this.dropEl, frag)
    this.revealActive(activeId)
  }

  /**
   * 活动标签滚进视口。标签栏是 `overflow-x: auto`（`base.css` 的 `#tabbar`），
   * 开到七八个就横着滚了 —— 会话恢复接回一排、⌘T 快速打开、关掉当前标签之后
   * 接手的那个，落点都可能在视口外：屏幕上于是「切过去了，却看不见切到哪儿」。
   *
   * **自己算而不是 `scrollIntoView`**：后者会顺带滚祖先，整页跟着跳一下；
   * 这里只想动标签栏自己那根横轴。已经看得见时一个字节都不写（避免打断惯性滚动）。
   */
  private revealActive(activeId: number): void {
    const el = this.el.querySelector<HTMLElement>(`.tab-item[data-id="${activeId}"]`)
    if (!el) return
    const left = el.offsetLeft
    const right = left + el.offsetWidth
    const from = this.el.scrollLeft
    const width = this.el.clientWidth
    if (left < from) this.el.scrollLeft = left
    else if (right > from + width) this.el.scrollLeft = right - width
  }

  // ---------- 拖拽重排 ----------
  //
  // 自己接 mousedown/mousemove/mouseup，**不走 HTML5 拖放** —— 与大纲重排、文件树
  // 拖拽移动同一个理由：① 阈值、落点指示、取消都好控；② `DataTransfer` 在无头自检里
  // 造不出来，走鼠标事件才能让 E2E 把整条路径跑一遍。

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0 || !this.onReorder) return
    // 关闭键上按下不该开始拖（那一下是要关掉它）
    if ((e.target as Element).closest('.tab-close')) return
    const tab = (e.target as HTMLElement).closest<HTMLElement>('.tab-item')
    if (!tab) return
    const id = Number(tab.dataset['id'])
    // 上一次拖拽如果在栏外松手，就不会有 click 来清这个标记 —— 按下时先清一次
    this.swallowClick = false
    const x0 = e.clientX
    const y0 = e.clientY
    let on = false

    const move = (ev: MouseEvent): void => {
      if (!on && Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < DRAG_SLOP) return
      if (!on) {
        on = true
        this.dragId = id
        this.markDrag()
        document.body.classList.add('is-dragging-row')
      }
      this.paintDrop(ev.clientX)
    }
    const up = (ev: MouseEvent): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('is-dragging-row')
      this.dropEl.hidden = true
      if (!on) return
      const before = this.dropTarget(ev.clientX, id)
      this.dragId = null
      this.markDrag()
      this.swallowClick = true
      if (before !== undefined) this.onReorder?.(id, before)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  private markDrag(): void {
    for (const el of this.el.querySelectorAll<HTMLElement>('.tab-item')) {
      el.classList.toggle('is-dragging', Number(el.dataset['id']) === this.dragId)
    }
  }

  /**
   * 落点：光标过了某个标签的中线就插到它后面。
   * `null` = 末尾，`undefined` = 原地不动（落回自己那一格，包括「自己的下一个之前」）。
   */
  private dropTarget(clientX: number, dragId: number): number | null | undefined {
    const els = [...this.el.querySelectorAll<HTMLElement>('.tab-item')]
    if (!els.length) return undefined
    let before: number | null = null
    for (const el of els) {
      const box = el.getBoundingClientRect()
      if (clientX >= box.left + box.width / 2) continue
      before = Number(el.dataset['id'])
      break
    }
    const at = els.findIndex((el) => Number(el.dataset['id']) === dragId)
    const beforeAt =
      before === null ? els.length : els.findIndex((el) => Number(el.dataset['id']) === before)
    return beforeAt === at || beforeAt === at + 1 ? undefined : before
  }

  private paintDrop(clientX: number): void {
    const target = this.dragId === null ? undefined : this.dropTarget(clientX, this.dragId)
    if (target === undefined) {
      this.dropEl.hidden = true
      return
    }
    const els = [...this.el.querySelectorAll<HTMLElement>('.tab-item')]
    const el =
      target === null ? els[els.length - 1] : els.find((x) => Number(x.dataset['id']) === target)
    if (!el) return
    const box = el.getBoundingClientRect()
    const host = this.el.getBoundingClientRect()
    // 横着滚的栏：落点线画在**内容坐标**里，所以要把 scrollLeft 加回去（同大纲那条的 scrollTop）
    const x = (target === null ? box.right : box.left) - host.left + this.el.scrollLeft
    this.dropEl.style.left = `${x}px`
    this.dropEl.hidden = false
  }
}
