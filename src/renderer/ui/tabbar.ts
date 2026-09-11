export interface TabItem {
  id: number
  title: string
  dirty: boolean
  /** 磁盘文件被外部修改且本标签有未保存改动 */
  stale?: boolean
}

/** 顶部标签栏：点击激活、× 关闭、中键关闭。每次全量重建（标签数小，无所谓） */
export class TabBar {
  readonly el: HTMLElement

  constructor(
    private readonly onActivate: (id: number) => void,
    private readonly onClose: (id: number) => void
  ) {
    this.el = document.createElement('div')
    this.el.id = 'tabbar'

    this.el.addEventListener('click', (e) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>('.tab-item')
      if (!tab) return
      const id = Number(tab.dataset['id'])
      if ((e.target as HTMLElement).classList.contains('tab-close')) {
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
  }

  render(tabs: TabItem[], activeId: number): void {
    const frag = document.createDocumentFragment()
    for (const t of tabs) {
      const el = document.createElement('div')
      el.className = 'tab-item' + (t.id === activeId ? ' is-active' : '')
      el.dataset['id'] = String(t.id)
      el.title = t.title

      const title = document.createElement('span')
      title.className = 'tab-title'
      title.textContent = t.title
      el.appendChild(title)

      if (t.dirty) {
        const dot = document.createElement('span')
        dot.className = 'tab-dirty'
        el.appendChild(dot)
      }
      if (t.stale) {
        const warn = document.createElement('span')
        warn.className = 'tab-stale'
        warn.textContent = '⚠'
        warn.title = '文件在外部被修改，此标签的未保存改动已过期'
        el.appendChild(warn)
      }

      const close = document.createElement('span')
      close.className = 'tab-close'
      close.textContent = '×'
      el.appendChild(close)

      frag.appendChild(el)
    }
    this.el.replaceChildren(frag)
  }
}
