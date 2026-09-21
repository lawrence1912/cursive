import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'
import { collectHeadings } from '../src/renderer/editor/headings'
import type { EditorView } from '@codemirror/view'
import {
  foldedSpans,
  sectionAt,
  sectionFolded,
  sectionFoldField,
  spanAt,
  spanOf,
  toggleFoldAt,
  toggleSectionFold
} from '../src/renderer/editor/fold'

/**
 * 折叠一节（0.4.0 F1）里能错的那一半。
 *
 * 画把手、贴药丸那半是 DOM，进不了 node 测试；这一半是**范围算法 + 一个 StateField**，
 * 而这条路上所有「折错地方」的方式都住在它们里面：多吃一个换行会把下一个标题吸上来、
 * 嵌套折叠会让两条跨行装饰重叠（CM 当场报错）、光标掉进折叠区之后每一次打字都是在
 * 改看不见的东西。
 */
const DOC = [
  '# 一级',
  '',
  '开场白。',
  '',
  '## 甲',
  '',
  '甲的正文。',
  '',
  '### 甲一',
  '',
  '甲一的正文。',
  '',
  '## 乙',
  '',
  '乙的正文。',
  ''
].join('\n')

function make(doc = DOC): EditorState {
  return EditorState.create({ doc, extensions: [cursiveMarkdown(), sectionFoldField] })
}

function fold(state: EditorState, pos: number): EditorState {
  return state.update({ effects: toggleSectionFold.of(pos) }).state
}

function headingPos(state: EditorState, text: string): number {
  const hit = collectHeadings(state).find((h) => h.text === text)
  if (!hit) throw new Error(`没有这个标题：${text}`)
  return hit.pos
}

describe('折叠范围', () => {
  const state = make()

  it('从标题行末尾起 —— 标题自己永远看得见', () => {
    const h = collectHeadings(state).find((x) => x.text === '甲')!
    const span = spanOf(state, h)!
    expect(state.doc.sliceString(h.pos, span.from)).toBe('## 甲')
  })

  it('**不吃最后那个换行** —— 吃了的话下一个标题会被吸到折叠行的尾巴上', () => {
    const h = collectHeadings(state).find((x) => x.text === '甲')!
    const span = spanOf(state, h)!
    // 折叠区的下一个字符必须还是换行（也就是「## 乙」那一行还在自己的行上）
    expect(state.doc.sliceString(span.to, span.to + 1)).toBe('\n')
    expect(state.doc.lineAt(span.to + 1).text).toBe('## 乙')
  })

  it('下级小节算在自己身上（`## 甲` 折起来，`### 甲一` 一起进去）', () => {
    const h = collectHeadings(state).find((x) => x.text === '甲')!
    const hidden = state.doc.sliceString(spanOf(state, h)!.from, spanOf(state, h)!.to)
    expect(hidden).toContain('### 甲一')
    expect(hidden).toContain('甲一的正文。')
    expect(hidden).not.toContain('## 乙')
  })

  it('只有标题行的一节折不起来（没东西可折，别给把手）', () => {
    // 同级的下一个标题紧跟着 —— 这一节真的一行正文都没有
    const only = make('# 空节\n# 下一节\n\n正文\n')
    expect(spanOf(only, collectHeadings(only)[0]!)).toBeNull()
  })

  it('但「后面只有下级小节」不算空 —— 折起来要把整棵子树收走', () => {
    const tree = make('# 一级\n## 子节\n\n正文\n')
    const span = spanOf(tree, collectHeadings(tree)[0]!)!
    expect(tree.doc.sliceString(span.from, span.to)).toContain('## 子节')
  })

  it('最后一节折到文末', () => {
    const h = collectHeadings(state).find((x) => x.text === '乙')!
    expect(spanOf(state, h)!.to).toBe(state.doc.length - 1) // 末尾那个换行不算进去
  })
})

describe('折叠状态', () => {
  it('折 / 展开是同一条效应的两下', () => {
    let state = make()
    const pos = headingPos(state, '甲')
    expect(sectionFolded(state, pos)).toBe(false)
    state = fold(state, pos)
    expect(sectionFolded(state, pos)).toBe(true)
    state = fold(state, pos)
    expect(sectionFolded(state, pos)).toBe(false)
  })

  it('**一个字节都不碰文档** —— 折叠是编辑器里的态，不是一次编辑', () => {
    const state = make()
    const folded = fold(state, headingPos(state, '甲'))
    expect(folded.doc.toString()).toBe(DOC)
  })

  it('前面插字，折叠跟着文档挪', () => {
    let state = make()
    state = fold(state, headingPos(state, '甲'))
    const next = state.update({ changes: { from: 0, insert: '前言\n\n' } }).state
    const pos = headingPos(next, '甲')
    expect(sectionFolded(next, pos)).toBe(true)
    expect(next.doc.sliceString(pos, pos + 4)).toBe('## 甲')
  })

  it('标题被删掉，那条折叠跟着消失（不留悬空的态）', () => {
    let state = make()
    const pos = headingPos(state, '甲')
    state = fold(state, pos)
    const line = state.doc.lineAt(pos)
    const next = state.update({ changes: { from: line.from, to: line.to + 1, insert: '' } }).state
    expect(foldedSpans(next)).toEqual([])
  })

  it('嵌套只留外层 —— 两条跨行替换重叠 CM 会当场报错', () => {
    let state = make()
    state = fold(state, headingPos(state, '甲'))
    state = fold(state, headingPos(state, '甲一'))
    const spans = foldedSpans(state)
    expect(spans).toHaveLength(1)
    expect(state.doc.sliceString(spans[0]!.from, spans[0]!.to)).toContain('### 甲一')
  })

  it('外层展开之后，里层那条还在（态没被丢掉，只是刚才被盖住了）', () => {
    let state = make()
    state = fold(state, headingPos(state, '甲'))
    state = fold(state, headingPos(state, '甲一'))
    state = fold(state, headingPos(state, '甲')) // 外层展开
    const spans = foldedSpans(state)
    expect(spans).toHaveLength(1)
    expect(spans[0]!.pos).toBe(headingPos(state, '甲一'))
  })
})

describe('落点掉进折叠区 = 当场展开', () => {
  it('光标跳进藏起来的正文里（查找 / 大纲 / 跨文件搜索都走这条）', () => {
    let state = make()
    const pos = headingPos(state, '甲')
    state = fold(state, pos)
    const inside = state.doc.toString().indexOf('甲一的正文。')
    const next = state.update({ selection: { anchor: inside } }).state
    expect(sectionFolded(next, pos), '不展开的话，之后每一次打字都是在改看不见的东西').toBe(
      false
    )
  })

  it('改到了藏起来的正文（替换全部 / 外部重载）同样展开', () => {
    let state = make()
    const pos = headingPos(state, '甲')
    state = fold(state, pos)
    const at = state.doc.toString().indexOf('甲的正文。')
    const next = state.update({ changes: { from: at, to: at + 5, insert: '改过的正文。' } }).state
    expect(sectionFolded(next, pos)).toBe(false)
  })

  it('光标停在标题行末尾（= 折叠区起点）不算掉进去 —— 否则折完当场就弹开', () => {
    // 这一条是真事：折叠命令会把光标挪到标题行上，而那个位置**就是**折叠区的 from。
    // 闭区间的判定会让下一个带选区的事务（滚动、状态栏跟随…）当场展开它，
    // 表现是「菜单点了没反应」
    let state = make()
    const pos = headingPos(state, '甲')
    const head = state.doc.lineAt(pos).to
    state = fold(state, pos)
    const next = state.update({ selection: { anchor: head } }).state
    expect(sectionFolded(next, pos)).toBe(true)
    // 再往里一个字符就算掉进去了
    const deeper = next.update({ selection: { anchor: head + 1 } }).state
    expect(sectionFolded(deeper, pos)).toBe(false)
  })

  it('别的地方动光标不影响折叠', () => {
    let state = make()
    const pos = headingPos(state, '甲')
    state = fold(state, pos)
    const next = state.update({ selection: { anchor: 2 } }).state
    expect(sectionFolded(next, pos)).toBe(true)
  })

  it('折叠那一下自己不算「落点掉进去」（否则点了就当场弹回来）', () => {
    const state = make()
    const pos = headingPos(state, '甲')
    const inside = state.doc.toString().indexOf('甲的正文。')
    // 光标本来就在这一节里，同一个事务里折叠 + 把光标挪到标题行（toggleFoldAt 的做法）
    const withCursor = state.update({ selection: { anchor: inside } }).state
    const folded = withCursor.update({
      effects: toggleSectionFold.of(pos),
      selection: { anchor: withCursor.doc.lineAt(pos).to }
    }).state
    expect(sectionFolded(folded, pos)).toBe(true)
  })
})

describe('sectionAt（命令入口靠它找「本节」）', () => {
  const state = make()

  it('嵌套时取最里面那一层', () => {
    const at = state.doc.toString().indexOf('甲一的正文。')
    expect(sectionAt(state, at)!.text).toBe('甲一')
  })

  it('光标在标题行上 = 那一节自己', () => {
    expect(sectionAt(state, headingPos(state, '乙'))!.text).toBe('乙')
  })

  it('第一个标题之前没有节', () => {
    const lead = make('开场白\n\n# 一级\n\n正文\n')
    expect(sectionAt(lead, 1)).toBeNull()
  })
})


/**
 * 折叠一条列表（0.4.1）。列表与小节共用同一个 StateField，所以这儿只测「多出来的
 * 那一半」：范围怎么算、嵌套怎么收、以及**手边最近的那一层说了算** ——
 * 光标在列表里按折叠键，折的必须是这一条，不是它所在的整节。
 */
const LIST = [
  '# 一级',
  '',
  '- 父项',
  '  - 子项 A',
  '    - 孙项',
  '- 另一个父项',
  '',
  '收尾正文。',
  ''
].join('\n')

/** toggleFoldAt 要一个 view，这儿只借它的 state 与 dispatch */
function toggleAt(state: EditorState, pos: number): { state: EditorState; moved: boolean } {
  let next = state
  const view = {
    state,
    dispatch: (spec: Parameters<EditorState['update']>[0]) => {
      next = state.update(spec).state
    }
  } as unknown as EditorView
  const moved = toggleFoldAt(view, pos)
  return { state: next, moved }
}

function itemPos(state: EditorState, text: string): number {
  const at = state.doc.toString().indexOf(text)
  return state.doc.lineAt(at).from + (state.doc.lineAt(at).text.length - state.doc.lineAt(at).text.trimStart().length)
}

describe('折叠一条列表', () => {
  const state = make(LIST)

  it('从本条首行末尾起 —— 这一条自己永远看得见', () => {
    const pos = itemPos(state, '- 父项')
    const span = spanAt(state, pos)!
    expect(state.doc.sliceString(pos, span.from)).toBe('- 父项')
  })

  it('**不吃最后那个换行** —— 吃了的话下一条会被吸到折叠行的尾巴上', () => {
    const span = spanAt(state, itemPos(state, '- 父项'))!
    expect(state.doc.sliceString(span.to, span.to + 1)).toBe('\n')
    expect(state.doc.lineAt(span.to + 1).text).toBe('- 另一个父项')
  })

  it('子项算在自己身上，兄弟不算', () => {
    const span = spanAt(state, itemPos(state, '- 父项'))!
    const hidden = state.doc.sliceString(span.from, span.to)
    expect(hidden).toContain('子项 A')
    expect(hidden).toContain('孙项')
    expect(hidden).not.toContain('另一个父项')
  })

  it('没有子项的一条折不起来（别给把手）', () => {
    expect(spanAt(state, itemPos(state, '- 另一个父项'))).toBeNull()
  })

  it('嵌套时只留外层那一条 —— 两条跨行替换重叠 CM 当场报错', () => {
    const outer = itemPos(state, '- 父项')
    const inner = itemPos(state, '- 子项 A')
    const both = fold(fold(state, outer), inner)
    const spans = foldedSpans(both)
    expect(spans).toHaveLength(1)
    expect(spans[0]!.pos).toBe(outer)
  })

  it('里层的列表项优先于外层的小节：光标在列表里，折的是这一条', () => {
    const inside = state.doc.toString().indexOf('孙项')
    const { state: after, moved } = toggleAt(state, inside)
    expect(moved).toBe(true)
    // 折的是「子项 A」那一条（孙项最里层那条自己没东西可折，往外退一层）
    expect(sectionFolded(after, itemPos(state, '- 子项 A'))).toBe(true)
    expect(sectionFolded(after, headingPos(state, '一级'))).toBe(false)
  })

  it('光标在标题行上仍然折整节 —— 标题行不在任何列表项里', () => {
    const h = headingPos(state, '一级')
    const { state: after, moved } = toggleAt(state, h)
    expect(moved).toBe(true)
    expect(sectionFolded(after, h)).toBe(true)
  })

  it('折起来之后光标被挪到首行上 —— 留在藏起来的正文里会被当场展开', () => {
    const inside = state.doc.toString().indexOf('孙项')
    const withCursor = state.update({ selection: { anchor: inside } }).state
    const { state: after } = toggleAt(withCursor, inside)
    const span = spanAt(state, itemPos(state, '- 子项 A'))!
    expect(after.selection.main.head).toBe(span.from)
    expect(sectionFolded(after, span.pos)).toBe(true)
  })
})
