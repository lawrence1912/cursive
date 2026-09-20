/**
 * 公式命令表（0.4.0 F3 的第七个补全源）。
 *
 * **为什么这里非得自己列一份**：KaTeX 对外只暴露 `__defineSymbol` / `__defineFunction`
 * 这类**写**入口，它自己那张表读不到（`Object.keys(katex)` 亲自数过）。
 * 于是「补全里有、KaTeX 却不认」这种漂移只能用断言挡：`test/latex.test.ts` 拿
 * **真的 KaTeX** 把每一条渲染一遍，渲不出来就红 —— 升级 katex 之后第一时间知道。
 *
 * 表不求全（KaTeX 支持好几百条），只收**中文写作里真的会打**的那些：
 * 希腊字母、常用关系/运算符、箭头、大算符、函数名、结构与装饰。
 * 打 `\` 之后按名字过滤，CM 的模糊匹配会替我们干剩下的事。
 */
export interface LatexCommand {
  /** 命令名，带反斜杠。补全面板里的 label */
  cmd: string
  /** 真正插进文档的文本（默认与 `cmd` 相同）。带占位大括号的在这儿写出来 */
  insert?: string
  /** 插完光标落在 `insert` 的第几个字符后面。不写就落在第一对 `{}` 里，再没有就落到末尾 */
  caret?: number
  /** 右边那一列：能画出来的画符号，画不出来的写一句话 */
  hint: string
}

/** 希腊字母（小写常用的那些 + 几个大写） */
const GREEK: LatexCommand[] = [
  { cmd: '\\alpha', hint: 'α' },
  { cmd: '\\beta', hint: 'β' },
  { cmd: '\\gamma', hint: 'γ' },
  { cmd: '\\delta', hint: 'δ' },
  { cmd: '\\epsilon', hint: 'ϵ' },
  { cmd: '\\varepsilon', hint: 'ε' },
  { cmd: '\\zeta', hint: 'ζ' },
  { cmd: '\\eta', hint: 'η' },
  { cmd: '\\theta', hint: 'θ' },
  { cmd: '\\iota', hint: 'ι' },
  { cmd: '\\kappa', hint: 'κ' },
  { cmd: '\\lambda', hint: 'λ' },
  { cmd: '\\mu', hint: 'μ' },
  { cmd: '\\nu', hint: 'ν' },
  { cmd: '\\xi', hint: 'ξ' },
  { cmd: '\\pi', hint: 'π' },
  { cmd: '\\rho', hint: 'ρ' },
  { cmd: '\\sigma', hint: 'σ' },
  { cmd: '\\tau', hint: 'τ' },
  { cmd: '\\upsilon', hint: 'υ' },
  { cmd: '\\phi', hint: 'ϕ' },
  { cmd: '\\varphi', hint: 'φ' },
  { cmd: '\\chi', hint: 'χ' },
  { cmd: '\\psi', hint: 'ψ' },
  { cmd: '\\omega', hint: 'ω' },
  { cmd: '\\Gamma', hint: 'Γ' },
  { cmd: '\\Delta', hint: 'Δ' },
  { cmd: '\\Theta', hint: 'Θ' },
  { cmd: '\\Lambda', hint: 'Λ' },
  { cmd: '\\Pi', hint: 'Π' },
  { cmd: '\\Sigma', hint: 'Σ' },
  { cmd: '\\Phi', hint: 'Φ' },
  { cmd: '\\Psi', hint: 'Ψ' },
  { cmd: '\\Omega', hint: 'Ω' }
]

/** 关系与运算 */
const OPS: LatexCommand[] = [
  { cmd: '\\times', hint: '×' },
  { cmd: '\\div', hint: '÷' },
  { cmd: '\\pm', hint: '±' },
  { cmd: '\\mp', hint: '∓' },
  { cmd: '\\cdot', hint: '·' },
  { cmd: '\\cdots', hint: '⋯' },
  { cmd: '\\ldots', hint: '…' },
  { cmd: '\\leq', hint: '≤' },
  { cmd: '\\geq', hint: '≥' },
  { cmd: '\\neq', hint: '≠' },
  { cmd: '\\approx', hint: '≈' },
  { cmd: '\\equiv', hint: '≡' },
  { cmd: '\\sim', hint: '∼' },
  { cmd: '\\propto', hint: '∝' },
  { cmd: '\\in', hint: '∈' },
  { cmd: '\\notin', hint: '∉' },
  { cmd: '\\subset', hint: '⊂' },
  { cmd: '\\subseteq', hint: '⊆' },
  { cmd: '\\supset', hint: '⊃' },
  { cmd: '\\cup', hint: '∪' },
  { cmd: '\\cap', hint: '∩' },
  { cmd: '\\emptyset', hint: '∅' },
  { cmd: '\\forall', hint: '∀' },
  { cmd: '\\exists', hint: '∃' },
  { cmd: '\\neg', hint: '¬' },
  { cmd: '\\land', hint: '∧' },
  { cmd: '\\lor', hint: '∨' },
  { cmd: '\\infty', hint: '∞' },
  { cmd: '\\partial', hint: '∂' },
  { cmd: '\\nabla', hint: '∇' },
  { cmd: '\\degree', hint: '°' },
  { cmd: '\\perp', hint: '⊥' },
  { cmd: '\\parallel', hint: '∥' },
  { cmd: '\\angle', hint: '∠' }
]

/** 箭头 */
const ARROWS: LatexCommand[] = [
  { cmd: '\\to', hint: '→' },
  { cmd: '\\gets', hint: '←' },
  { cmd: '\\leftrightarrow', hint: '↔' },
  { cmd: '\\Rightarrow', hint: '⇒' },
  { cmd: '\\Leftarrow', hint: '⇐' },
  { cmd: '\\Leftrightarrow', hint: '⇔' },
  { cmd: '\\mapsto', hint: '↦' },
  { cmd: '\\uparrow', hint: '↑' },
  { cmd: '\\downarrow', hint: '↓' }
]

/** 大算符与结构 —— 带占位大括号，插完光标落在最前面那一对里 */
const STRUCT: LatexCommand[] = [
  { cmd: '\\frac', insert: '\\frac{}{}', hint: '分数' },
  { cmd: '\\dfrac', insert: '\\dfrac{}{}', hint: '行间分数' },
  { cmd: '\\sqrt', insert: '\\sqrt{}', hint: '根号' },
  { cmd: '\\sum', insert: '\\sum_{}^{}', hint: '∑' },
  { cmd: '\\prod', insert: '\\prod_{}^{}', hint: '∏' },
  { cmd: '\\int', insert: '\\int_{}^{}', hint: '∫' },
  { cmd: '\\iint', hint: '∬' },
  { cmd: '\\oint', hint: '∮' },
  { cmd: '\\lim', insert: '\\lim_{}', hint: 'lim' },
  { cmd: '\\binom', insert: '\\binom{}{}', hint: '组合数' },
  { cmd: '\\overline', insert: '\\overline{}', hint: '上横线' },
  { cmd: '\\underline', insert: '\\underline{}', hint: '下横线' },
  { cmd: '\\hat', insert: '\\hat{}', hint: '帽' },
  { cmd: '\\bar', insert: '\\bar{}', hint: '横' },
  { cmd: '\\vec', insert: '\\vec{}', hint: '向量' },
  { cmd: '\\dot', insert: '\\dot{}', hint: '点' },
  { cmd: '\\tilde', insert: '\\tilde{}', hint: '波浪' },
  { cmd: '\\boldsymbol', insert: '\\boldsymbol{}', hint: '粗体' },
  { cmd: '\\mathbb', insert: '\\mathbb{}', hint: '黑板粗' },
  { cmd: '\\mathrm', insert: '\\mathrm{}', hint: '正体' },
  { cmd: '\\text', insert: '\\text{}', hint: '文字' },
  // 成对的：`\left(` 单独一个 KaTeX 直接报错（`test/latex.test.ts` 抓到过），
  // 所以一次把两半都插进去，光标停在中间
  { cmd: '\\left(', insert: '\\left(\\right)', caret: 6, hint: '自适应括号' },
  { cmd: '\\left[', insert: '\\left[\\right]', caret: 6, hint: '自适应方括号' },
  { cmd: '\\left\\{', insert: '\\left\\{\\right\\}', caret: 7, hint: '自适应花括号' }
]

/** 函数名 */
const FUNCS: LatexCommand[] = [
  '\\sin', '\\cos', '\\tan', '\\cot', '\\sec', '\\csc',
  '\\arcsin', '\\arccos', '\\arctan', '\\sinh', '\\cosh', '\\tanh',
  '\\log', '\\ln', '\\lg', '\\exp', '\\max', '\\min', '\\det', '\\gcd', '\\deg'
].map((cmd) => ({ cmd, hint: cmd.slice(1) }))

export const LATEX_COMMANDS: LatexCommand[] = [...GREEK, ...OPS, ...ARROWS, ...STRUCT, ...FUNCS]

/** 插进文档的那一串（默认就是命令自己） */
export function latexInsert(c: LatexCommand): string {
  return c.insert ?? c.cmd
}

/**
 * 插完光标该落在哪儿（相对插入起点的偏移）。
 * 显式写了就听它的；否则落进第一对 `{}` 里；再没有就落到末尾。
 */
export function latexCaret(c: LatexCommand): number {
  if (c.caret !== undefined) return c.caret
  const insert = latexInsert(c)
  const hole = insert.indexOf('{}')
  return hole < 0 ? insert.length : hole + 1
}
