import { describe, expect, it } from 'vitest'
import { holesFrom, type RectLike } from '../src/renderer/ui/drag-holes'

/**
 * 标题栏的「放行区段」（契约 v26）。
 *
 * 这一段算错的后果很隐蔽：**页面那一侧完全看不出来**。标签照旧画在那儿、
 * `elementFromPoint` 照旧命中它，只是真鼠标点下去被原生拖拽条吃掉了 ——
 * 于是「点标签没反应」，而所有页面级断言全是绿的。所以算法这一半在这儿守，
 * 「壳真的放行了」那一半在 `release.sh` 的 `tabNativeHole` 守，两条缺一不可。
 */
describe('标题栏放行区段', () => {
  const strip = { width: 1000, height: 38 }
  /** 文件树开关：base.css 的 78 起、26 宽，钉在 y=3 那条线上 */
  const btnLeft: RectLike = { left: 78, right: 104, top: 3, bottom: 29 }
  /** 右上三颗（深色 / 栏宽 / 大纲）：26×3 + 间隙 2×2 = 82，右内边距 10 */
  const btnRight: RectLike = { left: 908, right: 990, top: 3, bottom: 29 }
  /** 标签：顶栏 38 − 顶部留白 6 = 32 高 */
  const tab = (left: number, right: number): RectLike => ({ left, right, top: 6, bottom: 38 })

  it('两端按钮各一段，连着的标签并成一段', () => {
    // 侧栏开着（宽 252）时中间列从 260 起，按钮与标签之间隔着侧栏那一截
    expect(holesFrom([btnLeft, btnRight, tab(260, 400), tab(402, 542)], strip)).toEqual([
      [72, 110],
      [254, 548],
      [902, 996]
    ])
  })

  it('顺序无关：DOM 里怎么排都一样', () => {
    const a = holesFrom([tab(402, 542), btnRight, tab(260, 400), btnLeft], strip)
    const b = holesFrom([btnLeft, btnRight, tab(260, 400), tab(402, 542)], strip)
    expect(a).toEqual(b)
  })

  it('裁到条子里：标签栏横向滚动时滚出去的那半截不算', () => {
    // 左边滚出去（left 为负）与右边超出窗口，都只留条子里那一段
    expect(holesFrom([tab(-40, 120)], strip)).toEqual([[0, 126]])
    expect(holesFrom([tab(960, 1200)], strip)).toEqual([[954, 1000]])
  })

  it('条子底下才算数：编辑区里的东西不挖', () => {
    // 条子只有 38 高。正文里的元素本来就点得到，挖了只会把能拖窗口的地方越挖越少
    expect(holesFrom([{ left: 100, right: 300, top: 40, bottom: 80 }], strip)).toEqual([])
  })

  it('藏起来的按钮不占段（rect 全 0）', () => {
    // display:none 的元素 rect 是 0/0/0/0 —— 不挡住的话窗口左上角会白挖一个洞
    expect(holesFrom([{ left: 0, right: 0, top: 0, bottom: 0 }], strip)).toEqual([])
  })

  it('一个都没有 = 整条都归拖拽', () => {
    expect(holesFrom([], strip)).toEqual([])
  })

  it('侧栏藏起来：标签让开 110，正好接上那颗开关的洞', () => {
    // `#topbar.is-inset-left` 让标签从 110 起，而开关的洞开到 110 —— 两段连成一段，
    // 中间不留「看着能拖、其实点不动」的缝
    expect(holesFrom([btnLeft, tab(110, 300)], strip)).toEqual([[72, 306]])
  })
})
