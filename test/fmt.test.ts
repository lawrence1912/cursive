import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { formatStateAt, makeFormatSpec, wordAt } from '../src/renderer/editor/fmt'

function apply(state: EditorState, action: string): EditorState {
  const spec = makeFormatSpec(state, action as never)
  return state.update({
    changes: spec.changes,
    selection: spec.selection,
    userEvent: 'input'
  }).state
}

function sel(anchor: number, head = anchor): EditorSelection {
  return EditorSelection.single(anchor, head)
}

describe('行内格式（幂等）', () => {
  it('加粗再加粗 = 原文（idempotent）', () => {
    const s = EditorState.create({ doc: 'hello world', selection: sel(0, 5) })
    const b1 = apply(s, 'fmt:bold')
    expect(b1.doc.toString()).toBe('**hello** world')
    const b2 = apply(b1, 'fmt:bold')
    expect(b2.doc.toString()).toBe('hello world')
  })

  it('斜体/行内代码/删除线同理', () => {
    const s = EditorState.create({ doc: 'ab', selection: sel(0, 2) })
    expect(apply(s, 'fmt:italic').doc.toString()).toBe('*ab*')
    expect(apply(s, 'fmt:code-inline').doc.toString()).toBe('`ab`')
    expect(apply(s, 'fmt:strikethrough').doc.toString()).toBe('~~ab~~')
  })

  it('无选区光标在空白：插入空对', () => {
    const s = EditorState.create({ doc: 'a b', selection: sel(1) }) // 空格位置
    expect(apply(s, 'fmt:bold').doc.toString()).toBe('a**** b')
  })

  it('一个事务内完成 → 可一步撤回', () => {
    // 造一个带 single undo 的 state 验证：整个格式化是一个 transaction
    const s = EditorState.create({ doc: 'xy', selection: sel(0, 2) })
    const done = apply(s, 'fmt:bold')
    expect(done.doc.toString()).toBe('**xy**')
  })
})

describe('标题 / 段落', () => {
  it('无标题 → 加；同级 → 摘；跨级 → 换级', () => {
    const s = EditorState.create({ doc: '标题文本', selection: sel(0) })
    const h1 = apply(s, 'fmt:h3')
    expect(h1.doc.toString()).toBe('### 标题文本')
    expect(apply(h1, 'fmt:h3').doc.toString()).toBe('标题文本')
    expect(apply(h1, 'fmt:h1').doc.toString()).toBe('# 标题文本')
  })

  it('⌘0（正文）摘掉标题', () => {
    const s = EditorState.create({ doc: '## 小节', selection: sel(0) })
    expect(apply(s, 'fmt:p').doc.toString()).toBe('小节')
  })
})

describe('行级：引用 / 列表 / 任务 / 围栏', () => {
  it('引用开关', () => {
    const s = EditorState.create({ doc: '引文', selection: sel(0) })
    expect(apply(s, 'fmt:quote').doc.toString()).toBe('> 引文')
    expect(apply(apply(s, 'fmt:quote'), 'fmt:quote').doc.toString()).toBe('引文')
  })

  it('无序/有序列表开关', () => {
    const s = EditorState.create({ doc: '条目', selection: sel(0) })
    expect(apply(s, 'fmt:ulist').doc.toString()).toBe('- 条目')
    expect(apply(s, 'fmt:olist').doc.toString()).toBe('1. 条目')
  })

  it('多行选区逐行生效', () => {
    const s = EditorState.create({ doc: 'a\nb\n', selection: sel(0, 3) })
    expect(apply(s, 'fmt:ulist').doc.toString()).toBe('- a\n- b\n')
  })

  it('任务项开关', () => {
    const s = EditorState.create({ doc: 'todo', selection: sel(0) })
    expect(apply(s, 'fmt:task').doc.toString()).toBe('- [ ] todo')
  })

  it('代码块围栏：包上再摘', () => {
    const s = EditorState.create({ doc: 'code', selection: sel(0, 4) })
    const fenced = apply(s, 'fmt:code-block')
    expect(fenced.doc.toString()).toBe('```\ncode\n```')
    expect(apply(fenced, 'fmt:code-block').doc.toString()).toBe('code')
  })
})

describe('链接', () => {
  it('选区包成链接', () => {
    const s = EditorState.create({ doc: '官网', selection: sel(0, 2) })
    expect(apply(s, 'fmt:link').doc.toString()).toBe('[官网]()')
  })

  it('已是链接 → 摘回纯文本', () => {
    const s = EditorState.create({ doc: '[官网](https://x)', selection: sel(0, 15) })
    expect(apply(s, 'fmt:link').doc.toString()).toBe('官网')
  })
})

describe('多光标', () => {
  it('两个选区同时加粗', () => {
    const s = EditorState.create({
      doc: 'aa bb',
      extensions: [EditorState.allowMultipleSelections.of(true)],
      selection: EditorSelection.create([EditorSelection.range(0, 2), EditorSelection.range(3, 5)], 0)
    })
    const out = apply(s, 'fmt:bold')
    expect(out.doc.toString()).toBe('**aa** **bb**')
  })
})

describe('wordAt', () => {
  it('中文词边界（Segmenter 按词切：你好=0-2 世界=2-4）', () => {
    const s = EditorState.create({ doc: '你好世界' })
    expect(wordAt(s, 1)).toEqual({ from: 0, to: 2 })
    expect(wordAt(s, 3)).toEqual({ from: 2, to: 4 })
  })
  it('光标在词外（空格/标点）返回 null', () => {
    const s = EditorState.create({ doc: 'a b' })
    expect(wordAt(s, 1)).toBeNull()
  })
  it('英文词边界', () => {
    const s = EditorState.create({ doc: 'hello world' })
    expect(wordAt(s, 1)).toEqual({ from: 0, to: 5 })
  })
})

// ---------- P2-8：格式栏的高亮状态 ----------

function stateAt(doc: string, anchor: number, head = anchor): Set<string> {
  return formatStateAt(
    EditorState.create({ doc, selection: EditorSelection.single(anchor, head) })
  ) as Set<string>
}

describe('formatStateAt：与切换判定同源', () => {
  it('选区正好盖住 **粗体** → 点亮加粗', () => {
    const doc = '这是 **粗体** 结束'
    const from = doc.indexOf('**')
    expect(stateAt(doc, from, from + 6).has('fmt:bold')).toBe(true)
  })

  it('无选区时看光标所在词（和 emitForRange 的无选区分支一致）', () => {
    const doc = 'a **bold** b'
    expect(stateAt(doc, doc.indexOf('bold') + 1).has('fmt:bold')).toBe(true)
    expect(stateAt(doc, 0).has('fmt:bold')).toBe(false)
  })

  it('亮着就点得灭：点亮的动作跑一次必须把格式摘掉', () => {
    const doc = 'a **bold** b'
    const at = doc.indexOf('bold') + 1
    expect(stateAt(doc, at).has('fmt:bold')).toBe(true)
    const state = EditorState.create({ doc, selection: EditorSelection.single(at) })
    expect(apply(state, 'fmt:bold').doc.toString()).toBe('a bold b')
  })

  it('标题级别 / 正文', () => {
    expect(stateAt('## 标题', 4).has('fmt:h2')).toBe(true)
    expect(stateAt('## 标题', 4).has('fmt:p')).toBe(false)
    expect(stateAt('普通一行', 1).has('fmt:p')).toBe(true)
  })

  it('引用 / 有序列表 / 代码块围栏', () => {
    expect(stateAt('> 引用', 3).has('fmt:quote')).toBe(true)
    expect(stateAt('1. 一项', 4).has('fmt:olist')).toBe(true)
    expect(stateAt('```', 3).has('fmt:code-block')).toBe(true)
  })

  it('任务项只点亮「任务项」，不连带点亮「无序列表」', () => {
    const on = stateAt('- [ ] 买菜', 7)
    expect(on.has('fmt:task')).toBe(true)
    expect(on.has('fmt:ulist')).toBe(false)
    expect(stateAt('- 普通项', 3).has('fmt:ulist')).toBe(true)
  })

  it('链接：选区是 [x](u) 时点亮', () => {
    const doc = '看 [链接](https://a.b) 这里'
    const from = doc.indexOf('[')
    expect(stateAt(doc, from, from + '[链接](https://a.b)'.length).has('fmt:link')).toBe(true)
  })
})

describe('定界符不越权（格式栏把这两个坑摆到了明面上）', () => {
  it('光标停在已加粗的词里，再按一次 ⌘B 是取消，不是套成 ****词****', () => {
    const doc = 'a **bold** b'
    const s = EditorState.create({ doc, selection: sel(doc.indexOf('bold') + 1) })
    expect(apply(s, 'fmt:bold').doc.toString()).toBe('a bold b')
  })

  it('`*` 不认领 `**粗体**`：斜体既不点亮也不去啃它', () => {
    const doc = 'a **粗体** b'
    const at = doc.indexOf('粗体') + 1
    expect(stateAt(doc, at).has('fmt:italic')).toBe(false)
    expect(stateAt(doc, at).has('fmt:bold')).toBe(true)
    const s = EditorState.create({ doc, selection: sel(2, 8) }) // 正好盖住 **粗体**
    expect(apply(s, 'fmt:italic').doc.toString()).toBe('a ***粗体*** b')
  })
})

// ---------- P2-9 命令表补齐 ----------

describe('P2-9 行内：高亮 / 上标 / 下标 / 行内公式', () => {
  it('四个都是幂等开关（包上再点一次就摘掉）', () => {
    const cases: [string, string, string][] = [
      ['fmt:highlight', 'hello', '==hello=='],
      ['fmt:superscript', 'hello', '^hello^'],
      ['fmt:subscript', 'hello', '~hello~'],
      ['fmt:math-inline', 'hello', '$hello$']
    ]
    for (const [action, plain, wrapped] of cases) {
      const s = EditorState.create({ doc: plain, selection: sel(0, plain.length) })
      const once = apply(s, action)
      expect(once.doc.toString()).toBe(wrapped)
      expect(apply(once, action).doc.toString()).toBe(plain)
    }
  })

  it('一次事务 → 一步撤回', () => {
    const spec = makeFormatSpec(
      EditorState.create({ doc: 'x', selection: sel(0, 1) }),
      'fmt:highlight'
    )
    expect(spec.changes).toHaveLength(2) // 两处插入，同一个事务
  })

  it('`~` 不认领 `~~删除线~~`：下标既不点亮也不跟删除线一起亮', () => {
    const doc = 'a ~~删除~~ b'
    const at = doc.indexOf('删除') + 1
    expect(stateAt(doc, at).has('fmt:subscript')).toBe(false)
    expect(stateAt(doc, at).has('fmt:strikethrough')).toBe(true)
  })

  it('`$` 不认领 `$$块公式$$`', () => {
    const doc = '$$x+y$$'
    expect(stateAt(doc, 0, doc.length).has('fmt:math-inline')).toBe(false)
    expect(stateAt('$x+y$', 0, 5).has('fmt:math-inline')).toBe(true)
  })

  it('亮着就点得灭：==高亮== 里放光标，点一次必须摘掉', () => {
    const doc = 'a ==亮== b'
    const at = doc.indexOf('亮') + 1
    expect(stateAt(doc, at).has('fmt:highlight')).toBe(true)
    const s = EditorState.create({ doc, selection: sel(at) })
    expect(apply(s, 'fmt:highlight').doc.toString()).toBe('a 亮 b')
  })
})

describe('P2-9 插入：块级骨架独占一段', () => {
  it('空文档插表格：3 列 × 2 行，光标落在表头第一格', () => {
    const s = EditorState.create({ doc: '' })
    const out = apply(s, 'fmt:table')
    expect(out.doc.toString()).toBe(
      ['|     |     |     |', '| --- | --- | --- |', '|     |     |     |', '|     |     |     |'].join('\n')
    )
    expect(out.selection.main.head).toBe(2)
  })

  it('插表格带 setTableEdit：新表直接以渲染态出现（值 = 改动之后的表格起点）', () => {
    const spec = makeFormatSpec(EditorState.create({ doc: '段落' }), 'fmt:table')
    expect(spec.effects).toHaveLength(1)
    expect(spec.effects![0]!.value).toBe(4) // '段落' + 垫的那个空行
  })

  it('有字的行上插分隔线：前面垫空行，不会变成 setext 二级标题', () => {
    const s = EditorState.create({ doc: '段落\n下一段', selection: sel(2) })
    const out = apply(s, 'fmt:hr')
    expect(out.doc.toString()).toBe('段落\n\n---\n\n下一段')
    // 光标停在分隔线下面那一空行上
    expect(out.doc.lineAt(out.selection.main.head).text).toBe('')
  })

  it('空行上插分隔线：就地占用那一行，上面已有空行就不再多垫', () => {
    const from = (doc: string, at: number) =>
      apply(EditorState.create({ doc, selection: sel(at) }), 'fmt:hr').doc.toString()
    // 两条路（停在有字的行尾 / 停在下面那一空行上）落到同一份良构源码
    expect(from('段落\n下一段', 2)).toBe('段落\n\n---\n\n下一段')
    expect(from('段落\n\n\n下一段', 4)).toBe('段落\n\n---\n\n下一段')
  })

  it('公式块 / 流程图 / 告示块 / 目录：光标停在该接着打字的地方', () => {
    const body = (action: string) => {
      const out = apply(EditorState.create({ doc: '' }), action)
      return [out.doc.toString(), out.selection.main.head] as const
    }
    expect(body('fmt:math-block')).toEqual(['$$\n\n$$', 3])
    expect(body('fmt:mermaid')).toEqual(['```mermaid\n\n```', 11])
    expect(body('fmt:callout')).toEqual(['> [!NOTE]\n> ', 12])
    expect(body('fmt:toc')).toEqual(['[TOC]\n', 6])
  })

  it('块级插入只认主选区，不吃选区内容（落在选区之后）', () => {
    const s = EditorState.create({ doc: '一段文字', selection: sel(0, 4) })
    expect(apply(s, 'fmt:hr').doc.toString()).toBe('一段文字\n\n---\n')
  })
})

describe('P2-9 插入：图片与脚注', () => {
  it('无选区插图片：光标落进 url 那对括号', () => {
    const out = apply(EditorState.create({ doc: '' }), 'fmt:image')
    expect(out.doc.toString()).toBe('![]()')
    expect(out.selection.main.head).toBe(4)
  })

  it('有选区插图片：选区当 alt', () => {
    const s = EditorState.create({ doc: '封面', selection: sel(0, 2) })
    const out = apply(s, 'fmt:image')
    expect(out.doc.toString()).toBe('![封面]()')
    expect(out.selection.main.head).toBe(6)
  })

  it('脚注：光标处插引用 + 文末插定义，光标停到定义上', () => {
    const s = EditorState.create({ doc: '正文', selection: sel(2) })
    const out = apply(s, 'fmt:footnote')
    expect(out.doc.toString()).toBe('正文[^1]\n\n[^1]: ')
    expect(out.selection.main.head).toBe(out.doc.length)
  })

  it('编号取现有数字标签的最大值 + 1（复用编号会把两处引用并成一条注）', () => {
    const doc = '甲[^1]乙[^3]\n\n[^1]: a\n[^3]: b'
    const s = EditorState.create({ doc, selection: sel(10) }) // 第一行行尾
    expect(apply(s, 'fmt:footnote').doc.toString()).toContain('乙[^3][^4]')
    expect(apply(s, 'fmt:footnote').doc.toString().endsWith('[^4]: ')).toBe(true)
  })
})

describe('P2-9 插入类永远不点亮（它们不是开关）', () => {
  it('不管光标在哪，formatStateAt 都不认领插入类', () => {
    const inserts = [
      'fmt:table',
      'fmt:image',
      'fmt:hr',
      'fmt:math-block',
      'fmt:callout',
      'fmt:mermaid',
      'fmt:footnote',
      'fmt:toc'
    ]
    const docs = ['', '正文', '| a | b |', '---', '[TOC]', '> [!NOTE]\n> x', '![x](y)']
    for (const doc of docs) {
      const on = stateAt(doc, Math.min(1, doc.length))
      for (const a of inserts) expect(on.has(a), `${doc} → ${a}`).toBe(false)
    }
  })
})
