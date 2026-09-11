import { basename, dirname } from '../../shared/path'
import type { DirEntry } from '../../shared/types'

interface Node {
  entry: DirEntry
  /** null 表示还没读过这个目录（懒加载） */
  children: Node[] | null
}

const WIDTH_KEY = 'typmd.sidebarWidth'
const MIN_WIDTH = 150
const MAX_WIDTH = 520

export class Sidebar {
  readonly el: HTMLElement
  private readonly headTitle: HTMLElement
  private readonly treeEl: HTMLElement
  private readonly emptyEl: HTMLElement

  private root: string | null = null
  private nodes: Node[] = []
  private readonly expanded = new Set<string>()
  private readonly byPath = new Map<string, Node>()
  private activePath: string | null = null

  constructor(private readonly onOpenFile: (path: string) => void) {
    this.el = document.createElement('aside')
    this.el.id = 'sidebar'
    this.el.innerHTML = `
      <div class="sb-head">
        <span class="sb-title"></span>
        <button class="sb-change" title="打开其他文件夹">⋯</button>
      </div>
      <div class="sb-tree" tabindex="-1"></div>
      <div class="sb-empty">
        <button class="sb-open-btn">打开文件夹</button>
        <p>或按 ⌘⇧O</p>
      </div>
      <div class="sb-resize" title="拖动调整宽度"></div>
    `
    this.headTitle = this.el.querySelector('.sb-title')!
    this.treeEl = this.el.querySelector('.sb-tree')!
    this.emptyEl = this.el.querySelector('.sb-empty')!

    this.el.querySelector('.sb-change')!.addEventListener('click', () => void this.pick())
    this.el.querySelector('.sb-open-btn')!.addEventListener('click', () => void this.pick())
    this.treeEl.addEventListener('click', (e) => void this.onRowClick(e))
    this.setupResize()

    this.el.style.width = `${this.savedWidth()}px`
  }

  get visible(): boolean {
    return !this.el.classList.contains('is-hidden')
  }

  toggle(): void {
    this.el.classList.toggle('is-hidden')
  }

  /** 弹目录选择框并载入 */
  async pick(): Promise<void> {
    const dir = await window.api.pickFolder()
    if (dir) await this.open(dir)
  }

  /** 载入一个文件夹作为树根 */
  async open(dir: string): Promise<void> {
    this.root = dir
    this.expanded.clear()
    this.byPath.clear()
    this.headTitle.textContent = basename(dir)
    this.headTitle.title = dir
    this.nodes = (await window.api.readDir(dir)).map((entry) => ({ entry, children: null }))
    this.index(this.nodes)
    this.render()
  }

  /** 恢复上次打开的文件夹 */
  async restore(): Promise<void> {
    const dir = await window.api.lastFolder()
    if (dir) await this.open(dir)
    else this.render()
  }

  /** 标记当前正在编辑的文件，并展开沿途的目录 */
  async setActive(path: string | null): Promise<void> {
    this.activePath = path
    // 没开过文件夹时，把文档所在目录挂为树根 —— 打开单个 .md 也能立刻看到文件树
    if (path && !this.root) {
      const dir = dirname(path)
      if (dir) await this.open(dir)
    }
    if (path && this.root && path.startsWith(`${this.root}/`)) {
      // 逐级展开，让这个文件在树里可见
      const rel = path.slice(this.root.length + 1).split('/')
      let prefix = this.root
      for (const seg of rel.slice(0, -1)) {
        prefix = `${prefix}/${seg}`
        await this.loadChildren(prefix)
        this.expanded.add(prefix)
      }
    }
    this.render()
    this.treeEl.querySelector('.sb-row.is-active')?.scrollIntoView({ block: 'nearest' })
  }

  // ---------- 内部 ----------

  private index(nodes: Node[]): void {
    for (const n of nodes) {
      this.byPath.set(n.entry.path, n)
      if (n.children) this.index(n.children)
    }
  }

  private async loadChildren(path: string): Promise<void> {
    const node = this.byPath.get(path)
    if (!node || !node.entry.isDir || node.children) return
    node.children = (await window.api.readDir(path)).map((entry) => ({ entry, children: null }))
    this.index(node.children)
  }

  private async onRowClick(e: MouseEvent): Promise<void> {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.sb-row')
    const path = row?.dataset['path']
    if (!path) return
    const node = this.byPath.get(path)
    if (!node) return

    if (!node.entry.isDir) {
      this.onOpenFile(path)
      return
    }
    if (this.expanded.has(path)) {
      this.expanded.delete(path)
    } else {
      await this.loadChildren(path)
      this.expanded.add(path)
    }
    this.render()
  }

  private render(): void {
    const hasRoot = this.root !== null
    this.treeEl.hidden = !hasRoot
    this.emptyEl.hidden = hasRoot
    this.el.querySelector('.sb-head')!.classList.toggle('is-hidden', !hasRoot)
    if (!hasRoot) return

    const frag = document.createDocumentFragment()
    this.appendRows(frag, this.nodes, 0)
    this.treeEl.replaceChildren(frag)
  }

  private appendRows(parent: DocumentFragment | HTMLElement, nodes: Node[], depth: number): void {
    for (const node of nodes) {
      const { entry } = node
      const row = document.createElement('div')
      row.className = 'sb-row'
      row.dataset['path'] = entry.path
      row.style.paddingLeft = `${8 + depth * 14}px`
      if (entry.isDir) row.classList.add('is-dir')
      if (entry.path === this.activePath) row.classList.add('is-active')

      const chevron = document.createElement('span')
      chevron.className = 'sb-chevron'
      if (entry.isDir) chevron.classList.toggle('is-open', this.expanded.has(entry.path))
      row.appendChild(chevron)

      const name = document.createElement('span')
      name.className = 'sb-name'
      // 文件名去掉 .md 后缀，树里更清爽
      name.textContent = entry.isDir ? entry.name : entry.name.replace(/\.(md|markdown)$/i, '')
      name.title = entry.name
      row.appendChild(name)

      parent.appendChild(row)

      if (entry.isDir && this.expanded.has(entry.path) && node.children) {
        this.appendRows(parent, node.children, depth + 1)
      }
    }
  }

  private savedWidth(): number {
    const raw = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(raw) && raw >= MIN_WIDTH ? Math.min(raw, MAX_WIDTH) : 240
  }

  private setupResize(): void {
    const handle = this.el.querySelector<HTMLElement>('.sb-resize')!
    handle.addEventListener('mousedown', (down) => {
      down.preventDefault()
      const startX = down.clientX
      const startW = this.el.getBoundingClientRect().width
      document.body.classList.add('is-resizing')

      const move = (e: MouseEvent): void => {
        const w = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startW + e.clientX - startX))
        this.el.style.width = `${w}px`
      }
      const up = (): void => {
        document.body.classList.remove('is-resizing')
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        localStorage.setItem(WIDTH_KEY, String(this.el.getBoundingClientRect().width))
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    })
  }
}
