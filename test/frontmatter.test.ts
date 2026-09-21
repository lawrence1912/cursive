import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'
import { tagAt, tagQuery } from '../src/renderer/editor/frontmatter'

/**
 * front matter 里的标签（0.4.1）：认它、以及把它翻成一条跨文件搜索。
 *
 * 画药丸那半是 DOM，进不了 node 测试；能错的那一半住在这儿 ——
 * 「点在哪儿算点中了一颗标签」和「那条正则到底匹不匹配得上」。
 * 尤其是后者：`\b` 那种词边界对中文标签**一个都匹配不到**，而这正是这个应用
 * 最常见的标签。
 */
const FLOW = ['---', 'title: 部署手册', 'tags: [VPS, 3x-ui, 运维]', '---', '', '# 正文', ''].join(
  '\n'
)

const BLOCK = ['---', 'tags:', '  - 运维', '  - 备份', 'draft: true', '---', '', '# 正文', ''].join(
  '\n'
)

function make(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [cursiveMarkdown()] })
}

function at(state: EditorState, text: string): number {
  const i = state.doc.toString().indexOf(text)
  if (i < 0) throw new Error(`夹具里没有：${text}`)
  return i
}

describe('认一颗标签', () => {
  it('行内数组写法', () => {
    const s = make(FLOW)
    expect(tagAt(s, at(s, 'VPS'))).toBe('VPS')
    expect(tagAt(s, at(s, '运维'))).toBe('运维')
  })

  it('块序列写法', () => {
    const s = make(BLOCK)
    expect(tagAt(s, at(s, '备份'))).toBe('备份')
  })

  it('键名、标量值、正文都不算', () => {
    const s = make(FLOW)
    expect(tagAt(s, at(s, 'title'))).toBeNull()
    expect(tagAt(s, at(s, '部署手册'))).toBeNull()
    expect(tagAt(s, at(s, '# 正文') + 2)).toBeNull()
  })

  it('front matter 之外的数组不算 —— 标签是这份文件的头，不是正文里的括号', () => {
    const s = make('# 标题\n\n正文里写一个 [a, b] 不是标签。\n')
    expect(tagAt(s, at(s, 'a,'))).toBeNull()
  })
})

describe('翻成一条搜索', () => {
  const run = (tag: string, line: string): boolean => new RegExp(tagQuery(tag)).test(line)

  it('行内数组：逗号空格分隔的都认', () => {
    expect(run('VPS', 'tags: [VPS, 3x-ui, 运维]')).toBe(true)
    expect(run('3x-ui', 'tags: [VPS, 3x-ui, 运维]')).toBe(true)
    expect(run('运维', 'tags: [VPS, 3x-ui, 运维]')).toBe(true)
  })

  it('**中文标签是这条式子存在的理由** —— `\\b运维\\b` 在同一行上一个都匹配不到', () => {
    expect(run('运维', 'tags: [VPS, 运维]')).toBe(true)
    expect(new RegExp('\\b运维\\b').test('tags: [VPS, 运维]')).toBe(false)
  })

  it('块序列：前面是空格、后面就是行尾', () => {
    expect(run('运维', '  - 运维')).toBe(true)
    expect(run('备份', '  - 备份')).toBe(true)
  })

  it('标量值也认（`tags: 运维` 这种只写一个的）', () => {
    expect(run('运维', 'tags: 运维')).toBe(true)
  })

  it('不匹配更长的同前缀标签 —— 「运维」不该搜出「运维手册」', () => {
    expect(run('运维', 'tags: [运维手册]')).toBe(false)
    expect(run('VPS', 'tags: [VPSX]')).toBe(false)
  })

  it('中文正文里不误伤：两侧没有分隔符', () => {
    expect(run('运维', '这一段讲的是运维的事。')).toBe(false)
  })

  it('正则元字符要转义 —— `c++` 不该被当成一条式子', () => {
    expect(run('c++', 'tags: [c++, rust]')).toBe(true)
    expect(() => new RegExp(tagQuery('a(b'))).not.toThrow()
  })
})
