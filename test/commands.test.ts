import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { commandItems, selectAllScope, splitLabel } from '../src/renderer/ui/commands'
import type { MenuAction } from '../src/shared/types'

/**
 * 0.2.0 命令面板。
 *
 * 最要紧的一条是**对账**：面板号称「列的就是原生菜单自己」，那这句话就得有东西守着。
 * `MenuAction` 是类型、运行时取不到，所以这里直接读契约文件把联合成员抠出来 ——
 * 以后往契约里加一条命令却忘了摆进面板，这条测试当场变红。
 */
function contractActions(): MenuAction[] {
  const src = readFileSync(new URL('../src/shared/types.ts', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('export type MenuAction'), src.indexOf('/** 视图菜单里带勾的那几项'))
  return [...body.matchAll(/^\s*\|\s*'([^']+)'/gm)].map((m) => m[1] as MenuAction)
}

/**
 * 有意不进面板的那几条，每条都得说得出理由 —— 这份名单本身就是「为什么不列」的记录。
 */
const OFF_PALETTE: Record<string, string> = {
  // 关窗协议的一环（壳拦住关闭 → 渲染层落盘所有脏标签 → confirmClose），不是用户命令
  'file:save-and-close': '关窗协议，不是用户能主动发的命令',
  // 面板自己。列在面板里 = 开着的面板里有一条「打开面板」
  'view:command-palette': '面板自己'
}

describe('命令表与契约对账', () => {
  const actions = contractActions()

  it('契约里确实抠到了命令（别在解析上悄悄失败）', () => {
    expect(actions.length).toBeGreaterThan(40)
    expect(actions).toContain('fmt:bold')
    expect(actions).toContain('view:toggle-source')
  })

  it('每一条 MenuAction 要么在面板里，要么在豁免名单里', () => {
    const listed = new Set<string>()
    commandItems((a) => listed.add(a)).forEach((item) => void item.run())
    const missing = actions.filter((a) => !listed.has(a) && !(a in OFF_PALETTE))
    expect(missing).toEqual([])
  })

  it('豁免名单里的不许混进面板', () => {
    const listed = new Set<string>()
    commandItems((a) => listed.add(a)).forEach((item) => void item.run())
    expect(Object.keys(OFF_PALETTE).filter((a) => listed.has(a))).toEqual([])
  })

  it('豁免名单不许留着已经不存在的命令', () => {
    expect(Object.keys(OFF_PALETTE).filter((a) => !actions.includes(a as MenuAction))).toEqual([])
  })
})

describe('条目长相', () => {
  const items = commandItems(() => {})

  it('名字和快捷键分两列（格式栏那份标签里两者是连在一起的）', () => {
    const bold = items.find((i) => i.label === '粗体')
    expect(bold?.hint).toBe('⌘B')
  })

  it('快捷键也参与匹配 —— 记得住 ⌘D 却想不起它叫什么时还能找到', () => {
    const selectNext = items.find((i) => i.hint === '⌘D')
    expect(selectNext?.key).toContain('⌘D')
  })

  it('标题带级数（fb.h 的占位符真的填了）', () => {
    expect(items.some((i) => i.label === '标题 3')).toBe(true)
  })

  it('每条都有名字，没有空壳', () => {
    expect(items.filter((i) => i.label.trim() === '')).toEqual([])
  })
})

describe('splitLabel', () => {
  it('两个以上空格处切开', () => {
    expect(splitLabel('粗体  ⌘B')).toEqual({ label: '粗体', hint: '⌘B' })
  })

  it('没有快捷键就整条当名字（不报错、不留空 hint）', () => {
    expect(splitLabel('目录')).toEqual({ label: '目录' })
  })

  it('单个空格不算分隔（`Toggle File Tree` 不该被切成两半）', () => {
    expect(splitLabel('Toggle File Tree')).toEqual({ label: 'Toggle File Tree' })
  })
})

/**
 * 撤销这条键盘入口（0.4.0 修）。
 *
 * 判断 1 说「带 ⌘ 的键全归菜单系统」——「编辑」菜单里那条撤销原先挂的是 AppKit 的
 * `undo:`，沿响应链落进 WKWebView，撤的是 **WebKit 自己那套 DOM 编辑撤销栈**，
 * 而文档的真历史在 CodeMirror 里。表格一改结构（回车加行、删行、增删列、整理）
 * 整张表的格子都会重建，WebKit 栈顶那条记录指着的元素当场没了 —— 它既不派
 * `beforeinput` 也不做事，可 `canUndo` 还是真：菜单项照亮、照吃 ⌘Z，一按下去
 * 一点反应都没有。症状是「在格子里打过字之后回车加一行，⌘Z 失灵」，
 * **偶发**取决于 WebKit 栈里那一刻是不是恰好压着死记录。
 *
 * 所以这两条键必须与 ⌘D 同款：菜单 → `MenuAction` → 渲染层调 CM 的 undo/redo。
 * Swift 那边没有单测，这里直接扫源码把关。
 */
describe('撤销这条键盘入口', () => {
  const swift = readFileSync(new URL('../shell-swift/main.swift', import.meta.url), 'utf8')

  it('菜单项走 MenuAction，不再是 AppKit 的 undo:/redo:', () => {
    expect(swift).toContain('item(L("menu.edit.undo"), "edit:undo", key: "z")')
    expect(swift).toContain('item(L("menu.edit.redo"), "edit:redo"')
    expect(swift).not.toContain('Selector(("undo:"))')
    expect(swift).not.toContain('Selector(("redo:"))')
  })

  it('剪切 / 拷贝 / 粘贴仍旧归 WebKit（那三条本来就该是原生选择器）', () => {
    for (const sel of ['cut:', 'copy:', 'paste:']) {
      expect(swift, `${sel} 不该被一起改掉`).toContain(`Selector(("${sel}"))`)
    }
  })

  it('两条都在契约里，也都在面板里（漏一条 = 键是死的）', () => {
    expect(contractActions()).toEqual(expect.arrayContaining(['edit:undo', 'edit:redo']))
    const listed = new Set<string>()
    commandItems((a) => listed.add(a)).forEach((item) => void item.run())
    expect(listed.has('edit:undo') && listed.has('edit:redo')).toBe(true)
  })
})

/**
 * 全选这条键盘入口（0.4.1 修）。
 *
 * 与上面撤销那条同一个病灶：「编辑」菜单里那条全选原先挂 AppKit 的 `selectAll:`，
 * 沿响应链落进 WKWebView，执行的是 **WebKit 自己那条 SelectAll 编辑命令** ——
 * 它选的是「编辑宿主里渲染出来的内容」，而 CodeMirror 只把**视口那一段**放进 DOM，
 * 视口外是 `contenteditable=false` 的 `.cm-gap` 占位块，WebKit 规范化选区两头时
 * 会跳过它们。于是「全选」只选到一屏：实测 829 行 / 19340 字符的文档，真点一次
 * 「编辑 ▸ 全选」，选区停在 `0…340` —— 正好是那一刻的视口 `0…339`。
 * 症状是「⌘A 之后复制 / 删除只拿到当前屏幕上的那一段」，而**短文档一切正常**
 * （一屏装得下 = 视口就是全文），所以它藏得住。
 *
 * 所以这条键必须与 ⌘Z / ⌘D 同款：菜单 → `MenuAction` → 渲染层调 CM 的 selectAll。
 * Swift 那边没有单测，这里直接扫源码把关；「真的选到了全文」由
 * `release.sh` 里长文档那一条 E2E（`selectAllProbe`）守着。
 */
describe('全选这条键盘入口', () => {
  const swift = readFileSync(new URL('../shell-swift/main.swift', import.meta.url), 'utf8')

  it('菜单项走 MenuAction，不再是 AppKit 的 selectAll:', () => {
    expect(swift).toContain('item(L("menu.edit.selectAll"), "edit:select-all", key: "a")')
    expect(swift).not.toContain('Selector(("selectAll:"))')
  })

  it('在契约里，也在面板里（漏一条 = 键是死的）', () => {
    expect(contractActions()).toContain('edit:select-all')
    const listed = new Set<string>()
    commandItems((a) => listed.add(a)).forEach((item) => void item.run())
    expect(listed.has('edit:select-all')).toBe(true)
  })

  it('长文档那条 E2E 断言还在（只有它证明得了「选的是全文」）', () => {
    expect(swift).toContain('selectAllProbe')
    const sh = readFileSync(new URL('../shell-swift/release.sh', import.meta.url), 'utf8')
    expect(sh).toContain("s.get('coversAll') is True")
    expect(sh).toContain("s.get('viewportSmaller') is True")
    // 0.4.1 修：探针从**非编辑控件**上按 ⌘A，全选之后焦点得回到编辑器
    expect(sh).toContain("s.get('refocused') is True")
    expect(swift).toContain("document.getElementById('status-count')")
  })
})

/**
 * 全选之后**焦点要回编辑器**（0.4.1 修）。
 *
 * 这一句只能扫源码：它的后果发生在渲染层之外 —— ⌘C / ⌘X 走的是原生 `copy:` /
 * `cut:`（沿响应链落进 WebKit），而 CodeMirror 只在自己是 activeElement 时才把选区
 * 写进 DOM。焦点留在文件树上的话，人看着整篇都选中了，复制出来是空的。
 * 真机那半在 `release.sh` 的 `refocused` 上（jsdom 里没有响应链，测不到）。
 */
describe('全选之后的焦点', () => {
  const main = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8')
  const at = main.indexOf("case 'edit:select-all'")
  const block = main.slice(at, main.indexOf("case 'edit:find'", at))

  it('整篇那一支收焦点', () => {
    expect(at).toBeGreaterThan(0)
    const doc = block.slice(block.indexOf('default:'))
    expect(doc).toContain('selectAll(view)')
    expect(doc, 'view.focus() 丢了的话，⌘A 之后复制是空的').toContain('view.focus()')
  })

  it('表格格子那座孤岛**不**收 —— 焦点一走，整块表当场换回管道符源码', () => {
    const island = block.slice(block.indexOf("case 'island'"), block.indexOf('default:'))
    expect(island).toContain("document.execCommand('selectAll')")
    expect(island).not.toContain('view.focus()')
  })
})

/**
 * ⌘A 落到哪儿（0.4.1）。判断提成了纯函数，所以这六条**一个窗口都不用开** ——
 * 三个假元素就够。真机那半边（「选到的确实是整篇文档」）在 `release.sh` 的
 * `selectAllProbe` 里，它必须有真 WKWebView：CodeMirror 只渲染视口这件事，
 * jsdom 里不存在（没有布局，整篇都在 DOM 里），在那儿测等于没测。
 */
describe('全选落到哪儿', () => {
  const contentDOM = { tagName: 'DIV', isContentEditable: true } as unknown as Element
  const el = (tag: string, editable = false) =>
    ({ tagName: tag, isContentEditable: editable }) as unknown as Element

  it('壳自己的输入框 → 只选那一行字', () => {
    expect(selectAllScope(el('INPUT'), contentDOM)).toBe('field')
    expect(selectAllScope(el('TEXTAREA'), contentDOM)).toBe('field')
  })

  it('表格格子那座孤岛 → 只选这一格（它在 contentDOM 里面，不能按「在不在编辑器里」分）', () => {
    expect(selectAllScope(el('TD', true), contentDOM)).toBe('island')
  })

  it('编辑器自己 → 整篇文档', () => {
    expect(selectAllScope(contentDOM, contentDOM)).toBe('doc')
  })

  it('焦点在文件树 / 大纲那种不可编辑的地方 → 也是整篇文档', () => {
    expect(selectAllScope(el('DIV'), contentDOM)).toBe('doc')
  })

  it('没有焦点元素 → 整篇文档（别在这儿抛）', () => {
    expect(selectAllScope(null, contentDOM)).toBe('doc')
  })
})
