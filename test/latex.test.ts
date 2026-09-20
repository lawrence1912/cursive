import katex from 'katex'
import { describe, expect, it } from 'vitest'
import { LATEX_COMMANDS, latexInsert } from '../src/renderer/editor/latex'

/**
 * 公式命令表（0.4.0 F3 的第七个补全源）与**真的 KaTeX** 对账。
 *
 * KaTeX 只暴露 `__defineSymbol` / `__defineFunction` 这类写入口，它自己那张表读不到 ——
 * 所以 `editor/latex.ts` 只能自己列一份。而「补全里有、KaTeX 却不认」这种漂移
 * 光靠自觉挡不住：这里把表里每一条拿 KaTeX 渲染一遍，渲不出来就红。
 * 升级 katex 之后哪条没了，第一时间在这儿知道。
 */
describe('公式命令表', () => {
  it('每一条都是 KaTeX 真认的（渲不出来就是表写错了）', () => {
    const bad: string[] = []
    for (const c of LATEX_COMMANDS) {
      try {
        katex.renderToString(latexInsert(c), { throwOnError: true })
      } catch (e) {
        bad.push(`${c.cmd} → ${(e as Error).message.slice(0, 60)}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('命令名都以反斜杠开头、没有重复', () => {
    const names = LATEX_COMMANDS.map((c) => c.cmd)
    expect(names.filter((n) => !n.startsWith('\\'))).toEqual([])
    expect(names.length).toBe(new Set(names).size)
  })

  it('每一条都有右边那一列（符号或一句话）', () => {
    expect(LATEX_COMMANDS.filter((c) => !c.hint.trim())).toEqual([])
  })

  it('够用：希腊字母、结构、函数名都在（表太小等于没做）', () => {
    const names = new Set(LATEX_COMMANDS.map((c) => c.cmd))
    for (const must of ['\\alpha', '\\Omega', '\\frac', '\\sqrt', '\\sum', '\\int', '\\log', '\\times'])
      expect(names.has(must), must).toBe(true)
    expect(LATEX_COMMANDS.length).toBeGreaterThan(80)
  })
})
