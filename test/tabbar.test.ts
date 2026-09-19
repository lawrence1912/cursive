import { describe, expect, it } from 'vitest'
import { reorderIds } from '../src/renderer/ui/tabbar'

/**
 * 标签拖拽重排（0.2.x）的**顺序语义**。
 *
 * 拖拽那一半是 DOM（阈值、落点线、松手），进不了 node 测试；这一半是纯函数，
 * 而它正是别处要用的那份真相 —— 会话按 `tabs` 的顺序记、「关闭左边/右边」
 * 按它算、⌃Tab 循环按它走。挪错一格，那三处一起错。
 */
describe('标签重排', () => {
  const ids = [1, 2, 3, 4]

  it('往后挪：落在某个标签之前', () => {
    expect(reorderIds(ids, 1, 3)).toEqual([2, 1, 3, 4])
    expect(reorderIds(ids, 1, 4)).toEqual([2, 3, 1, 4])
  })

  it('往前挪同一条路（落点永远是「插到它之前」）', () => {
    expect(reorderIds(ids, 4, 2)).toEqual([1, 4, 2, 3])
    expect(reorderIds(ids, 3, 1)).toEqual([3, 1, 2, 4])
  })

  it('null = 挪到末尾', () => {
    expect(reorderIds(ids, 2, null)).toEqual([1, 3, 4, 2])
    // 本来就在末尾，挪到末尾 = 原样
    expect(reorderIds(ids, 4, null)).toEqual([1, 2, 3, 4])
  })

  it('落在自己身上 = 原地不动', () => {
    expect(reorderIds(ids, 2, 2)).toEqual(ids)
  })

  it('落在「自己的下一个」之前 = 也是原地（DOM 那侧已经拦了，这里是第二道）', () => {
    expect(reorderIds(ids, 2, 3)).toEqual([1, 2, 3, 4])
  })

  it('落点已经不在表里 = 整个作废，不去猜用户想放哪儿', () => {
    // 拖到一半，落点那个标签被外部变更 / 另一个窗口关掉了
    expect(reorderIds(ids, 1, 99)).toEqual(ids)
  })

  it('拖的那个已经不在表里 = 同样作废', () => {
    expect(reorderIds(ids, 99, 2)).toEqual(ids)
  })

  it('不改原数组（调用方拿它和旧顺序比对，决定要不要重画）', () => {
    const src = [1, 2, 3]
    const out = reorderIds(src, 1, null)
    expect(src).toEqual([1, 2, 3])
    expect(out).not.toBe(src)
  })

  it('一个标签时怎么拖都不动', () => {
    expect(reorderIds([7], 7, null)).toEqual([7])
    expect(reorderIds([7], 7, 7)).toEqual([7])
  })
})
