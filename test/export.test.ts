import { readFileSync, writeFileSync } from 'node:fs'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { beforeAll, describe, expect, it } from 'vitest'
import { calloutAt } from '../src/renderer/editor/live-preview/decorate'
import { buildBlocks } from '../src/renderer/editor/live-preview/index'
import { tableEditField } from '../src/renderer/editor/live-preview/table'
import { plainInline } from '../src/renderer/editor/inline-text'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'
import { parsedTree } from '../src/renderer/editor/syntax'
import { collectCodeLangs, loadCodeLangs, renderBody } from '../src/renderer/export/render'
import { EXPORT_CSS } from '../src/renderer/export/style'

// widgets.ts 的 currentTheme（mermaid 分支用）读 document.documentElement，
// node 测试环境补一个最小桩（同 test/block.test.ts）
beforeAll(() => {
  ;(globalThis as { document?: unknown }).document ??= { documentElement: { dataset: {} } }
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

  it('一个脚注节点里连着几条定义要各自成条', () => {
    const out = html('[^1]: 甲\n[^2]: 乙\n')
    expect(out).toContain('<li id="fn-1">')
    expect(out).toContain('<li id="fn-2">')
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

  it('Typora 的 `=宽x高` 尺寸语法：解析器不认，于是两边都是字面量', () => {
    // `![图](a.png =120x80)` 在 lezer 里只得到 `![图]` 这一个 shortcut 形状的 Image 节点
    // （`=120x80` 不是合法的链接标题），装饰层的 parseImage 因此返回 null、原样显示。
    // 导出照抄这一条 —— 这里断言的是**一致**，不是「对」：真要支持得先教解析器（P1-5 的尾巴）
    expect(html('![图](a.png =120x80)\n')).toContain('![图](a.png =120x80)')
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
      expect(countOf(out, '<div class="footnotes">')).toBe(widgets['FootnoteDefWidget'] ?? 0)
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

// ---------- golden ----------
//
// 整份产出存一份快照：导出这条路上任何一处改动都会在 diff 里现形，
// 该不该改由人看一眼。确认新产出正确后 `UPDATE_GOLDEN=1 npx vitest run export` 重录。

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
