import { syntaxTree } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import type { EditorState, Text, TransactionSpec } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { getLang, onLangChange, t, type Key } from '../../i18n'
import { icon } from '../../ui/icons'
import { focusKeepScroll } from '../focus'
import { resolveCodeLang } from '../markdown-lang'
import { copyText } from './widgets'

/**
 * 围栏代码块：把 ``` 藏起来 + 顶部语言条。
 *
 * 为什么围栏能藏了：以前的说法是「藏了会剩个空行更难看」—— 那是把围栏行当成
 * **空行**处理的结论。这里换了个做法：开围栏那一行整行换成一条**语言条**
 * （语言名 + 复制），它自己就是卡片的上沿；闭围栏那一行留着但压成几像素高，
 * 正好当卡片的下边距。于是「行还在、源码不见了」，光标还能回去改。
 *
 * 回显粒度是**每条围栏行各算各的**（不是整块）：光标在代码体里敲字时围栏保持
 * 藏着（卡片不会一边打字一边抽动），只有光标真落在围栏那一行才回显 ``` 源码。
 * 这比整块 reveal 更贴所见即所得，也让复制按钮在写代码时一直够得着。
 */

/** 语言名在文档里怎么写（```ts 的 ts），以及给人看的名字（TypeScript） */
export interface Fence {
  /** 围栏行上的第一个词；没写语言就是空串 */
  lang: string
  /** 语言串在文档里的位置。没写语言时是围栏号后面的一个零长度插入点 */
  langFrom: number
  langTo: number
  /** 开围栏：from 是 ``` 的起点（**不是行首** —— 列表/引用里前面还有缩进） */
  openFrom: number
  openTo: number
  /** 闭围栏那一行；没闭合就是 null */
  closeFrom: number | null
  closeTo: number | null
  /** 代码体（去掉围栏行、去掉引用块的 `>` 前缀），空块是空串 */
  body: string
}

/**
 * 从 FencedCode 节点上拆出围栏的各个部件。
 *
 * **走子节点而不是正则切文本**：引用块里的代码块长这样
 * `> ```js` / `> const b = 2` / `> ``` `，行首那截 `> ` 是 QuoteMark 兄弟节点，
 * 按行首正则匹配闭围栏会直接漏掉；缩进在列表里的代码块同理。
 * 子节点结构在嵌套语言加载后依然成立（CodeMark / CodeInfo / CodeText / CodeMark）。
 */
export function fenceParts(doc: Text, node: SyntaxNode): Fence | null {
  const open = node.firstChild
  if (!open || open.name !== 'CodeMark') return null

  let info: SyntaxNode | null = null
  const texts: string[] = []
  let close: SyntaxNode | null = null
  for (let c = open.nextSibling; c; c = c.nextSibling) {
    if (c.name === 'CodeInfo' && !info) info = c
    else if (c.name === 'CodeText') texts.push(doc.sliceString(c.from, c.to))
    else if (c.name === 'CodeMark') close = c
  }

  let lang = ''
  let langFrom = open.to
  let langTo = open.to
  if (info) {
    // 围栏行上可能还有别的参数（```js title=a.js），只认第一个词、其余原样留着
    const first = /^\s*\S*/.exec(doc.sliceString(info.from, info.to))?.[0] ?? ''
    lang = first.trim()
    langFrom = info.from
    langTo = info.from + first.length
  }

  return {
    lang,
    langFrom,
    langTo,
    openFrom: open.from,
    openTo: doc.lineAt(open.from).to,
    closeFrom: close ? close.from : null,
    closeTo: close ? doc.lineAt(close.from).to : null,
    body: texts.join('\n').replace(/\n+$/, '')
  }
}

/** 光标落在 pos 处时所在的围栏块；不在代码块里返回 null */
export function fenceNodeAt(state: EditorState, pos: number): SyntaxNode | null {
  const tree = syntaxTree(state)
  for (const start of [pos, pos + 1]) {
    for (let n: SyntaxNode | null = tree.resolveInner(start, 1); n; n = n.parent) {
      if (n.name === 'FencedCode') return n
    }
  }
  return null
}

/**
 * 改写某个代码块的语言 = 一次 dispatch（一步撤销白拿）。
 * 纯函数：单测不碰 DOM 就能断言「只动语言那几个字符」。
 */
export function fenceLangSpec(
  state: EditorState,
  pos: number,
  lang: string
): TransactionSpec | null {
  const node = fenceNodeAt(state, pos)
  const fence = node ? fenceParts(state.doc, node) : null
  if (!fence) return null
  if (fence.lang === lang) return null
  return { changes: { from: fence.langFrom, to: fence.langTo, insert: lang } }
}

// ---------- 语言名 ----------

const labelCache = new Map<string, string>()

/** 自家渲染但 language-data 里没有的「语言」：写在围栏上同样是合法用法 */
const EXTRA: { key: Key; write: string }[] = [{ key: 'cd.mermaid', write: 'mermaid' }]

/**
 * `ts` → `TypeScript`。认不出来的**原样显示** —— 挑解析器用的是同一个
 * `resolveCodeLang`，所以条子上写什么 = 这块真的会按什么上色，不会自相矛盾
 * （显示 `conf` 就是在说「这块没有语法高亮」）。
 */
export function langLabel(lang: string): string {
  // 缓存键带上当前界面语言：切语言后同一条子要跟着换名字
  const ck = `${getLang()}/${lang}`
  if (!lang) return t('cd.plain')
  let label = labelCache.get(ck)
  if (label === undefined) {
    const extra = EXTRA.find((e) => e.write === lang.toLowerCase())
    label = (extra ? t(extra.key) : undefined) ?? resolveCodeLang(lang)?.name ?? lang
    labelCache.set(ck, label)
  }
  return label
}

export interface LangOption {
  /** 给人看的名字 */
  name: string
  /** 写进围栏行的那个词 */
  write: string
  /** 筛选用：名字 + 全部别名，小写 */
  keys: string
}

let optionCache: LangOption[] | null = null
// 语言切换后候选名单里的「纯文本」等名字要重算
onLangChange(() => {
  optionCache = null
})

/**
 * 选择器里的候选项。**只列真的会上色的语言**（language-data 那一份）——
 * 列一堆点了没反应的名字，比不给选择器更糟。
 */
export function langOptions(): LangOption[] {
  optionCache ??= [
    { name: t('cd.plain'), write: '', keys: `${t('cd.plain')} plain text` },
    ...EXTRA.map((e) => ({ name: t(e.key), write: e.write, keys: `${t(e.key)} ${e.write}`.toLowerCase() })),
    ...languages
      .map((desc) => ({
        name: desc.name,
        write: desc.alias[0] ?? desc.name.toLowerCase(),
        keys: [desc.name, ...desc.alias].join(' ').toLowerCase()
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  ]
  return optionCache
}

// ---------- 语言条 ----------

/**
 * 代码块顶部的语言条：**整条替换掉开围栏那一行**（``` 连语言一起藏），
 * 左边是语言名（点开选择器），右边是复制。
 *
 * 刻意**不把代码正文存进 widget**：存了的话块里每敲一个字 `eq()` 就不成立，
 * 整条 DOM 重建一遍（「已复制」提示会被冲掉、还白闪）。要用的时候按
 * `posAtDOM` 现查语法树 —— 位置会漂移，现查才是对的那一份（同脚注角标）。
 */
export class CodeHeadWidget extends WidgetType {
  constructor(
    readonly lang: string,
    /** 围栏行上语言之后剩下的参数，只进 tooltip */
    readonly rest: string
  ) {
    super()
  }

  eq(other: CodeHeadWidget): boolean {
    return other.lang === this.lang && other.rest === this.rest
  }

  toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement('span')
    bar.className = 'cm-lp-codebar'
    bar.innerHTML = codeBarHTML(this.lang)
    const langBtn = bar.querySelector<HTMLButtonElement>('.cm-lp-codebar-lang')!
    const copyBtn = bar.querySelector<HTMLButtonElement>('.cm-lp-codebar-copy')!
    langBtn.title = this.rest
      ? t('cd.changeHint', { spec: `${this.lang}${this.rest}` })
      : t('cd.changeHintFull')
    copyBtn.title = t('cd.copyCode')

    // 焦点必须留在编辑器里：跑到按钮上选区就没了（同格式栏）
    bar.addEventListener('mousedown', (e) => e.preventDefault())

    langBtn.addEventListener('click', () => {
      const pos = view.posAtDOM(bar)
      openLangPicker(
        langBtn,
        this.lang,
        (write) => {
          const spec = fenceLangSpec(view.state, pos, write)
          if (spec) view.dispatch(spec)
          // 焦点这会儿在选择器的筛选框里，直接 focus() 会连画面一起滚走
          focusKeepScroll(view)
        },
        // Esc 取消：焦点得回编辑器，否则下一次按键落到 body 上没人接
        () => focusKeepScroll(view)
      )
    })

    copyBtn.addEventListener('click', () => {
      const node = fenceNodeAt(view.state, view.posAtDOM(bar))
      const fence = node ? fenceParts(view.state.doc, node) : null
      if (!fence) return
      copyText(fence.body)
      copyBtn.textContent = t('cd.copied')
      setTimeout(() => {
        copyBtn.textContent = t('cd.copy')
      }, 1200)
    })
    return bar
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
}

/**
 * 语言条那两颗按钮的 HTML。**拆成纯函数是为了能单测转义** ——
 * `langLabel` 认不出来的语言原样返回围栏行上那个词，那是**文档内容**，而这里是 innerHTML：
 * 漏一处 `esc` 的话 ```` ```x"onfocus="…" ```` 就能从属性值里挣出去自己再添几个属性
 * （HTML 解析器读完带引号的属性值后遇到非空白，会直接开始读下一个属性名，不需要空格）。
 * 页面 CSP 没有 `'unsafe-inline'`，注进去的事件处理器跑不起来 —— 但别拿 CSP 当唯一一道闸。
 */
export function codeBarHTML(lang: string): string {
  const name = langLabel(lang)
  return `
      <button type="button" class="cm-lp-codebar-lang" aria-haspopup="listbox"
              aria-label="${esc(t('cd.langAria', { name }))}">
        <span>${esc(name)}</span>${icon('chevron-down')}
      </button>
      <button type="button" class="cm-lp-codebar-copy" aria-label="${esc(t('cd.copyCode'))}">${esc(t('cd.copy'))}</button>
    `
}

// ---------- 语言选择器 ----------

let picker: HTMLElement | null = null
let closePicker: (() => void) | null = null

export function closeLangPicker(): void {
  picker?.remove()
  picker = null
  closePicker?.()
  closePicker = null
}

/**
 * 语言选择器：筛选框 + 列表。挂 body 上（编辑器自己会裁剪），
 * 视觉沿用右键菜单那套圆角毛玻璃 —— 同一个应用里只该有一种浮层长相。
 */
export function openLangPicker(
  anchor: HTMLElement,
  current: string,
  onPick: (write: string) => void,
  onCancel?: () => void
): void {
  closeLangPicker()
  const all = langOptions()
  const box = document.createElement('div')
  box.className = 'ctx-menu lang-pick'
  box.innerHTML = `
    <input class="lang-filter" type="text" placeholder="${t('cd.filter')}" aria-label="${t('cd.filter')}"
           autocomplete="off" spellcheck="false" />
    <div class="lang-list" role="listbox"></div>
  `
  const filter = box.querySelector<HTMLInputElement>('.lang-filter')!
  const list = box.querySelector<HTMLElement>('.lang-list')!
  document.body.appendChild(box)
  picker = box

  let shown: LangOption[] = []
  let active = 0

  const render = (): void => {
    const q = filter.value.trim().toLowerCase()
    shown = q ? all.filter((o) => o.keys.includes(q)) : all
    active = Math.max(
      0,
      shown.findIndex((o) => o.write === current)
    )
    list.innerHTML = shown.length
      ? shown
          .map(
            (o, i) =>
              `<button type="button" role="option" class="ctx-item lang-item" data-i="${i}">` +
              `<span class="lang-name">${esc(o.name)}</span>` +
              `<span class="lang-write">${esc(o.write)}</span></button>`
          )
          .join('')
      : '<div class="lang-empty">' + t('cd.noMatch') + '</div>'
    paint()
  }

  const paint = (): void => {
    const items = list.querySelectorAll<HTMLElement>('.lang-item')
    items.forEach((el, i) => el.classList.toggle('is-active', i === active))
    items[active]?.scrollIntoView({ block: 'nearest' })
  }

  const pick = (i: number): void => {
    const opt = shown[i]
    if (!opt) return
    closeLangPicker()
    onPick(opt.write)
  }

  filter.addEventListener('input', render)
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      active = Math.min(shown.length - 1, Math.max(0, active + (e.key === 'ArrowDown' ? 1 : -1)))
      paint()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(active)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeLangPicker()
      onCancel?.()
    }
  })
  list.addEventListener('mousedown', (e) => e.preventDefault())
  list.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest<HTMLElement>('.lang-item')
    if (btn) pick(Number(btn.dataset['i']))
  })

  render()

  // 贴着窗口右下角弹出时要回折（同右键菜单）
  const a = anchor.getBoundingClientRect()
  const size = box.getBoundingClientRect()
  box.style.left = `${Math.max(4, Math.min(a.left, window.innerWidth - size.width - 8))}px`
  box.style.top =
    a.bottom + size.height + 8 < window.innerHeight
      ? `${a.bottom + 4}px`
      : `${Math.max(4, a.top - size.height - 4)}px`
  filter.focus()

  const dismiss = (ev: Event): void => {
    if (box.contains(ev.target as Node)) return
    closeLangPicker()
  }
  // 捕获阶段：编辑器自己也吃 mousedown，等冒泡就晚了
  window.addEventListener('mousedown', dismiss, true)
  window.addEventListener('blur', dismiss)
  closePicker = () => {
    window.removeEventListener('mousedown', dismiss, true)
    window.removeEventListener('blur', dismiss)
  }
}

// ---------- 纯文本版围栏解析（mermaid 用） ----------

/** 从 FencedCode 的源码文本里拆出语言与代码体（闭围栏存在则去掉） */
export function extractFence(text: string): { lang: string; src: string } | null {
  const nl = text.indexOf('\n')
  if (nl < 0) return null
  const open = /^(`{3,}|~{3,})[ \t]*(.*)$/.exec(text.slice(0, nl))
  if (!open) return null
  const lang = (open[2] ?? '').trim().split(/\s+/)[0] ?? ''
  const lines = text.slice(nl + 1).split('\n')
  const last = lines[lines.length - 1]
  if (last !== undefined && /^\s*(`{3,}|~{3,})\s*$/.test(last)) lines.pop()
  return { lang, src: lines.join('\n') }
}
