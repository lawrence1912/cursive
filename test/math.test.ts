import { describe, expect, it } from 'vitest'
import { extractFence, renderMath } from '../src/renderer/editor/live-preview/widgets'

describe('KaTeX 渲染', () => {
  it('正常公式输出 .katex HTML', () => {
    expect(renderMath('x^2', false)).toContain('katex')
    expect(renderMath('e^{-x^2}', false)).toContain('katex')
  })

  it('displayMode 产出块级结构', () => {
    expect(renderMath('\\frac{1}{2}', true)).toContain('katex-display')
  })

  it('非法公式不抛异常，回退为红色源码（throwOnError:false）', () => {
    // katex 0.18 的错误回退不是 .katex-error 类，而是把非法记号内联染成 color:#cc0000
    const html = renderMath('\\fraud{1}', false)
    expect(html).toContain('color:#cc0000')
    expect(html).toContain('\\fraud')
  })
})

describe('FencedCode 拆解（mermaid 用）', () => {
  it('提取语言与代码体，闭围栏不算内容', () => {
    const f = extractFence('```mermaid\nflowchart TD\n  a --> b\n```')
    expect(f).toEqual({ lang: 'mermaid', src: 'flowchart TD\n  a --> b' })
  })

  it('未闭合的围栏：内容到结尾为止', () => {
    const f = extractFence('```mermaid\nflowchart TD\n  a --> b')
    expect(f?.src).toBe('flowchart TD\n  a --> b')
  })

  it('波浪线围栏与带参数的 info string', () => {
    expect(extractFence('~~~mermaid strict\na --> b\n~~~')).toEqual({
      lang: 'mermaid',
      src: 'a --> b'
    })
    expect(extractFence('```ts live\nconst a = 1\n```')?.lang).toBe('ts')
  })
})
