import { describe, expect, it } from 'vitest'
import { withImageSize } from '../src/renderer/editor/markdown-lang'

/**
 * 拖角改尺寸（0.2.x）写回源码的那一步。
 *
 * 拖拽本身是 DOM，进不了 node 测试；会写坏文档的全在这个纯函数里 ——
 * 尤其「什么时候**不该**写」：写进一条两边解析器都不认的源码，屏幕上就是一串裸文字。
 */
describe('写回图片尺寸', () => {
  it('本来就有尺寸 = 原地换掉', () => {
    expect(withImageSize('![图](a.png =600x400)', 300, 200)).toBe('![图](a.png =300x200)')
  })

  it('本来没有 = 插在目的地后面', () => {
    expect(withImageSize('![图](a.png)', 300, 200)).toBe('![图](a.png =300x200)')
  })

  it('尖括号目的地（文件名带空格）照样成立，括号原样留着', () => {
    expect(withImageSize('![图](<我的 图.png>)', 120, 90)).toBe('![图](<我的 图.png> =120x90)')
  })

  it('空 alt、只写宽、大写 X 都认', () => {
    expect(withImageSize('![](a.png)', 50, 50)).toBe('![](a.png =50x50)')
    expect(withImageSize('![图](a.png =600x)', 80, 60)).toBe('![图](a.png =80x60)')
    expect(withImageSize('![图](a.png =600X400)', 80, 60)).toBe('![图](a.png =80x60)')
  })

  it('小数与 0 都收敛成正整数 —— 文档里不该出现 `=300.4x200`', () => {
    expect(withImageSize('![图](a.png)', 300.4, 200.6)).toBe('![图](a.png =300x201)')
    expect(withImageSize('![图](a.png)', 0, -5)).toBe('![图](a.png =1x1)')
  })

  it('**带标题的不写**：尺寸 + 标题两边解析器都不认，硬写等于把图写坏', () => {
    expect(withImageSize('![图](a.png "说明")', 300, 200)).toBeNull()
    expect(withImageSize("![图](a.png '说明')", 300, 200)).toBeNull()
  })

  it('不是一整条图片源码的一律不碰', () => {
    expect(withImageSize('前面 ![图](a.png)', 300, 200)).toBeNull()
    expect(withImageSize('![图](a.png) 后面', 300, 200)).toBeNull()
    expect(withImageSize('[链接](a.md)', 300, 200)).toBeNull()
    expect(withImageSize('![图][ref]', 300, 200)).toBeNull()
  })
})
