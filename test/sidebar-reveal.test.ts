import { describe, expect, it } from 'vitest'
import { edgeScroll, revealChain } from '../src/renderer/ui/sidebar'

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

/**
 * 拖到树的上下边缘时该滚多快。
 *
 * 提成纯函数是因为这条的错法全在**边界**上：热区外沿差一个像素就该是 0（否则树会
 * 在指针没进热区时自己动），刚进热区那一档不能被取整抹成 0（那会让人觉得卡住了），
 * 指针跑出面板之后不能跟着距离一路加速（手已经没有余量了，只会冲过头）。
 * 这三件事在真机上都要拿着鼠标贴着边试半天，而在这儿是三行。
 */
describe('edgeScroll：拖到边缘自己滚', () => {
  const TOP = 100
  const BOTTOM = 500

  it('中间一带不滚', () => {
    expect(edgeScroll(300, TOP, BOTTOM)).toBe(0)
  })

  it('热区外沿正好不滚（差一个像素才开始）', () => {
    expect(edgeScroll(TOP + 24, TOP, BOTTOM)).toBe(0)
    expect(edgeScroll(BOTTOM - 24, TOP, BOTTOM)).toBe(0)
    expect(edgeScroll(TOP + 23, TOP, BOTTOM)).toBe(-1)
    expect(edgeScroll(BOTTOM - 23, TOP, BOTTOM)).toBe(1)
  })

  it('贴死边缘满速，上下对称', () => {
    expect(edgeScroll(TOP, TOP, BOTTOM)).toBe(-14)
    expect(edgeScroll(BOTTOM, TOP, BOTTOM)).toBe(14)
  })

  it('指针跑出面板：还是满速，不一路加下去', () => {
    expect(edgeScroll(TOP - 400, TOP, BOTTOM)).toBe(-14)
    expect(edgeScroll(BOTTOM + 400, TOP, BOTTOM)).toBe(14)
  })

  it('越靠近边缘越快（热区里单调）', () => {
    const speeds = [20, 15, 10, 5, 0].map((d) => -edgeScroll(TOP + d, TOP, BOTTOM))
    expect(speeds).toEqual([...speeds].sort((a, b) => a - b))
    expect(new Set(speeds).size).toBeGreaterThan(3)
  })
})
