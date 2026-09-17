import { describe, expect, it } from 'vitest'
import { needsKatex, needsMermaid } from '../src/renderer/editor/warmup'

/**
 * 预热的判据（`editor/warmup.ts`）。守的是**分寸**而不是正确性：
 * 认错了只多拖一个 chunk，漏认了只回到「先摆源码、加载完再换」那个样子。
 * 但有一条不能松 —— **`$5` 这种价格写法不算公式**，否则每份带价钱的文档
 * 都要在后台白拖 261 KB 的 katex 进来，P4-6② 砍首屏 JS 的成果就漏了一半。
 */
describe('要不要预热 katex', () => {
  it('闭合的行内公式算', () => {
    expect(needsKatex('前面 $E = mc^2$ 后面')).toBe(true)
  })

  it('块级公式算', () => {
    expect(needsKatex('前文\n\n$$\nx = 1\n$$\n')).toBe(true)
  })

  it('孤零零一个价格不算', () => {
    expect(needsKatex('这件事花了 $5 就搞定了')).toBe(false)
    expect(needsKatex('预算 $100，实付 $80')).toBe(true) // 两个价格确实会配上对：认错的代价只是多热一次
  })

  it('没有美元符号的文档不算', () => {
    expect(needsKatex('# 标题\n\n正文，带 **粗体** 和 `代码`。\n')).toBe(false)
  })

  it('跨行的两个 $ 不算（公式不跨行配对）', () => {
    expect(needsKatex('第一行 $ 开头\n第二行 $ 结尾')).toBe(false)
  })
})

describe('要不要预热 mermaid', () => {
  it('围栏语言是 mermaid 才算', () => {
    expect(needsMermaid('```mermaid\nflowchart LR\n A --> B\n```')).toBe(true)
    expect(needsMermaid('~~~mermaid\nflowchart LR\n~~~')).toBe(true)
    expect(needsMermaid('```ts\nconst a = 1\n```')).toBe(false)
  })

  it('缩进的围栏也算，正文里提一句「mermaid」不算', () => {
    expect(needsMermaid('- 列表\n  ```mermaid\n  flowchart LR\n  ```')).toBe(true)
    expect(needsMermaid('我们用 mermaid 画图。')).toBe(false)
  })
})
