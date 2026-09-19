import { readFileSync, writeFileSync } from 'node:fs'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { beforeAll, describe, expect, it } from 'vitest'
import { calloutAt } from '../src/renderer/editor/live-preview/decorate'
import { buildBlocks } from '../src/renderer/editor/live-preview/index'
import { tableEditField } from '../src/renderer/editor/live-preview/table'
import { loadKatex } from '../src/renderer/editor/live-preview/widgets'
import { plainInline } from '../src/renderer/editor/inline-text'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'
import { parsedTree, primeTree, rememberTree } from '../src/renderer/editor/syntax'
import { collectCodeLangs, loadCodeLangs, renderBody } from '../src/renderer/export/render'
import {
  EXPORT_CSS,
  TYPOGRAPHY_DEFAULT,
  typographyCss,
  type Typography
} from '../src/renderer/export/style'
import { wrapDocument } from '../src/renderer/export/index'

// widgets.ts 的 currentTheme（mermaid 分支用）读 document.documentElement，
// node 测试环境补一个最小桩（同 test/block.test.ts）。
// katex 按需加载（P4-6②）：这里直接调 renderBody（绕过 export/index.ts 那句
// `await loadKatex()`），所以要自己先把它拉进来，否则公式全退化成 `<code>`
beforeAll(async () => {
  ;(globalThis as { document?: unknown }).document ??= { documentElement: { dataset: {} } }
  await loadKatex()
})

function stateOf(doc: string): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [cursiveMarkdown(), tableEditField]
  })
  ensureSyntaxTree(state, doc.length, 8000)
  return state
}

function html(doc: string, dir: string | null = '/docs'): string {
  return renderBody(stateOf(doc), { dir }).html
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1
}

describe('导出 HTML：块级', () => {
  it('标题带锚点，锚点与大纲 slug 同一份', () => {
    const out = html('# 一级\n\n## 二级\n\n## 二级\n')
    expect(out).toContain('<h1 id="一级">一级</h1>')
    // 重名标题依次加后缀（slugs() 的规则）
    expect(out).toContain('<h2 id="二级">二级</h2>')
    expect(out).toContain('<h2 id="二级-1">二级</h2>')
  })

  it('setext 标题不拖下划线，标题里的行内语法真的渲染', () => {
    const out = html('带 **粗体** 的标题\n=========\n')
    expect(out).toContain('<h1 id="带-粗体-的标题">带 <strong>粗体</strong> 的标题</h1>')
    expect(out).not.toContain('=====')
  })

  it('紧凑列表不包 <p>，任务项是禁用的复选框', () => {
    const out = html('- 一\n- [ ] 未完成\n- [x] 完成\n')
    expect(out).toContain('<li>一</li>')
    expect(out).toContain('<li class="task"><input type="checkbox" disabled> 未完成</li>')
    expect(out).toContain('<li class="task"><input type="checkbox" disabled checked> 完成</li>')
  })

  it('有序列表保留起始编号', () => {
    expect(html('3. 三\n4. 四\n')).toContain('<ol start="3">')
    expect(html('1. 一\n2. 二\n')).toContain('<ol>')
  })

  it('引用块里的 `>` 不会各自成段', () => {
    const out = html('> 第一行\n> 第二行\n')
    expect(out).toContain('<blockquote>')
    expect(countOf(out, '<p>')).toBe(1)
    expect(out).not.toContain('&gt;</p>')
  })

  it('告示块出卡片：类型色 + 图标 + 没写标题时补中文名', () => {
    const out = html('> [!danger] 小心\n> 正文\n')
    expect(out).toContain('<div class="callout callout-danger">')
    expect(out).toContain('<span>小心</span>')
    expect(out).toContain('<svg class="ic"')
    expect(html('> [!note]\n> 正文\n')).toContain('<span>笔记</span>')
    // 类型表里没有的写法仍旧是普通引用（和编辑器一致）
    expect(html('> [!xyz]\n> 正文\n')).toContain('<blockquote>')
  })

  it('围栏代码块：语言名给人看，代码真的上色', () => {
    const state = stateOf('```ts\nconst a = 1\n```\n')
    return loadCodeLangs(collectCodeLangs(state)).then(() => {
      const out = renderBody(state).html
      expect(out).toContain('<figcaption>TypeScript</figcaption>')
      expect(out).toContain('class="tok-keyword"')
    })
  })

  it('缩进代码块拼回原文（CodeText 之间的空隙是缩进）', () => {
    expect(html('    第一行\n    第二行\n')).toContain('<code>第一行\n第二行</code>')
  })

  it('表格：对齐落在 style 上，格内行内语法与编辑器同一份数据', () => {
    const out = html('| a | b |\n|:--|--:|\n| **粗** | `码` |\n')
    expect(out).toContain('<th>a</th>')
    expect(out).toContain('<th style="text-align:right">b</th>')
    expect(out).toContain('<td><strong>粗</strong></td>')
    expect(out).toContain('<td style="text-align:right"><code>码</code></td>')
  })

  it('数学走 MathML（导出不依赖 KaTeX 的 CSS 与字体）', () => {
    const inline = html('公式 $E = mc^2$。\n')
    expect(inline).toContain('<math')
    expect(inline).toContain('E = mc^2') // annotation 里留着源码，可复制
    expect(html('$$\nx = 1\n$$\n')).toContain('<div class="math-block">')
  })

  it('mermaid 先占位，占位就是渲染失败时的最终形态（保留源码）', () => {
    const res = renderBody(stateOf('```mermaid\nflowchart TD\n A-->B\n```\n'))
    expect(res.mermaid).toHaveLength(1)
    expect(res.mermaid[0]!.src).toContain('flowchart TD')
    expect(res.html).toContain(res.mermaid[0]!.placeholder)
    expect(res.html).toContain('<figure class="mermaid"')
  })

  it('[TOC] 与脚注：锚点两头对得上', () => {
    const out = html('# 标题\n\n[TOC]\n\n正文[^a]。\n\n[^a]: 定义。\n')
    expect(out).toContain('<nav class="toc">')
    expect(out).toContain('<a href="#标题">标题</a>')
    expect(out).toContain('<sup class="footnote-ref" id="fnref-a"><a href="#fn-a">a</a></sup>')
    expect(out).toContain('<li id="fn-a">')
    expect(out).toContain('href="#fnref-a"')
  })

  it('连着几条定义各自成条，并进同一个脚注区', () => {
    const out = html('[^1]: 甲\n[^2]: 乙\n')
    expect(out).toContain('<li id="fn-1">')
    expect(out).toContain('<li id="fn-2">')
    // .footnotes 自带 2em 上边距和一道上边框，一条一个容器就在文末摞出好几道分隔线
    expect(countOf(out, '<div class="footnotes">')).toBe(1)
  })

  it('空行分隔的几条定义同样只出一个脚注区', () => {
    const out = html('[^1]: 甲\n\n[^2]: 乙\n')
    expect(countOf(out, '<li id="fn-')).toBe(2)
    expect(countOf(out, '<div class="footnotes">')).toBe(1)
  })

  it('悬空的脚注引用保持字面量，不发死锚点', () => {
    const out = html('正文 [^ref] 结束。\n')
    expect(out).toContain('[^ref]')
    expect(out).not.toContain('footnote-ref')
    expect(out).not.toContain('#fn-ref')
    // 有定义的那个照旧发链接
    expect(html('正文 [^ref] 结束。\n\n[^ref]: 有了。\n')).toContain('href="#fn-ref"')
  })

  it('空文档不炸：正文是空串，标题退到兜底', () => {
    const empty = renderBody(stateOf(''), { title: '空' })
    expect(empty.html).toBe('')
    expect(empty.title).toBe('空')
    expect(renderBody(stateOf('\n\n  \n')).title).toBe('未命名')
  })

  it('front matter 原样保留，裸 HTML 一律转义（所见即所得）', () => {
    expect(html('---\ntitle: a\n---\n\n正文\n')).toContain('<pre class="frontmatter">')
    expect(html('<div class="x">块</div>\n')).toContain('&lt;div class=&quot;x&quot;&gt;')
    expect(html('段落里的 <b>标签</b>。\n')).toContain('&lt;b&gt;')
  })
})

describe('导出 HTML：行内', () => {
  it('强调 / 删除线 / 高亮 / 上下标 / emoji / 转义', () => {
    const out = html('**粗** *斜* ~~删~~ ==亮== x^2^ H~2~O :smile: \\*字面\\*\n')
    expect(out).toContain('<strong>粗</strong>')
    expect(out).toContain('<em>斜</em>')
    expect(out).toContain('<del>删</del>')
    expect(out).toContain('<mark>亮</mark>')
    expect(out).toContain('<sup>2</sup>')
    expect(out).toContain('<sub>2</sub>')
    expect(out).toContain('😄')
    expect(out).toContain('*字面*')
  })

  it('链接：标题进 title，引用式定义解析得到，定义行本身不出现在正文里', () => {
    const out = html('[文字](https://a.b "说明") 与 [别的][ref]。\n\n[ref]: https://c.d\n')
    expect(out).toContain('<a href="https://a.b" title="说明">文字</a>')
    expect(out).toContain('<a href="https://c.d">别的</a>')
    expect(out).not.toContain('[ref]:')
  })

  it('裸链接与邮箱各自成链接', () => {
    const out = html('看 https://a.b/c 或 me@a.b。\n')
    expect(out).toContain('<a href="https://a.b/c">https://a.b/c</a>')
    expect(out).toContain('<a href="mailto:me@a.b">me@a.b</a>')
  })

  it('javascript: 链接只留文字 —— 导出物是要发给别人的', () => {
    const out = html('[点我](javascript:alert(1))\n')
    expect(out).toContain('点我')
    expect(out).not.toContain('javascript:')
  })

  it('图片：src 保留文档里的写法，另挂绝对路径给壳嵌图用', () => {
    const out = html('![图](assets/a.png)\n', '/docs')
    expect(out).toContain('<img src="assets/a.png" data-abs="/docs/assets/a.png" alt="图">')
    // 未命名文档没有目录可依，就只留相对路径（壳侧也就不会去嵌它）
    expect(html('![图](assets/a.png)\n', null)).toContain('<img src="assets/a.png" alt="图">')
    // 网络图片不嵌
    expect(html('![图](https://a.b/c.png)\n')).not.toContain('data-abs')
  })

  it('尺寸图片经过真实解析器后导出宽高', () => {
    expect(html('![图](a.png =120x80)\n')).toContain('alt="图" width="120" height="80"')
    expect(html('![图](a.png =120x)\n')).toContain('alt="图" width="120"')
  })

  it('尖括号目的地（文件名带空格）整条链都通，不退回裸源码', () => {
    const out = html('![图](<中文 图.png> =120x80)\n', '/docs')
    expect(out).toContain('src="中文 图.png"')
    expect(out).toContain('data-abs="/docs/中文 图.png"')
    expect(out).toContain('width="120" height="80"')
    expect(out).not.toContain('![图]')
  })

  it('正文里的尖括号与 & 一律转义', () => {
    const out = html('a < b && c > d\n')
    expect(out).toContain('a &lt; b &amp;&amp; c &gt; d')
  })
})

// ---------- 和编辑器对账（roadmap 点名的「方言漂移」）----------
//
// 导出渲染全文、编辑器只渲染视口，两条路径对同一段 markdown 必须是同一种理解。
// 结构上已经共用一棵语法树与同一批解析函数，这里再用断言把它钉死：
// 块级拿 `buildBlocks()` 的 widget 逐类对账，行内拿 `plainInline()` 的纯文本对账。

const FIXTURES = ['export.md', 'kitchen-sink.md', 'dialect.md', 'callout.md', 'math.md', 'mermaid.md']

/** 块级装饰按 widget 类名计数 */
function blockWidgets(state: EditorState): Record<string, number> {
  const out: Record<string, number> = {}
  buildBlocks(state).between(0, state.doc.length, (_f, _t, v) => {
    const name = (v.spec as { widget?: { constructor: { name: string } } }).widget?.constructor.name
    if (name) out[name] = (out[name] ?? 0) + 1
  })
  return out
}

/** 引用块里有几张告示卡（用的就是装饰层那一个 calloutAt） */
function calloutCount(state: EditorState): number {
  let n = 0
  parsedTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Blockquote') return
      if (calloutAt(state.doc, node.node)) n++
    }
  })
  return n
}

describe('导出与编辑器同一种理解（方言不漂移）', () => {
  for (const name of FIXTURES) {
    it(`${name}：块级构件一个不多一个不少`, () => {
      const state = stateOf(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8'))
      const widgets = blockWidgets(state)
      const out = renderBody(state, { dir: '/docs' }).html
      expect(countOf(out, '<table>')).toBe(widgets['TableWidget'] ?? 0)
      expect(countOf(out, '<div class="math-block">')).toBe(widgets['MathWidget'] ?? 0)
      expect(countOf(out, '<figure class="mermaid"')).toBe(widgets['MermaidWidget'] ?? 0)
      expect(countOf(out, '<nav class="toc">')).toBe(widgets['TocWidget'] ?? 0)
      // 脚注按**定义**对账：连着摞的几条并进同一个 .footnotes 容器，
      // 容器数不等于定义数（老口径数容器，两条定义合成一个节点时照样绿，漏掉了 B1）
      expect(countOf(out, '<li id="fn-')).toBe(widgets['FootnoteDefWidget'] ?? 0)
      expect(countOf(out, '<div class="callout ')).toBe(calloutCount(state))
    })
  }

  it('行内：剥掉标签之后就是编辑器显示的那串字', () => {
    const doc =
      '**粗** *斜* ~~删~~ `码` ==亮== x^2^ H~2~O :smile: \\*字面\\* ' +
      '[文字](https://a.b) <https://c.d> 结尾。\n'
    const state = stateOf(doc)
    const para = parsedTree(state).topNode.firstChild!.firstChild!
    expect(para.name).toBe('Paragraph')
    const shown = plainInline(state, para.from, para.to)
    const exported = renderBody(state)
      .html.replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .trim()
    expect(exported).toBe(shown.trim())
  })
})

describe('导出样式表（P4-2 的地基）', () => {
  it('不写 @page size —— 纸张与页边距的真相只有一份，在壳侧的 NSPrintInfo', () => {
    // 两处各说一套时 WebKit 的行为没有定义；分页是壳在做（printOperation）
    expect(EXPORT_CSS).not.toMatch(/@page[^}]*size\s*:/)
  })

  it('打印时的断页规则在：标题不落页脚、表格与告示块整块搬页、代码块不锁', () => {
    const print = EXPORT_CSS.slice(EXPORT_CSS.indexOf('@media print'))
    expect(print).toContain('break-after: avoid')
    expect(print).toMatch(/table[\s\S]*break-inside: avoid/)
    expect(print).toContain('figure.code { break-inside: auto; }')
    // 纸上没有横向滚动条：代码宁可折行也不能被裁掉
    expect(print).toContain('white-space: pre-wrap')
  })
})

describe('导出排版跟随设置（0.2.x）', () => {
  const type = (over: Partial<Typography> = {}): Typography => ({ ...TYPOGRAPHY_DEFAULT, ...over })

  it('与默认值全等 = 一个字节都不加（没改过设置的人，导出物与从前逐字节相同）', () => {
    expect(typographyCss()).toBe('')
    expect(typographyCss(type())).toBe('')
    // 顺带把这条钉在最要紧的地方：整份外壳也必须逐字节相同
    expect(wrapDocument('<p>x</p>', 'T', type())).toBe(wrapDocument('<p>x</p>', 'T'))
  })

  it('四个 token 与 themes/base.css 同名 —— 覆盖段盖的就是 EXPORT_CSS 里那四个', () => {
    for (const name of ['--body-font', '--body-size', '--body-leading', '--column']) {
      expect(EXPORT_CSS).toContain(`${name}:`)
    }
    expect(EXPORT_CSS).toContain('font-family: var(--body-font)')
    expect(EXPORT_CSS).toContain('font-size: var(--body-size)')
    expect(EXPORT_CSS).toContain('line-height: var(--body-leading)')
    expect(EXPORT_CSS).toContain('max-width: var(--column)')
  })

  it('字族走 --serif / --sans 那两个现成的栈，不另写一份字体名', () => {
    expect(typographyCss(type({ font: 'sans' }))).toContain('--body-font: var(--sans);')
    expect(typographyCss(type({ font: 'sans' }))).not.toMatch(/PingFang|Georgia/)
  })

  it('字号：屏幕原样 px，纸上按比例缩（16px = 五号 10.5pt）', () => {
    const css = typographyCss(type({ size: 20 }))
    expect(css).toContain('--body-size: 20px;')
    // 10.5 × 20/16 = 13.125 → 13.13pt。原样搬成 20pt 的话一页少放三分之一的字
    expect(css).toContain('--print-size: 13.13pt;')
    // 缩小同理
    expect(typographyCss(type({ size: 13 }))).toContain('--print-size: 8.53pt;')
  })

  it('行距：屏幕原样，纸上保持「比屏幕紧一点」那 3%（1.75 → 1.7）', () => {
    const css = typographyCss(type({ leading: 2 }))
    expect(css).toContain('--body-leading: 2;')
    expect(css).toContain('--print-leading: 1.94;')
    // 默认那档正是纸上原来的值，比例基准没走样
    expect(typographyCss(type({ leading: 1.75, size: 17 }))).toContain('--print-leading: 1.7;')
  })

  it('栏宽只作用于屏幕 —— 纸的宽度归 NSPrintInfo，@media print 里仍是 max-width: none', () => {
    expect(typographyCss(type({ column: 30 }))).toContain('--column: 30rem;')
    const print = EXPORT_CSS.slice(EXPORT_CSS.indexOf('@media print'))
    expect(print).toContain('max-width: none')
    // 覆盖段里不许出现第二条 max-width，否则纸上又被压回去
    expect(typographyCss(type({ column: 30 }))).not.toContain('max-width')
  })

  it('覆盖段排在 EXPORT_CSS 之后（同名 token 后来者胜）', () => {
    const doc = wrapDocument('<p>x</p>', 'T', type({ font: 'sans' }))
    expect(doc.indexOf('--body-font: var(--sans)')).toBeGreaterThan(doc.indexOf('--body-font: var(--serif)'))
    // 仍然只有一个 <style>：导出物是单文件，样式全内联
    expect(countOf(doc, '<style>')).toBe(1)
  })

  it('坏值不炸：NaN / 0 / 负数退回默认，不写出 NaNpx', () => {
    const css = typographyCss(type({ size: Number.NaN, leading: 0, column: -5, font: 'sans' }))
    expect(css).not.toMatch(/NaN|Infinity|-\d/)
    expect(css).toContain('--body-size: 16px;')
    expect(css).toContain('--body-leading: 1.75;')
    expect(css).toContain('--column: 42rem;')
  })
})

// ---------- golden ----------
//
// 整份产出存一份快照：导出这条路上任何一处改动都会在 diff 里现形，
// 该不该改由人看一眼。确认新产出正确后 `UPDATE_GOLDEN=1 npx vitest run export` 重录。

/**
 * 导出不接受半截树（0.2.x）。
 *
 * `parsedTree` 的最后一句是「ensure 超预算（50ms）就退回手上那棵快照」——
 * 屏幕上那是「先画一部分，后台 parse 跟上再补」，而导出**只有一次机会**：
 * 少的那一截就是交出去的文件里没有的内容，产物看着还完好。真摔过：E2E 里偶发地
 * 只导出了文档的前三分之一（正文停在代码围栏之前）。
 */
describe('导出前先把整棵树确保出来', () => {
  it('没预先 ensure 过的 state：primeTree 之后树盖住全文', () => {
    const doc = readFileSync(new URL('fixtures/export.md', import.meta.url), 'utf8')
    // **故意不 ensure** —— 复刻「刚开出来 / 刚改过」的那一刻
    const state = EditorState.create({ doc, extensions: [cursiveMarkdown(), tableEditField] })
    expect(primeTree(state).length).toBe(doc.length)
  })

  it('确保之后第二次直接命中缓存，不重复解析', () => {
    const doc = readFileSync(new URL('fixtures/export.md', import.meta.url), 'utf8')
    const state = EditorState.create({ doc, extensions: [cursiveMarkdown(), tableEditField] })
    expect(primeTree(state)).toBe(primeTree(state))
  })

  it('确保过的树记进了同一份缓存 —— renderBody 里的每次 parsedTree 直接命中', () => {
    const doc = readFileSync(new URL('fixtures/export.md', import.meta.url), 'utf8')
    const state = EditorState.create({ doc, extensions: [cursiveMarkdown(), tableEditField] })
    expect(parsedTree(state)).toBe(primeTree(state))
  })

  it('拿不到全长的树画出来的正文**真的会短** —— 钉住「短了会怎样」，也就是这条改动在防什么', () => {
    // 得比 3000 字长：CM 打开文档时只解析前 3000 字（`Work.InitViewport`，
    // `test/block.test.ts` 的「首开长文档」守的是同一个常数）
    const doc = Array.from({ length: 300 }, (_, i) => `## 第 ${i} 节\n\n正文一段。\n`).join('\n')
    expect(doc.length).toBeGreaterThan(3000)

    // ① 复刻「ensure 超预算、退回手上那棵快照」那一幕：把首开那棵半截树钉进缓存
    const short = EditorState.create({ doc, extensions: [cursiveMarkdown(), tableEditField] })
    const snap = syntaxTree(short)
    expect(snap.length, '首开的快照本来就该是半截的').toBeLessThan(doc.length)
    rememberTree(short, snap, doc.length)
    // `blocks()` 按 topNode 的范围走 —— 树盖不住文档，正文就是这么悄悄少掉的
    const half = renderBody(short, {}).html

    // ② 导出那条路：primeTree 先把整棵确保出来，正文才是全的
    const full = EditorState.create({ doc, extensions: [cursiveMarkdown(), tableEditField] })
    primeTree(full)
    expect(renderBody(full, {}).html.length).toBeGreaterThan(half.length)
    // 最后一节必须在里面 —— 「短了一截」的产物看着完好，只有末尾能揭穿它
    expect(renderBody(full, {}).html).toContain('第 299 节')
    expect(half).not.toContain('第 299 节')
  })
})

describe('golden', () => {
  it('export.md 的产出与快照一致', async () => {
    const src = new URL('fixtures/export.md', import.meta.url)
    const goldenPath = new URL('fixtures/golden/export.html', import.meta.url)
    const state = stateOf(readFileSync(src, 'utf8'))
    await loadCodeLangs(collectCodeLangs(state))
    const out = renderBody(state, { dir: '/docs' }).html
    if (process.env['UPDATE_GOLDEN']) {
      writeFileSync(goldenPath, out)
      return
    }
    expect(out).toBe(readFileSync(goldenPath, 'utf8'))
  })
})
