import type { EditorState } from '@codemirror/state'
import { count, group, readLabel, shape, type Counts, type Shape } from '../../shared/wordcount'
import { t } from '../i18n'
import { icon } from './icons'

export interface Stat extends Counts, Shape {}

export function measure(text: string): Stat {
  return { ...count(text), ...shape(text) }
}

/** 状态栏「行 12 · 列 8」。列按**码点**数，emoji 占一列而不是两列 */
export function cursorLabel(state: EditorState): string {
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  const col = [...line.text.slice(0, head - line.from)].length + 1
  return t('st.cursor', { line: line.number, col })
}

/**
 * 选中的文字；没有非空选区时返回 null。
 *
 * 多光标按各段**用换行接起来**再统计 —— 段落数会因此比「各段分别统计再相加」多算，
 * 但多光标下本来就没有一个「对」的段落口径，接起来至少让词数/字符数是准的。
 *
 * 判「非空」用的是 `r.from < r.to` 而**不是** `!r.empty`：一次把选区整段吞掉的改写
 * （整理表格 / 大纲搬节 / 覆盖粘贴）之后，CM 的 `SelectionRange.map` 拿 assoc=+1 算
 * from、assoc=−1 算 to 且不再归一化，留下的是 `from > to` 的倒挂区间 —— `empty` 为
 * false，`sliceDoc` 却是空串，状态栏于是挂出「已选 0 词 · 0 字符」。
 * 倒挂就是「其实没选中什么」，按没有选区处理。
 */
export function selectedText(state: EditorState): string | null {
  const parts: string[] = []
  for (const r of state.selection.ranges) if (r.from < r.to) parts.push(state.sliceDoc(r.from, r.to))
  return parts.length ? parts.join('\n') : null
}

export interface StatRow {
  label: string
  all: string
  /** 没有选区时是空串（那一列整列不渲染） */
  sel: string
}

/** 面板表格的行。纯函数，单测不用起浏览器 */
export function statRows(all: Stat, sel: Stat | null): StatRow[] {
  const row = (label: string, pick: (s: Stat) => number): StatRow => ({
    label,
    all: group(pick(all)),
    sel: sel ? group(pick(sel)) : ''
  })
  return [
    row(t('st.words'), (s) => s.words),
    row(t('st.chars'), (s) => s.chars),
    row(t('st.charsNoSpace'), (s) => s.charsNoSpace),
    row(t('st.cjk'), (s) => s.cjk),
    row(t('st.latin'), (s) => s.latin),
    row(t('st.paragraphs'), (s) => s.paragraphs),
    row(t('st.lines'), (s) => s.lines),
    {
      label: t('st.readTime'),
      all: readLabel(all) || t('wc.lessThan1m'),
      sel: sel ? readLabel(sel) || t('wc.lessThan1m') : ''
    }
  ]
}

/**
 * P3-8 详细统计面板。贴着状态栏那枚字数条的上方弹出。
 *
 * **不是模态**：写作时想边看边改，盖一层遮罩就得先关掉才能动文档。因此也**不抢焦点** ——
 * 触发那颗条子在 `mousedown` 里 `preventDefault`（同 P2-8 格式栏的坑 ①），
 * 光标和选区都留在编辑器里，面板里的「选中」一列才有东西可显示。
 * 代价是 Escape 收不到 —— 于是和 `ui/menu.ts` 一样在 window 上捕获。
 */
export class StatsPanel {
  private el: HTMLElement | null = null
  private cleanup: (() => void) | null = null

  get open(): boolean {
    return this.el !== null
  }

  toggle(anchor: HTMLElement, data: () => [Stat, Stat | null]): void {
    if (this.open) this.close()
    else this.show(anchor, data)
  }

  show(anchor: HTMLElement, data: () => [Stat, Stat | null]): void {
    this.close()
    const el = document.createElement('div')
    el.id = 'stats'
    el.setAttribute('role', 'dialog')
    document.body.appendChild(el)
    this.el = el
    this.render(...data())

    // 贴着触发条的右沿、压在状态栏上方。窗口窄到装不下就往左顶回来
    const box = anchor.getBoundingClientRect()
    el.style.right = `${Math.max(8, window.innerWidth - box.right)}px`
    el.style.bottom = `${window.innerHeight - box.top + 6}px`

    const dismiss = (ev?: Event): void => {
      const t = ev?.target as Node | undefined
      if (t && (el.contains(t) || anchor.contains(t))) return
      this.close()
    }
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.stopPropagation()
        this.close()
      }
    }
    // 捕获阶段：编辑器自己也吃 mousedown / Escape，等冒泡就晚了
    window.addEventListener('mousedown', dismiss, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', dismiss)
    this.cleanup = () => {
      window.removeEventListener('mousedown', dismiss, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', dismiss)
    }
  }

  close(): void {
    this.el?.remove()
    this.el = null
    this.cleanup?.()
    this.cleanup = null
  }

  /** 开着的时候跟着文档/选区实时刷新（关着就是空操作） */
  render(all: Stat, sel: Stat | null): void {
    const el = this.el
    if (!el) return
    const rows = statRows(all, sel)
    // aria-label 放在 render 里而不是 show 里：切语言时 main.ts 重跑的是 render，
    // 搁在 show 里的话面板开着切语言，读屏念到的还是旧标题
    el.setAttribute('aria-label', t('st.title'))
    el.classList.toggle('has-sel', sel !== null)
    el.innerHTML = `
      <div class="st-head">
        <span class="st-title">${t('st.title')}</span>
        <button class="st-close" type="button" aria-label="${t('st.close')}">${icon('close')}</button>
      </div>
      <div class="st-grid">
        <span class="st-col"></span>
        <span class="st-col">${t('st.all')}</span>
        ${sel ? `<span class="st-col">${t('st.sel')}</span>` : ''}
        ${rows
          .map(
            (r) =>
              `<span class="st-label">${r.label}</span><span class="st-num">${r.all}</span>` +
              (sel ? `<span class="st-num st-sel">${r.sel}</span>` : '')
          )
          .join('')}
      </div>`
    el.querySelector('.st-close')!.addEventListener('click', () => this.close())
  }
}
