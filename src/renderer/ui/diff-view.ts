import { collapse, diffLines, diffStat, type DiffRow } from '../editor/diff'
import { t } from '../i18n'

/**
 * 差异那块版面（0.2.0 从版本历史里长出来，第八节 2 提出来共用）。
 *
 * 版本历史与外部修改冲突问的是同一个问题 ——「这两份差在哪儿」—— 所以它们用的是
 * **同一份标记、同一套 `.hi-*` 样式**：一份差异在这个应用里只有一个长相。
 * 两处的区别只在「老的那份是谁」：历史里是某个快照，冲突里是磁盘上此刻那一份。
 */

export interface DiffView {
  added: number
  removed: number
  /** 差异的 HTML。两份一模一样时是空串（调用方据此摆自己的空态文案） */
  html: string
}

export function diffView(oldText: string, newText: string): DiffView {
  const rows = diffLines(oldText, newText)
  const stat = diffStat(rows)
  if (stat.added + stat.removed === 0) return { ...stat, html: '' }
  const chunks = collapse(rows)
  return {
    ...stat,
    html:
      `<div class="hi-stat">${escapeHtml(t('hi.stat', { added: stat.added, removed: stat.removed }))}</div>` +
      chunks
        .map((c) =>
          c.skipped
            ? `<div class="hi-skip">${escapeHtml(t('hi.skipped', { n: c.skipped }))}</div>`
            : c.rows.map(line).join('')
        )
        .join('')
  }
}

const SIGN: Record<DiffRow['kind'], string> = { same: ' ', add: '+', del: '−' }

function line(r: DiffRow): string {
  // 空行也要占一行高，否则连续空行处的差异会挤成一条
  const text = r.text === '' ? '&nbsp;' : escapeHtml(r.text)
  return (
    `<div class="hi-line is-${r.kind}">` +
    `<span class="hi-no">${r.oldLine ?? ''}</span>` +
    `<span class="hi-no">${r.newLine ?? ''}</span>` +
    `<span class="hi-sign">${SIGN[r.kind]}</span>` +
    `<span class="hi-text">${text}</span></div>`
  )
}

/** 这里拼的是 innerHTML，而内容是**用户的文档正文** —— 一个字都不能原样放进去 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
