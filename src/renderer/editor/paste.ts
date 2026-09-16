import { EditorSelection, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type TurndownService from 'turndown'
import { configureTurndown } from './paste-rules'
import { destLiteral } from './link'
import { docDir } from './live-preview'

/**
 * P2-4 智能粘贴。
 *
 * - 粘贴 HTML（网页 / 飞书 / Notion）→ turndown 转 Markdown
 * - 选中文字后粘贴一个 URL → 包成 `[文字](url)`
 * - ⇧⌥⌘V → 始终纯文本
 *
 * 转换结果的强调符统一成 `*` / `**`（与 fmt.ts 的格式化命令一致）；
 * turndown 默认丢掉的那一批（表格 / 任务项 / 删除线 / `==高亮==` / 上下标）
 * 由 `paste-rules.ts` 的 `configureTurndown` 补齐。
 */

let turndownPromise: Promise<TurndownService> | null = null

/**
 * P4-6②：turndown 只在「粘贴一段 HTML」时才用得上，从静态 import 改成动态 ——
 * 首屏不背它。第一次粘贴多花一次 chunk 加载（本地文件，毫秒级），之后一直在手。
 */
function loadTurndown(): Promise<TurndownService> {
  turndownPromise ??= import('turndown').then((m) => {
    const td = new m.default({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      emDelimiter: '*',
      strongDelimiter: '**'
    })
    configureTurndown(td)
    return td
  })
  return turndownPromise
}

const URL_RE = /^https?:\/\/\S+$/i

/**
 * 决定粘什么：HTML 能转出与纯文本**不同**的 Markdown 才用转换结果。
 * 从本编辑器复制的富文本，plain 已是 Markdown、html 是渲染结果，
 * 转一圈会等于 plain —— 这种情况直接用纯文本，避免无谓往返与损失。
 * convert 注入是为了在 node 测试里不依赖 DOM。
 */
export function choosePasteContent(
  plain: string,
  html: string | null,
  convert: (html: string) => string
): { text: string; converted: boolean } {
  const p = plain ?? ''
  if (!html) return { text: p, converted: false }
  let md: string
  try {
    md = convert(html)
  } catch {
    return { text: p, converted: false }
  }
  if (md.trim() === p.trim()) return { text: p, converted: false }
  return { text: md, converted: true }
}

export function insertText(view: EditorView, text: string): void {
  const ranges = view.state.selection.ranges
  const changes = ranges.map((r) => ({ from: r.from, to: r.to, insert: text }))
  const sel = ranges.map((r) => EditorSelection.cursor(r.from + text.length))
  view.dispatch({
    changes,
    selection: EditorSelection.create(sel, view.state.selection.mainIndex),
    userEvent: 'input.paste'
  })
}

/** 把选区/词包成链接（选中文字 + 粘 URL 时用） */
function wrapSelectionAsLink(view: EditorView, url: string): void {
  const r = view.state.selection.main
  const label = view.state.doc.sliceString(r.from, r.to)
  const text = `[${label}](${url})`
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: text },
    selection: EditorSelection.cursor(r.from + text.length),
    userEvent: 'input.paste'
  })
}

/** P2-5：剪贴板里是图片 → 让壳落盘到 <docDir>/assets/，只插一条相对链接 */
async function pasteClipboardImage(view: EditorView): Promise<void> {
  const dir = view.state.facet(docDir)
  const res = await window.api.pasteImage(dir)
  if (!res) return
  const alt = res.relPath.replace(/^assets\//, '').replace(/\.[^.]+$/, '')
  // 带空格的文件名括进 <…>（见 link.ts 的 destLiteral）：写出去的链接要在别处也成立
  insertText(view, `![${alt}](${destLiteral(res.relPath)})`)
}

export function smartPaste(): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const dt = event.clipboardData
      if (!dt) return false
      // 剪贴板里是图片（截图）→ 落盘插链接（判断 3：数据由壳从 NSPasteboard 取）
      const items = Array.from(dt.items ?? [])
      if (items.some((i) => i.kind === 'file' && i.type.startsWith('image/'))) {
        event.preventDefault()
        void pasteClipboardImage(view)
        return true
      }

      const plain = dt.getData('text/plain')
      const html = dt.getData('text/html') || null

      const sel = view.state.selection.main
      // 选中文字 + 粘贴的是一整个 URL → 包成链接
      if (!sel.empty && URL_RE.test(plain.trim())) {
        event.preventDefault()
        wrapSelectionAsLink(view, plain.trim())
        return true
      }

      // 没有 HTML（纯文本复制）→ 交给 CodeMirror 默认处理
      if (!html) return false

      // 这里已经决定自己接管（要么插转换结果、要么插纯文本），所以先 preventDefault，
      // 再等 turndown 到手 —— 事件处理器不能是异步的，但插入可以晚一拍
      event.preventDefault()
      void loadTurndown().then((td) => {
        const { text } = choosePasteContent(plain, html, (h) => td.turndown(h))
        insertText(view, text)
      })
      return true
    }
  })
}
