import { basename } from '../../shared/path'
import { applyI18n, onLangChange, t } from '../i18n'
import { icon } from './icons'
import type { SearchHit, SearchOptions } from '../../shared/types'

/** macOS 上 /tmp、/var 都是 /private 下的软链，路径两边可能一边带一边不带 */
function unprivate(p: string): string {
  return p.startsWith('/private/') ? p.slice(8) : p
}

/** 中间目录太长就从左边截：尾巴（离文件最近的那几层）才是有信息量的一段 */
function trimLeft(p: string, max = 30): string {
  return p.length <= max ? p : `…${p.slice(p.length - max)}`
}

/**
 * 命中文件所在目录**相对树根**的那一段，给同名文件消歧用；就在树根下就返回空串。
 *
 * 两处坑：
 * ① **`/private` 前缀**：`/tmp` `/var` 在 macOS 上是 `/private/*` 的软链，树根与命中路径
 *    可能一边带一边不带，直接 `startsWith` 会把整条绝对路径当成相对段落显示出来；
 * ② 太长的中间段从**左边**截（尾巴才有信息量）。原先想用 `direction: rtl` 让
 *    `text-overflow` 把省略号放到前面，但路径开头那个 `/` 是中性字符，双向文本重排会把它
 *    甩到行尾，显示成 `private/tmp/x/` —— 少了根斜杠，多了个假的尾斜杠。
 */
export function relativeDir(path: string, root: string | null): string {
  const dir = path.slice(0, Math.max(0, path.lastIndexOf('/')))
  if (root) {
    const a = unprivate(dir)
    const b = unprivate(root)
    if (a === b) return ''
    if (a.startsWith(`${b}/`)) return trimLeft(a.slice(b.length + 1))
  }
  return trimLeft(dir)
}

/** 一个文件下的全部命中 —— 结果按文件分组，正好也是壳侧回推的批次单位 */
interface Group {
  path: string
  hits: SearchHit[]
}

const OPT_KEY = 'cursive.searchOpts'
const DEBOUNCE = 220

/**
 * 状态行**存状态、不存已经翻好的那句话**。切语言时要把「12 处 · 3 个文件」重新说一遍，
 * 手里只有字符串是说不出来的（`fs.truncated` 那一截更是连有没有都不知道）
 */
type Status =
  | { kind: 'blank' }
  | { kind: 'noFolder' }
  | { kind: 'searching' }
  | { kind: 'noMatch' }
  | { kind: 'hits'; truncated: boolean }

/**
 * P3-2 跨文件搜索面板（占侧边栏，与文件树二选一显示）。
 *
 * **搜索本身在壳里跑**（契约 v11）：渲染层递归 `readDir` 会让 IPC 往返爆炸。
 * 这里只做三件事 —— 发查询、收流式批次、把命中画成可点的行。
 *
 * 过期结果靠 `token` 挡：边打字边搜时上一次的批次还在路上，token 对不上就整批丢掉。
 * 不这么做的话，慢查询的结果会盖在快查询上面（典型的竞态，症状是「结果跟查询对不上」）。
 */
export class FileSearch {
  readonly el: HTMLElement
  private readonly input: HTMLInputElement
  private readonly clearBtn: HTMLButtonElement
  private readonly statusEl: HTMLElement
  private readonly listEl: HTMLElement

  private root: string | null = null
  private opts: SearchOptions = { caseSensitive: false, wholeWord: false, regex: false }
  private token = 0
  private groups: Group[] = []
  private total = 0
  private timer: number | undefined
  private status: Status = { kind: 'blank' }

  constructor(
    private readonly onOpenHit: (hit: SearchHit) => void,
    /** 面板收起（Esc / 返回键）：交还给文件树 */
    private readonly onBack: () => void
  ) {
    this.opts = this.loadOpts()
    this.el = document.createElement('div')
    this.el.className = 'sb-search'
    this.el.hidden = true
    this.el.innerHTML = `
      <div class="fs-box">
        <span class="fs-icon">${icon('search')}</span>
        <input class="fs-input" type="search" placeholder="${t('fs.placeholder')}" aria-label="${t('fs.placeholder')}"
               data-i18n-ph="fs.placeholder" data-i18n-aria="fs.placeholder"
               autocomplete="off" spellcheck="false" />
        <button class="fs-clear" hidden aria-label="${t('fs.clear')}" data-i18n-aria="fs.clear">${icon('close')}</button>
      </div>
      <div class="fs-opts" role="group" aria-label="${t('fs.opts')}" data-i18n-aria="fs.opts">
        <button data-opt="caseSensitive" title="${t('fs.case')}" data-i18n-title="fs.case">Aa</button>
        <button data-opt="wholeWord" title="${t('fs.word')}" data-i18n-title="fs.word">ab|</button>
        <button data-opt="regex" title="${t('fs.regex')}" data-i18n-title="fs.regex">.*</button>
      </div>
      <div class="fs-status"></div>
      <div class="fs-list" tabindex="-1"></div>
    `
    applyI18n(this.el)
    this.input = this.el.querySelector('.fs-input')!
    this.clearBtn = this.el.querySelector('.fs-clear')!
    this.statusEl = this.el.querySelector('.fs-status')!
    this.listEl = this.el.querySelector('.fs-list')!

    this.input.addEventListener('input', () => {
      // [hidden] 压不过作者写的 display（同 P3-6 大纲清空键那条坑）
      this.clearBtn.hidden = this.input.value === ''
      this.schedule()
    })
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (this.input.value) this.clear()
        else this.onBack()
      }
      // 回车 = 立刻搜，不等防抖
      if (e.key === 'Enter') {
        e.preventDefault()
        this.run()
      }
    })
    this.clearBtn.addEventListener('click', () => this.clear())

    this.el.querySelector('.fs-opts')!.addEventListener('click', (e) => {
      const btn = (e.target as Element).closest<HTMLElement>('button[data-opt]')
      if (!btn) return
      const key = btn.dataset['opt'] as keyof SearchOptions
      this.opts = { ...this.opts, [key]: !this.opts[key] }
      this.saveOpts()
      this.syncOpts()
      this.run()
    })
    this.syncOpts()

    this.listEl.addEventListener('click', (e) => {
      const row = (e.target as Element).closest<HTMLElement>('.fs-hit')
      if (!row) return
      const g = this.groups[Number(row.dataset['g'])]
      const hit = g?.hits[Number(row.dataset['h'])]
      if (hit) this.onOpenHit(hit)
    })

    // 流式回推：token 对不上的整批丢掉（过期查询的结果不许盖住当前这次）
    window.api.onSearchHits((batch) => {
      if (batch.token !== this.token || !batch.hits.length) return
      const path = batch.hits[0]!.path
      this.groups.push({ path, hits: batch.hits })
      this.total += batch.hits.length
      this.appendGroup(this.groups.length - 1)
      this.setStatus({ kind: 'hits', truncated: false })
    })
    window.api.onSearchDone((done) => {
      if (done.token !== this.token) return
      if (!this.total) {
        this.setStatus(this.input.value ? { kind: 'noMatch' } : { kind: 'blank' })
        return
      }
      this.setStatus({ kind: 'hits', truncated: done.truncated })
    })

    // 语言切换：静态那批属性由侧栏的 applyI18n(this.el) 一起重翻（面板挂在它里头），
    // 这里补的是**已经画出来的结果** —— 状态行那句话和每一行的「第 N 行」提示
    onLangChange(() => {
      this.renderStatus()
      this.relabelHits()
    })
  }

  setRoot(root: string | null): void {
    if (root === this.root) return
    this.root = root
    if (this.el.hidden) return
    this.run()
  }

  get visible(): boolean {
    return !this.el.hidden
  }

  show(): void {
    this.el.hidden = false
    this.input.focus()
    this.input.select()
  }

  hide(): void {
    this.el.hidden = true
    this.cancel()
  }

  /** 焦点给输入框（面板已经开着时再按一次 ⌘⇧F 也应该回到输入框） */
  focus(): void {
    this.input.focus()
    this.input.select()
  }

  // ---------- 内部 ----------

  private clear(): void {
    this.input.value = ''
    this.clearBtn.hidden = true
    this.reset()
    this.setStatus({ kind: 'blank' })
    this.cancel()
    this.input.focus()
  }

  private cancel(): void {
    window.api.cancelSearch(this.token)
  }

  private schedule(): void {
    clearTimeout(this.timer)
    this.timer = window.setTimeout(() => this.run(), DEBOUNCE)
  }

  private reset(): void {
    this.groups = []
    this.total = 0
    this.listEl.replaceChildren()
  }

  private run(): void {
    clearTimeout(this.timer)
    this.reset()
    const query = this.input.value
    // token 每次都推进：上一次在路上的批次因此自动作废
    this.token += 1
    if (!query || !this.root) {
      this.cancel()
      this.setStatus(this.root ? { kind: 'blank' } : { kind: 'noFolder' })
      return
    }
    this.setStatus({ kind: 'searching' })
    window.api.searchFiles(this.token, this.root, query, this.opts)
  }

  private setStatus(status: Status): void {
    this.status = status
    this.renderStatus()
  }

  /** 状态 → 当前语言下的那句话。切语言时单独再跑一遍 */
  private renderStatus(): void {
    const s = this.status
    const hits = (): string => t('fs.hits', { n: this.total, files: this.groups.length })
    this.statusEl.textContent =
      s.kind === 'blank'
        ? ''
        : s.kind === 'noFolder'
          ? t('fs.noFolder')
          : s.kind === 'searching'
            ? t('fs.searching')
            : s.kind === 'noMatch'
              ? t('fs.noMatch')
              : hits() + (s.truncated ? t('fs.truncated') : '')
  }

  /** 已经画出来的命中行：行号提示跟着语言换（行本身是数字，不用重画） */
  private relabelHits(): void {
    for (const row of this.listEl.querySelectorAll<HTMLElement>('.fs-hit')) {
      const hit = this.groups[Number(row.dataset['g'])]?.hits[Number(row.dataset['h'])]
      if (hit) row.title = t('fs.line', { line: hit.line })
    }
  }

  private appendGroup(index: number): void {
    const g = this.groups[index]!
    const wrap = document.createElement('div')
    wrap.className = 'fs-group'

    const head = document.createElement('div')
    head.className = 'fs-file'
    const name = document.createElement('span')
    name.className = 'fs-file-name'
    name.textContent = basename(g.path)
    const dir = document.createElement('span')
    dir.className = 'fs-file-dir'
    dir.textContent = this.relDir(g.path)
    const n = document.createElement('span')
    n.className = 'fs-file-n'
    n.textContent = String(g.hits.length)
    head.append(name, dir, n)
    head.title = g.path
    wrap.appendChild(head)

    for (const [i, hit] of g.hits.entries()) {
      const row = document.createElement('div')
      row.className = 'fs-hit'
      row.dataset['g'] = String(index)
      row.dataset['h'] = String(i)
      row.title = t('fs.line', { line: hit.line })
      const ln = document.createElement('span')
      ln.className = 'fs-line'
      ln.textContent = String(hit.line)
      const text = document.createElement('span')
      text.className = 'fs-text'
      // 窗口是壳侧围着命中点裁好的，这里只按 textCol 切三段（前导 … 已经在串里了）
      const mark = document.createElement('mark')
      mark.textContent = hit.text.slice(hit.textCol, hit.textCol + hit.length)
      text.append(
        document.createTextNode(hit.text.slice(0, hit.textCol)),
        mark,
        document.createTextNode(hit.text.slice(hit.textCol + hit.length))
      )
      row.append(ln, text)
      wrap.appendChild(row)
    }
    this.listEl.appendChild(wrap)
  }

  private relDir(path: string): string {
    return relativeDir(path, this.root)
  }

  private syncOpts(): void {
    for (const btn of this.el.querySelectorAll<HTMLElement>('.fs-opts button')) {
      const on = this.opts[btn.dataset['opt'] as keyof SearchOptions]
      btn.classList.toggle('is-on', on)
      btn.setAttribute('aria-pressed', String(on))
    }
  }

  private loadOpts(): SearchOptions {
    try {
      const raw = JSON.parse(localStorage.getItem(OPT_KEY) ?? '{}') as Partial<SearchOptions>
      return {
        caseSensitive: raw.caseSensitive === true,
        wholeWord: raw.wholeWord === true,
        regex: raw.regex === true
      }
    } catch {
      return { caseSensitive: false, wholeWord: false, regex: false }
    }
  }

  private saveOpts(): void {
    try {
      localStorage.setItem(OPT_KEY, JSON.stringify(this.opts))
    } catch {
      /* 存不下就算了 */
    }
  }
}
