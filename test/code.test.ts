import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { describe, expect, it } from 'vitest'
import {
  codeBarHTML,
  fenceLangSpec,
  fenceNodeAt,
  fenceParts,
  langLabel,
  langOptions
} from '../src/renderer/editor/live-preview/code'
import { buildDecorations } from '../src/renderer/editor/live-preview/decorate'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'

function make(doc: string, anchor?: number): EditorState {
  const state = EditorState.create({
    doc,
    selection: anchor === undefined ? undefined : { anchor },
    extensions: [cursiveMarkdown()]
  })
  ensureSyntaxTree(state, doc.length, 5000)
  return state
}

function firstFence(state: EditorState): SyntaxNode {
  let found: SyntaxNode | null = null
  syntaxTree(state).iterate({
    enter: (n) => {
      if (!found && n.name === 'FencedCode') found = n.node
    }
  })
  expect(found, '没找到 FencedCode 节点').not.toBeNull()
  return found!
}

function parts(doc: string) {
  const state = make(doc)
  return fenceParts(state.doc, firstFence(state))
}

/** 装饰器只读 state + visibleRanges，假 view 就够跑（不必造 DOM） */
function decos(doc: string, anchor?: number): string[] {
  const state = make(doc, anchor)
  const view = {
    state,
    visibleRanges: [{ from: 0, to: doc.length }]
  } as unknown as EditorView
  const out: string[] = []
  buildDecorations(view).between(0, doc.length, (from, to, value) => {
    const spec = value.spec as { widget?: { constructor: { name: string } }; class?: string }
    if (spec.class?.includes('cm-lp-code-')) out.push(`${from}:${spec.class}`)
    else if (from !== to) out.push(`${from}-${to}:${spec.widget?.constructor.name ?? 'hide'}`)
  })
  return out
}

describe('围栏拆解（fenceParts）', () => {
  it('带语言的块：语言串的位置精确到那个词', () => {
    const doc = '```ts\nconst a = 1\n```\n'
    const f = parts(doc)!
    expect(f.lang).toBe('ts')
    expect(doc.slice(f.langFrom, f.langTo)).toBe('ts')
    expect(doc.slice(f.openFrom, f.openTo)).toBe('```ts')
    expect(doc.slice(f.closeFrom!, f.closeTo!)).toBe('```')
    expect(f.body).toBe('const a = 1')
  })

  it('裸 ``` 块：语言是个零长度插入点，就在围栏号后面', () => {
    const doc = '```\nfoo\n```\n'
    const f = parts(doc)!
    expect(f.lang).toBe('')
    expect(f.langFrom).toBe(3)
    expect(f.langTo).toBe(3)
    expect(f.body).toBe('foo')
  })

  it('围栏行上的额外参数原样留着，只认第一个词', () => {
    const doc = '```js title=a.js\nx\n```\n'
    const f = parts(doc)!
    expect(f.lang).toBe('js')
    expect(doc.slice(f.langFrom, f.langTo)).toBe('js')
    expect(doc.slice(f.langTo, f.openTo)).toBe(' title=a.js')
  })

  it('没闭合的围栏：closeFrom 是 null（下面那条线不该画）', () => {
    const f = parts('~~~py\nx = 1\n')!
    expect(f.lang).toBe('py')
    expect(f.closeFrom).toBeNull()
  })

  // 走子节点而不是按行首正则的理由：引用块/列表里，行首那截 `> ` 和缩进
  // 都不属于围栏，正则匹配会直接漏掉闭围栏
  it('引用块里的代码块：闭围栏认得出来，代码体不含 > 前缀', () => {
    const doc = '> ```js\n> const b = 2\n> ```\n'
    const f = parts(doc)!
    expect(f.lang).toBe('js')
    expect(doc.slice(f.closeFrom!, f.closeTo!)).toBe('```')
    expect(f.body).toBe('const b = 2')
  })

  it('列表里缩进的代码块：开围栏从 ``` 起算，不从行首起算', () => {
    const doc = '- 项\n  ```sh\n  ls\n  ```\n'
    const f = parts(doc)!
    expect(doc.slice(f.openFrom, f.openTo)).toBe('```sh')
    expect(f.closeFrom).not.toBeNull()
  })
})

describe('语言名', () => {
  it('别名解析成给人看的名字', () => {
    expect(langLabel('ts')).toBe('TypeScript')
    expect(langLabel('sh')).toBe('Shell')
  })

  // py / yml / rs / kt 在 language-data 里只登记成扩展名、没进 alias，
  // 名字匹配一概认不出来 —— markdown-lang.ts 的后缀兜底就是为这批常用简称加的
  it('常用简称走后缀兜底（顺带这些块才真的有颜色）', () => {
    expect(langLabel('py')).toBe('Python')
    expect(langLabel('yml')).toBe('YAML')
    expect(langLabel('rs')).toBe('Rust')
  })

  it('没写语言 = 纯文本；不认识的原样显示（那种块本来也不会上色）', () => {
    expect(langLabel('')).toBe('纯文本')
    expect(langLabel('conf')).toBe('conf')
  })

  // 名字解析走的就是 @codemirror/lang-markdown 给围栏挑解析器的那一次
  // matchLanguageName（模糊匹配），所以条子上写什么 = 这块真的会按什么上色
  it('与解析器同一套匹配：```plaintext 实际吃的是 LaTeX，条子就得这么说', () => {
    expect(langLabel('plaintext')).toBe('LaTeX')
  })

  it('mermaid 是自家渲染的，也要有名字', () => {
    expect(langLabel('mermaid')).toBe('Mermaid 图表')
  })

  it('候选表：纯文本排第一，每条都带「写进围栏的那个词」', () => {
    const opts = langOptions()
    expect(opts[0]).toMatchObject({ name: '纯文本', write: '' })
    expect(opts.some((o) => o.write === 'mermaid')).toBe(true)
    const ts = opts.find((o) => o.name === 'TypeScript')!
    expect(ts.write).toBe('ts')
    // 筛选键里要有别名，否则打 "ts" 找不到 TypeScript
    expect(ts.keys).toContain('ts')
  })
})

describe('改语言（fenceLangSpec：纯函数，一步撤销）', () => {
  it('换语言只动那个词', () => {
    const state = make('```ts\nconst a = 1\n```\n')
    const spec = fenceLangSpec(state, 0, 'js')!
    expect(spec.changes).toEqual({ from: 3, to: 5, insert: 'js' })
  })

  it('裸块补语言 = 在围栏号后面插入', () => {
    const state = make('```\nfoo\n```\n')
    expect(fenceLangSpec(state, 0, 'bash')!.changes).toEqual({ from: 3, to: 3, insert: 'bash' })
  })

  it('选「纯文本」= 把语言删掉', () => {
    const state = make('```ts\nfoo\n```\n')
    const next = state.update(fenceLangSpec(state, 0, '')!).state
    expect(next.doc.toString()).toBe('```\nfoo\n```\n')
  })

  it('额外参数不受影响', () => {
    const state = make('```js title=a.js\nx\n```\n')
    const next = state.update(fenceLangSpec(state, 0, 'ts')!).state
    expect(next.doc.toString()).toBe('```ts title=a.js\nx\n```\n')
  })

  it('选的就是当前语言 → 不产生事务（别白占一步撤销）', () => {
    const state = make('```ts\nfoo\n```\n')
    expect(fenceLangSpec(state, 0, 'ts')).toBeNull()
  })

  it('光标不在代码块里 → null', () => {
    const state = make('前文\n\n```ts\nfoo\n```\n')
    expect(fenceLangSpec(state, 1, 'js')).toBeNull()
    expect(fenceNodeAt(state, 1)).toBeNull()
  })
})

describe('围栏装饰（藏 ``` + 语言条）', () => {
  // 0-5 ```ts · 6-17 代码 · 18-21 ``` · 22 文末空行（把光标停在这儿 = 不碰这个块）
  const doc = '```ts\nconst a = 1\n```\n'
  const AWAY = doc.length

  it('开围栏整行换成语言条，闭围栏整行藏掉', () => {
    expect(decos(doc, AWAY)).toEqual([
      '0:cm-lp-code-open cm-lp-fence-off',
      '0-5:CodeHeadWidget',
      '18:cm-lp-code-close cm-lp-fence-off',
      '18-21:hide'
    ])
  })

  it('光标落在开围栏那一行 → 回显 ```ts 源码，语言条让位', () => {
    const out = decos(doc, 2)
    expect(out).toContain('0:cm-lp-code-open')
    expect(out.some((d) => d.includes('CodeHeadWidget'))).toBe(false)
    // 闭围栏那头不受影响：两条围栏各算各的
    expect(out).toContain('18:cm-lp-code-close cm-lp-fence-off')
  })

  it('光标在代码体里敲字 → 两条围栏都还藏着（卡片不抽动，复制也还够得着）', () => {
    const out = decos(doc, 10)
    expect(out).toContain('0:cm-lp-code-open cm-lp-fence-off')
    expect(out.some((d) => d.includes('CodeHeadWidget'))).toBe(true)
    expect(out).toContain('18:cm-lp-code-close cm-lp-fence-off')
  })

  it('只开了个头的裸 ```（没语言没内容没闭合）不藏：整行凭空消失更吓人', () => {
    const out = decos('```\n', 4)
    expect(out.some((d) => d.includes('CodeHeadWidget'))).toBe(false)
    expect(out).toContain('0:cm-lp-code-open')
  })
})

/**
 * 语言条是 innerHTML 拼出来的，而围栏行上那个词认不出来时**原样显示** = 文档内容直通模板。
 * 一句 `aria-label="${...}"` 少个 esc，一份 .md 就能往编辑器 chrome 里塞属性
 *（HTML 解析器读完带引号的属性值，遇到非空白直接开始读下一个属性名 —— 连空格都不用）。
 */
describe('语言条的转义', () => {
  const EVIL = 'x"onfocus="alert(1)"autofocus'

  it('围栏语言里的引号挣不出属性值', () => {
    const html = codeBarHTML(EVIL)
    // 断言的是「引号还在不在」，不是「onfocus 这几个字母在不在」——
    // 转义之后 onfocus= 照样会作为**文字**出现，危险的是它后面跟着一个真引号
    expect(html).not.toContain('onfocus="')
    expect(html).not.toContain('"autofocus')
    // 文字还是要显示出来的，只是变成了实体
    expect(html).toContain('x&#34;onfocus=&#34;')
  })

  it('尖括号也转义（别让围栏语言开出新标签）', () => {
    expect(codeBarHTML('<img src=x>')).not.toContain('<img')
  })

  it('正常语言名照常显示', () => {
    expect(codeBarHTML('ts')).toContain('<span>TypeScript</span>')
  })
})
