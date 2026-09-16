import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { COMPLETION_SOURCES } from '../src/renderer/editor/complete'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'

/**
 * 0.2.0 自动补全。
 *
 * 文档里用 `|` 标光标位置（真正喂给编辑器前会去掉），断言看的是
 * 「弹不弹」「起点对不对」「候选里有没有那一条」三件事 ——
 * 面板长什么样归主题管，不在这儿守。
 */
function at(docWithCaret: string): { state: EditorState; pos: number } {
  const pos = docWithCaret.indexOf('|')
  const doc = docWithCaret.replace('|', '')
  return { state: EditorState.create({ doc, extensions: [cursiveMarkdown()] }), pos }
}

/** 跑一遍六个源，返回第一个认领的结果（与 CM 里 `override` 的语义一致） */
function complete(docWithCaret: string, explicit = false): CompletionResult | null {
  const { state, pos } = at(docWithCaret)
  const cx = new CompletionContext(state, pos, explicit)
  for (const source of COMPLETION_SOURCES) {
    const res = source(cx) as CompletionResult | null
    if (res) return res
  }
  return null
}

const labels = (r: CompletionResult | null): string[] => (r?.options ?? []).map((o) => o.label)

describe('中文输入法', () => {
  it.each([false, true])('从组字开始就暂停所有补全源（composing=%s）', (composing) => {
    const documents = [
      ':sm|',
      '> [!|',
      '正文[^|\n\n[^注]: 定义',
      '# 标题\n\n[链接](#|',
      '```ty|',
      '/tab|'
    ]
    for (const doc of documents) {
      const { state, pos } = at(doc)
      const view = { composing, compositionStarted: true } as EditorView
      const cx = new CompletionContext(state, pos, true, view)
      for (const source of COMPLETION_SOURCES) expect(source(cx)).toBeNull()
    }
  })
})

describe('emoji 短代码', () => {
  it(':sm 弹出，候选里有 :smile:', () => {
    const r = complete('写点什么 :sm|')
    expect(labels(r)).toContain(':smile:')
  })

  it('只敲一个冒号不弹 —— 否则 `10:30:45` 每个冒号都要被打断一次', () => {
    expect(complete('十点 :|')).toBeNull()
    expect(complete('10:30:|')).toBeNull()
  })

  it('冒号前面是字母数字不弹（`TODO:fix` 不是短代码）', () => {
    expect(complete('TODO:fi|')).toBeNull()
    expect(complete('https:|')).toBeNull()
  })

  it('起点落在冒号上，补全会把 `:sm` 整个换掉', () => {
    const r = complete('a :sm|')
    expect(r?.from).toBe(2)
  })
})

describe('告示块', () => {
  it('引用行开头的 `[!` 列出 13 种类型', () => {
    const r = complete('> [!|')
    expect(labels(r)).toContain('[!note]')
    expect(labels(r)).toContain('[!danger]')
    // 别名折叠掉：`warning` / `caution` / `attention` 同属一种，只出现一次
    expect(labels(r)).toEqual([...new Set(labels(r))])
  })

  it('已经打了半个类型名照样弹（`[!da`）', () => {
    expect(labels(complete('> [!da|'))).toContain('[!danger]')
  })

  it('正文里的 `[!` 不是告示块，不弹', () => {
    expect(complete('正文 [!|')).toBeNull()
  })
})

describe('脚注引用', () => {
  const doc = ['正文[^|', '', '[^注一]: 第一条', '[^注二]: 第二条'].join('\n')

  it('列出文档里已有的定义', () => {
    expect(labels(complete(doc))).toEqual(['[^注一]', '[^注二]'])
  })

  it('定义行自己不补全（那儿要的是新 id）', () => {
    expect(complete(['[^新|', '', '[^注一]: 第一条'].join('\n'))).not.toBeNull()
    expect(complete(['[^注一]: 正文 [^|'].join('\n'))).toBeNull()
  })

  it('一条定义都没有就不弹', () => {
    expect(complete('正文[^|')).toBeNull()
  })
})

describe('标题锚点', () => {
  const doc = ['# 第一章', '', '## 小节 A', '', '见 [这里](#|'].join('\n')

  it('`](#` 后列出本文标题，锚点串与 slugs() 同源', () => {
    expect(labels(complete(doc))).toEqual(['#第一章', '#小节-a'])
  })

  it('不在 `](` 后面的 `#` 不弹（那是标题标记）', () => {
    expect(complete('# 第一章\n\n#|')).toBeNull()
  })
})

describe('围栏语言', () => {
  it('``` 之后列语言，起点在围栏后面 —— 过滤串不能带上围栏', () => {
    const r = complete('```|')
    expect(r?.from).toBe(3)
    expect(labels(r)).toContain('TypeScript')
  })

  it('候选写进文档的是 `write` 那个词，不是显示名', () => {
    const r = complete('```ty|')
    expect(r?.options.find((o) => o.label === 'TypeScript')?.apply).toBe('ts')
  })

  it('「纯文本」这一条不进候选（它的 write 是空串，补出来等于没补）', () => {
    expect(labels(complete('```|'))).not.toContain('纯文本')
  })

  it('不在行首的 ``` 不弹（行内代码不是围栏）', () => {
    expect(complete('正文 ```|')).toBeNull()
  })
})
