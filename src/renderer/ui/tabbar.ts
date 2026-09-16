import { t } from '../i18n'
import { icon } from './icons'

export interface TabItem {
  id: number
  title: string
  dirty: boolean
  /** 磁盘文件被外部修改且本标签有未保存改动 */
  stale?: boolean
}

/** 顶部标签栏：点击激活、× 关闭、中键关闭、右键菜单。每次全量重建（标签数小，无所谓） */
export class TabBar {
  readonly el: HTMLElement

  /**
   * 右键菜单此刻作用在哪个标签（画高亮用）。**存 id 而不是直接加 class**：
   * `render()` 每次文档变化都会重建全部子元素（自动保存落盘也会触发一次），
   * 加在 DOM 上的标记会被悄悄冲掉，菜单还开着、高亮却没了
   */
  private contextId: number | null = null

  constructor(
    private readonly onActivate: (id: number) => void,
    private readonly onClose: (id: number) => void,
    /** 右键：由 main.ts 建菜单 —— 标签的顺序语义（左边/右边/其他）是它那边的事 */
    private readonly onContext?: (id: number, e: MouseEvent) => void
  ) {
    this.el = document.createElement('div')
    this.el.id = 'tabbar'

    this.el.addEventListener('click', (e) => {
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
  }

  /** 菜单开在哪个标签上（null = 收起）。高亮由 `render()` 一并画，见 `contextId` */
  markContext(id: number | null): void {
    this.contextId = id
    for (const el of this.el.querySelectorAll<HTMLElement>('.tab-item')) {
      el.classList.toggle('is-context', Number(el.dataset['id']) === id)
    }
  }

  render(tabs: TabItem[], activeId: number): void {
    const frag = document.createDocumentFragment()
    for (const tab of tabs) {
      const el = document.createElement('div')
      el.className =
        'tab-item' +
        (tab.id === activeId ? ' is-active' : '') +
        (tab.id === this.contextId ? ' is-context' : '')
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
    this.el.replaceChildren(frag)
  }
}
