import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { history, undo } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { formatActionOf } from '../src/renderer/editor/fmt'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'
import { SLASH_TABLE, slashIcon, slashSource, slashSpec } from '../src/renderer/editor/slash'
import { FORMAT_ICONS } from '../src/renderer/ui/format-bar'
import type { MenuAction } from '../src/shared/types'

/**
 * 斜杠命令（`/callout`、`/table`、`/h2`…）。
 *
 * 文档里用 `|` 标光标（喂给编辑器前去掉）。三组断言，正好对应这个源要回答的三个问题：
 * **什么时候弹**、**列哪些**、**插完光标落在哪**。
 * 面板长什么样归主题管，键位归 `@codemirror/autocomplete` 管，都不在这儿守。
 */
function at(docWithCaret: string): { state: EditorState; pos: number } {
  const pos = docWithCaret.indexOf('|')
  const doc = docWithCaret.replace('|', '')
  return { state: EditorState.create({ doc, extensions: [cursiveMarkdown()] }), pos }
}

function menu(docWithCaret: string): CompletionResult | null {
  const { state, pos } = at(docWithCaret)
  return slashSource(new CompletionContext(state, pos, false)) as CompletionResult | null
}

const labels = (r: CompletionResult | null): string[] => (r?.options ?? []).map((o) => o.label)

/** 挑一条命令插下去：算出事务、应用，返回结果文档与光标（`^` 标出来） */
function pick(docWithCaret: string, action: MenuAction): string {
  const { state, pos } = at(docWithCaret)
  const line = state.doc.lineAt(pos)
  const from = line.from + line.text.search(/\S/)
  const next = state.update(slashSpec(state, action, from, pos)).state
  const head = next.selection.main.head
  return `${next.doc.sliceString(0, head)}^${next.doc.sliceString(head)}`
}

describe('什么时候弹', () => {
  it('行首的 `/` 弹出整份菜单', () => {
    expect(menu('/|')?.options.length).toBe(SLASH_TABLE.length)
  })

  it('缩进不影响（前面只有空白仍然算行首）', () => {
    expect(menu('  /|')).not.toBeNull()
  })

  it('但缩进到成了代码块就不弹（四个空格 / 一个 Tab 起头的行是代码）', () => {
    expect(menu('    /|')).toBeNull()
    expect(menu('\t/|')).toBeNull()
  })

  it('正文里的斜杠不弹 —— 日期、路径、and/or 才是它最常见的样子', () => {
    expect(menu('写于 2026/09|')).toBeNull()
    expect(menu('见 src/ren|')).toBeNull()
    expect(menu('正文 /ta|')).toBeNull()
  })

  it('列表项与引用行里不弹：那儿插一张表会剩下一个空的项目符号', () => {
    expect(menu('- /|')).toBeNull()
    expect(menu('1. /|')).toBeNull()
    expect(menu('> /|')).toBeNull()
  })

  it('续行也不弹 —— 前面确实只有空白，但人在写的还是上面那个块', () => {
    expect(menu('- 项目\n  /|')).toBeNull()
    expect(menu('> 引用\n/|')).toBeNull()
    // 空行隔开之后就不是那个块了，照弹
    expect(menu('- 项目\n\n/|')).not.toBeNull()
    expect(menu('> 引用\n\n/|')).not.toBeNull()
  })

  it('代码块 / 公式 / front matter 里的斜杠是内容，不是命令', () => {
    expect(menu('```js\n/|\n```')).toBeNull()
    expect(menu('$$\n/|\n$$')).toBeNull()
    expect(menu('---\ntitle: a\n/|\n---\n\n正文')).toBeNull()
    expect(menu('---\ntitle: a\n---\n\n/|')).not.toBeNull()
    expect(menu('`/|`')).toBeNull()
  })

  it('空格一打进来就收摊（想写个斜杠时的退路之一）', () => {
    expect(menu('/table |')).toBeNull()
  })

  it('一条都匹配不上就关掉，不留空面板', () => {
    expect(menu('/zzzz|')).toBeNull()
  })

  it('组字期间不弹（红线二）', () => {
    const { state, pos } = at('/ta|')
    const view = { composing: true, compositionStarted: true } as EditorView
    expect(slashSource(new CompletionContext(state, pos, true, view))).toBeNull()
  })
})

describe('列哪些', () => {
  it('只打一个 `/` 时按表序，标题 1 在最前面', () => {
    expect(labels(menu('/|'))[0]).toBe('标题 1')
  })

  it('`/cal` 找得到告示块，关键词摆在右边那一列', () => {
    const r = menu('/cal|')
    expect(labels(r)[0]).toBe('告示块')
    expect(r?.options[0]?.detail).toBe('/callout')
  })

  it('中文照样找得到 —— 关键词、显示名、别名三个串一起参与匹配', () => {
    expect(labels(menu('/告示|'))).toContain('告示块')
    expect(labels(menu('/待办|'))).toContain('任务项')
    expect(labels(menu('/表格|'))[0]).toBe('表格')
  })

  it('英文别名也认（`/divider` 是分隔线的 Notion 叫法）', () => {
    expect(labels(menu('/divid|'))[0]).toBe('分隔线')
    expect(labels(menu('/bullet|'))[0]).toBe('无序列表')
  })

  it('起点落在斜杠上 —— 插入时 `/cal` 三个字要整个被换掉', () => {
    expect(menu('正文\n\n/cal|')?.from).toBe(4)
  })

  it('筛选和排序自己做，所以不能让 CM 再筛一遍', () => {
    expect(menu('/cal|')?.filter).toBe(false)
  })

  it('命中的字加粗：查的是显示名，只匹配到关键词就不画', () => {
    const zh = menu('/告示|')!
    const first = zh.options[0]!
    expect(zh.getMatch?.(first)).toEqual([0, 2])
    // `/cal` 命中的是关键词那一段，「告示块」上一个粗体都没有
    expect(menu('/cal|')!.getMatch?.(menu('/cal|')!.options[0]!)).toEqual([])
  })
})

describe('插完光标落在哪', () => {
  it('标题：落在 `## ` 后面，接着就能打字（不是落在 `#` 前面）', () => {
    expect(pick('/h2|', 'fmt:h2')).toBe('## ^')
  })

  it('引用 / 列表 / 任务项：同样落在标记后面', () => {
    expect(pick('/quote|', 'fmt:quote')).toBe('> ^')
    expect(pick('/list|', 'fmt:ulist')).toBe('- ^')
    expect(pick('/todo|', 'fmt:task')).toBe('- [ ] ^')
  })

  it('代码块：落在围栏中间那一空行', () => {
    expect(pick('/code|', 'fmt:code-block')).toBe('```\n^\n```')
  })

  it('表格：落在表头第一格', () => {
    expect(pick('/table|', 'fmt:table')).toBe(
      '| ^    |     |     |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |'
    )
  })

  it('告示块：骨架带类型，光标停在正文那一行', () => {
    expect(pick('/callout|', 'fmt:callout')).toBe('> [!NOTE]\n> ^')
  })

  it('上一段有字时块级骨架自己垫空行（复用 fmt.ts 的落点算法）', () => {
    expect(pick('正文\n/hr|', 'fmt:hr')).toBe('正文\n\n---\n^')
  })

  it('缩进连着关键词一起删掉 —— 否则两个空格会挪到 `#` 后面', () => {
    expect(pick('  /h1|', 'fmt:h1')).toBe('# ^')
  })

  it('⌘Z 一下就回到打 `/table` 之前 —— 删关键词和插骨架是同一个事务', () => {
    const doc = '正文\n/table'
    const state = EditorState.create({
      doc,
      extensions: [cursiveMarkdown(), history()]
    })
    const from = state.doc.length - '/table'.length
    let cur = state.update(slashSpec(state, 'fmt:table', from, state.doc.length)).state
    expect(cur.doc.toString()).not.toBe(doc)
    undo({
      state: cur,
      dispatch: (tr) => {
        cur = tr.state
      }
    })
    expect(cur.doc.toString()).toBe(doc)
  })
})

describe('命令表', () => {
  it('每一条都是 fmt.ts 认得的命令（写错一个 action 当场红）', () => {
    expect(SLASH_TABLE.filter((i) => formatActionOf(i.action) === null)).toEqual([])
  })

  it('只收块级命令 —— 行内开关在行首没有可套的文字', () => {
    const inline = SLASH_TABLE.filter((i) => {
      const kind = formatActionOf(i.action)?.kind
      return kind === 'inline' || kind === 'link'
    })
    expect(inline).toEqual([])
  })

  it('关键词不重复，也不带斜杠（斜杠由面板补）', () => {
    const keys = SLASH_TABLE.map((i) => i.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.filter((k) => k.includes('/'))).toEqual([])
  })
})

describe('图标', () => {
  it('与格式栏配的是同一颗 —— 同一条命令在两处菜单里不该长两个样', () => {
    const drift = SLASH_TABLE.filter(
      (i) => FORMAT_ICONS[i.action] && FORMAT_ICONS[i.action] !== i.ic
    ).map((i) => `${i.action}: 斜杠 ${i.ic} ≠ 格式栏 ${FORMAT_ICONS[i.action]}`)
    expect(drift).toEqual([])
  })

  it('十九条里只有标题六级是新画的，其余全从格式栏那份拿', () => {
    const own = SLASH_TABLE.filter((i) => !FORMAT_ICONS[i.action]).map((i) => i.ic)
    expect(own).toEqual(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
  })

  it('每条都配了图标，一条都不能空着（空的那行会塌掉半列）', () => {
    expect(SLASH_TABLE.filter((i) => !i.ic)).toEqual([])
  })

  it('别的补全源不带图标 —— 渲染器读不到就什么都不画，不多出一列空白', () => {
    expect(slashIcon({ label: ':smile:', detail: '😄' })).toBeNull()
  })
})
