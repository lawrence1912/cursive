import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  SearchQuery,
  selectMatches,
  setSearchQuery
} from '@codemirror/search'
import type { EditorState } from '@codemirror/state'
import { runScopeHandlers, type EditorView, type Panel, type ViewUpdate } from '@codemirror/view'
import { applyI18n, onLangChange, t } from '../i18n'
import { icon } from '../ui/icons'
import { keepScroll } from './focus'

/**
 * 文档内查找 / 替换面板（换掉 @codemirror/search 的默认那一版）。
 *
 * 默认面板的三个毛病，正好是这里要解决的三件事：
 *   ① **贴在编辑区底部通栏**：一按 ⌘F，底部悬浮格式栏就得整体抬高让位，
 *      正文也被顶上去 —— 改成右上角的浮层之后，两者井水不犯河水，
 *      而且查找框离正在读的那几行更近（Safari / VS Code 都是这个位置）。
 *   ② **查找框只认 change / keyup**：输入法组字期间的中间态会被当成查询提交，
 *      中文边打边搜整条都在闪。这里接 `input` + 组字期间不提交。
 *   ③ **一排复选框 + 文字按钮**：跟 P3-2 跨文件搜索那块地方长得完全不像。
 *      现在两边共用 `.fs-box` / `.fs-opts` 那套（放大镜 + Aa / ab| / .*），
 *      「在本文找」和「在文件夹里找」终于是一对兄弟。
 *
 * 替换那一行默认收着（⌥⌘R 或左边的三角展开），状态记在 localStorage：
 * 十次查找里有九次不替换，没必要一直占两行。
 */

const REPLACE_KEY = 'cursive.searchReplace'

/** 展开过替换就记住（隐私模式 / 存储被禁时就当没记过） */
function loadReplacePref(): boolean {
  try {
    return localStorage.getItem(REPLACE_KEY) === '1'
  } catch {
    return false
  }
}
function saveReplacePref(on: boolean): void {
  try {
    localStorage.setItem(REPLACE_KEY, on ? '1' : '0')
  } catch {
    /* 存不下就算了，本次会话内照样生效 */
  }
}

let showReplace = loadReplacePref()

/** 当前挂着的那一份面板。一个渲染进程一个编辑器（多窗口 = 多个进程），够用 */
let current: CursiveSearchPanel | null = null

export interface SearchStat {
  /** 压根没输入查询 */
  empty: boolean
  /** 正则写错了 */
  invalid: boolean
  /** 命中总数；到顶就停在 CAP（capped=true），别为一个 `.` 把整篇数一遍 */
  total: number
  /** 光标之后第一处命中的序号（1 起）；光标已经在最后一处之后则是 0 */
  index: number
  capped: boolean
}

const CAP = 5000
const EMPTY: SearchStat = { empty: true, invalid: false, total: 0, index: 0, capped: false }

let statFor: EditorState | null = null
let statValue: SearchStat = EMPTY
let matchesFor: { doc: EditorState['doc']; query: SearchQuery; wordChars: string; starts: number[] } | null = null

/**
 * 「第几处 / 共几处」。面板和状态栏都要，所以**算在一处**：
 * 同一次 update 共用结果；选区变化只在已缓存的命中位置里查序号。
 * 正文、查询或整词规则变化才重扫，避免长文档每按一次方向键都扫描全文。
 */
export function searchStat(state: EditorState): SearchStat {
  if (statFor === state) return statValue
  statFor = state
  const q = getSearchQuery(state)
  if (!q.search) return (statValue = EMPTY)
  if (!q.valid) return (statValue = { ...EMPTY, empty: false, invalid: true })

  // 整词规则由光标所在语言决定：进入代码块后可能与正文不同。
  const wordChars = q.wholeWord ? state.languageDataAt<string>('wordChars', state.selection.main.head)[0] ?? '' : ''
  // 自定义匹配器可以读取整个 state，不能复用其他选区下的结果。
  if (matchesFor?.doc !== state.doc || matchesFor.query !== q || matchesFor.wordChars !== wordChars || q.test) {
    const starts: number[] = []
    try {
      const cursor = q.getCursor(state)
      for (let r = cursor.next(); !r.done; r = cursor.next()) {
        starts.push(r.value.from)
        if (starts.length >= CAP) break
      }
    } catch {
      return (statValue = { ...EMPTY, empty: false, invalid: true })
    }
    matchesFor = { doc: state.doc, query: q, wordChars, starts }
  }
  const { starts } = matchesFor
  const total = starts.length
  const head = state.selection.main.from
  let lo = 0
  let hi = total
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (starts[mid]! < head) lo = mid + 1
    else hi = mid
  }
  return (statValue = { empty: false, invalid: false, total, index: lo < total ? lo + 1 : 0, capped: total >= CAP })
}

/** ⌥⌘R：开面板并把替换那一行摊开（面板已经开着也照样摊开） */
export function openReplace(view: EditorView): void {
  showReplace = true
  saveReplacePref(true)
  openSearchPanel(view)
  current?.setReplace(true)
  current?.focusReplace()
}

interface Opts {
  case: boolean
  word: boolean
  re: boolean
}

class CursiveSearchPanel implements Panel {
  readonly dom: HTMLElement
  private readonly input: HTMLInputElement
  private readonly replaceInput: HTMLInputElement
  private readonly box: HTMLElement
  private readonly countEl: HTMLElement
  private readonly replaceRow: HTMLElement
  private readonly foldBtn: HTMLButtonElement
  private query: SearchQuery
  private opts: Opts
  private composing = false

  constructor(private readonly view: EditorView) {
    this.query = getSearchQuery(view.state)
    this.opts = {
      case: this.query.caseSensitive,
      word: this.query.wholeWord,
      re: this.query.regexp
    }

    this.dom = document.createElement('div')
    this.dom.className = 'cs-panel'
    this.dom.setAttribute('role', 'search')
    this.dom.setAttribute('aria-label', t('sp.title'))
    // 根元素自己的 data-i18n-* 要靠全局那次 applyI18n() 来翻 ——
    // `applyI18n(root)` 走的是 querySelectorAll，选不中 root 本身
    this.dom.setAttribute('data-i18n-aria', 'sp.title')
    this.dom.innerHTML = `
      <div class="cs-row">
        <button type="button" class="cs-fold" name="fold" aria-expanded="false"
                aria-label="${t('sp.showReplace')}"
                title="${t('sp.replaceTitle')}" data-i18n-title="sp.replaceTitle">${icon('chevron')}</button>
        <div class="fs-box cs-box">
          <span class="fs-icon">${icon('search')}</span>
          <input class="fs-input" name="search" main-field="true" placeholder="${t('sp.find')}"
                 aria-label="${t('sp.find')}" data-i18n-ph="sp.find" data-i18n-aria="sp.find"
                 autocomplete="off" spellcheck="false" />
          <span class="cs-count" aria-live="polite"></span>
        </div>
        <div class="fs-opts" role="group" aria-label="${t('sp.findOpts')}" data-i18n-aria="sp.findOpts">
          <button type="button" data-opt="case" title="${t('fs.case')}" data-i18n-title="fs.case">Aa</button>
          <button type="button" data-opt="word" title="${t('fs.word')}" data-i18n-title="fs.word">ab|</button>
          <button type="button" data-opt="re" title="${t('fs.regex')}" data-i18n-title="fs.regex">.*</button>
        </div>
        <div class="cs-nav">
          <button type="button" name="prev" aria-label="${t('sp.prev')}" data-i18n-aria="sp.prev"
                  title="${t('sp.prevTitle')}" data-i18n-title="sp.prevTitle">${icon('chevron-up')}</button>
          <button type="button" name="next" aria-label="${t('sp.next')}" data-i18n-aria="sp.next"
                  title="${t('sp.nextTitle')}" data-i18n-title="sp.nextTitle">${icon('chevron-down')}</button>
          <button type="button" name="select" class="cs-text" title="${t('sp.selectAllTitle')}"
                  data-i18n-title="sp.selectAllTitle" data-i18n="sp.selectAll">${t('sp.selectAll')}</button>
          <button type="button" name="close" aria-label="${t('sp.close')}" data-i18n-aria="sp.close"
                  title="${t('sp.closeTitle')}" data-i18n-title="sp.closeTitle">${icon('close')}</button>
        </div>
      </div>
      <div class="cs-row cs-replace" hidden>
        <div class="fs-box cs-box">
          <input class="fs-input" name="replace" placeholder="${t('sp.replace')}"
                 aria-label="${t('sp.replace')}" data-i18n-ph="sp.replace" data-i18n-aria="sp.replace"
                 autocomplete="off" spellcheck="false" />
        </div>
        <button type="button" name="replace" class="cs-text" data-i18n="sp.replaceBtn">${t('sp.replaceBtn')}</button>
        <button type="button" name="replaceAll" class="cs-text" data-i18n="sp.replaceAll">${t('sp.replaceAll')}</button>
      </div>
    `
    applyI18n(this.dom)
    this.input = this.dom.querySelector('input[name="search"]')!
    this.replaceInput = this.dom.querySelector('input[name="replace"]')!
    this.box = this.dom.querySelector('.cs-box')!
    this.countEl = this.dom.querySelector('.cs-count')!
    this.replaceRow = this.dom.querySelector('.cs-replace')!
    this.foldBtn = this.dom.querySelector('.cs-fold')!

    this.input.value = this.query.search
    this.replaceInput.value = this.query.replace
    this.paintOpts()
    this.setReplace(showReplace)

    for (const input of [this.input, this.replaceInput]) {
      // 输入法组字期间不提交：拼音的中间态当查询用，整条面板会跟着闪
      input.addEventListener('compositionstart', () => {
        this.composing = true
      })
      input.addEventListener('compositionend', () => {
        this.composing = false
        this.commit()
      })
      input.addEventListener('input', (e) => {
        if (this.composing || (e as InputEvent).isComposing) return
        this.commit()
      })
    }

    this.dom.addEventListener('keydown', (e) => this.keydown(e))
    // 按钮一律不抢焦点：点完「下一个」还要接着在查找框里打字
    this.dom.addEventListener('mousedown', (e) => {
      if ((e.target as Element).closest('button')) e.preventDefault()
    })
    this.dom.addEventListener('click', (e) => this.click(e))
  }

  /** 面板贴编辑区顶部（浮在右上角，见 base.css） */
  get top(): boolean {
    return true
  }

  mount(): void {
    current = this
    this.input.select()
    this.paintCount()
  }

  destroy(): void {
    if (current === this) current = null
  }

  update(u: ViewUpdate): void {
    for (const tr of u.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) this.setQuery(effect.value)
      }
    }
    this.paintCount()
  }

  setReplace(on: boolean): void {
    this.replaceRow.hidden = !on
    this.foldBtn.classList.toggle('is-on', on)
    this.foldBtn.setAttribute('aria-expanded', String(on))
    this.foldBtn.setAttribute('aria-label', on ? t('sp.hideReplace') : t('sp.showReplace'))
  }

  /** 切语言：面板里按状态拼出来的那几句（展开/收起替换）重说一遍 */
  relabel(): void {
    this.setReplace(!this.replaceRow.hidden)
    this.paintCount()
  }

  focusReplace(): void {
    this.replaceInput.focus()
    this.replaceInput.select()
  }

  private click(e: Event): void {
    const btn = (e.target as Element).closest<HTMLElement>('button')
    if (!btn) return
    const opt = btn.dataset['opt'] as keyof Opts | undefined
    if (opt) {
      this.opts = { ...this.opts, [opt]: !this.opts[opt] }
      this.paintOpts()
      this.commit()
      this.input.focus()
      return
    }
    switch (btn.getAttribute('name')) {
      case 'prev':
        findPrevious(this.view)
        break
      case 'next':
        findNext(this.view)
        break
      case 'select':
        selectMatches(this.view)
        break
      case 'replace':
        replaceNext(this.view)
        break
      case 'replaceAll':
        replaceAll(this.view)
        break
      case 'close':
        this.close()
        break
      case 'fold': {
        const on = this.replaceRow.hidden
        this.setReplace(on)
        saveReplacePref((showReplace = on))
        if (on) this.focusReplace()
        else this.input.focus()
        break
      }
    }
  }

  private keydown(e: KeyboardEvent): void {
    // Esc 自己接：searchKeymap 那条也是关面板，但它走的 closeSearchPanel 里那句
    // view.focus() 会把画面滚到旧 DOM 选区上（焦点正在查找框里，见 editor/focus.ts）
    if (e.key === 'Escape') {
      e.preventDefault()
      this.close()
      return
    }
    // searchKeymap 里 scope 带 search-panel 的其余几条（⌘G 下一个…）
    if (runScopeHandlers(this.view, e, 'search-panel')) {
      e.preventDefault()
      return
    }
    if (e.key !== 'Enter' || e.isComposing) return
    e.preventDefault()
    if (e.target === this.replaceInput) replaceNext(this.view)
    else if (e.shiftKey) findPrevious(this.view)
    else findNext(this.view)
  }

  /** 关面板 = 焦点回编辑器，但视口留在原地 */
  private close(): void {
    keepScroll(this.view, () => closeSearchPanel(this.view))
  }

  private commit(): void {
    const query = new SearchQuery({
      search: this.input.value,
      replace: this.replaceInput.value,
      caseSensitive: this.opts.case,
      wholeWord: this.opts.word,
      regexp: this.opts.re
    })
    if (query.eq(this.query)) return
    this.query = query
    this.view.dispatch({ effects: setSearchQuery.of(query) })
  }

  /** 外部改了查询（⌘F 重开时按选区重新填、或别处 dispatch 了 setSearchQuery） */
  private setQuery(query: SearchQuery): void {
    this.query = query
    this.input.value = query.search
    this.replaceInput.value = query.replace
    this.opts = { case: query.caseSensitive, word: query.wholeWord, re: query.regexp }
    this.paintOpts()
  }

  private paintOpts(): void {
    for (const btn of this.dom.querySelectorAll<HTMLElement>('.fs-opts button')) {
      btn.classList.toggle('is-on', this.opts[btn.dataset['opt'] as keyof Opts])
      btn.setAttribute('aria-pressed', String(this.opts[btn.dataset['opt'] as keyof Opts]))
    }
  }

  private paintCount(): void {
    const stat = searchStat(this.view.state)
    this.countEl.textContent = stat.empty
      ? ''
      : stat.invalid
        ? t('status.regexInvalid')
        : stat.total === 0
          ? t('status.noMatch')
          : `${stat.index || stat.total}/${stat.total}${stat.capped ? '+' : ''}`
    // 找不到就把框子染一下：光看小字容易没注意到
    this.box.classList.toggle('is-empty', !stat.empty && (stat.invalid || stat.total === 0))
  }
}

// 面板是 CodeMirror 建的、也归它销毁，拿不到组件那种「构造时订阅」的位置；
// 订阅挂在模块上，开着的那一份跟着换语言，没开就是空操作
onLangChange(() => current?.relabel())

export function cursiveSearchPanel(view: EditorView): Panel {
  return new CursiveSearchPanel(view)
}
