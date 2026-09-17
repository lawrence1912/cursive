import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildBlocks, patchBlocks } from '../src/renderer/editor/live-preview/index'
import { tableEditField } from '../src/renderer/editor/live-preview/table'
import { collectHeadings, slugs } from '../src/renderer/editor/headings'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'

/**
 * 非功能红线三的看门狗（0.2.0 补）。
 *
 * ROADMAP 第五节写着「1 万行 + 50 个公式 + 10 张图，滚动不掉帧，打字无延迟」，
 * 但红线一（保存零损耗）和红线二（输入法）各有断言守着，**只有这一条一直没有**。
 * 而它恰恰最容易在不知不觉中退化：判断 2 定了「块级组件一律照抄 tableField」，
 * 于是每加一种块级装饰就多一遍全文遍历 —— 单看每一次改动都「只是多一个 StateField」。
 *
 * ## 这份断言要怎么读
 *
 * 阈值按「**会不会让人感觉到**」订，不是按本机跑出来的数字订：`buildBlocks` 每次
 * 文档变化都要跑一遍，掉到 120ms 就是打字时肉眼可见的迟滞（一帧的预算是 16ms）。
 * 本机实测约 4ms / 1 万行，于是还有三十倍的余量 —— CI 机器慢几倍也不会假红，
 * 但真退化一个数量级就拦得住。每次跑都会把实测值打印出来，不必改代码就能看出漂移。
 *
 * 时间是噪声大的量（ROADMAP「量启动速度的五个坑」第 1 条：同一个二进制跑 20 次，
 * 噪声带能有 ±150ms）。所以这里**跑三轮取最小值** —— min 才是「机器没在忙时」的真值。
 */

/** 一份长文档：一万行出头（红线三说的量），公式 / 图 / 表格 / 代码块 / 告示块都掺进去 */
function bigDoc(): string {
  const out: string[] = []
  // 每轮 9 行打底 + 周期性的块，1200 轮刚好越过一万行
  for (let i = 1; i <= 1200; i++) {
    out.push(`## 第 ${i} 节`, '')
    out.push(`这是第 ${i} 段正文，带 **粗体**、\`行内码\`、[链接](#锚点) 和 ==高亮==。`, '')
    out.push('- 列表项一', '- 列表项二', '  - 嵌套项', '')
    if (i % 10 === 0) out.push('$$', `E_{${i}} = mc^2`, '$$', '')
    if (i % 50 === 0) out.push(`![图 ${i}](assets/x.png)`, '')
    if (i % 25 === 0) out.push('| 甲 | 乙 |', '| --- | --- |', '| 1 | 2 |', '')
    if (i % 20 === 0) out.push('```ts', `const n = ${i}`, '```', '')
    if (i % 30 === 0) out.push(`> [!note] 提示 ${i}`, '> 正文', '')
  }
  return out.join('\n')
}

let doc: string
let state: EditorState

beforeAll(() => {
  ;(globalThis as { document?: unknown }).document ??= { documentElement: { dataset: {} } }
  doc = bigDoc()
  state = EditorState.create({ doc, extensions: [cursiveMarkdown(), tableEditField] })
  // 语法树先建好：这里量的是**装饰层**的成本，不是 lezer 的
  ensureSyntaxTree(state, doc.length, 30_000)
})

/** 跑三轮取最小 —— 单次计时在有别的进程抢 CPU 时能飘出好几倍 */
function fastest(times: number, fn: () => void): number {
  let best = Infinity
  for (let i = 0; i < times; i++) {
    const t0 = performance.now()
    fn()
    best = Math.min(best, performance.now() - t0)
  }
  return best
}

describe('长文档（红线三）', () => {
  it('夹具真的够大 —— 别让断言在一份小文档上空跑', () => {
    expect(state.doc.lines).toBeGreaterThan(10_000)
  })

  it('块级装饰全文重建 < 120ms（每次文档变化都要跑一遍）', () => {
    const ms = fastest(3, () => buildBlocks(state))
    console.log(`[perf] buildBlocks ${ms.toFixed(1)}ms / ${state.doc.lines} 行`)
    expect(ms).toBeLessThan(120)
  })

  it('块级装饰真的建出来了（不是提前返回骗过了计时）', () => {
    let n = 0
    buildBlocks(state).between(0, state.doc.length, () => {
      n++
    })
    // 公式 120 + 表 48 + 代码块 60（告示块是**行级**装饰、图片是行内的，不在这一份里）
    expect(n).toBeGreaterThan(150)
  })

  /**
   * **打字这条路不许退回全文重扫。**
   *
   * 上面那条守的是「全量重建本身别变慢」，而这一条守的是「别再走全量」——
   * 两者会一起骗人：`buildBlocks` 永远是对的，于是哪天一个过度保守的判定让每次
   * 按键都退回它，功能测试全绿、断言也全绿，只有手感悄悄变回去（1 万行 3.4ms、
   * 3 万行 10.9ms，一帧的预算是 16ms）。
   *
   * 比的是**比值而不是毫秒**：时间是噪声大的量（见文件头那段），而「增量比全量便宜
   * 一个数量级」是机制决定的、与机器快慢无关 —— 比值把机器快慢约掉了。本机实测
   * 约 19 倍（0.11ms vs 2.2ms），卡在 5 倍：退回全量时这个比值会掉到 1 附近，
   * 5 倍既拦得住又不会被单次抖动误伤。
   * 树先备好 —— 这里量的是装饰层的成本，不是 lezer 的（与上面那条同一口径）。
   */
  it('打字走增量：每按一个键的块级重建 < 全量的 1/5', () => {
    // 在一段正文中间连打：围栏行与标题行按机制退回全量（见 live-preview/index.ts 的
    // `pairingRisk` 与 `tocDocs`），拿它们当基准等于在量 buildBlocks 自己
    const anchor = doc.indexOf('这是第 900 段正文') + 6
    expect(anchor).toBeGreaterThan(0)
    let s = state
    const times: number[] = []
    for (let i = 0; i < 20; i++) {
      const value = buildBlocks(s)
      const tr = s.update({ changes: { from: anchor + i, insert: '字' } })
      ensureSyntaxTree(tr.state, tr.state.doc.length, 30_000)
      const t0 = performance.now()
      const patched = patchBlocks(value, s, tr.state, tr.changes)
      times.push(performance.now() - t0)
      expect(patched, `第 ${i} 个字`).not.toBeNull()
      s = tr.state
    }
    const sorted = [...times].sort((a, b) => a - b)
    const patch = sorted[Math.floor(sorted.length / 2)]!
    const full = fastest(3, () => buildBlocks(s))
    console.log(`[perf] 按键增量 ${patch.toFixed(2)}ms vs 全量 ${full.toFixed(1)}ms（${(full / patch).toFixed(0)}×）`)
    expect(patch * 5).toBeLessThan(full)
  })

  it('大纲取数 < 120ms（[TOC]、大纲面板、锚点补全共用这一条）', () => {
    const ms = fastest(3, () => slugs(collectHeadings(state)))
    console.log(`[perf] collectHeadings+slugs ${ms.toFixed(1)}ms`)
    expect(ms).toBeLessThan(120)
  })

  it('大纲条数对得上（1200 个二级标题）', () => {
    expect(collectHeadings(state).length).toBe(1200)
  })
})
