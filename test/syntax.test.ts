import { readFileSync } from 'node:fs'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { IterMode, type Tree } from '@lezer/common'
import { describe, expect, it } from 'vitest'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'
import { parsedTree } from '../src/renderer/editor/syntax'

/**
 * `parsedTree` 的**快照分支**（0.2.x 提速）：快照已经盖住要的那一段时直接用它，
 * 不再 `ensureSyntaxTree`。省下的是一笔不小的钱 —— 只要文档里有带语言的代码块，
 * ensure 每次翻视口都会 cutFragments + reset，1 万行实测 12.5ms/键。
 *
 * **这份断言守的是那个分支的前提**：盖住全文的快照，与强制 ensure 出来的树，
 * 在**外层结构**上必须是同一棵。前提一旦不成立，症状是「某个表格/公式偶尔不出现」，
 * 而且只在有代码块的长文档上偶发 —— 肉眼几乎抓不到，只能靠这一条。
 *
 * 两处口径要说清楚：
 * - **比的是 `IterMode.IgnoreMounts`**：嵌套语言的内层树本来就可能只有一边有
 *   （ensure 把视口挪到全文，于是连视口外的代码块也一并解析），而**本仓库没有一个
 *   `parsedTree` 的消费者读内层挂载** —— 块级装饰、大纲、表格取数、行内文本、导出
 *   全都只看外层块（导出的代码高亮是自己 `parser.parse(src)` 另起一棵树）。
 * - **快照没盖住全文的那几轮跳过**：那时候本来就走 ensure，没什么可比的。
 *   所以这条测试不吃机器负载 —— 只在分支真被走到时才断言。
 */

/** 外层结构：每个节点的名字与范围（不进嵌套语言的内层树） */
function shape(tree: Tree, to: number): string {
  const out: string[] = []
  tree.iterate({
    from: 0,
    to,
    mode: IterMode.IgnoreMounts,
    enter: (n) => {
      out.push(`${n.name}@${n.from}-${n.to}`)
      return undefined
    }
  })
  return out.join(' ')
}

function make(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [cursiveMarkdown()] })
}

/**
 * 在一份文档上走一串改动，每一步都比对两棵树。
 * 返回真比过的轮数 —— 调用方要断言它非零，否则「跳过」会让这条测试悄悄空跑。
 */
function compareThroughEdits(text: string): number {
  let state = make(text)
  ensureSyntaxTree(state, text.length, 30_000)
  let compared = 0
  const edits: { from: number; to?: number; insert?: string }[] = []
  // 文档各处各插一个字 + 插一整块 + 删一行：三种形状各覆盖一遍
  for (let i = 1; i <= 6; i++) edits.push({ from: Math.floor((text.length / 7) * i), insert: '字' })
  edits.push({ from: Math.floor(text.length / 2), insert: '\n\n| 新 | 表 |\n| --- | --- |\n| 1 | 2 |\n\n' })
  edits.push({ from: Math.floor(text.length / 3), insert: '\n\n$$\ny = 1\n$$\n\n' })
  for (const changes of edits) {
    state = state.update({ changes }).state
    const snap = syntaxTree(state)
    if (snap.length < state.doc.length) continue // 这一轮本来就走 ensure
    const forced = ensureSyntaxTree(state, state.doc.length, 30_000)
    if (!forced) continue
    compared++
    expect(shape(snap, state.doc.length)).toBe(shape(forced, state.doc.length))
  }
  return compared
}

const FIXTURES = [
  'kitchen-sink.md',
  'dialect.md',
  'callout.md',
  'math.md',
  'mermaid.md',
  'export.md'
]

describe('parsedTree 的快照分支：盖住全文的快照 === 强制 ensure 的树', () => {
  for (const name of FIXTURES) {
    it(`${name}：逐次改动后两棵树的外层结构一致`, () => {
      const compared = compareThroughEdits(readFileSync(`test/fixtures/${name}`, 'utf8'))
      expect(compared, '一轮都没比上，这条测试在空跑').toBeGreaterThan(0)
    })
  }

  // 带语言的代码块正是 ensure 会 reset 的那种文档（`skipped` 区间），也正是这次提速
  // 要救的那种。它必须与别的文档一样对得上，否则省下来的 10ms 是拿正确性换的
  it('掺满 ```ts 的长文档（ensure 会 reset 的那种）', () => {
    const parts: string[] = []
    for (let i = 1; i <= 200; i++) {
      parts.push(`## 第 ${i} 节`, '', `第 ${i} 段正文。`, '')
      if (i % 3 === 0) parts.push('```ts', `const n = ${i}`, '```', '')
      if (i % 5 === 0) parts.push('| 甲 | 乙 |', '| --- | --- |', '| 1 | 2 |', '')
    }
    expect(compareThroughEdits(parts.join('\n'))).toBeGreaterThan(0)
  })

  /**
   * 反过来的一半：快照**不够长**时（打开文件那一刻只解析前 3000 字）必须照旧 ensure。
   * 这是 `CONTEXT.md` 里那条老坑 —— 拿半截树建装饰，一张 100 行的表只画到第 44 行。
   */
  it('快照不够长时照旧强制解析到位', () => {
    // 行要够长：3000 字是 CM 首开只解析那么多的分界线（`Work.InitViewport`）
    const rows = Array.from({ length: 150 }, (_, i) => `| 第${i + 1}行 | 数据数据数据数据 | 备注备注 |`)
    const doc = `# 标题\n\n| 甲 | 乙 | 丙 |\n| --- | --- | --- |\n${rows.join('\n')}\n`
    expect(doc.length).toBeGreaterThan(3000)
    const state = make(doc)
    expect(syntaxTree(state).length).toBeLessThan(doc.length) // 前提：快照确实只有半截
    expect(parsedTree(state).length).toBe(doc.length) // parsedTree 必须把它补齐
  })
})
