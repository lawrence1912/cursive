import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { beforeAll, describe, expect, it } from 'vitest'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'
import { setTableEdit, tableEditField } from '../src/renderer/editor/live-preview/table'
import { blockField, buildBlocks, livePreview, patchBlocks } from '../src/renderer/editor/live-preview/index'
import { revealScope } from '../src/renderer/editor/live-preview/reveal'

// widgets.ts 的 currentTheme（mermaid 分支用）读 document.documentElement，
// node 测试环境补一个最小桩
beforeAll(() => {
  ;(globalThis as { document?: unknown }).document ??= {
    documentElement: { dataset: {} }
  }
})

function decos(doc: string, anchor?: number, editAt?: number): string[] {
  let state = EditorState.create({
    doc,
    selection: anchor === undefined ? undefined : { anchor },
    extensions: [cursiveMarkdown(), tableEditField]
  })
  if (editAt !== undefined) state = state.update({ effects: setTableEdit.of(editAt) }).state
  ensureSyntaxTree(state, doc.length, 5000)
  const out: string[] = []
  buildBlocks(state).between(0, doc.length, (f, t, v) => {
    const widget = (v.spec as { widget?: { constructor: { name: string } } }).widget
    out.push(`${f}-${t}:${widget?.constructor.name ?? '?'}`)
  })
  return out
}

describe('块级装饰（blockField 的纯函数，不依赖 DOM）', () => {
  it('DisplayMath → MathWidget 块级替换', () => {
    const doc = 'A\n\n$$\nx = 1\n$$\n'
    expect(decos(doc)).toEqual([`3-${doc.trimEnd().length}:MathWidget`])
  })

  it('光标进入数学块 → 回显源码，不再出 widget', () => {
    expect(decos('A\n\n$$\nx = 1\n$$\n', 8)).toEqual([])
  })

  it('Table → TableWidget；光标碰到同样回落', () => {
    const doc = '前文\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'
    expect(decos(doc)).toEqual([`4-${doc.trimEnd().length}:TableWidget`])
    // 光标落在表格行上 → 回显源码
    expect(decos(doc, 10)).toEqual([])
  })

  it('就地编辑中的表格：光标落在表格行上也不回落源码', () => {
    const doc = '前文\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'
    // 没进编辑态：老规矩，光标碰到就回显源码
    expect(decos(doc, 10)).toEqual([])
    // tableEditField 指向这张表 → reveal 判定对它失效，widget 照常出
    expect(decos(doc, 10, 4)).toEqual([`4-${doc.trimEnd().length}:TableWidget`])
    // 指向别的位置不算数
    expect(decos(doc, 10, 0)).toEqual([])
  })

  it('mermaid 代码块 → MermaidWidget；其它语言不换', () => {
    const doc = '图：\n\n```mermaid\nflowchart TD\n a-->b\n```'
    expect(decos(doc)).toEqual([`4-${doc.trimEnd().length}:MermaidWidget`])
    // 光标进入代码块 → 源码
    expect(decos(doc, 10)).toEqual([])
    // 非 mermaid 围栏不换 widget
    expect(decos('代码：\n\n```ts\nconst a = 1\n```')).toEqual([])
  })

  it('FootnoteDefinition → FootnoteDefWidget；光标进入回落', () => {
    const doc = '前文\n\n[^1]: 这是定义\n'
    expect(decos(doc)).toEqual([`4-${doc.trimEnd().length}:FootnoteDefWidget`])
    expect(decos(doc, 10)).toEqual([])
  })

  it('TocBlock → TocWidget，收集全文标题', () => {
    const doc = '目录：\n\n[TOC]\n\n# 一\n\n## 二\n'
    // TocBlock 只盖 [TOC] 那一行
    expect(decos(doc)).toEqual(['5-10:TocWidget'])
  })

  // 打开文件那一刻 CM 只解析前 3000 字（Work.InitViewport），而 ensureSyntaxTree
  // 推进的是 ParseContext、**不回填 syntaxTree(state) 那份快照** —— 老代码在这里
  // 会拿半截树建 widget：一张 100 行的表首开只画到跨过 3000 字的那一行，点一下
  // （任何事务都会刷新快照）又突然长全，视口跟着乱跳。
  it('首开长文档：表格不因半截树被截断（不预先 ensure，复刻打开文件）', () => {
    const rows = Array.from({ length: 150 }, (_, i) => `| 第${i + 1}行 | 数据数据数据数据 | 备注备注 |`)
    const doc = `# 标题\n\n| 甲 | 乙 | 丙 |\n| --- | --- | --- |\n${rows.join('\n')}\n`
    expect(doc.length).toBeGreaterThan(3000) // 不跨过 3000 字就测不到这个坑
    const state = EditorState.create({ doc, extensions: [cursiveMarkdown(), tableEditField] })

    const out: { from: number; to: number; rows: number }[] = []
    buildBlocks(state).between(0, doc.length, (from, to, v) => {
      const w = (v.spec as { widget?: { data?: { rows: unknown[] } } }).widget
      out.push({ from, to, rows: w?.data?.rows.length ?? -1 })
    })
    expect(out).toEqual([{ from: 6, to: doc.trimEnd().length, rows: 150 }])
  })
})

/**
 * 增量重建（`patchBlocks`）：只动选区时不重扫全文，只重建光标离开/进入的那两段。
 * 它必须与全量重建**逐条相同** —— 这条路一旦漂移，症状是「某个表格/公式在光标
 * 路过之后就消失了」，而且只在长文档上偶发，靠肉眼极难抓。所以这里把一串光标位置
 * 逐个走一遍，每一步都跟 `buildBlocks` 的结果对账。
 */
describe('块级装饰增量重建 === 全量重建', () => {
  // fixture 里这两样是**踩过坑才加的**，别删：
  //  · YAML frontmatter —— 正文会被套进**第二层 Document**（Document → [FrontMatter,
  //    Document]），脏区按「一路撑到整棵树之下」算就会变成整份文档，增量等于没生效；
  //  · 折叠告示块 `> [!note]-` —— 它的装饰从首行末尾起（`head.to → node.to`），
  //    而成不成立看的是**整块**有没有被光标碰到；两者范围不一致，脏区不撑到块边界
  //    就会把它漏在那儿不撤（`reveal=node` 下必现）。
  const doc = [
    '---',
    'title: 测试',
    'tags: [a, b]',
    '---',
    '',
    '# 标题',
    '',
    '正文一段，带 **粗体** 和 `代码`。',
    '',
    '> [!note]- 这一条默认折起',
    '> 折叠态的装饰从首行末尾画到块尾，和节点范围对不上。',
    '> 第三行。',
    '',
    '| 甲 | 乙 |',
    '| :-- | --: |',
    '| 1 | 2 |',
    '| 3 | 4 |',
    '',
    '$$',
    'x = 1',
    '$$',
    '',
    '> [!note] 告示',
    '> 正文',
    '',
    '```mermaid',
    'flowchart LR',
    '  A --> B',
    '```',
    '',
    '[TOC]',
    '',
    '## 小节',
    '',
    '又一段正文，后面跟一条脚注[^1]。',
    '',
    '[^1]: 脚注定义',
    ''
  ].join('\n')

  function dump(set: ReturnType<typeof buildBlocks>): string[] {
    const out: string[] = []
    set.between(0, doc.length, (f, t, v) => {
      const widget = (v.spec as { widget?: { constructor: { name: string } } }).widget
      out.push(`${f}-${t}:${widget?.constructor.name ?? '?'}`)
    })
    return out
  }

  for (const scope of ['line', 'block', 'node'] as const) {
    it(`reveal=${scope}：每一个光标位置都对得上`, () => {
      let state = EditorState.create({
        doc,
        extensions: [cursiveMarkdown(), livePreview(), revealScope.of(scope)]
      })
      ensureSyntaxTree(state, doc.length, 5000)
      let patchedAtLeastOnce = false

      // **一个字符一个字符地走**，不是跳着采样：折叠告示块那个坑只在光标正好落在
      //「块起点到首行末尾」之间才露头（装饰从首行末尾才开始），跳着走很容易整段跨过去
      for (let anchor = 0; anchor <= doc.length; anchor += 1) {
        const before = state
        const next = before.update({ selection: { anchor } }).state
        const patched = patchBlocks(buildBlocks(before), before, next)
        if (patched) {
          patchedAtLeastOnce = true
          expect(dump(patched), `光标 ${anchor}`).toEqual(dump(buildBlocks(next)))
        }
        state = next
      }
      expect(patchedAtLeastOnce).toBe(true)
    })
  }

  it('选区横跨半份文档时退回全量重建（返回 null）', () => {
    const state = EditorState.create({ doc, extensions: [cursiveMarkdown(), livePreview()] })
    ensureSyntaxTree(state, doc.length, 5000)
    const all = state.update({ selection: { anchor: 0, head: doc.length } }).state
    expect(patchBlocks(buildBlocks(state), state, all)).toBeNull()
  })
})

/**
 * 上面比的是「结果对不对」，这里比的是「有没有白干」：只动选区时，远处那些块的
 * 装饰对象必须**原样留着**（`RangeSet` 把没碰的块整段搬过去）。一旦哪天又退回
 * 全量重扫，每个块都会换成新造的 widget 对象，这条就会红 —— 长文档里移动光标
 * 从 0.05ms 变回 9ms 是无声的，只能靠这种身份比对守住。
 */
describe('只动选区不重扫全文', () => {
  it('远处的块级装饰对象原样保留', () => {
    const rows = Array.from({ length: 60 }, (_, i) => `| 第${i + 1}行 | 数据 |`)
    // 正文里**必须有带语言的围栏**：嵌套语言的解析会在 ParseContext 上留下 skipped
    // 区间，`ensureSyntaxTree` 每次翻视口都会因此 reset 并换一棵新树 —— 「树变了就
    // 全量重建」的旧写法正是在这种文档上死循环的。没有围栏就复刻不出这个坑。
    const tail = Array.from(
      { length: 150 },
      (_, i) => `第 ${i + 1} 段正文，离那张表很远。\n\n\`\`\`ts\nconst x${i} = ${i}\n\`\`\``
    )
    const doc = `| 甲 | 乙 |\n| --- | --- |\n${rows.join('\n')}\n\n${tail.join('\n\n')}\n`
    let state = EditorState.create({
      doc,
      extensions: [cursiveMarkdown(), livePreview()]
    })
    ensureSyntaxTree(state, doc.length, 5000)

    const tableWidget = (s: EditorState): unknown => {
      let found: unknown = null
      s.field(blockField).between(0, 10, (_f, _t, v) => {
        found = (v.spec as { widget?: unknown }).widget
      })
      return found
    }

    // 先走一个事务让快照追平（首开时快照只到 3000 字，那一次本来就该全量重建）
    state = state.update({ selection: { anchor: doc.length - 20 } }).state
    const first = tableWidget(state)
    expect(first).toBeTruthy()

    // 之后在文末附近来回挪光标：那张表离得远，不该被重建
    for (let i = 1; i <= 5; i++) {
      state = state.update({ selection: { anchor: doc.length - 20 - i } }).state
      expect(tableWidget(state), `第 ${i} 次移动`).toBe(first)
    }
  })
})
