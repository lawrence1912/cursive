import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { commandItems, splitLabel } from '../src/renderer/ui/commands'
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
