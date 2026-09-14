import { EditorState, type TransactionSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import {
  collectHeadings,
  headingBefore,
  levelChangeSpec,
  moveSectionSpec,
  newSiblingSpec,
  sections,
  slugs
} from '../src/renderer/editor/headings'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'

function headings(doc: string) {
  const state = EditorState.create({ doc, extensions: [cursiveMarkdown()] })
  return collectHeadings(state)
}

describe('标题取数（大纲 / [TOC] 共用）', () => {
  it('ATX 标题剥掉首尾井号', () => {
    expect(
      headings('# 一级\n\n### 尾部井号 ###\n').map((h) => [h.level, h.text, h.pos])
    ).toEqual([
      [1, '一级', 0],
      [3, '尾部井号', 6]
    ])
  })

  it('setext 标题不再拖着下划线（P3-6 既有缺陷 1）', () => {
    const out = headings('我的标题\n=====\n\n子标题\n-----\n')
    expect(out.map((h) => h.text)).toEqual(['我的标题', '子标题'])
    expect(out.map((h) => h.level)).toEqual([1, 2])
  })

  it('标题里的行内语法不再是裸源码（P3-6 既有缺陷 2）', () => {
    const out = headings('## 带 **粗体** 和 `码` 与 [链接](http://a.b) :smile:\n')
    expect(out[0]!.text).toBe('带 粗体 和 码 与 链接 😄')
  })

  it('高亮 / 上下标 / 删除线 / 行内公式也剥标记', () => {
    expect(headings('## ==高亮== H~2~O x^2^ ~~删~~ $a+b$\n')[0]!.text).toBe(
      '高亮 H2O x2 删 a+b'
    )
  })

  it('转义只脱反斜杠', () => {
    expect(headings('# 一个 \\* 星号\n')[0]!.text).toBe('一个 * 星号')
  })

  it('空标题给占位文字，不是空行', () => {
    expect(headings('##\n')[0]!.text).toBe('（空标题）')
  })

  it('setext 标题也进 [TOC]（两个目录取同一份数）', () => {
    // 老的 collectHeadings 只认 ATXHeading，setext 标题在 [TOC] 里整个看不见
    expect(headings('标题\n===\n\n## 二级\n').map((h) => h.level)).toEqual([1, 2])
  })

  it('代码块里的 # 不算标题', () => {
    expect(headings('```\n# 不是标题\n```\n\n# 是标题\n').map((h) => h.text)).toEqual(['是标题'])
  })

  it('headingBefore 取「该位置之前最近的标题」', () => {
    const items = headings('# 一\n\n正文\n\n## 二\n\n正文\n')
    expect(headingBefore(items, 0)).toBe(items[0]!.pos)
    expect(headingBefore(items, items[1]!.pos + 1)).toBe(items[1]!.pos)
    expect(headingBefore([], 10)).toBeNull()
  })
})

// ---------- P3-6 下半场：每节范围 / 字数 / 锚点 / 搬节 / 升降级 / 新建同级 ----------

function st(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [cursiveMarkdown()] })
  // 让语法树先解析出来（collectHeadings 自己也会 ensure，这里只是让用例读起来直白）
  collectHeadings(state)
  return state
}

/** 把纯函数算出的 spec 应用一次，返回新正文 */
function applied(state: EditorState, spec: TransactionSpec | null): string {
  expect(spec, 'spec 不应为 null').not.toBeNull()
  return state.update(spec!).state.doc.toString()
}

const DOC = ['# 一', '一的正文', '', '## 一甲', '甲的正文', '', '# 二', '二的正文', ''].join('\n')

describe('本节范围与字数', () => {
  it('本节 = 到下一个同级或更高级标题，下级小节算在自己名下', () => {
    const items = collectHeadings(st(DOC))
    const [h1, h11, h2] = items
    expect(DOC.slice(h1!.pos, h1!.end)).toBe('# 一\n一的正文\n\n## 一甲\n甲的正文\n\n')
    expect(DOC.slice(h11!.pos, h11!.end)).toBe('## 一甲\n甲的正文\n\n')
    expect(DOC.slice(h2!.pos, h2!.end)).toBe('# 二\n二的正文\n')
  })

  it('字数不含标题那一行，但含下级小节', () => {
    const [h1, h11] = sections(st(DOC))
    // 「一的正文」4 + 「一甲」2 + 「甲的正文」4
    expect(h1!.words).toBe(10)
    expect(h11!.words).toBe(4)
  })

  it('空节是 0 词（面板据此不显示数字）', () => {
    expect(sections(st('# 光杆标题\n'))[0]!.words).toBe(0)
  })

  it('setext 标题标记得出来（升降级要走另一条路）', () => {
    const items = collectHeadings(st('标题\n===\n\n# ATX\n'))
    expect(items.map((h) => h.setext)).toEqual([true, false])
  })
})

describe('锚点', () => {
  it('GitHub 规矩：小写、去标点、空格换连字符，CJK 保留', () => {
    expect(slugs([{ text: 'Hello World!' }, { text: '第一章：开始' }])).toEqual([
      'hello-world',
      '第一章开始'
    ])
  })

  it('重名依次加后缀', () => {
    expect(slugs([{ text: '小结' }, { text: '小结' }, { text: '小结' }])).toEqual([
      '小结',
      '小结-1',
      '小结-2'
    ])
  })
})

describe('拖拽重排章节（唯一会改文档的操作）', () => {
  const move = (doc: string, from: number, before: number | null): string => {
    const state = st(doc)
    const items = collectHeadings(state)
    return applied(state, moveSectionSpec(state, items, items[from]!.pos, before === null ? null : items[before]!.pos))
  }

  it('往前搬：整节（含下级小节）一起走', () => {
    expect(move(DOC, 2, 0)).toBe('# 二\n二的正文\n# 一\n一的正文\n\n## 一甲\n甲的正文\n\n')
  })

  it('往后搬 = 搬到文末', () => {
    expect(move(DOC, 0, null)).toBe('# 二\n二的正文\n# 一\n一的正文\n\n## 一甲\n甲的正文\n\n')
  })

  it('字节只是换了个顺序：总量与字符构成都不变', () => {
    for (const [from, before] of [[2, 0], [0, null], [1, 0]] as const) {
      const out = move(DOC, from, before)
      expect(out.length, `${from}→${before}`).toBe(DOC.length)
      expect([...out].sort().join('')).toBe([...DOC].sort().join(''))
    }
  })

  it('文末不带换行时两头都不会粘在一起', () => {
    const doc = '# 甲\n甲正文\n\n# 乙\n乙正文'
    const state = st(doc)
    const items = collectHeadings(state)
    // 搬走文末那一节（它自己不带收尾换行）
    const a = applied(state, moveSectionSpec(state, items, items[1]!.pos, items[0]!.pos))
    expect(a).toBe('# 乙\n乙正文\n# 甲\n甲正文\n')
    expect(a.length).toBe(doc.length)
    // 反过来：搬到不带收尾换行的文末
    const b = applied(state, moveSectionSpec(state, items, items[0]!.pos, null))
    expect(b).toBe('# 乙\n乙正文\n# 甲\n甲正文\n')
    expect(b.length).toBe(doc.length)
  })

  it('搬进自己肚子里 / 原地不动 → 返回 null，不产生事务', () => {
    const state = st(DOC)
    const items = collectHeadings(state)
    // 一级标题「一」搬到它自己的子标题之前
    expect(moveSectionSpec(state, items, items[0]!.pos, items[1]!.pos)).toBeNull()
    expect(moveSectionSpec(state, items, items[0]!.pos, items[0]!.pos)).toBeNull()
    expect(moveSectionSpec(state, items, 99999, null)).toBeNull()
  })
})

describe('升降级', () => {
  it('ATX 走 fmt.ts 同一条命令', () => {
    const state = st('## 标题\n正文\n')
    const items = collectHeadings(state)
    expect(applied(state, levelChangeSpec(state, items[0]!, 1))).toBe('# 标题\n正文\n')
    expect(applied(state, levelChangeSpec(state, items[0]!, 3))).toBe('### 标题\n正文\n')
  })

  it('setext 在 1/2 级之间只换下划线字符，长度不动', () => {
    const state = st('标题\n=====\n\n正文\n')
    const items = collectHeadings(state)
    expect(applied(state, levelChangeSpec(state, items[0]!, 2))).toBe('标题\n-----\n\n正文\n')
  })

  it('setext 降到 3 级只能转成 ATX（下划线没地方放）', () => {
    const state = st('标题\n=====\n\n正文\n')
    const items = collectHeadings(state)
    expect(applied(state, levelChangeSpec(state, items[0]!, 3))).toBe('### 标题\n\n正文\n')
  })

  it('同级或越界 → null', () => {
    const state = st('## 标题\n')
    const h = collectHeadings(state)[0]!
    expect(levelChangeSpec(state, h, 2)).toBeNull()
    expect(levelChangeSpec(state, h, 0)).toBeNull()
    expect(levelChangeSpec(state, h, 7)).toBeNull()
  })
})

describe('在此后新建同级标题', () => {
  it('插在本节末尾，并选中「新标题」三个字', () => {
    const state = st(DOC)
    const h = collectHeadings(state)[1]! // ## 一甲
    const next = state.update(newSiblingSpec(state, h)).state
    expect(next.doc.toString()).toBe(
      '# 一\n一的正文\n\n## 一甲\n甲的正文\n\n## 新标题\n\n# 二\n二的正文\n'
    )
    expect(next.sliceDoc(next.selection.main.from, next.selection.main.to)).toBe('新标题')
  })

  it('文末那一节：先补一个换行，别粘在最后一行后面', () => {
    const state = st('# 甲\n甲正文')
    const h = collectHeadings(state)[0]!
    expect(state.update(newSiblingSpec(state, h)).state.doc.toString()).toBe('# 甲\n甲正文\n# 新标题\n')
  })
})
