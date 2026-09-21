import { basename, dirname } from '../../shared/path'
import { applyI18n, onLangChange, t, type Key } from '../i18n'
import { icon, type IconName } from './icons'
import { closeMenu, openMenu, type MenuItem } from './menu'
import { FileSearch } from './file-search'
import type { DirEntry, ReplaceTarget, SearchHit, SearchOptions } from '../../shared/types'

export interface Node {
  entry: DirEntry
  /** null 表示还没读过这个目录（懒加载） */
  children: Node[] | null
}

const WIDTH_KEY = 'cursive.sidebarWidth'
const MIN_WIDTH = 180
const MAX_WIDTH = 560
/**
 * 首字母跳的落点：从 `from` 起绕一圈，第一个以 `want` 开头的行下标（找不到 = -1）。
 *
 * **绕圈那一下是这条路唯一会错的地方**：不绕，按到最后一个 `r` 开头的文件就卡住了；
 * 绕错了（比如从 0 开始），同一个字母连按会永远停在第一个匹配上。大小写不敏感 ——
 * 文件名 `README` 与 `readme` 在这儿说的是一回事。
 */
export function typeaheadIndex(names: string[], from: number, want: string): number {
  if (!names.length || !want) return -1
  const needle = want.toLowerCase()
  const start = ((from % names.length) + names.length) % names.length
  for (let i = 0; i < names.length; i++) {
    const at = (start + i) % names.length
    if (names[at]!.toLowerCase().startsWith(needle)) return at
  }
  return -1
}

/**
 * 两份目录内容是不是同一回事 —— **只看名字与是不是目录**。
 *
 * 自动刷新（契约 v32）的第一道闸。我们自己的保存是原子写（临时文件 + rename），
 * 在目录看来就是「条目变了」，于是边打字边自动保存，当前文档那一级每两秒就会报一次。
 * 不比对就重画的话，等于给每一次自动保存配一次整棵树重建。
 *
 * mtime 与大小一概不看：树里画的就是名字和图标这两样。内容变了是**文档**那条监听
 * 的事（`onFileChangedExternal`），两条线各管各的。
 *
 * 两边都按名字排好序（壳侧 `readDir` 出来就是排过的，这棵树从不重排），所以逐位比。
 */
export function sameEntries(a: DirEntry[], b: DirEntry[]): boolean {
  if (a.length !== b.length) return false
  return a.every((x, i) => x.name === b[i]!.name && x.isDir === b[i]!.isDir)
}

/**
 * 用新读到的一层换掉旧的一层，**留住还在的那些节点**。
 *
 * 整层丢掉重建是错的：`children` 会跟着回到 null，而展开着的子目录正是靠它画的 ——
 * 在这一级里新建一个文件，能让它下面所有展开着的子树当场空掉一片（而且那份懒加载
 * 缓存也白丢了，每一级都要重走一趟 IPC）。
 *
 * 名字还在、但「文件 ↔ 目录」换了身份的按新的来：那已经不是同一个东西了。
 */
export function adoptEntries(old: Node[], fresh: DirEntry[]): Node[] {
  const was = new Map(old.map((n) => [n.entry.path, n]))
  return fresh.map((entry) => {
    const prev = was.get(entry.path)
    return { entry, children: prev && prev.entry.isDir === entry.isDir ? prev.children : null }
  })
}

/**
 * 盯着谁（契约 v32 的监听单子）：树根 + **所有已经读进来的目录**
 * （`children` 不是 null 的那些）。
 *
 * 不是「展开着的那些」：懒加载读过就不再读第二遍（`loadChildren` 见 children
 * 非 null 直接回头），而「完全折叠」有意留着这份缓存 —— 跟着 `expanded` 去盯的话，
 * 收起来的那几级会在背后悄悄过期，下次展开给人看的是旧的一层。
 * **缓存了谁就盯着谁**，这条规矩没有缝。
 *
 * 排过序：调用方拿 `join` 出来的串去重，顺序一抖就会白发一次 IPC。
 */
export function watchPaths(root: string | null, nodes: Node[]): string[] {
  if (!root) return []
  const dirs = [root]
  const walk = (list: Node[]): void => {
    for (const n of list) {
      if (n.entry.isDir && n.children) {
        dirs.push(n.entry.path)
        walk(n.children)
      }
    }
  }
  walk(nodes)
  return dirs.sort()
}

/** 超过这个位移才算拖拽 —— 否则每次点文件都会被判成一次微小的拖动 */
const DRAG_SLOP = 5
/** 首字母跳：两次按键隔得超过这个数就当是新的一个词（Finder 也是 0.8 秒上下） */
const TYPEAHEAD_GAP = 800

export interface SidebarHooks {
  openFile: (path: string) => void
  /**
   * 文件被移进废纸篓：让 main.ts 有机会关掉对应标签，并给出那条带「撤销」的回执。
   * `trashed` 是它在废纸篓里的落点（契约 v25），空串 = 壳没能给出落点，撤销这一下就不提供
   */
  trashed?: (path: string, trashed: string) => void
  /** 重命名 / 移动之后路径变了：开着的标签要跟着走，否则它指着一个不存在的文件 */
  moved?: (from: string, to: string) => void
  /** 跨文件搜索点中一处命中 */
  openHit?: (hit: SearchHit) => void
  /** 0.4.0 F2 跨文件替换：回执与撤销都在 main.ts（状态栏那条通道在那儿） */
  replaceInFiles?: (targets: ReplaceTarget[], replacement: string) => Promise<void>
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
  /** 行的 `id` 序号（`aria-activedescendant` 要指得到某一行），每次 render 从 0 重来 */
  private rowSeq = 0
  /** 首字母跳的缓冲：连着按算一个词，停手 `TYPEAHEAD_GAP` 之后从头算 */
  private typeahead = { text: '', at: 0 }
  /** 刚结束一次拖拽 —— 紧随其后的 click 不该再把文件打开 */
  private dragged = false
  /** 已经推给壳的监听单子（去重用：树每动一下 `render` 都会来问一次） */
  private watching = ''
  /** 收到了还没消化的目录变更：拖拽期间先攒着，松手再看（契约 v32） */
  private readonly pendingDirs = new Set<string>()

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
      <div class="sb-tree" tabindex="0" role="tree" aria-label="${t('sb.tree')}" data-i18n-aria="sb.tree"></div>
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
      () => this.closeSearch(),
      async (targets, replacement) => {
        await hooks.replaceInFiles?.(targets, replacement)
      }
    )
    this.el.insertBefore(this.search.el, this.el.querySelector('.sb-resize'))

    this.el.querySelector('.sb-tools')!.addEventListener('click', (e) => {
      const btn = (e.target as Element).closest<HTMLElement>('button[data-act]')
      if (btn) void this.toolAction(btn.dataset['act']!)
    })
    this.el.querySelector('.sb-open-btn')!.addEventListener('click', () => void this.pick())
    this.treeEl.addEventListener('click', (e) => void this.onRowClick(e))
    this.treeEl.addEventListener('mousedown', (e) => this.onRowMouseDown(e))
    this.treeEl.addEventListener('keydown', (e) => void this.onKeyDown(e))
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

  /** 当前工作区根（没打开文件夹就是 null）。0.2.0 快速打开要拿它去要文件索引 */
  get treeRoot(): string | null {
    return this.root
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
    if (path) await this.reveal(path)
    this.render()
    this.treeEl.querySelector('.sb-row.is-active')?.scrollIntoView({ block: 'nearest' })
  }

  /** 逐级展开，让这个路径在树里可见。`setActive` 与 `refresh` 共用 */
  private async reveal(path: string): Promise<void> {
    if (!this.root || !path.startsWith(`${this.root}/`)) return
    const rel = path.slice(this.root.length + 1).split('/')
    let prefix = this.root
    for (const seg of rel.slice(0, -1)) {
      prefix = `${prefix}/${seg}`
      await this.loadChildren(prefix)
      this.expanded.add(prefix)
    }
  }

  /**
   * 重新读一遍树（0.2.x）。给「磁盘被我们自己改了、但没经过这棵树」那条路用 ——
   * 目前只有一条：状态栏那颗「撤销」把文件从废纸篓挪了回来（契约 v25）。
   * `reload()` 自己是私有的（它还管着展开状态的保持），所以这里另开一个口子，
   * 顺带把还原出来的那个**展开到看得见**。
   */
  async refresh(select?: string): Promise<void> {
    await this.reload()
    if (!select) return
    await this.reveal(select)
    this.selected = select
    this.render()
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

  /**
   * 打开搜索面板并直接搜一条（0.4.1：⌘+点击 front matter 里的标签）。
   * 面板已经开着也要重搜 —— 连点两颗不同的标签，看到的必须是第二颗的结果。
   *
   * 回 false = 这个窗口还没有工作区（搜索没根可扫），由调用方去说那一句。
   */
  searchFor(query: string, opts?: Partial<SearchOptions>): boolean {
    if (!this.root) return false
    this.openSearch()
    this.search.search(query, opts)
    return true
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
    await this.activateRow(path)
  }

  /**
   * 「激活一行」：文件 = 打开，目录 = 收/展。点击与 Enter 共用同一条路 ——
   * 分成两份的话，某天给点击加了什么（比如预览），键盘那条就会悄悄少一块
   */
  private async activateRow(path: string): Promise<void> {
    const node = this.byPath.get(path)
    if (!node) return
    this.selected = path

    if (!node.entry.isDir) {
      this.paintCursor()
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
    this.syncWatch()
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
    this.rowSeq = 0
    this.appendRows(frag, this.nodes, 0)
    this.treeEl.replaceChildren(frag)
    this.paintCursor()
  }

  private appendRows(parent: DocumentFragment | HTMLElement, nodes: Node[], depth: number): void {
    for (const node of nodes) {
      const { entry } = node
      const row = document.createElement('div')
      row.className = 'sb-row'
      row.dataset['path'] = entry.path
      row.style.paddingLeft = `${4 + depth * 16}px`
      // 读屏要的那三件：这是棵树的一项、在第几层、（目录）此刻是收还是展。
      // `id` 是给 `aria-activedescendant` 指的 —— 见 `paintCursor`
      row.id = `sb-row-${this.rowSeq++}`
      row.setAttribute('role', 'treeitem')
      row.setAttribute('aria-level', String(depth + 1))
      if (entry.isDir) row.setAttribute('aria-expanded', String(this.expanded.has(entry.path)))
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
      // 文件名去掉文档后缀，树里更清爽（白名单与壳侧 DocScan.exts 对齐）
      name.textContent = entry.isDir
        ? entry.name
        : entry.name.replace(/\.(md|markdown|mdown|mkd|txt)$/i, '')
      name.title = entry.name
      item.appendChild(name)
      row.appendChild(item)

      parent.appendChild(row)

      if (entry.isDir && this.expanded.has(entry.path) && node.children) {
        this.appendRows(parent, node.children, depth + 1)
      }
    }
  }

  // ---------- 契约 v32 自动刷新 ----------

  /**
   * 壳报来：这一级目录的条目变了。**只重读这一级**。
   *
   * 不走 `reload()`：那是「根 + 每个展开目录各一次 IPC，还得串着等」，给我们自己
   * 改完盘用正好，接在一条每两秒就可能来一次的事件上太重。这条路的常态是
   * 「1 次 IPC + 一次清单比对 + 什么都不画」。
   */
  onDirChanged(path: string): void {
    // 拖拽进行中：树在手底下重建 = 落点高亮被抹掉、拖着的那一行还可能当场消失。
    // 攒着，松手再说
    if (document.body.classList.contains('is-dragging-row')) {
      this.pendingDirs.add(path)
      return
    }
    void this.refreshDir(path)
  }

  private flushPendingDirs(): void {
    const paths = [...this.pendingDirs]
    this.pendingDirs.clear()
    for (const p of paths) void this.refreshDir(p)
  }

  private async refreshDir(path: string): Promise<void> {
    if (path === this.root) {
      const fresh = await window.api.readDir(path)
      // **等这趟 IPC 的工夫树可能已经被整个换过**（换根 / reload / 又一次刷新）。
      // 认准同一棵树再落笔，否则会把旧的一层盖回一棵新树上
      if (path !== this.root) return
      if (sameEntries(this.nodes.map((n) => n.entry), fresh)) return
      this.nodes = adoptEntries(this.nodes, fresh)
    } else {
      const node = this.byPath.get(path)
      // 不在树里 / 还没读进来 = 这一级根本没缓存，读它没有意义（也不该在监听单子里）
      if (!node?.entry.isDir || !node.children) return
      const fresh = await window.api.readDir(path)
      if (this.byPath.get(path) !== node || !node.children) return
      if (sameEntries(node.children.map((n) => n.entry), fresh)) return
      node.children = adoptEntries(node.children, fresh)
    }
    // 索引整张重建：走掉的那一级连同它的子孙都得从 `byPath` 里消失，
    // 否则 `expanded` 的清理、`targetDir`、拖拽落点还认得出一个已经不在的路径
    this.byPath.clear()
    this.index(this.nodes)
    for (const p of [...this.expanded]) if (!this.byPath.has(p)) this.expanded.delete(p)
    // 光标那一行没了：退到它的父目录（那也正是「新建落在哪儿」的答案）。
    // 不退的话 `cursorRow()` 会回到第 0 行 —— 光标当场跳到树顶
    if (this.selected && !this.byPath.has(this.selected)) {
      const parent = dirname(this.selected)
      this.selected = parent && this.byPath.has(parent) ? parent : null
    }
    this.render()
  }

  /**
   * 把「要盯着哪几级」推给壳。挂在 `render()` 上是因为那是唯一的收口 ——
   * 换根 / 展开 / 折叠 / 增删改之后都会走到它，别处再各记一次迟早漏一处。
   * 单子没变就一个字节都不发（树每动一下这里都会被叫到）。
   */
  private syncWatch(): void {
    const paths = watchPaths(this.root, this.nodes)
    const key = paths.join('\n')
    if (key === this.watching) return
    this.watching = key
    window.api.watchDirs(paths)
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
    const res = await window.api.trashItem(path)
    if (!res) return
    this.expanded.delete(path)
    if (this.selected === path) this.selected = null
    await this.reload()
    this.hooks.trashed?.(path, res.trashed)
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

  // ---------- 键盘（0.2.x）----------
  //
  // 在这之前**整棵树只认鼠标**：大纲有过滤框、命令面板有键盘、查找有键盘，
  // 只有文件树得把手从键盘上拿开。这里补的是树控件的常规那一套（VS Code / Finder
  // 同款）：↑↓ 走行、←→ 收展、Enter 打开、首字母跳、F2 重命名、⌘⌫ 进废纸篓。
  //
  // 焦点模型走 **aria-activedescendant**：焦点始终在 `.sb-tree` 这**一个**元素上，
  // 「光标在哪一行」只是它的一个属性。换成「每行一个 tabindex、焦点跟着行走」的话，
  // 每一次 `render()`（自动保存、外部变更、展开一级、撤销删除…）都会把带着焦点的
  // 那个元素整个换掉，焦点当场掉回 body —— 而这棵树重建得非常勤。

  private rows(): HTMLElement[] {
    return [...this.treeEl.querySelectorAll<HTMLElement>('.sb-row')]
  }

  /** 光标所在行；还没落过光标就当在第一行 */
  private cursorRow(): HTMLElement | null {
    const rows = this.rows()
    return rows.find((r) => r.dataset['path'] === this.selected) ?? rows[0] ?? null
  }

  private moveCursor(to: HTMLElement | null | undefined): void {
    if (!to) return
    this.selected = to.dataset['path'] ?? null
    this.paintCursor()
    to.scrollIntoView({ block: 'nearest' })
  }

  /**
   * 把光标画出来，并告诉读屏它在哪一行。
   * `selected` 本来就是「新建落到哪个目录」「右键作用在谁身上」的依据，
   * 键盘光标用的是同一个字段 —— 两套光标会立刻打架。
   */
  private paintCursor(): void {
    let id = ''
    for (const row of this.rows()) {
      const on = row.dataset['path'] === this.selected
      row.classList.toggle('is-cursor', on)
      if (on) id = row.id
    }
    if (id) this.treeEl.setAttribute('aria-activedescendant', id)
    else this.treeEl.removeAttribute('aria-activedescendant')
  }

  private async expandDir(path: string): Promise<void> {
    await this.loadChildren(path)
    this.expanded.add(path)
    this.render()
  }

  private async onKeyDown(e: KeyboardEvent): Promise<void> {
    // 组字期间一个键都别接：中文输入法在树上也会先走这儿
    if (e.isComposing) return
    const rows = this.rows()
    if (!rows.length) return
    const cur = this.cursorRow()
    const at = cur ? rows.indexOf(cur) : -1
    const path = cur?.dataset['path'] ?? null
    const node = path ? this.byPath.get(path) : undefined
    const isDir = node?.entry.isDir === true

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        this.moveCursor(rows[Math.min(at + 1, rows.length - 1)])
        return
      case 'ArrowUp':
        e.preventDefault()
        this.moveCursor(rows[Math.max(at - 1, 0)])
        return
      case 'Home':
        e.preventDefault()
        this.moveCursor(rows[0])
        return
      case 'End':
        e.preventDefault()
        this.moveCursor(rows[rows.length - 1])
        return
      case 'ArrowRight':
        e.preventDefault()
        if (!path || !isDir) return
        // 收着 → 展开（光标留在目录上，同 Finder）；已经展开 → 进它的第一个孩子
        if (!this.expanded.has(path)) await this.expandDir(path)
        else this.moveCursor(rows[at + 1])
        return
      case 'ArrowLeft': {
        e.preventDefault()
        if (path && isDir && this.expanded.has(path)) {
          this.expanded.delete(path)
          this.render()
          return
        }
        // 文件、或者已经收起的目录：退到父目录那一行（已经在根这一层就原地不动）
        const parent = path ? dirname(path) : null
        this.moveCursor(parent ? rows.find((r) => r.dataset['path'] === parent) : null)
        return
      }
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (path) await this.activateRow(path)
        return
      case 'F2':
        e.preventDefault()
        if (path) await this.rename(path)
        return
      case 'Backspace':
      case 'Delete':
        // **⌘⌫ 才算数**（Finder 同款）。裸 ⌫ 有意不接：删除是这棵树上唯一
        // 「按错一个键就没了」的动作，得要一个修饰键。壳侧还会再问一次，
        // 而且现在删完状态栏那条回执里有「撤销」（契约 v25）
        if (!e.metaKey) return
        e.preventDefault()
        if (path) await this.trash(path)
        return
      default:
        this.onTypeahead(e, rows, at)
    }
  }

  /**
   * 首字母跳（Finder / VS Code 同款）。连着按算一个词，停手 `TYPEAHEAD_GAP` 从头算。
   * 单个字母时从**下一行**开始找 —— 同一个字母连按就是在这几行之间轮着走；
   * 攒成词之后从**当前行**开始找，否则打 `re` 会跳过正对着的那个 `readme`。
   */
  private onTypeahead(e: KeyboardEvent, rows: HTMLElement[], at: number): void {
    if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return
    const now = Date.now()
    this.typeahead.text = now - this.typeahead.at > TYPEAHEAD_GAP ? e.key : this.typeahead.text + e.key
    this.typeahead.at = now
    const names = rows.map((r) => r.querySelector('.sb-name')?.textContent ?? '')
    const from = this.typeahead.text.length > 1 ? Math.max(at, 0) : at + 1
    const hit = typeaheadIndex(names, from, this.typeahead.text)
    if (hit < 0) return
    e.preventDefault()
    this.moveCursor(rows[hit])
  }

  // ---------- P3-1 拖拽移动 ----------

  /**
   * **不走 HTML5 拖放**：与大纲重排同一个理由 —— 阈值/落点高亮/取消都好控，
   * 而且 `DataTransfer` 在无头自检里造不出来，走鼠标事件 E2E 才跑得通整条路径。
   */
  private onRowMouseDown(down: MouseEvent): void {
    if (down.button !== 0) return
    // 点过之后方向键就该能接着走。**放在最前面**：点的是文件时，稍后 `openFile`
    // 会把焦点交给编辑器（时间上在后，它赢），所以这一下只对点目录/空白真正生效
    this.treeEl.focus()
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
      // 拖着的这一路上攒下来的外部变更，现在补上（`move` 那条自己会 reload，
      // 撞上了也只是多读一趟 —— `refreshDir` 认节点，盖不回旧的一层）
      this.flushPendingDirs()
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

      /**
       * **一帧最多写一次宽度。** `mousemove` 在一帧里能来好几发（触控板尤其密），
       * 而改侧栏宽度不是改一个盒子 —— 编辑区跟着变窄，CodeMirror 要把视口里每一行
       * 重新折行、重新量高。每发都写等于一帧里做好几遍同样的重排，拖起来发涩。
       * 攒到 rAF 里只用最后那个值：光标在哪儿、宽度就是多少，一点都不欠账。
       */
      let pending: number | null = null
      let frame = 0
      const move = (e: MouseEvent): void => {
        pending = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startW + e.clientX - startX))
        if (frame) return
        frame = requestAnimationFrame(() => {
          frame = 0
          if (pending !== null) this.el.style.width = `${pending}px`
        })
      }
      const up = (): void => {
        // 松手这一下要**立即**把最后一个值落到位：rAF 还没回调就散了的话，
        // 宽度会停在上一帧，而下面那句紧接着就把它存进 localStorage
        if (frame) cancelAnimationFrame(frame)
        frame = 0
        if (pending !== null) this.el.style.width = `${pending}px`
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
