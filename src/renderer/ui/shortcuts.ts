import type { MenuAction } from '../../shared/types'

/**
 * 界面上写着的快捷键（第八节 14）。
 *
 * **真相在原生菜单**（`shell-swift/main.swift` 的 `buildMenu`）：判断 1 定了带 ⌘ 的键一律走菜单，
 * 渲染层只负责把它**念出来** —— 命令面板右边那一列、格式栏的下拉、标题栏与文件树工具栏
 * 按钮的悬停说明、空白文档里那句提示。从前这些地方各写各的一份，于是同一个键在菜单里是
 * `⇧⌘O`、在文件树按钮上是 `⌘⇧O`，命令面板的键死了好几个版本也没人发现（第八节 21）。
 *
 * 写法照 macOS 菜单自己画的那样：修饰键按 ⌃ ⌥ ⇧ ⌘ 排，字母大写，Tab 写 ⇥。
 * `test/shortcuts.test.ts` 读 main.swift 对账：这里每一条都得与菜单一字不差，菜单里带键的
 * 命令这里也一条不能少；字典里写死在句子里的快捷键（`fb.*`、几句提示）在那儿逐条核对，
 * README 里提到的每一个也是。
 */
const SHORTCUTS: Partial<Record<MenuAction, string>> = {
  'app:preferences': '⌘,',

  'file:new': '⌘N',
  'file:open': '⌘O',
  'file:open-folder': '⇧⌘O',
  'file:quick-open': '⌘T',
  'file:save': '⌘S',
  'file:save-as': '⇧⌘S',
  'file:export-html': '⇧⌘E',
  'file:export-pdf': '⌥⌘P',
  'file:close-tab': '⌘W',
  'file:reopen-closed-tab': '⌥⇧⌘T',
  'file:next-tab': '⌃⇥',
  'file:prev-tab': '⌃⇧⇥',

  'edit:undo': '⌘Z',
  'edit:redo': '⇧⌘Z',
  'edit:select-all': '⌘A',
  'edit:paste-plain': '⌥⇧⌘V',
  'edit:copy-html': '⌥⇧⌘C',
  'edit:find': '⌘F',
  'edit:replace': '⌥⌘R',
  'edit:find-in-files': '⇧⌘F',
  'edit:find-next': '⌘G',
  'edit:find-prev': '⇧⌘G',
  'edit:select-next': '⌘D',

  'fmt:bold': '⌘B',
  'fmt:italic': '⌘I',
  'fmt:underline': '⌘U',
  'fmt:strikethrough': '⇧⌘X',
  'fmt:code-inline': '⌃⌘C',
  'fmt:highlight': '⇧⌘H',
  'fmt:superscript': '⌃⌘=',
  'fmt:subscript': '⌃⌘-',
  'fmt:math-inline': '⌃⌘M',
  'fmt:link': '⌘K',
  'fmt:h1': '⌘1',
  'fmt:h2': '⌘2',
  'fmt:h3': '⌘3',
  'fmt:h4': '⌘4',
  'fmt:h5': '⌘5',
  'fmt:h6': '⌘6',
  'fmt:p': '⌘0',
  'fmt:code-block': '⇧⌘K',
  'fmt:quote': '⇧⌘Q',
  'fmt:ulist': '⇧⌘[',
  'fmt:olist': '⇧⌘]',
  'fmt:task': '⇧⌘C',
  'fmt:table': '⌃⌘T',

  'view:toggle-sidebar': '⌘\\',
  'view:toggle-outline': '⇧⌘T',
  'view:toggle-source': '⌘/',
  'view:toggle-read-only': '⌥⌘L',
  'view:toggle-focus': '⌥⌘F',
  'view:toggle-typewriter': '⌥⌘T',
  'view:command-palette': '⇧⌘P',
  'view:toggle-fold': '⌥⌘[',
  'view:toggle-dark': '⌃⌘D',
  'view:zoom-in': '⌘+',
  'view:zoom-out': '⌘-',
  'view:zoom-reset': '⌥⌘0',

  'go:back': '⌥⌘←',
  'go:forward': '⌥⌘→'
}

/** 这条命令在菜单里的快捷键；没有就是 undefined（命令面板那一列留空） */
export function keyOf(action: MenuAction): string | undefined {
  return SHORTCUTS[action]
}

/** 「名字 (⇧⌘F)」：按钮悬停说明的统一写法。没有快捷键就只有名字 */
export function withKey(label: string, action: MenuAction): string {
  const key = keyOf(action)
  return key ? `${label} (${key})` : label
}

/** 对账用：整张表（单测拿它与 main.swift 的菜单逐条比） */
export function allShortcuts(): Readonly<Partial<Record<MenuAction, string>>> {
  return SHORTCUTS
}
