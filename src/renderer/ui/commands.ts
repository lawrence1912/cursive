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
  { action: 'file:next-tab', labelKey: 'cmd.nextTab', hint: '⌃⇥' },
  { action: 'file:prev-tab', labelKey: 'cmd.prevTab', hint: '⌃⇧⇥' },
  { action: 'file:history', labelKey: 'cmd.history' },
  { action: 'file:export-html', labelKey: 'cmd.exportHtml', hint: '⇧⌘E' },
  { action: 'file:export-png', labelKey: 'cmd.exportPng' },

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
  { action: 'view:toggle-focus', labelKey: 'cmd.focus', hint: '⌥⌘F' },
  { action: 'view:toggle-typewriter', labelKey: 'cmd.typewriter', hint: '⌥⌘T' },
  { action: 'view:toggle-fold', labelKey: 'cmd.toggleFold' },
  { action: 'view:toggle-dark', labelKey: 'cmd.toggleDark', hint: '⌃⌘D' },
  { action: 'view:disable-custom-theme', labelKey: 'cmd.customOff' },
  { action: 'app:preferences', labelKey: 'cmd.prefs', hint: '⌘,' },
  { action: 'app:check-update', labelKey: 'cmd.checkUpdate' }
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
