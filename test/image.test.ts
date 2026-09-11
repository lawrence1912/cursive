import { describe, expect, it } from 'vitest'
import { parseImage } from '../src/renderer/editor/live-preview/decorate'

describe('parseImage（P1-5：尺寸语法）', () => {
  it('普通图片', () => {
    expect(parseImage('![cat](assets/cat.png)')).toEqual({
      alt: 'cat',
      src: 'assets/cat.png'
    })
  })

  it('绝对路径和标题', () => {
    expect(parseImage('![x](/tmp/p.png "标题")')).toEqual({ alt: 'x', src: '/tmp/p.png' })
  })

  it('Typora 尺寸语法 =宽x高', () => {
    expect(parseImage('![a](pic.png =600x400)')).toEqual({
      alt: 'a',
      src: 'pic.png',
      width: 600,
      height: 400
    })
  })

  it('只写宽（不写高），高为 undefined', () => {
    expect(parseImage('![a](pic.png =300x)')).toEqual({
      alt: 'a',
      src: 'pic.png',
      width: 300,
      height: undefined
    })
  })

  it('尺寸语法带空格 = 600 × 400', () => {
    expect(parseImage('![a](pic.png = 600x400)')).toMatchObject({
      src: 'pic.png',
      width: 600,
      height: 400
    })
  })

  it('非图片语法返回 null', () => {
    expect(parseImage('普通文本[链接](x)')).toBeNull()
    expect(parseImage('![缺括号](src')).toBeNull()
  })
})
