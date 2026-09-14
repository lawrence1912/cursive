import { beforeAll, describe, expect, it, vi } from 'vitest'
import { extractFence } from '../src/renderer/editor/live-preview/code'
import { loadKatex, renderMath } from '../src/renderer/editor/live-preview/widgets'

// katex 改成按需加载之后（P4-6②）renderMath 在模块到手前返回 null。
// 编辑器里由 fillMath 先摆源码、加载完再换；这里断言的是「到手之后渲染成什么」
beforeAll(async () => {
  await loadKatex()
})

describe('KaTeX 渲染', () => {
  it('模块没到手时返回 null（调用方据此先摆源码占位）', async () => {
    // 拿一份全新的模块实例来看「加载之前」那一刻 —— fillMath 的占位分支、
    // 导出那条 `<code>` 兜底都挂在这个返回值上，不守住它会静默退化
    vi.resetModules()
    const fresh = await import('../src/renderer/editor/live-preview/widgets')
    expect(fresh.renderMath('x^2', false)).toBeNull()
    expect(fresh.katexNow()).toBeNull()
  })

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
