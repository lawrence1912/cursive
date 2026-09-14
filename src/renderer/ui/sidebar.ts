import { basename, dirname } from '../../shared/path'
import { applyI18n, onLangChange, t, type Key } from '../i18n'
import { icon, type IconName } from './icons'
import { closeMenu, openMenu, type MenuItem } from './menu'
import { FileSearch } from './file-search'
import type { DirEntry, SearchHit } from '../../shared/types'

interface Node {
  entry: DirEntry
  /** null 表示还没读过这个目录（懒加载） */
  children: Node[] | null
}

const WIDTH_KEY = 'cursive.sidebarWidth'
const MIN_WIDTH = 180
const MAX_WIDTH = 560
/** 超过这个位移才算拖拽 —— 否则每次点文件都会被判成一次微小的拖动 */
const DRAG_SLOP = 5

export interface SidebarHooks {
  openFile: (path: string) => void
  /** 文件被移进废纸篓：让 main.ts 有机会关掉对应标签 */
  trashed?: (path: string) => void
  /** 重命名 / 移动之后路径变了：开着的标签要跟着走，否则它指着一个不存在的文件 */
  moved?: (from: string, to: string) => void
  /** 跨文件搜索点中一处命中 */
  openHit?: (hit: SearchHit) => void
  /**
   * 「打开其他文件夹」：**开哪个窗口由 main.ts 决定**（一个窗口 = 一个工作区，
   * 默认新窗口）。侧栏自己只负责把这件事转出去
   */
  pickFolder?: () => void | Promise<void>
}

/** 工具栏五颗按钮的文案规格（title 带快捷键后缀，所以重翻时走 relabel 而不是 data-i18n） */
const TOOL_BTNS: { act: string; name: IconName; labelKey: Key; key?: string }[] = [
  { act: 'new-file', name: 'file-plus', labelKey: 'sb.newFile' },
  { act: 'new-folder', name: 'folder-plus', labelKey: 'sb.newFolder' },
  // 「完全折叠」排在两个「新建」之后、搜索之前 —— 与 VS Code 资源管理器同序
  { act: 'collapse', name: 'collapse', labelKey: 'sb.collapseAll' },
  { act: 'search', name: 'search', labelKey: 'sb.search', key: '⌘⇧F' },
  { act: 'open-folder', name: 'folder-open', labelKey: 'sb.openFolder', key: '⌘⇧O' }
]

export class Sidebar {
  readonly el: HTMLElement
  readonly search: FileSearch
  private readonly headTitle: HTMLElement
  private readonly treeEl: HTMLElement
  private readonly emptyEl: HTMLElement

  private root: string | null = null
  private nodes: Node[] = []
  private readonly expanded = new Set<string>()
  private readonly byPath = new Map<string, Node>()
  private activePath: string | null = null
  /** 最后点过的那一行：工具栏的「新建」以它所在目录为落点 */
  private selected: string | null = null
  /** 刚结束一次拖拽 —— 紧随其后的 click 不该再把文件打开 */
  private dragged = false

  /** 右键菜单挂在 body 上：.sb-tree 是 overflow:auto，挂在里面会被裁掉 */

  constructor(private readonly hooks: SidebarHooks) {
    this.el = document.createElement('aside')
    this.el.id = 'sidebar'
    this.el.innerHTML = `
      <div class="sb-head">
        <span class="sb-title"></span>
        <div class="sb-tools">
          ${TOOL_BTNS.map((b) => toolButton(b)).join('')}
        </div>
      </div>
      <div class="sb-tree" tabindex="-1"></div>
      <div class="sb-empty">
        <button class="sb-open-btn" data-i18n="sb.openFolderBtn">${t('sb.openFolderBtn')}</button>
        <p data-i18n="sb.orOpen">${t('sb.orOpen')}</p>
      </div>
      <div class="sb-resize" title="${t('sb.resize')}" data-i18n-title="sb.resize"></div>
    `
    applyI18n(this.el)
    this.headTitle = this.el.querySelector('.sb-title')!
    this.treeEl = this.el.querySelector('.sb-tree')!
    this.emptyEl = this.el.querySelector('.sb-empty')!

    this.search = new FileSearch(
      (hit) => hooks.openHit?.(hit),
      () => this.closeSearch()
    )
    this.el.insertBefore(this.search.el, this.el.querySelector('.sb-resize'))

    this.el.querySelector('.sb-tools')!.addEventListener('click', (e) => {
      const btn = (e.target as Element).closest<HTMLElement>('button[data-act]')
      if (btn) void this.toolAction(btn.dataset['act']!)
    })
    this.el.querySelector('.sb-open-btn')!.addEventListener('click', () => void this.pick())
    this.treeEl.addEventListener('click', (e) => void this.onRowClick(e))
    this.treeEl.addEventListener('mousedown', (e) => this.onRowMouseDown(e))
    this.el.addEventListener('contextmenu', (e) => this.onContextMenu(e))
    this.setupResize()

    this.el.style.width = `${this.savedWidth()}px`
    // 语言切换：空态/拖拽条由 applyI18n 重翻，工具栏的 title 带快捷键后缀要重拼
    onLangChange(() => {
      applyI18n(this.el)
      for (const btn of this.el.querySelectorAll<HTMLElement>('.sb-tool')) {
        const spec = TOOL_BTNS.find((b) => b.act === btn.dataset['act'])
        if (!spec) continue
        const label = t(spec.labelKey)
        btn.title = spec.key ? `${label} (${spec.key})` : label
        btn.setAttribute('aria-label', label)
      }
    })
  }

  get visible(): boolean {
    return !this.el.classList.contains('is-hidden')
  }

  toggle(): void {
    this.el.classList.toggle('is-hidden')
  }

  /** 「打开其他文件夹」入口（工具栏按钮 / 右键菜单 / ⌘⇧O 都走这里） */
  async pick(): Promise<void> {
    if (this.hooks.pickFolder) {
      await this.hooks.pickFolder()
      return
    }
    const dir = await window.api.pickFolder()
    if (dir) await this.open(dir)
  }

  /** 载入一个文件夹作为树根 */
  async open(dir: string): Promise<void> {
    this.root = dir
    this.expanded.clear()
    this.byPath.clear()
    this.selected = null
    this.headTitle.textContent = basename(dir)
    this.headTitle.title = dir
    this.nodes = (await window.api.readDir(dir)).map((entry) => ({ entry, children: null }))
    this.index(this.nodes)
    this.search.setRoot(dir)
    this.render()
  }

  /** 挂上这个窗口的工作区（契约 v19）—— 带文件开出来的窗口就是那个文件所在的目录 */
  async restore(): Promise<void> {
    const dir = await window.api.workspaceRoot()
    // 启动时这一趟 IPC **不被等**（见 main.ts 的顺序），文档可能已经抢先把树根挂好了
    // （`setActive` 的兜底）。同一个目录就别再读一遍 —— `open()` 会把展开状态和选中项清掉
    if (!dir || dir === this.root) {
      if (!this.root) this.render()
      return
    }
    await this.open(dir)
    // 上面这趟里文档可能就进来了，补一次定位（open 清过 expanded / selected）
    if (this.activePath) await this.setActive(this.activePath)
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

  // ---------- P3-2 搜索面板（与文件树二选一占这块地方）----------

  openSearch(): void {
    this.search.setRoot(this.root)
    if (this.search.visible) {
      this.search.focus()
      return
    }
    this.search.show()
    this.el.classList.add('is-searching')
    this.render()
  }

  closeSearch(): void {
    this.search.hide()
    this.el.classList.remove('is-searching')
    this.render()
  }

  toggleSearch(): void {
    if (this.search.visible) this.closeSearch()
    else this.openSearch()
  }

  /**
   * 完全折叠：一次收起所有展开的目录（工具栏那颗 + 右键菜单两个入口）。
   *
   * 只清 `expanded`，**不动 `byPath` 里已经读过的 children** —— 那是懒加载的缓存，
   * 清掉等于下次每一级都要重新过一趟 IPC；显示与否本来就只由 `expanded` 说了算。
   *
   * 折完树根那一层还在（树根不进 `expanded`，它就是 `nodes` 本身）。
   * 注意这不是持久状态：下一次 `setActive` 会把活动文件沿途的目录重新展开 ——
   * 那是「让当前文件在树里看得见」，比「保持折叠」更要紧。
   */
  collapseAll(): void {
    if (!this.expanded.size) return
    this.expanded.clear()
    this.render()
  }

  // ---------- 内部 ----------

  private async toolAction(act: string): Promise<void> {
    if (act === 'open-folder') return this.pick()
    if (act === 'search') return this.toggleSearch()
    if (act === 'collapse') return this.collapseAll()
    const dir = this.targetDir(this.selected)
    if (dir) await this.create(dir, act === 'new-folder')
  }

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
    if (this.dragged) {
      this.dragged = false
      return
    }
    const row = (e.target as HTMLElement).closest<HTMLElement>('.sb-row')
    const path = row?.dataset['path']
    if (!path) return
    const node = this.byPath.get(path)
    if (!node) return
    this.selected = path

    if (!node.entry.isDir) {
      this.hooks.openFile(path)
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
    const searching = this.search.visible
    this.treeEl.hidden = !hasRoot || searching
    this.emptyEl.hidden = hasRoot || searching
    this.el.querySelector('.sb-head')!.classList.toggle('is-hidden', !hasRoot && !searching)
    this.el.querySelector<HTMLElement>('[data-act="search"]')!.classList.toggle('is-on', searching)
    // 没有展开的目录（或正在搜索、树根本没露面）时「完全折叠」点了也没反应，灰掉它
    this.el.querySelector<HTMLButtonElement>('[data-act="collapse"]')!.disabled =
      searching || !this.expanded.size
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
      row.style.paddingLeft = `${4 + depth * 16}px`
      if (entry.isDir) row.classList.add('is-dir')
      if (entry.path === this.activePath) row.classList.add('is-active')

      const chevron = document.createElement('span')
      chevron.className = 'sb-chevron'
      if (entry.isDir) {
        chevron.innerHTML = icon('chevron')
        chevron.classList.toggle('is-open', this.expanded.has(entry.path))
      }
      row.appendChild(chevron)

      // 高亮画在 .sb-item 上而不是整行：从文件名前方起，跟着层级缩进一起往右挪，
      // 折叠箭头留在高亮外面（它是控件，不是标签的一部分）
      const item = document.createElement('span')
      item.className = 'sb-item'
      const name = document.createElement('span')
      name.className = 'sb-name'
      // 文件名去掉 .md 后缀，树里更清爽
      name.textContent = entry.isDir ? entry.name : entry.name.replace(/\.(md|markdown)$/i, '')
      name.title = entry.name
      item.appendChild(name)
      row.appendChild(item)

      parent.appendChild(row)

      if (entry.isDir && this.expanded.has(entry.path) && node.children) {
        this.appendRows(parent, node.children, depth + 1)
      }
    }
  }

  // ---------- P3-1 新建 / 删除 / 重命名 / 移动 ----------

  /**
   * 重新读一遍树：根 + 所有展开着的目录。
   * 只在增删之后跑，比「精确刷新某个父目录」笨，但**不会漏**（新建的目录、
   * 被删掉的展开目录、重名加后缀的路径，都不用各写一条分支）。
   */
  private async reload(): Promise<void> {
    if (!this.root) return
    this.byPath.clear()
    this.nodes = (await window.api.readDir(this.root)).map((entry) => ({ entry, children: null }))
    this.index(this.nodes)
    // 浅的先加载：子目录要等父目录的 children 就位才找得到
    for (const path of [...this.expanded].sort((a, b) => a.length - b.length)) {
      await this.loadChildren(path)
    }
    for (const path of [...this.expanded]) if (!this.byPath.has(path)) this.expanded.delete(path)
    this.render()
  }

  /** 在哪个目录里新建：目录行就是它自己，文件行是它的父目录，空白处是树根 */
  private targetDir(path: string | null): string | null {
    if (!path) return this.root
    const node = this.byPath.get(path)
    if (!node) return this.root
    return node.entry.isDir ? path : dirname(path)
  }

  private async create(dir: string, folder: boolean): Promise<void> {
    const made = folder ? await window.api.createFolder(dir) : await window.api.createFile(dir)
    if (!made) return
    // 新建的东西得看得见：把它所在的目录展开
    if (dir !== this.root) this.expanded.add(dir)
    if (folder) this.expanded.add(made.path)
    await this.reload()
    this.selected = made.path
    if (!folder) this.hooks.openFile(made.path)
  }

  private async trash(path: string): Promise<void> {
    if (!(await window.api.trashItem(path))) return
    this.expanded.delete(path)
    if (this.selected === path) this.selected = null
    await this.reload()
    this.hooks.trashed?.(path)
  }

  private async rename(path: string): Promise<void> {
    const res = await window.api.renameItem(path)
    if (!res) return
    await this.afterMove(path, res.path)
  }

  private async move(src: string, destDir: string): Promise<void> {
    const res = await window.api.moveItem(src, destDir)
    if (!res) return
    this.expanded.add(destDir)
    await this.afterMove(src, res.path)
  }

  /**
   * 路径变了之后的收尾。**展开集合要跟着搬**：里面存的是绝对路径，
   * 改名一个目录会让它自己和全部子孙的键一起失效，不重写前缀的话整棵子树会「啪」地收起来。
   */
  private async afterMove(from: string, to: string): Promise<void> {
    for (const p of [...this.expanded]) {
      if (p === from || p.startsWith(`${from}/`)) {
        this.expanded.delete(p)
        this.expanded.add(to + p.slice(from.length))
      }
    }
    if (this.selected === from) this.selected = to
    if (this.activePath === from) this.activePath = to
    await this.reload()
    this.hooks.moved?.(from, to)
  }

  private onContextMenu(e: MouseEvent): void {
    if (!this.root || this.search.visible) return
    e.preventDefault()
    const row = (e.target as HTMLElement).closest<HTMLElement>('.sb-row')
    const path = row?.dataset['path'] ?? null
    const dir = this.targetDir(path)
    if (!dir) return
    if (path) this.selected = path

    const items: MenuItem[] = [
      { label: t('sb.newFile'), run: () => this.create(dir, false) },
      { label: t('sb.newFolder'), run: () => this.create(dir, true) }
    ]
    if (path) {
      const node = this.byPath.get(path)
      items.push(
        { label: t('sb.rename'), run: () => this.rename(path), separated: true },
        {
          label: node?.entry.isDir ? t('sb.deleteDir') : t('sb.deleteFile'),
          run: () => this.trash(path),
          danger: true
        }
      )
    }
    items.push({
      label: t('sb.reveal'),
      run: () => window.api.revealInFinder(path ?? this.root!),
      separated: true
    })
    // 树摊开好几层之后，够回工具栏那颗按钮要横穿整条侧栏 —— 就地给一条
    if (this.expanded.size) {
      items.push({ label: t('sb.collapseAll'), run: () => this.collapseAll(), separated: true })
    }
    // 命令作用在哪一行，哪一行就亮着 —— 菜单关掉再取消
    row?.classList.add('is-context')
    openMenu(e.clientX, e.clientY, items, {
      onClose: () => row?.classList.remove('is-context'),
      scrollHost: this.treeEl
    })
  }

  // ---------- P3-1 拖拽移动 ----------

  /**
   * **不走 HTML5 拖放**：与大纲重排同一个理由 —— 阈值/落点高亮/取消都好控，
   * 而且 `DataTransfer` 在无头自检里造不出来，走鼠标事件 E2E 才跑得通整条路径。
   */
  private onRowMouseDown(down: MouseEvent): void {
    if (down.button !== 0) return
    const row = (down.target as HTMLElement).closest<HTMLElement>('.sb-row')
    const src = row?.dataset['path']
    if (!row || !src || !this.root) return

    let ghost: HTMLElement | null = null
    let dropDir: string | null = null

    const paint = (dir: string | null): void => {
      dropDir = dir
      for (const r of this.treeEl.querySelectorAll('.sb-row.is-drop')) r.classList.remove('is-drop')
      this.treeEl.classList.toggle('is-drop-root', dir === this.root)
      if (dir && dir !== this.root) {
        this.treeEl.querySelector(`.sb-row[data-path="${cssEscape(dir)}"]`)?.classList.add('is-drop')
      }
    }

    const move = (e: MouseEvent): void => {
      if (!ghost) {
        if (Math.abs(e.clientX - down.clientX) + Math.abs(e.clientY - down.clientY) < DRAG_SLOP) return
        ghost = document.createElement('div')
        ghost.className = 'sb-ghost'
        ghost.textContent = basename(src)
        document.body.appendChild(ghost)
        document.body.classList.add('is-dragging-row')
        closeMenu()
      }
      ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 8}px)`
      const over = document.elementFromPoint(e.clientX, e.clientY)
      const overRow = over?.closest<HTMLElement>('.sb-row')
      const overPath = overRow?.dataset['path'] ?? null
      // 落在树的空白处 = 落到树根；落在文件上 = 落到它的父目录
      const dir = this.treeEl.contains(over) ? this.targetDir(overPath) : null
      // 拖进自己或自己的子孙目录是无效动作，别给出可落的错觉（壳侧还有第二道闸）
      paint(dir && dir !== src && !dir.startsWith(`${src}/`) ? dir : null)
    }

    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('is-dragging-row')
      ghost?.remove()
      const target = dropDir
      paint(null)
      if (!ghost) return
      this.dragged = true
      if (target) void this.move(src, target)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  private savedWidth(): number {
    const raw = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(raw) && raw >= MIN_WIDTH ? Math.min(raw, MAX_WIDTH) : 252
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

function toolButton(spec: { act: string; name: IconName; labelKey: Key; key?: string }): string {
  const label = t(spec.labelKey)
  const hint = spec.key ? `${label} (${spec.key})` : label
  return `<button class="sb-tool" data-act="${spec.act}" title="${hint}" aria-label="${label}">${icon(spec.name)}</button>`
}

/** 只用来拼属性选择器；CSS.escape 在 WKWebView 里有，兜底给个手写版 */
function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&')
}
