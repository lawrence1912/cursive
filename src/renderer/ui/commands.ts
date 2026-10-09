import { t, type Key } from '../i18n'
import type { MenuAction } from '../../shared/types'
import type { PaletteItem } from './palette'

/**
 * 0.2.0 命令面板的条目表。
 *
 * **一条命令在这里只是一个 `MenuAction`**，执行时原样交给 `handleMenu` ——
 * 与原生菜单、格式栏、快捷键走的是同一条路。面板因此不可能做出
 * 「菜单能做但面板做不了」或者反过来的事，也不用为它写任何编辑逻辑。
 *
 * 文案尽量复用：
 * - 格式类全部走格式栏那份 `fb.*`（它本来就是给人看的名字）；
 * - 主题四态走设置面板那份 `pf.theme.*`，右边一列标上「主题」当分类；
 * - 只有文件 / 编辑 / 视图这批在渲染层没有名字的，才新加 `cmd.*`。
 *
 * 快捷键那一列是**字面量**，不进字典 —— ⌘N 在中英文里都是 ⌘N。
 */

/**
 * ⌘A 落到哪儿（0.4.1）。
 *
 * **提成纯函数是为了不开窗口就能测** —— 同 `revealChain` / `edgeScroll` 那条路子：
 * 三条分支的判断全在这儿，`handleMenu` 那边只剩「照着做」，于是 `vitest` 里
 * 拿三个假元素就能把它们钉死，不必起 WKWebView。
 *
 * - `field`：壳自己的 `<input>/<textarea>`（搜索、重命名、设置…）—— 该全选那一行字；
 * - `island`：表格格子那座 contenteditable 孤岛。它**长在 CM 的 contentDOM 里面**，
 *   所以不能按「在不在编辑器里」分，只能认「是不是 contentDOM 自己」。那儿该全选
 *   这一格（与 Excel / Notion 一致），交还给浏览器；
 * - `doc`：其余一律整篇文档，包括焦点在文件树 / 大纲里的时候。**这一支之后调用方要
 *   把焦点收回编辑器**（0.4.1 修）：⌘C / ⌘X 走的是原生 `copy:`，而 CodeMirror 只在
 *   自己是 activeElement 时才把选区写进 DOM —— 不收焦点的话，全选之后复制是空的。
 */
export type SelectAllScope = 'field' | 'island' | 'doc'

export function selectAllScope(active: Element | null, contentDOM: Element | null): SelectAllScope {
  const tag = active?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return 'field'
  if (active && active !== contentDOM && (active as HTMLElement).isContentEditable) return 'island'
  return 'doc'
}

interface Entry {
  action: MenuAction
  labelKey: Key
  /** 快捷键；分类类目（主题）借这一列显示 */
  hint?: string
  hintKey?: Key
  /** `fb.h` 这种带占位符的 */
  args?: Record<string, number>
}

/**
 * 格式栏的标签把快捷键写在名字里（`'粗体  ⌘B'`，中间两个空格）。
 * 面板要把它拆成两列 —— 拆不开（某条没写快捷键）就整条当名字，不出错。
 *
 * 复用而不是另起一套名字：这两处说的本来就是同一件事，分开写迟早会有一边改了、
 * 另一边没改，于是同一个命令在菜单里叫「高亮」、在面板里叫「标记」。
 */
export function splitLabel(text: string): { label: string; hint?: string } {
  const at = text.search(/\s{2,}/)
  if (at < 0) return { label: text }
  return { label: text.slice(0, at), hint: text.slice(at).trim() }
}

/** 文件 / 编辑 / 视图三类。顺序照着原生菜单来 —— 空查询时面板列的就是菜单本身 */
const GENERAL: Entry[] = [
  { action: 'file:new', labelKey: 'cmd.new', hint: '⌘N' },
  { action: 'file:open', labelKey: 'cmd.open', hint: '⌘O' },
  { action: 'file:open-folder', labelKey: 'cmd.openFolder', hint: '⇧⌘O' },
  { action: 'file:quick-open', labelKey: 'cmd.quickOpen', hint: '⌘T' },
  { action: 'file:save', labelKey: 'cmd.save', hint: '⌘S' },
  { action: 'file:save-as', labelKey: 'cmd.saveAs', hint: '⇧⌘S' },
  { action: 'file:close-tab', labelKey: 'cmd.closeTab', hint: '⌘W' },
  { action: 'file:reopen-closed-tab', labelKey: 'cmd.reopenTab', hint: '⌥⇧⌘T' },
  { action: 'file:next-tab', labelKey: 'cmd.nextTab', hint: '⌃⇥' },
  { action: 'file:prev-tab', labelKey: 'cmd.prevTab', hint: '⌃⇧⇥' },
  { action: 'file:history', labelKey: 'cmd.history' },
  { action: 'file:check-refs', labelKey: 'cmd.checkRefs' },
  { action: 'file:export-html', labelKey: 'cmd.exportHtml', hint: '⇧⌘E' },
  { action: 'file:export-pdf', labelKey: 'cmd.exportPdf', hint: '⌥⌘P' },
  { action: 'file:export-png', labelKey: 'cmd.exportPng' },

  { action: 'edit:undo', labelKey: 'cmd.undo', hint: '⌘Z' },
  { action: 'edit:redo', labelKey: 'cmd.redo', hint: '⇧⌘Z' },
  { action: 'edit:select-all', labelKey: 'cmd.selectAll', hint: '⌘A' },
  { action: 'edit:find', labelKey: 'cmd.find', hint: '⌘F' },
  { action: 'edit:replace', labelKey: 'cmd.replace', hint: '⌥⌘R' },
  { action: 'edit:find-next', labelKey: 'cmd.findNext', hint: '⌘G' },
  { action: 'edit:find-prev', labelKey: 'cmd.findPrev', hint: '⇧⌘G' },
  { action: 'edit:find-in-files', labelKey: 'cmd.findInFiles', hint: '⇧⌘F' },
  { action: 'edit:select-next', labelKey: 'cmd.selectNext', hint: '⌘D' },
  { action: 'edit:copy-html', labelKey: 'cmd.copyHtml', hint: '⌥⇧⌘C' },
  { action: 'edit:paste-plain', labelKey: 'cmd.pastePlain', hint: '⌥⇧⌘V' },

  { action: 'view:toggle-sidebar', labelKey: 'cmd.sidebar', hint: '⌘\\' },
  { action: 'view:toggle-outline', labelKey: 'cmd.outline', hint: '⇧⌘T' },
  { action: 'view:toggle-format-bar', labelKey: 'cmd.formatBar' },
  { action: 'view:toggle-source', labelKey: 'cmd.source', hint: '⌘/' },
  { action: 'view:toggle-read-only', labelKey: 'cmd.readOnly', hint: '⌥⌘L' },
  { action: 'view:toggle-focus', labelKey: 'cmd.focus', hint: '⌥⌘F' },
  { action: 'view:toggle-typewriter', labelKey: 'cmd.typewriter', hint: '⌥⌘T' },
  { action: 'view:toggle-fold', labelKey: 'cmd.toggleFold', hint: '⌥⌘[' },
  { action: 'view:zoom-in', labelKey: 'cmd.zoomIn', hint: '⌘+' },
  { action: 'view:zoom-out', labelKey: 'cmd.zoomOut', hint: '⌘−' },
  { action: 'view:zoom-reset', labelKey: 'cmd.zoomReset', hint: '⌥⌘0' },
  { action: 'view:toggle-dark', labelKey: 'cmd.toggleDark', hint: '⌃⌘D' },
  { action: 'view:disable-custom-theme', labelKey: 'cmd.customOff' },
  { action: 'app:preferences', labelKey: 'cmd.prefs', hint: '⌘,' },
  { action: 'app:check-update', labelKey: 'cmd.checkUpdate' },

  // 「前往」菜单（第八节 6）
  { action: 'go:back', labelKey: 'cmd.navBack', hint: '⌥⌘←' },
  { action: 'go:forward', labelKey: 'cmd.navForward', hint: '⌥⌘→' }
]

/** 主题四态：名字借设置面板那份，右边一列标「主题」当分类 */
const THEMES: Entry[] = [
  { action: 'view:theme-system', labelKey: 'pf.theme.system', hintKey: 'pf.theme' },
  { action: 'view:theme-light', labelKey: 'pf.theme.light', hintKey: 'pf.theme' },
  { action: 'view:theme-dark', labelKey: 'pf.theme.dark', hintKey: 'pf.theme' },
  { action: 'view:theme-sepia', labelKey: 'pf.theme.sepia', hintKey: 'pf.theme' }
]

/**
 * 格式类。顺序照着原生「格式」菜单来，而不是照格式栏 —— 面板是菜单的替身。
 * 一条都不能漏：`test/commands.test.ts` 拿 `MenuAction` 的全集对账，
 * 以后往契约里加一条 `fmt:*` 却忘了这里，那条测试当场变红。
 */
const FORMAT: Entry[] = [
  { action: 'fmt:bold', labelKey: 'fb.bold' },
  { action: 'fmt:italic', labelKey: 'fb.italic' },
  { action: 'fmt:underline', labelKey: 'fb.underline' },
  { action: 'fmt:strikethrough', labelKey: 'fb.strike' },
  { action: 'fmt:code-inline', labelKey: 'fb.code' },
  { action: 'fmt:highlight', labelKey: 'fb.highlight' },
  { action: 'fmt:superscript', labelKey: 'fb.sup' },
  { action: 'fmt:subscript', labelKey: 'fb.sub' },
  { action: 'fmt:math-inline', labelKey: 'fb.mathInline' },
  { action: 'fmt:latex-format', labelKey: 'cmd.latexFormat' },
  { action: 'fmt:link', labelKey: 'fb.link' },

  { action: 'fmt:h1', labelKey: 'fb.h', args: { n: 1 }, hint: '⌘1' },
  { action: 'fmt:h2', labelKey: 'fb.h', args: { n: 2 }, hint: '⌘2' },
  { action: 'fmt:h3', labelKey: 'fb.h', args: { n: 3 }, hint: '⌘3' },
  { action: 'fmt:h4', labelKey: 'fb.h', args: { n: 4 }, hint: '⌘4' },
  { action: 'fmt:h5', labelKey: 'fb.h', args: { n: 5 }, hint: '⌘5' },
  { action: 'fmt:h6', labelKey: 'fb.h', args: { n: 6 }, hint: '⌘6' },
  { action: 'fmt:p', labelKey: 'fb.p', hint: '⌘0' },

  { action: 'fmt:code-block', labelKey: 'fb.codeBlock' },
  { action: 'fmt:quote', labelKey: 'fb.quote' },
  { action: 'fmt:ulist', labelKey: 'fb.ulist' },
  { action: 'fmt:olist', labelKey: 'fb.olist' },
  { action: 'fmt:task', labelKey: 'fb.task' },

  { action: 'fmt:table', labelKey: 'fb.table', hint: '⌃⌘T' },
  { action: 'fmt:image', labelKey: 'fb.image' },
  { action: 'fmt:hr', labelKey: 'fb.hr' },
  { action: 'fmt:math-block', labelKey: 'fb.mathBlock' },
  { action: 'fmt:callout', labelKey: 'fb.callout' },
  { action: 'fmt:mermaid', labelKey: 'fb.mermaid' },
  { action: 'fmt:footnote', labelKey: 'fb.footnote' },
  { action: 'fmt:toc', labelKey: 'fb.toc' }
]

/**
 * 面板要的那份条目。**每次开面板现算** —— 文案要跟着语言走，
 * 缓存一份的话切完语言再开面板还是旧文字（`langOptions()` 踩过同一个坑）。
 */
export function commandItems(run: (action: MenuAction) => void): PaletteItem[] {
  const entries = [...GENERAL, ...THEMES, ...FORMAT]
  return entries.map((e) => {
    const raw = t(e.labelKey, e.args)
    const split = splitLabel(raw)
    const hint = e.hint ?? (e.hintKey ? t(e.hintKey) : split.hint)
    return {
      label: split.label,
      hint,
      // 快捷键也参与匹配：记得住 ⌘D 却想不起它叫什么的人，打 `d` 就该找到
      key: hint ? `${split.label} ${hint}` : split.label,
      run: () => run(e.action)
    }
  })
}
