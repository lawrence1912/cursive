import { EditorState } from '@codemirror/state'
import { SearchQuery, search, setSearchQuery } from '@codemirror/search'
import { describe, expect, it, vi } from 'vitest'
import { searchStat } from '../src/renderer/editor/search-panel'

function queried(doc: string, query: SearchQuery) {
  return EditorState.create({ doc, extensions: [search()] })
    .update({ effects: setSearchQuery.of(query) }).state
}

describe('查找计数', () => {
  it('光标移动和无关 effect 不重扫文档，序号仍跟随选区', () => {
    const query = new SearchQuery({ search: '正文' })
    const scan = vi.spyOn(query, 'getCursor')
    let state = queried('正文 a\n正文 b\n正文 c', query)
    expect(searchStat(state)).toMatchObject({ total: 3, index: 1 })
    state = state.update({ selection: { anchor: 5 } }).state
    expect(searchStat(state)).toMatchObject({ total: 3, index: 2 })
    state = state.update({ selection: { anchor: state.doc.length } }).state
    expect(searchStat(state)).toMatchObject({ total: 3, index: 0 })
    expect(searchStat(state.update({}).state).total).toBe(3)
    expect(scan).toHaveBeenCalledTimes(1)
  })

  it('无匹配的长文档也缓存结果，不能每按方向键就扫全文', () => {
    const query = new SearchQuery({ search: 'missing' })
    const scan = vi.spyOn(query, 'getCursor')
    let state = queried('一行正文\n'.repeat(10_000), query)
    for (let anchor = 0; anchor < 20; anchor++) {
      state = state.update({ selection: { anchor } }).state
      expect(searchStat(state)).toMatchObject({ total: 0, index: 0 })
    }
    expect(scan).toHaveBeenCalledTimes(1)
  })

  it('修改正文、查询和查询选项都会刷新计数', () => {
    let state = queried('a A a', new SearchQuery({ search: 'a' }))
    expect(searchStat(state).total).toBe(3)
    state = state.update({ changes: { from: 0, to: 1 } }).state
    expect(searchStat(state).total).toBe(2)
    state = state.update({ effects: setSearchQuery.of(new SearchQuery({ search: 'a', caseSensitive: true })) }).state
    expect(searchStat(state).total).toBe(1)
    state = state.update({ effects: setSearchQuery.of(new SearchQuery({ search: 'z' })) }).state
    expect(searchStat(state).total).toBe(0)
  })

  it('整词搜索跟随光标所在语言的词边界规则', () => {
    const query = new SearchQuery({ search: 'one', wholeWord: true })
    let state = EditorState.create({
      doc: 'one-two one',
      extensions: [search(), EditorState.languageData.of((_state, pos) =>
        pos >= 8 ? [{ wordChars: '-' }] : [])]
    }).update({ effects: setSearchQuery.of(query) }).state
    expect(searchStat(state).total).toBe(2)
    state = state.update({ selection: { anchor: 8 } }).state
    expect(searchStat(state)).toMatchObject({ total: 1, index: 1 })
  })

  it('保留空查询、非法正则与截断语义', () => {
    expect(searchStat(queried('a', new SearchQuery({ search: '' }))).empty).toBe(true)
    expect(searchStat(queried('a', new SearchQuery({ search: '[', regexp: true }))).invalid).toBe(true)
    const state = queried('a '.repeat(6000), new SearchQuery({ search: 'a' }))
    expect(searchStat(state)).toMatchObject({ total: 5000, capped: true, index: 1 })
    expect(searchStat(state.update({ selection: { anchor: 10_001 } }).state).index).toBe(0)
  })
})
