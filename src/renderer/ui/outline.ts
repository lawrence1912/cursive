import type { Section } from '../editor/headings'
import { applyI18n, t } from '../i18n'
import { icon } from './icons'
import { openMenu, type MenuItem } from './menu'

/** 大纲要往回调的东西。文档语义（改哪段字节）全在 main.ts，面板只管「点了什么」 */
export interface OutlineActions {
  jump: (pos: number) => void
  /** 把 fromPos 那一节搬到 beforePos 那一节之前；beforePos 为 null = 搬到文末 */
  move: (fromPos: number, beforePos: number | null) => void
  setLevel: (pos: number, level: number) => void
  newSibling: (pos: number) => void
  copyAnchor: (pos: number) => void
}

const FOLD_KEY = 'cursive.outlineFold'
const LEVEL_KEY = 'cursive.outlineLevel'
/** 折叠状态最多记这么多篇文档，先进先出 —— 不设上限的话 localStorage 会一直长 */
const FOLD_DOCS = 20
/** 每级缩进（与文件树同一套口径） */
const INDENT = 14
/** 鼠标移动超过这么多像素才算「在拖」，否则是一次普通点击 */
const DRAG_SLOP = 4

interface Row {
  item: Section
  /** 名下有没有（当前层级档位下可见的）子标题 */
  parent: boolean
  folded: boolean
}

/**
 * 右侧大纲：标题层级列表 + 折叠 / 层级档位 / 过滤框 / 每节字数 / 拖拽重排 / 右键菜单。
 *
 * 面板本身只认 `Section[]`（`editor/headings.ts` 的取数，与 `[TOC]` 同一份）和一组回调；
 * 所有会改文档的操作都由 main.ts 拿纯函数算成一次 dispatch，撤销栈因此免费成立。
 */
export class Outline {
  readonly el: HTMLElement
  private items: Section[] = []
  private rows: Row[] = []
  private activePos: number | null = null
  private listEl: HTMLElement
  private emptyEl: HTMLElement
  private filterEl: HTMLInputElement
  private levelsEl: HTMLElement
  private dropEl: HTMLElement

  /** 当前文档（折叠状态按文档记；换文档换一套） */
  private docKey = ''
  private folded = new Set<string>()
  private maxLevel = 6
  private query = ''
  private drag: { pos: number; x: number; y: number; on: boolean } | null = null
  /** 刚拖完的那一下不要当成点击跳转 */
  private swallowClick = false

  constructor(private readonly actions: OutlineActions) {
    this.el = document.createElement('aside')
    this.el.id = 'outline'
    this.el.innerHTML = `
      <div class="ol-head">
        <span class="ol-title" data-i18n="ol.title">${t('ol.title')}</span>
        <div class="ol-levels" role="group" aria-label="${t('ol.levels')}" data-i18n-aria="ol.levels">
          ${[1, 2, 3, 4, 5, 6]
            .map(
              (n) =>
                `<button type="button" data-level="${n}" title="${t('ol.level', { n })}" aria-label="${t('ol.level', { n })}"` +
                ` data-i18n-title="ol.level" data-i18n-aria="ol.level" data-i18n-args='${JSON.stringify({ n })}'>${n}</button>`
            )
            .join('')}
        </div>
      </div>
      <div class="ol-filter">
        <input type="search" placeholder="${t('ol.filter')}" aria-label="${t('ol.filter')}"
               data-i18n-ph="ol.filter" data-i18n-aria="ol.filter" spellcheck="false">
        <button type="button" class="ol-clear" aria-label="${t('ol.clear')}" data-i18n-aria="ol.clear" hidden>${icon('close')}</button>
      </div>
      <div class="ol-list"><div class="ol-drop" hidden></div></div>
      <div class="ol-empty" hidden></div>
    `
    applyI18n(this.el)
    this.listEl = this.el.querySelector('.ol-list')!
    this.emptyEl = this.el.querySelector('.ol-empty')!
    this.filterEl = this.el.querySelector('input')!
    this.levelsEl = this.el.querySelector('.ol-levels')!
    this.dropEl = this.el.querySelector('.ol-drop')!
    this.maxLevel = this.loadLevel()

    this.levelsEl.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('button[data-level]')
      if (!btn) return
      const lv = Number(btn.dataset['level'])
      // 再点一次当前档位 = 回到「全部显示」，省一个「全部」按钮
      this.maxLevel = this.maxLevel === lv ? 6 : lv
      localStorage.setItem(LEVEL_KEY, String(this.maxLevel))
      this.render()
    })

    this.filterEl.addEventListener('input', () => {
      this.query = this.filterEl.value.trim().toLowerCase()
      this.el.querySelector<HTMLElement>('.ol-clear')!.hidden = this.query === ''
      this.render()
    })
    this.filterEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.filterEl.value) return
      e.stopPropagation()
      this.filterEl.value = ''
      this.filterEl.dispatchEvent(new Event('input'))
    })
    this.el.querySelector('.ol-clear')!.addEventListener('click', () => {
      this.filterEl.value = ''
      this.filterEl.dispatchEvent(new Event('input'))
      this.filterEl.focus()
    })

    this.listEl.addEventListener('click', (e) => {
      if (this.swallowClick) {
        this.swallowClick = false
        return
      }
      const twist = (e.target as HTMLElement).closest<HTMLElement>('.ol-twist')
      if (twist) {
        this.toggleFold(Number(twist.closest<HTMLElement>('.ol-row')!.dataset['pos']))
        return
      }
      const row = (e.target as HTMLElement).closest<HTMLElement>('.ol-row')
      if (row) this.actions.jump(Number(row.dataset['pos']))
    })

    this.listEl.addEventListener('contextmenu', (e) => this.onContextMenu(e))
    this.listEl.addEventListener('mousedown', (e) => this.onMouseDown(e))
  }

  get visible(): boolean {
    return !this.el.classList.contains('is-hidden')
  }

  toggle(): void {
    this.el.classList.toggle('is-hidden')
  }

  /** 换文档：折叠状态按文档记，不然换一篇文章折叠会乱套 */
  setDoc(key: string): void {
    if (key === this.docKey) return
    this.docKey = key
    this.folded = new Set(this.loadFold()[key] ?? [])
  }

  setItems(items: Section[]): void {
    this.items = items
    this.render()
  }

  /** 语言切换等与内容无关的重刷：行上的字数 tooltip / 空态文案跟着当前语言走 */
  refresh(): void {
    this.render()
  }

  /** 高亮「视口顶部所在章节」对应的标题 */
  setActive(pos: number | null): void {
    this.activePos = pos
    for (const row of this.listEl.querySelectorAll<HTMLElement>('.ol-row')) {
      row.classList.toggle('is-active', Number(row.dataset['pos']) === pos)
    }
  }

  // ---------- 折叠 ----------

  /** 折叠键按「层级 + 标题文字」记：记位置的话，编辑一下全乱 */
  private keyOf(item: Section): string {
    return `${item.level}\u0000${item.text}`
  }

  private toggleFold(pos: number): void {
    const item = this.items.find((h) => h.pos === pos)
    if (!item) return
    const key = this.keyOf(item)
    if (!this.folded.delete(key)) this.folded.add(key)
    this.persistFold()
    this.render()
  }

  private loadFold(): Record<string, string[]> {
    try {
      return JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}') as Record<string, string[]>
    } catch {
      return {}
    }
  }

  private persistFold(): void {
    try {
      const all = this.loadFold()
      if (this.folded.size) all[this.docKey] = [...this.folded]
      else delete all[this.docKey]
      // 只留最近 FOLD_DOCS 篇：对象键保持插入序，删掉最老的几个
      const keys = Object.keys(all)
      for (const k of keys.slice(0, Math.max(0, keys.length - FOLD_DOCS))) delete all[k]
      localStorage.setItem(FOLD_KEY, JSON.stringify(all))
    } catch {
      /* 存不下就算了，折叠本身照常生效 */
    }
  }

  private loadLevel(): number {
    const n = Number(localStorage.getItem(LEVEL_KEY))
    return n >= 1 && n <= 6 ? n : 6
  }

  // ---------- 渲染 ----------

  /**
   * 可见行 = 先过层级档位，再过折叠/过滤。
   * **过滤时不认折叠** —— 收起来的那一节里有命中项，也得让人看见。
   */
  private visibleRows(): Row[] {
    const capped = this.items.filter((h) => h.level <= this.maxLevel)
    const rows: Row[] = []
    // 折叠住的祖先层级：level 大于它的一律不出现，直到遇到同级或更高级
    let hideBelow = 0
    for (let i = 0; i < capped.length; i++) {
      const item = capped[i]!
      const next = capped[i + 1]
      const row: Row = {
        item,
        parent: next !== undefined && next.level > item.level,
        folded: this.folded.has(this.keyOf(item))
      }
      if (this.query) {
        if (item.text.toLowerCase().includes(this.query)) rows.push(row)
        continue
      }
      if (hideBelow && item.level > hideBelow) continue
      hideBelow = 0
      rows.push(row)
      if (row.parent && row.folded) hideBelow = item.level
    }
    return rows
  }

  private render(): void {
    for (const btn of this.levelsEl.querySelectorAll<HTMLElement>('button')) {
      // 档位是「显示到第 N 级」，所以 ≤ N 的按钮都亮着，像个进度条
      btn.classList.toggle('is-on', Number(btn.dataset['level']) <= this.maxLevel)
    }
    this.rows = this.visibleRows()
    const empty = !this.items.length ? t('ol.empty') : this.rows.length ? '' : t('ol.noMatch')
    this.emptyEl.textContent = empty
    this.emptyEl.hidden = empty === ''

    const frag = document.createDocumentFragment()
    for (const row of this.rows) {
      const el = document.createElement('div')
      el.className = `ol-row ol-l${row.item.level}`
      if (row.item.pos === this.activePos) el.classList.add('is-active')
      el.dataset['pos'] = String(row.item.pos)
      // 缩进给整行：高亮画的是里面的 .ol-item，跟着层级一起往右收
      //（和文件树 .sb-row/.sb-item 同一套口径）
      el.style.paddingLeft = `${(row.item.level - 1) * INDENT}px`

      const twist = document.createElement('button')
      twist.type = 'button'
      twist.className = row.folded ? 'ol-twist' : 'ol-twist is-open'
      twist.innerHTML = icon('chevron')
      twist.tabIndex = -1
      twist.setAttribute('aria-label', row.folded ? t('ol.expand') : t('ol.collapse'))
      // 没有子标题的行也占同样宽度，文字才对得齐（文件树同款）
      twist.style.visibility = row.parent && !this.query ? '' : 'hidden'

      const item = document.createElement('div')
      item.className = 'ol-item'
      const text = document.createElement('span')
      text.className = 'ol-text'
      this.paintText(text, row.item.text)
      item.appendChild(text)
      if (row.item.words) {
        const words = document.createElement('span')
        words.className = 'ol-words'
        words.textContent = String(row.item.words)
        words.title = t('ol.words', { n: row.item.words })
        item.appendChild(words)
      }

      el.append(twist, item)
      el.title = row.item.text
      frag.appendChild(el)
    }
    this.listEl.replaceChildren(this.dropEl, frag)
  }

  /** 过滤时把命中的那一段套上 <mark>，别让人自己在列表里找 */
  private paintText(host: HTMLElement, text: string): void {
    const at = this.query ? text.toLowerCase().indexOf(this.query) : -1
    if (at < 0) {
      host.textContent = text
      return
    }
    const mark = document.createElement('mark')
    mark.textContent = text.slice(at, at + this.query.length)
    host.append(text.slice(0, at), mark, text.slice(at + this.query.length))
  }

  // ---------- 拖拽重排 ----------

  /**
   * 自己接 mousedown/mousemove/mouseup，不走 HTML5 拖放：
   * ① 阈值、落点指示、取消都好控；② `DataTransfer` 在无头自检里造不出来，
   * 走鼠标事件的话 E2E 能直接把整条路径跑一遍。
   */
  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('.ol-twist')) return
    const row = (e.target as HTMLElement).closest<HTMLElement>('.ol-row')
    if (!row) return
    // 上一次拖拽如果在面板外松手，就不会有 click 来清这个标记 —— 按下时先清一次
    this.swallowClick = false
    this.drag = { pos: Number(row.dataset['pos']), x: e.clientX, y: e.clientY, on: false }

    const move = (ev: MouseEvent): void => {
      const d = this.drag
      if (!d) return
      if (!d.on && Math.abs(ev.clientX - d.x) + Math.abs(ev.clientY - d.y) < DRAG_SLOP) return
      if (!d.on) {
        d.on = true
        row.classList.add('is-dragging')
      }
      this.paintDrop(ev.clientY)
    }
    const up = (ev: MouseEvent): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      const d = this.drag
      this.drag = null
      row.classList.remove('is-dragging')
      this.dropEl.hidden = true
      if (!d?.on) return
      this.swallowClick = true
      const target = this.dropTarget(ev.clientY)
      if (target !== undefined) this.actions.move(d.pos, target)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  /** 落点：光标过了某一行的中线就插到它后面。undefined = 原地不动 */
  private dropTarget(clientY: number): number | null | undefined {
    const els = [...this.listEl.querySelectorAll<HTMLElement>('.ol-row')]
    if (!els.length) return undefined
    const src = this.items.find((h) => h.pos === this.drag?.pos)
    for (const el of els) {
      const box = el.getBoundingClientRect()
      if (clientY >= box.top + box.height / 2) continue
      const pos = Number(el.dataset['pos'])
      // 落进自己名下那一段 = 搬进自己肚子里，无效
      return src && pos >= src.pos && pos <= src.end ? undefined : pos
    }
    return src && src.end >= Number.MAX_SAFE_INTEGER ? undefined : null // 末尾
  }

  private paintDrop(clientY: number): void {
    const target = this.dropTarget(clientY)
    if (target === undefined) {
      this.dropEl.hidden = true
      return
    }
    const host = this.listEl.getBoundingClientRect()
    const els = [...this.listEl.querySelectorAll<HTMLElement>('.ol-row')]
    const el = target === null ? els[els.length - 1] : els.find((x) => Number(x.dataset['pos']) === target)
    if (!el) return
    const box = el.getBoundingClientRect()
    const y = (target === null ? box.bottom : box.top) - host.top + this.listEl.scrollTop
    this.dropEl.style.top = `${y}px`
    this.dropEl.hidden = false
  }

  // ---------- 右键菜单 ----------

  private onContextMenu(e: MouseEvent): void {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.ol-row')
    if (!row) return
    e.preventDefault()
    const pos = Number(row.dataset['pos'])
    const item = this.items.find((h) => h.pos === pos)
    if (!item) return

    const items: MenuItem[] = [
      { label: t('ol.copyAnchor'), run: () => this.actions.copyAnchor(pos) },
      { label: t('ol.newSibling'), run: () => this.actions.newSibling(pos) },
      {
        label: t('ol.promote'),
        separated: true,
        disabled: item.level <= 1,
        run: () => this.actions.setLevel(pos, item.level - 1)
      },
      {
        label: t('ol.demote'),
        disabled: item.level >= 6,
        run: () => this.actions.setLevel(pos, item.level + 1)
      }
    ]
    row.classList.add('is-context')
    openMenu(e.clientX, e.clientY, items, {
      onClose: () => row.classList.remove('is-context'),
      scrollHost: this.listEl
    })
  }
}
