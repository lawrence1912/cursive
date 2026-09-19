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

  it('连着摞的脚注定义逐条出 widget（中间不空行也一样）', () => {
    // 修好之前：解析器只认空行收尾，两条合成一个节点，而 widget 只画第一行，
    // `[^2]` 整条在编辑器里看不见 —— test/fixtures/dialect.md 自己就是这个形状
    expect(decos('前文\n\n[^1]: 一\n[^2]: 二\n')).toEqual([
      '4-11:FootnoteDefWidget',
      '12-19:FootnoteDefWidget'
    ])
    // 空行分隔的写法本来就是对的，守住它没被改坏
    expect(decos('前文\n\n[^1]: 一\n\n[^2]: 二\n')).toHaveLength(2)
  })

  it('脚注定义的续行仍并进同一条（折叠语义不变）', () => {
    const doc = '前文\n\n[^1]: 一\n  续行\n'
    expect(decos(doc)).toEqual([`4-${doc.trimEnd().length}:FootnoteDefWidget`])
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

/**
 * 打字这条路的增量重建（`patchBlocks` 带 `changes`）—— 与上面那串光标位置同一套对账，
 * 每一步换成一次真改动。
 *
 * 它比光标那条更容易错：**一次改动能让块的边界整个搬家**，而光标动来动去时块的
 * 形状是不变的。所以这里除了逐位置扫一遍，还专门摆了三种「边界搬家」的形状 ——
 * 补收尾围栏（老树吞到文末、新树只到补的那行）、删收尾围栏（反过来）、
 * 开一个围栏把后面整篇吞掉（该退回全量）。
 */
describe('打字时的增量重建 === 全量重建', () => {
  // 与上面那份同形，但**没有 `[TOC]`**：目录是全文依赖，带着它的话改标题一律退回
  // 全量（另有用例守这条），这里要的是让尽可能多的位置真正走进增量那条路
  const doc = [
    '---',
    'title: 测试',
    '---',
    '',
    '# 标题',
    '',
    '正文一段，带 **粗体** 和 `代码`。',
    '',
    '> [!note]- 这一条默认折起',
    '> 折叠态的装饰从首行末尾画到块尾。',
    '',
    '| 甲 | 乙 |',
    '| :-- | --: |',
    '| 1 | 2 |',
    '',
    '$$',
    'x = 1',
    '$$',
    '',
    '```mermaid',
    'flowchart LR',
    '  A --> B',
    '```',
    '',
    '## 小节',
    '',
    '又一段正文[^1]。',
    '',
    '[^1]: 脚注定义',
    ''
  ].join('\n')

  function dump(set: ReturnType<typeof buildBlocks>, state: EditorState): string[] {
    const out: string[] = []
    set.between(0, state.doc.length, (f, t, v) => {
      const widget = (v.spec as { widget?: { constructor: { name: string } } }).widget
      out.push(`${f}-${t}:${widget?.constructor.name ?? '?'}`)
    })
    return out
  }

  /**
   * 走一次改动：返回增量与全量两份结果（增量退回全量时 patched 为 null）。
   *
   * **两棵树都先钉死**（`buildBlocks` 顺带缓存老树，改完再 ensure 一次新树）：这条扫描
   * 量的是**脏区算法**，不该把 lezer 的挂钟预算算进来 —— `parsedTree` 会在快照够长时
   * 直接用快照（见 `editor/syntax.ts`），而快照走到哪儿取决于 CM 那一轮 `work()` 的
   * 时间预算，机器一忙就变。不钉的话这就成了仓库里第三条「机器忙就随机变红」的测试，
   * 而 `release.sh` 是「测试全绿才出包」。
   */
  function step(
    before: EditorState,
    changes: { from: number; to?: number; insert?: string }
  ): { patched: string[] | null; full: string[] } {
    const value = buildBlocks(before)
    const tr = before.update({ changes })
    ensureSyntaxTree(tr.state, tr.state.doc.length, 5000)
    const patched = patchBlocks(value, before, tr.state, tr.changes)
    return {
      patched: patched ? dump(patched, tr.state) : null,
      full: dump(buildBlocks(tr.state), tr.state)
    }
  }

  function at(anchor: number, text = doc): EditorState {
    const state = EditorState.create({
      doc: text,
      selection: { anchor },
      extensions: [cursiveMarkdown(), livePreview()]
    })
    // 老 state 这棵树也要钉死（理由同 step()）：`parsedTree` 内部那一发 ensure 的预算
    // 是 50ms，机器满载时真的会超 —— 超了就拿半截树建 `value`，这条扫描随即变成
    // 「半截树 vs 完整树」的对账，与它要守的东西毫无关系
    ensureSyntaxTree(state, text.length, 5000)
    return state
  }

  /**
   * **命中率也要断言**：这一串对账只在「真走了增量」时才有意义，而退回全量的那条路
   * 永远是对的 —— 哪天一个过度保守的红线让每个位置都退回全量，上面的 expect 会全绿，
   * 而增量那条路已经名存实亡（每按一个键重扫全文，1 万行 3.3ms、3 万行 10.9ms）。
   * 本机实测 89%（余下的是围栏行、标题行与阈值那三种退回），卡在 70% 留足余量。
   */
  const HIT_FLOOR = 0.7

  it('每一个位置插一个字都对得上', () => {
    let hit = 0
    for (let pos = 0; pos <= doc.length; pos += 1) {
      const { patched, full } = step(at(pos), { from: pos, insert: '字' })
      if (!patched) continue
      hit++
      expect(patched, `在 ${pos} 插字`).toEqual(full)
    }
    expect(hit / (doc.length + 1)).toBeGreaterThan(HIT_FLOOR)
  })

  it('每一个位置删一个字都对得上', () => {
    let hit = 0
    for (let pos = 0; pos < doc.length; pos += 1) {
      const { patched, full } = step(at(pos), { from: pos, to: pos + 1 })
      if (!patched) continue
      hit++
      expect(patched, `删掉 ${pos}`).toEqual(full)
    }
    expect(hit / doc.length).toBeGreaterThan(HIT_FLOOR)
  })

  it('整段回车断开 / 合并两行也对得上', () => {
    for (let pos = 0; pos <= doc.length; pos += 7) {
      const enter = step(at(pos), { from: pos, insert: '\n\n' })
      if (enter.patched) expect(enter.patched, `在 ${pos} 敲两个回车`).toEqual(enter.full)
      const join = step(at(pos), { from: Math.max(0, pos - 3), to: pos })
      if (join.patched) expect(join.patched, `吞掉 ${pos} 前面三个字`).toEqual(join.full)
    }
  })

  /**
   * 围栏是**成对**的，配对跨多远都算数 —— 改动落在一条围栏行上，几百行之外那条
   * ``` 会从「收尾」变成「开头」，把后面整篇吞进代码块。那一段离脏区要多远有多远，
   * 脏区那套推理在这里不成立，只能整条交回全量（`pairingRisk`）。
   *
   * 下面三条各守一个方向。**第一条是真摔出来的**：逐位置扫描当场抓到「在 ```mermaid
   * 行首插一个字，文末的脚注定义在全量里已经被吞掉、增量那边还留着一条过期装饰」。
   */
  it('在围栏行上打字退回全量（插进去的字里一个反引号都没有也一样）', () => {
    const pos = doc.indexOf('```mermaid')
    const before = at(pos, doc)
    const value = buildBlocks(before)
    const tr = before.update({ changes: { from: pos, insert: '字' } })
    expect(patchBlocks(value, before, tr.state, tr.changes)).toBeNull()
    // 全量那边：围栏废掉之后，文末的脚注定义被后面那条 ``` 吞进代码块
    expect(dump(buildBlocks(tr.state), tr.state).some((d) => d.endsWith('FootnoteDefWidget'))).toBe(
      false
    )
  })

  it('补上收尾的 ``` 同样退回全量（老树里它一路吞到文末）', () => {
    const head = '前言\n\n' + '正文段落。\n\n'.repeat(24)
    const tail = '| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n\n$$\ny = 2\n$$\n'
    const text = `${head}\`\`\`ts\nconst a = 1\n\n${tail}`
    const fenceBody = text.indexOf('const a = 1') + 'const a = 1'.length + 1
    const before = at(fenceBody, text)
    // 补之前：那一大段真的被围栏吞着，一条块级装饰都没有
    expect(dump(buildBlocks(before), before)).toEqual([])
    const value = buildBlocks(before)
    const tr = before.update({ changes: { from: fenceBody, insert: '```\n' } })
    expect(patchBlocks(value, before, tr.state, tr.changes)).toBeNull()
    // 而全量那边，下面重新变回表格与公式
    expect(dump(buildBlocks(tr.state), tr.state)).toHaveLength(2)
  })

  it('删掉收尾的 ``` 也退回全量（新树里它一路吞到文末）', () => {
    const head = '前言\n\n' + '正文段落。\n\n'.repeat(24)
    const tail = '| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n\n$$\ny = 2\n$$\n'
    const text = `${head}\`\`\`ts\nconst a = 1\n\`\`\`\n\n${tail}`
    const close = text.indexOf('```\n\n|')
    const before = at(close, text)
    expect(dump(buildBlocks(before), before)).toHaveLength(2)
    const value = buildBlocks(before)
    const tr = before.update({ changes: { from: close, to: close + 4 } })
    expect(patchBlocks(value, before, tr.state, tr.changes)).toBeNull()
    expect(dump(buildBlocks(tr.state), tr.state)).toEqual([])
  })
})

/**
 * `[TOC]` 是这堆块级构件里唯一的**全文依赖**：烘进 TocWidget 的是整份标题表。
 * 于是「改动碰到标题」+「这份文档里有目录」= 退回全量重建，否则目录会停在改之前
 * 那一版（而且只在长文档上才看得出来，肉眼极难抓）。
 */
describe('目录（全文依赖）与增量重建', () => {
  const body = ['# 标题', '', '正文。', '', '## 小节', '', '又一段正文。', ''].join('\n')
  const withToc = `[TOC]\n\n${body}`

  function make(text: string, anchor: number): EditorState {
    const state = EditorState.create({
      doc: text,
      selection: { anchor },
      extensions: [cursiveMarkdown(), livePreview()]
    })
    ensureSyntaxTree(state, text.length, 5000) // 同上：树先钉死
    return state
  }

  function typeAt(text: string, pos: number, insert: string, caret = pos) {
    const before = make(text, caret)
    const value = buildBlocks(before)
    const tr = before.update({ changes: { from: pos, insert } })
    ensureSyntaxTree(tr.state, tr.state.doc.length, 5000) // 同 step()：树先钉死
    return { patched: patchBlocks(value, before, tr.state, tr.changes), next: tr.state }
  }

  it('有目录时：在标题里打字退回全量', () => {
    const pos = withToc.indexOf('# 标题') + 4
    expect(typeAt(withToc, pos, '甲').patched).toBeNull()
  })

  it('有目录时：删掉一整行标题同样退回全量（只有老树看得见它）', () => {
    const from = withToc.indexOf('## 小节')
    const before = make(withToc, from)
    const value = buildBlocks(before)
    const tr = before.update({ changes: { from, to: from + '## 小节\n'.length } })
    expect(patchBlocks(value, before, tr.state, tr.changes)).toBeNull()
  })

  it('有目录时：改正文照旧走增量', () => {
    const pos = withToc.indexOf('正文。') + 1
    expect(typeAt(withToc, pos, '甲').patched).not.toBeNull()
  })

  it('没有目录时：改标题也走增量，且与全量一致', () => {
    const pos = body.indexOf('# 标题') + 4
    const { patched, next } = typeAt(body, pos, '甲')
    expect(patched).not.toBeNull()
    const dump = (set: ReturnType<typeof buildBlocks>): string[] => {
      const out: string[] = []
      set.between(0, next.doc.length, (f, t, v) => {
        const w = (v.spec as { widget?: { constructor: { name: string } } }).widget
        out.push(`${f}-${t}:${w?.constructor.name ?? '?'}`)
      })
      return out
    }
    expect(dump(patched!)).toEqual(dump(buildBlocks(next)))
  })

  // 新写出来的 `[TOC]` 落在脏区里，增量那条自己就看得见它 —— 不必也退回全量。
  // 光标要摆远一点：压在 `[TOC]` 那一行上本来就该回显源码（reveal），那样测的就不是
  // 「建没建出来」而是「回显对不对」了
  it('现写一个 [TOC]：增量就能把目录建出来', () => {
    const { patched, next } = typeAt(body, 0, '[TOC]\n\n', body.length)
    expect(patched).not.toBeNull()
    const names: string[] = []
    patched!.between(0, next.doc.length, (_f, _t, v) => {
      const w = (v.spec as { widget?: { constructor: { name: string } } }).widget
      names.push(w?.constructor.name ?? '?')
    })
    expect(names).toEqual(['TocWidget'])
  })
})

/**
 * 与「只动选区不重扫全文」同一条规矩，守的是打字这一路：在文末打字时，开头那张表的
 * 装饰对象必须**原样留着**。退回全量重扫是无声的 —— 结果一模一样，只是每按一个键多
 * 花几毫秒（1 万行 3.3ms、3 万行 10.9ms），只能靠身份比对守住。
 */
describe('打字时不重扫全文', () => {
  it('远处的块级装饰对象原样保留', () => {
    const rows = Array.from({ length: 60 }, (_, i) => `| 第${i + 1}行 | 数据 |`)
    const tail = Array.from(
      { length: 150 },
      (_, i) => `第 ${i + 1} 段正文，离那张表很远。\n\n\`\`\`ts\nconst x${i} = ${i}\n\`\`\``
    )
    const doc = `| 甲 | 乙 |\n| --- | --- |\n${rows.join('\n')}\n\n${tail.join('\n\n')}\n`
    let state = EditorState.create({ doc, extensions: [cursiveMarkdown(), livePreview()] })
    ensureSyntaxTree(state, doc.length, 5000)

    const tableWidget = (s: EditorState): unknown => {
      let found: unknown = null
      s.field(blockField).between(0, 10, (_f, _t, v) => {
        found = (v.spec as { widget?: unknown }).widget
      })
      return found
    }

    // 先走一个事务让快照追平（首开时快照只到 3000 字，那一次本来就该全量重建）
    state = state.update({ selection: { anchor: state.doc.length - 20 } }).state
    const first = tableWidget(state)
    expect(first).toBeTruthy()

    // 在文末连打十个字：那张表离得远，一次都不该被重建。
    // **每一步先把树钉死再读字段**（字段是惰性的，`tableWidget` 那一下才真跑）：
    // 不钉的话字段内部那一发 ensure 会在满载时超预算，退回半截树 → 全量重建 →
    // widget 换新对象，于是这条断言变成在量机器忙不忙
    for (let i = 1; i <= 10; i++) {
      state = state.update({ changes: { from: state.doc.length, insert: '字' } }).state
      ensureSyntaxTree(state, state.doc.length, 5000)
      expect(tableWidget(state), `第 ${i} 个字`).toBe(first)
    }
  })
})
