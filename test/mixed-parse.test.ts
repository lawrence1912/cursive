import { readFileSync } from 'node:fs'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState, type Extension } from '@codemirror/state'
import { IterMode, NodeProp, type Tree } from '@lezer/common'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { collectHeadings, headingsSettled } from '../src/renderer/editor/headings'
import { blockField, livePreview } from '../src/renderer/editor/live-preview/index'
import { Reveal } from '../src/renderer/editor/live-preview/reveal'
import { loadKatex } from '../src/renderer/editor/live-preview/widgets'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'
import { parsedExtent, parsedTree, primeTree } from '../src/renderer/editor/syntax'
import { exportHtmlDocument } from '../src/renderer/export/index'

/**
 * 第八节 16 的两处偶发失败，同一个根因（2026-10-08）。
 *
 * `cursiveMarkdown()` 外面套着 `yamlFrontmatter`，那是一层 `parseMixed`：外层一棵小语法
 * （`Document → Frontmatter? Body`），整篇 Markdown 挂在 `Body` 上。一次事务的 20ms 预算
 * （CM 的 `Work.Apply`）没解析完全文时，CM 用 `takeTree()` 把解析停在半路 —— 外层那棵小语法
 * 往往早就解析完了，**长度就是全文**，而挂在 Body 上的正文只到停下的地方。
 * `tree.length` 于是说「全都在」，`parsedTree` 的快照分支照单全收：
 *   - 导出 HTML 停在半路（第三轮回归：kitchen-sink 停在引用块后面，没有 `<table>`）；
 *   - 大纲把半截的标题表记进缓存（「降级之后大纲列表为空」）；
 *   - 块级装饰建在半截树上，而「后台 parse 推进了没有」也是拿 `tree.length` 比的，永远等不到。
 * 整篇替换（外部重载、探针收尾）一块碎片都复用不上，机器一忙就会撞上。
 */

beforeAll(async () => {
  // widgets.ts 的 currentTheme（mermaid 分支用）读 document.documentElement（同 block.test.ts）
  ;(globalThis as { document?: unknown }).document ??= { documentElement: { dataset: {} } }
  await loadKatex()
})

const DOC = readFileSync('test/fixtures/kitchen-sink.md', 'utf8')
const TABLE = DOC.indexOf('## 表格')

/** 挂在 Body 上的那棵 Markdown 真解析到哪儿 —— 测试自己数，不借被测代码 */
function bodyEnd(tree: Tree): number {
  const c = tree.cursor(IterMode.IgnoreMounts)
  if (c.firstChild()) {
    do {
      if (c.name !== 'Body') continue
      const mount = c.tree?.prop(NodeProp.mounted)
      return c.from + (mount ? mount.tree.length : 0)
    } while (c.nextSibling())
  }
  return tree.length
}

/**
 * 复刻「一次事务那 20ms 没解析完」：把挂钟拨快，再整篇替换一次。
 * 停在哪儿取决于挂钟走多快，所以从细到粗扫一遍步长，取第一份「外层全长、正文停在表格之前」的。
 *
 * `starve`：`Work.Apply` 那一段超时之后，挂钟每问一次就跳 10 秒 —— 同一个事务里后面那些
 * ensure（块级装饰字段里的那一次）也一并落空，才逼得出「装饰建在半截树上」那一幕。
 */
function stalled(extensions: Extension, opts: { starve?: boolean; anchor?: number } = {}): EditorState | null {
  for (let i = 1; i <= 40; i++) {
    const step = i * 0.025
    let state = EditorState.create({ doc: DOC, extensions })
    ensureSyntaxTree(state, DOC.length, 30_000)
    state = state.update({}).state // 快照追平：起点是一份解析完整的 state
    let t = Date.now()
    let first: number | null = null
    let late = false
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => {
      if (late && opts.starve) return (t += 10_000)
      t += step
      if (first === null) first = t
      else if (t > first + 20) late = true
      return t
    })
    try {
      state = state.update({
        changes: { from: 0, to: DOC.length, insert: DOC },
        selection: opts.anchor === undefined ? undefined : { anchor: opts.anchor }
      }).state
    } finally {
      spy.mockRestore()
    }
    const snap = syntaxTree(state)
    if (snap.length === DOC.length && bodyEnd(snap) < TABLE) return state
  }
  return null
}

function full(extensions: Extension): EditorState {
  const state = EditorState.create({ doc: DOC, extensions })
  ensureSyntaxTree(state, DOC.length, 30_000)
  return state.update({}).state
}

describe('混合解析停在半路：外层全长、正文半截', () => {
  it('前提：这种快照真的存在 —— tree.length 是全文，正文停在表格之前', () => {
    const state = stalled(cursiveMarkdown())
    expect(state, '扫遍步长都没停在想要的地方：CM/Lezer 的解析节奏变了，先看懂再改这条').not.toBeNull()
    const snap = syntaxTree(state!)
    expect(snap.length).toBe(DOC.length)
    expect(bodyEnd(snap)).toBeLessThan(TABLE)
  })

  it('parsedExtent 认得出正文停在哪儿', () => {
    const state = stalled(cursiveMarkdown())!
    const snap = syntaxTree(state)
    expect(parsedExtent(snap)).toBe(bodyEnd(snap))
  })

  it('parsedExtent：解析完整的树就是全文；不带 front matter 的外壳也一样', () => {
    expect(parsedExtent(syntaxTree(full(cursiveMarkdown())))).toBe(DOC.length)
    const plain = '# 只有正文\n\n一段。\n'
    expect(parsedExtent(syntaxTree(full(cursiveMarkdown()).update({ changes: { from: 0, to: DOC.length, insert: plain } }).state))).toBe(plain.length)
    // 没套 parseMixed 的语言：tree.length 本来就是真话
    const md = EditorState.create({ doc: plain, extensions: [markdown()] })
    expect(parsedExtent(syntaxTree(md))).toBe(syntaxTree(md).length)
  })

  it('parsedExtent：外层自己都没解析完（Body 还没挂上）时，正文一个字都不算', () => {
    // 首开只解析前 3000 字：外层在 3000 处被 stopAt，Body 上挂的正文更短或者没有
    const rows = Array.from({ length: 150 }, (_, i) => `| 第${i + 1}行 | 数据数据数据数据 | 备注备注 |`)
    const doc = `---\ntitle: x\n---\n\n# 标题\n\n| 甲 | 乙 | 丙 |\n| --- | --- | --- |\n${rows.join('\n')}\n`
    const state = EditorState.create({ doc, extensions: [cursiveMarkdown()] })
    const snap = syntaxTree(state)
    expect(parsedExtent(snap)).toBeLessThan(doc.length)
    expect(parsedExtent(snap)).toBeLessThanOrEqual(bodyEnd(snap))
  })

  it('parsedTree 不把它当成全文 —— 正文一直解析到文末', () => {
    const state = stalled(cursiveMarkdown())!
    expect(bodyEnd(parsedTree(state))).toBe(DOC.length)
    expect(parsedExtent(parsedTree(state))).toBe(DOC.length)
  })

  it('primeTree 同样：拿到的、记进缓存的，都是整棵', () => {
    const state = stalled(cursiveMarkdown())!
    expect(parsedExtent(primeTree(state))).toBe(DOC.length)
    expect(parsedExtent(parsedTree(state))).toBe(DOC.length)
  })

  it('大纲：标题一个不少（不把半截的标题表记进缓存）', () => {
    const want = collectHeadings(full(cursiveMarkdown())).map((h) => h.text)
    expect(want.length).toBeGreaterThan(5)
    const state = stalled(cursiveMarkdown())!
    expect(collectHeadings(state).map((h) => h.text)).toEqual(want)
  })

  it('ensure 也落空时：大纲说得出「这份是半截的」，解析跟上之后同一个 state 再取就是整份', () => {
    const want = collectHeadings(full(cursiveMarkdown())).map((h) => h.text)
    const state = stalled(cursiveMarkdown())!
    let t = Date.now()
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => (t += 10_000)) // 每次 ensure 一步就超时
    let partial: string[]
    try {
      partial = collectHeadings(state).map((h) => h.text)
    } finally {
      spy.mockRestore()
    }
    expect(partial.length).toBeLessThan(want.length)
    expect(headingsSettled(state)).toBe(false)
    expect(collectHeadings(state).map((h) => h.text)).toEqual(want)
    expect(headingsSettled(state)).toBe(true)
  })

  it('接线：大纲刷新拿到半截的标题表就过一会儿再取（main.ts 的 updateOutline）', () => {
    const src = readFileSync('src/renderer/main.ts', 'utf8')
    const body = src.slice(src.indexOf('function updateOutline(): void {'))
    const fn = body.slice(0, body.indexOf('\n}\n'))
    expect(fn).toContain('if (!headingsSettled(view.state)) scheduleOutline()')
  })

  it('导出 HTML：正文一直到最后一节（表格、公式、脚注都在）—— 第三轮回归失败的那一幕', async () => {
    const state = stalled(cursiveMarkdown())!
    const { html } = await exportHtmlDocument(state)
    expect(html).toContain('<h1 id=')
    expect(html).toContain('<table>')
    expect(html).toContain('<math')
    expect(html).toContain('脚注内容')
  })

  it('回显判定：光标落在还没解析到的那一段，也不把整篇当成「光标所在的块」', () => {
    const anchor = DOC.indexOf('| a ')
    const state = stalled(cursiveMarkdown(), { anchor })!
    expect(state.selection.main.head).toBe(anchor)
    const spans = new Reveal(state, 'block').ranges
    expect(spans.length).toBe(1)
    // 只露出那张表，而不是从 front matter 之后一直到文末
    expect(spans[0]!.from).toBeGreaterThanOrEqual(TABLE)
    expect(spans[0]!.to).toBeLessThan(DOC.indexOf('## 数学'))
  })

  it('块级装饰：建在半截树上之后，后台 parse 一推进就把后半篇补上', () => {
    const widgets = (s: EditorState): string[] => {
      const out: string[] = []
      s.field(blockField).between(0, s.doc.length, (_f, _t, v) => {
        const w = (v.spec as { widget?: { constructor: { name: string } } }).widget
        if (w) out.push(w.constructor.name)
      })
      return out
    }
    const want = widgets(full([cursiveMarkdown(), livePreview()]))
    expect(want).toContain('MathWidget')

    const state = stalled([cursiveMarkdown(), livePreview()], { starve: true })!
    // 前提：那一刻字段里的那次 ensure 也落空了，装饰只建到停下的地方
    expect(widgets(state)).not.toContain('MathWidget')

    // 复刻后台 parse：把解析推完，再来一个不改文档、不动选区的事务（快照随之追平）
    ensureSyntaxTree(state, DOC.length, 30_000)
    const next = state.update({}).state
    expect(parsedExtent(syntaxTree(next))).toBe(DOC.length)
    expect(widgets(next)).toEqual(want)
  })
})
