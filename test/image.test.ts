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

  it('尺寸语法 =宽x高', () => {
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

  it('尖括号目的地：脱掉括号，`>` 不许留在 src 里', () => {
    // 贪婪那版写成 `<?([^)\s]+)>?`，`[^)\s]+` 会把收尾的 `>` 一起吃进去，
    // 拼出来的 safe-file:// 找不到文件，图必裂
    expect(parseImage('![a](<pic.png>)')).toEqual({ alt: 'a', src: 'pic.png' })
  })

  it('尖括号目的地：文件名带空格（这是唯一的写法），尺寸照样认', () => {
    expect(parseImage('![a](<中文 图.png>)')).toEqual({ alt: 'a', src: '中文 图.png' })
    expect(parseImage('![a](<中文 图.png> =600x400)')).toEqual({
      alt: 'a',
      src: '中文 图.png',
      width: 600,
      height: 400
    })
    expect(parseImage('![a](<中文 图.png> "标题")')).toEqual({ alt: 'a', src: '中文 图.png' })
  })

  it('裸写的目的地允许空格（方言放宽：markdown-lang.ts 的 SpacedLink 会给节点）', () => {
    expect(parseImage('![图](我的 图.png)')).toEqual({ alt: '图', src: '我的 图.png' })
    // 尺寸段与标题不能被目的地吃进去
    expect(parseImage('![图](我的 图.png =600x400)')).toEqual({
      alt: '图',
      src: '我的 图.png',
      width: 600,
      height: 400
    })
    expect(parseImage('![图](我的 图.png "说明")')).toEqual({ alt: '图', src: '我的 图.png' })
  })

  it('非图片语法返回 null', () => {
    expect(parseImage('普通文本[链接](x)')).toBeNull()
    expect(parseImage('![缺括号](src')).toBeNull()
    // 解析得出来但没有目的地：当成「不是图片」，编辑器与导出一致地留下源码
    expect(parseImage('![a](<>)')).toBeNull()
  })
})
