import { basename } from '../../shared/path'
import { applyI18n, onLangChange, t } from '../i18n'
import { icon } from './icons'
import type { ReplaceHit, ReplaceTarget, SearchHit, SearchOptions } from '../../shared/types'

/** macOS 上 /tmp、/var 都是 /private 下的软链，路径两边可能一边带一边不带 */
function unprivate(p: string): string {
  return p.startsWith('/private/') ? p.slice(8) : p
}

/** 中间目录太长就从左边截：尾巴（离文件最近的那几层）才是有信息量的一段 */
function trimLeft(p: string, max = 30): string {
  return p.length <= max ? p : `…${p.slice(p.length - max)}`
}

/**
 * 路径相对树根的那一段（**不截断**）。0.2.0 快速打开拿它当模糊匹配的键 ——
 * 匹配要用完整的相对路径，`relativeDir` 那份是给眼睛看的、可能带着省略号。
 *
 * `/private` 那条坑与下面同源：树根与命中路径可能一边带一边不带（`/tmp` 是软链），
 * 直接 `startsWith` 会算不出相对段落，于是整条绝对路径原样示人。
 */
export function relativePath(path: string, root: string | null): string {
  if (!root) return path
  const a = unprivate(path)
  const b = unprivate(root)
  return a.startsWith(`${b}/`) ? a.slice(b.length + 1) : path
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
export interface Group {
  path: string
  hits: SearchHit[]
}

/** 逐处复选框的身份：第几组第几条。勾掉的记在一张集合里（默认全选） */
export function hitKey(group: number, hit: number): string {
  return `${group}:${hit}`
}

/**
 * 0.4.0 F2：勾剩下的那些命中 → 送给壳的那份清单（契约 v30）。
 *
 * **所见即所改**：清单里只有此刻列在结果里、而且没被勾掉的那些处，壳侧不再回盘
 * 重搜一遍。每一处都带上原文（`hit.text` 里按 `textCol` 切出来的那一段）——
 * 壳侧逐字比对过才改，对不上就整份跳过。
 *
 * 纯函数，`test/file-search.test.ts` 直接测：这条路上会错的（把勾掉的也送出去、
 * 原文切歪一个字符）全在这几行里，而它下游是「一次改几十个文件」。
 */
export function buildTargets(groups: Group[], excluded: ReadonlySet<string>): ReplaceTarget[] {
  const out: ReplaceTarget[] = []
  for (const [gi, g] of groups.entries()) {
    const hits: ReplaceHit[] = []
    for (const [hi, hit] of g.hits.entries()) {
      if (excluded.has(hitKey(gi, hi))) continue
      hits.push({
        line: hit.line,
        col: hit.col,
        length: hit.length,
        match: hit.text.slice(hit.textCol, hit.textCol + hit.length)
      })
    }
    if (hits.length) out.push({ path: g.path, hits })
  }
  return out
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
  /** 0.4.0 F2：被勾掉的那些命中（默认一个都没勾掉 = 全改） */
  private excluded = new Set<string>()
  private replacing = false

  constructor(
    private readonly onOpenHit: (hit: SearchHit) => void,
    /** 面板收起（Esc / 返回键）：交还给文件树 */
    private readonly onBack: () => void,
    /** 0.4.0 F2：按下「全部替换」。回执与撤销都在 main.ts（状态栏那条通道在那儿） */
    private readonly onReplaceAll: (
      targets: ReplaceTarget[],
      replacement: string
    ) => Promise<void> = async () => undefined
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
      <div class="fs-box fs-box-replace">
        <span class="fs-icon">${icon('pencil')}</span>
        <input class="fs-replace" type="text" placeholder="${t('fs.replacePh')}" aria-label="${t('fs.replacePh')}"
               data-i18n-ph="fs.replacePh" data-i18n-aria="fs.replacePh"
               autocomplete="off" spellcheck="false" />
        <button class="fs-replace-all" disabled title="${t('fs.replaceAllTip')}"
                data-i18n="fs.replaceAll" data-i18n-title="fs.replaceAllTip">${t('fs.replaceAll')}</button>
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

    // 0.4.0 F2：替换那一行。回车 = 按下「全部替换」（与查找框的回车对称）
    const replaceInput = this.el.querySelector<HTMLInputElement>('.fs-replace')!
    replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        this.onBack()
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        void this.replaceAll()
      }
    })
    this.el
      .querySelector('.fs-replace-all')!
      .addEventListener('click', () => void this.replaceAll())

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
      const key = hitKey(Number(row.dataset['g']), Number(row.dataset['h']))
      // 0.4.0 F2：勾掉某一处 —— **点复选框不算点这一行**，否则想取消一处就被带着跳走了
      if ((e.target as Element).closest('.fs-pick')) {
        const box = row.querySelector<HTMLInputElement>('.fs-pick')!
        if (box.checked) this.excluded.delete(key)
        else this.excluded.add(key)
        row.classList.toggle('is-off', !box.checked)
        this.syncReplace()
        return
      }
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
      this.syncReplace()
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

  /**
   * 从外面塞一条查询进来（0.4.1：点 front matter 里的标签）。
   *
   * **正则开关跟着一起打开，但不写进偏好** —— 送进来的是一条正则，不开的话它会被
   * 当成字面量转义掉，搜出来一条都没有，而人看着输入框里明明写着式子；面板上那颗
   * `.*` 于是要亮着（所见即所搜）。但这一下是**点标签带出来的**，不是人自己按的，
   * 没有理由改掉他存着的那份默认 —— 下次自己开搜索面板时，开关还是他留下的样子。
   *
   * 不走防抖：这不是打字，是一次明确的动作，等 220ms 只会显得慢。
   */
  search(query: string, opts?: Partial<SearchOptions>): void {
    if (opts) {
      this.opts = { ...this.opts, ...opts }
      this.syncOpts()
    }
    this.input.value = query
    this.clearBtn.hidden = !query
    clearTimeout(this.timer)
    this.run()
  }

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
    // 勾掉的那些跟着结果一起作废：下一次搜出来的第 3 条与这一次的第 3 条毫无关系
    this.excluded.clear()
    this.syncReplace()
  }

  /**
   * 0.4.0 F2：按下「全部替换」。
   *
   * **只送清单里剩下的那些处**（所见即所改），改完**重搜一次** —— 结果里那些行
   * 已经不成立了，留着会让人对着一份过期的清单再点一次。
   */
  private async replaceAll(): Promise<void> {
    if (this.replacing) return
    const replacement = this.el.querySelector<HTMLInputElement>('.fs-replace')!.value
    const targets = buildTargets(this.groups, this.excluded)
    if (!targets.length) return
    this.replacing = true
    this.syncReplace()
    try {
      await this.onReplaceAll(targets, replacement)
    } finally {
      this.replacing = false
      this.syncReplace()
    }
    this.run()
  }

  /** 「全部替换」什么时候能按：有查询、有剩下的命中、而且这会儿没在改 */
  private syncReplace(): void {
    const btn = this.el.querySelector<HTMLButtonElement>('.fs-replace-all')
    if (!btn) return
    const left = buildTargets(this.groups, this.excluded).reduce((n, t) => n + t.hits.length, 0)
    btn.disabled = this.replacing || !this.input.value || left === 0
    btn.textContent = left ? t('fs.replaceAllN', { n: left }) : t('fs.replaceAll')
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
      // 0.4.0 F2：每一处都能单独去掉 —— 「全有或全无」在跨文件替换里太粗
      const pick = document.createElement('input')
      pick.type = 'checkbox'
      pick.className = 'fs-pick'
      pick.checked = !this.excluded.has(hitKey(index, i))
      pick.setAttribute('aria-label', t('fs.pick'))
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
      row.append(pick, ln, text)
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
