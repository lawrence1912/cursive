import { describe, expect, it } from 'vitest'
import {
  normalizeZoom,
  stepZoom,
  zoomLabel,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEPS
} from '../src/renderer/ui/zoom'

/**
 * 0.4.1 正文缩放。这里测的是**档位表那三个纯函数** —— `Zoom` 类要 DOM 与
 * localStorage，那一半由探针在真 app 里验（状态栏读数 + 正文字号真的变了）。
 *
 * 为什么档位值得单独测：状态栏现在把这个数摆出来给人看了。从前 ×1.1 连乘，
 * 按三下是 133.1%，没人看见也就算了；现在它是屏幕上的一行字。
 */
describe('档位表', () => {
  it('升序、含 1、两端就是上下界', () => {
    expect([...ZOOM_STEPS].sort((a, b) => a - b)).toEqual(ZOOM_STEPS)
    expect(ZOOM_STEPS).toContain(1)
    expect(ZOOM_MIN).toBe(0.5)
    expect(ZOOM_MAX).toBe(3)
  })

  it('每一档都是整百分比 —— 它要摆到状态栏上给人读', () => {
    for (const z of ZOOM_STEPS) expect(zoomLabel(z)).toMatch(/^\d+%$/)
  })
})

describe('stepZoom', () => {
  it('一次一档，不跳格', () => {
    expect(stepZoom(1, 1)).toBe(1.1)
    expect(stepZoom(1.1, 1)).toBe(1.25)
    expect(stepZoom(1, -1)).toBe(0.9)
    expect(stepZoom(0.9, -1)).toBe(0.8)
  })

  it('顶到头就停在那儿（连按不会越界）', () => {
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX)
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN)
  })

  it('当前值不在表上（老数据 / 手改过的 localStorage）取严格相邻的那一档', () => {
    expect(stepZoom(1.331, 1)).toBe(1.5)
    expect(stepZoom(1.331, -1)).toBe(1.25)
  })

  it('浮点相等不算「下一档」—— 0.67 按一下降到 0.5，不是原地不动', () => {
    expect(stepZoom(0.67, -1)).toBe(0.5)
    expect(stepZoom(0.67, 1)).toBe(0.75)
  })

  it('越界 / 坏值先夹回来再走', () => {
    expect(stepZoom(99, -1)).toBe(2.5)
    expect(stepZoom(Number.NaN, 1)).toBe(1.1)
  })
})

describe('normalizeZoom', () => {
  it('夹在上下界之间', () => {
    expect(normalizeZoom(0.1)).toBe(ZOOM_MIN)
    expect(normalizeZoom(9)).toBe(ZOOM_MAX)
    expect(normalizeZoom(1.25)).toBe(1.25)
  })

  it('不是数字就当 100%，别让一份坏存储把正文缩没了', () => {
    expect(normalizeZoom(Number.NaN)).toBe(1)
    expect(normalizeZoom('1.5' as unknown as number)).toBe(1)
  })
})

describe('zoomLabel', () => {
  it('整数百分比', () => {
    expect(zoomLabel(1)).toBe('100%')
    expect(zoomLabel(0.67)).toBe('67%')
    expect(zoomLabel(1.25)).toBe('125%')
    expect(zoomLabel(3)).toBe('300%')
  })
})
