import { describe, expect, it } from 'vitest'
import { revealChain } from '../src/renderer/ui/sidebar'

/**
 * 「让当前文件在树里看得见」要沿途展开哪几级。
 *
 * 这条路自己很短，值钱的是它的**返回值被 `setActive` 当成「树的结构变没变」的依据** ——
 * 变了才重建整棵树（`render()` 是整棵 replaceChildren，1500 行实测 30ms+，
 * 而每切一次标签都会走到这里）。所以这几条边界一旦松了，代价不是画错一行，
 * 是每次切标签白白重建一次。
 */
describe('revealChain：沿途要展开哪几级', () => {
  it('树根下第一级的文件：一级都不用展（它本来就看得见）', () => {
    expect(revealChain('/w', '/w/a.md')).toEqual([])
  })

  it('深路径：从浅到深，不含文件自己那一级', () => {
    expect(revealChain('/w', '/w/写作/草稿/c.md')).toEqual(['/w/写作', '/w/写作/草稿'])
  })

  it('树根自己永远不在里面 —— 它不是树里的一行，是 nodes 本身', () => {
    expect(revealChain('/w', '/w/a/b.md')).not.toContain('/w')
  })

  it('根之外的路径一级都不展（树根同时是防穿越守卫之界）', () => {
    expect(revealChain('/w', '/other/a.md')).toEqual([])
    expect(revealChain('/w', '/w')).toEqual([])
  })

  it('前缀像但不是子路径：/w2 不归 /w 管', () => {
    expect(revealChain('/w', '/w2/a.md')).toEqual([])
  })

  it('还没有工作区 = 没得展', () => {
    expect(revealChain(null, '/w/a.md')).toEqual([])
  })
})
