import { describe, expect, it } from 'vitest'
import { typeaheadIndex } from '../src/renderer/ui/sidebar'

/**
 * 文件树首字母跳（0.2.x）。
 *
 * 方向键那几条是下标加减，看一眼就知道对不对；会错的是**绕圈**这一下 ——
 * 不绕，按到最后一个 `r` 开头的文件就卡住；起点取错，同一个字母连按会永远
 * 停在第一个匹配上。这里把这两种错各钉一条。
 */
describe('首字母跳', () => {
  const names = ['assets', 'draft.md', 'readme', 'roadmap', 'notes']

  it('从下一行开始找：同一个字母连按 = 在匹配的那几行之间轮着走', () => {
    // 光标在 assets(0)：按 r → readme(2)
    expect(typeaheadIndex(names, 1, 'r')).toBe(2)
    // 再按 r，从 3 起找 → roadmap(3)
    expect(typeaheadIndex(names, 3, 'r')).toBe(3)
    // 第三次，从 4 起绕回来 → readme(2)
    expect(typeaheadIndex(names, 4, 'r')).toBe(2)
  })

  it('攒成词之后从当前行开始找 —— 打 `re` 不该跳过正对着的 readme', () => {
    expect(typeaheadIndex(names, 2, 're')).toBe(2)
  })

  it('绕过末尾回到开头', () => {
    expect(typeaheadIndex(names, 4, 'a')).toBe(0)
    // 起点越界也要收得住（光标在最后一行时 from = 长度）
    expect(typeaheadIndex(names, names.length, 'd')).toBe(1)
    expect(typeaheadIndex(names, 99, 'n')).toBe(4)
  })

  it('大小写不敏感：README 与 readme 在这儿是一回事', () => {
    expect(typeaheadIndex(['README', 'CHANGELOG'], 0, 'r')).toBe(0)
    expect(typeaheadIndex(['readme'], 0, 'R')).toBe(0)
  })

  it('找不到 / 空树 / 空串都回 -1，不去动光标', () => {
    expect(typeaheadIndex(names, 0, 'z')).toBe(-1)
    expect(typeaheadIndex([], 0, 'a')).toBe(-1)
    expect(typeaheadIndex(names, 0, '')).toBe(-1)
  })

  it('负起点不炸（光标还没落过时 at = -1，from 就是 0 之前那一格）', () => {
    expect(typeaheadIndex(names, -1, 'n')).toBe(4)
  })
})
