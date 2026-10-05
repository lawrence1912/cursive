import { describe, expect, it } from 'vitest'
import katex from 'katex'
import { EditorState } from '@codemirror/state'
import { history, undo } from '@codemirror/commands'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'
import { formatLatex, latexFormatSpec } from '../src/renderer/editor/latex-format'

const render = (tex: string) => katex.renderToString(tex, { output: 'html', displayMode: true, strict: false })
const state = (doc: string, from = 0, to = from) => EditorState.create({
  doc, selection: { anchor: from, head: to }, extensions: [cursiveMarkdown(), history()]
})

describe('LaTeX 源码格式化', () => {
  const compact = String.raw`\begin{aligned}a&=b+c\\d&=\frac{1}{2}\end{aligned}`
  const pretty = String.raw`\begin{aligned}
  a &= b + c \\
  d &= \frac{1}{2}
\end{aligned}`

  it('按环境与公式行缩进，运算符两侧留空格', () => {
    expect(formatLatex(compact, true)).toBe(pretty)
    expect(formatLatex(pretty, true)).toBe(pretty)
    expect(render(pretty)).toBe(render(compact))
  })

  it.each([
    String.raw`\begin{cases}x+1&x>0\\-x&x<0\end{cases}`,
    String.raw`\begin{pmatrix}1&2\\[2pt]3&4\end{pmatrix}`,
    String.raw`\begin{aligned}A&=\begin{bmatrix}a&b\\c&d\end{bmatrix}\\x&=1\end{aligned}`,
    String.raw`\text{a  + b = c}\quad x+\frac{a+b}{c}`,
    String.raw`\left\{x\in\mathbb{R}:x>0\right\}`,
    String.raw`\begin{array}{cc}1&2\\3&4\end{array}`,
    String.raw`\begin{alignedat}{2}a&=b&c&=d\end{alignedat}`,
    'x+1% 注释含 \\begin{matrix} 和 }\n+y',
    String.raw`\text{escaped \% and \{ braces \}}+x`,
    String.raw`a\ b+1`,
    String.raw`x_1^-2+\sqrt[3]{x+1}`
  ])('保留公式语义与幂等性：%s', (tex) => {
    const result = formatLatex(tex, true)
    expect(render(result)).toBe(render(tex))
    expect(formatLatex(result, true)).toBe(result)
  })

  it('行内公式不引入换行', () => {
    expect(formatLatex('x=1+2', false)).toBe('x = 1 + 2')
    expect(formatLatex(compact, false)).not.toContain('\n')
  })

  it('光标只处理所在公式，保留正文与另一公式', () => {
    const s = state('正文 $x=1+2$；另一个 $y=3$。', 5)
    const result = latexFormatSpec(s, katex)
    expect(s.update(result.spec!).state.doc.toString()).toBe('正文 $x = 1 + 2$；另一个 $y=3$。')
    expect(result.changed).toBe(1)
  })

  it('多公式选区一次撤销恢复全部原文', () => {
    const doc = '$x=1$\n\n$$' + compact + '$$'
    let s = state(doc, 0, doc.length)
    const result = latexFormatSpec(s, katex)
    expect(result.changed).toBe(2)
    s = s.update(result.spec!).state
    expect(s.doc.toString()).toContain('$$\n' + pretty + '\n$$')
    expect(undo({ state: s, dispatch: tr => { s = tr.state } })).toBe(true)
    expect(s.doc.toString()).toBe(doc)
  })

  it('支持选中的纯 LaTeX，未选中正文不动', () => {
    const s = state(compact, 0, compact.length)
    expect(s.update(latexFormatSpec(s, katex).spec!).state.doc.toString()).toBe(pretty)
    expect(latexFormatSpec(state('普通段落'), katex).spec).toBeNull()
    const simple = state('x=1', 0, 3)
    expect(simple.update(latexFormatSpec(simple, katex).spec!).state.doc.toString()).toBe('x = 1')
  })

  it('代码示例与货币不当作公式，未闭合公式不补写', () => {
    for (const doc of ['`$x=1$`', '```tex\n$x=1$\n```', '费用 $5，另收 $8', '$$\nx=1']) {
      const s = state(doc, 0, doc.length)
      expect(latexFormatSpec(s, katex).spec).toBeNull()
    }
  })

  it('非法公式保留原文，其他合法公式仍可格式化', () => {
    const doc = '$\\fraud{1}$ 与 $x=1$'
    const s = state(doc, 0, doc.length)
    const result = latexFormatSpec(s, katex)
    expect(result.skipped).toBe(1)
    expect(result.changed).toBe(1)
    expect(s.update(result.spec!).state.doc.toString()).toBe('$\\fraud{1}$ 与 $x = 1$')
  })

  it('只读 state 不产生修改', () => {
    const s = EditorState.create({ doc: '$x=1$', selection: { anchor: 2 },
      extensions: [cursiveMarkdown(), EditorState.readOnly.of(true)] })
    expect(latexFormatSpec(s, katex).spec).toBeNull()
  })

  it('无法保持渲染一致的 verbatim 文本不改写', () => {
    const doc = String.raw`$\verb|a+b|$`
    const result = latexFormatSpec(state(doc, 3), katex)
    expect(result.spec).toBeNull()
    expect(result.skipped).toBe(1)
  })

  it('块公式闭定界符后的空格可以整理，未选择的正文不改', () => {
    const s = state('前文\n\n$$x=1$$  \n\n后文', 8)
    const result = latexFormatSpec(s, katex)
    expect(s.update(result.spec!).state.doc.toString()).toBe('前文\n\n$$\nx = 1\n$$\n\n后文')
  })

  it('部分选中一个公式会整理整个公式，横跨边界的残缺选择不动', () => {
    const s = state('$x=1$ 和 $y=2$', 1, 3)
    expect(s.update(latexFormatSpec(s, katex).spec!).state.doc.toString()).toBe('$x = 1$ 和 $y=2$')
    expect(latexFormatSpec(state('$x=1$ 和 $y=2$', 3, 10), katex).spec).toBeNull()
  })
})
