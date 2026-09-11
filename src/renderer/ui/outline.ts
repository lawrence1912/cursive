export interface OutlineItem {
  level: number
  text: string
  pos: number
}

/** 右侧大纲视图：标题层级列表，点击跳转，滚动跟随高亮当前章节 */
export class Outline {
  readonly el: HTMLElement
  private items: OutlineItem[] = []
  private activePos: number | null = null
  private listEl: HTMLElement

  constructor(private readonly onJump: (pos: number) => void) {
    this.el = document.createElement('aside')
    this.el.id = 'outline'
    this.el.innerHTML = `
      <div class="ol-head">大纲</div>
      <div class="ol-list"></div>
    `
    this.listEl = this.el.querySelector('.ol-list')!

    this.el.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.ol-item')
      if (!row) return
      const pos = Number(row.dataset['pos'])
      if (!Number.isNaN(pos)) this.onJump(pos)
    })
  }

  get visible(): boolean {
    return !this.el.classList.contains('is-hidden')
  }

  toggle(): void {
    this.el.classList.toggle('is-hidden')
  }

  setItems(items: OutlineItem[]): void {
    this.items = items
    this.render()
  }

  /** 高亮「视口顶部所在章节」对应的标题 */
  setActive(pos: number | null): void {
    this.activePos = pos
    for (const row of this.listEl.children) {
      const el = row as HTMLElement
      el.classList.toggle('is-active', Number(el.dataset['pos']) === pos)
    }
  }

  private render(): void {
    const frag = document.createDocumentFragment()
    for (const item of this.items) {
      const row = document.createElement('div')
      row.className = `ol-item ol-l${item.level}`
      if (item.pos === this.activePos) row.classList.add('is-active')
      row.dataset['pos'] = String(item.pos)
      row.style.paddingLeft = `${6 + (item.level - 1) * 12}px`
      row.textContent = item.text
      row.title = item.text
      frag.appendChild(row)
    }
    this.listEl.replaceChildren(frag)
  }
}
