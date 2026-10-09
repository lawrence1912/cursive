import { readFileSync } from 'node:fs'
import { SearchQuery, search, setSearchQuery } from '@codemirror/search'
import { EditorSelection, EditorState, type ChangeSpec, type Extension } from '@codemirror/state'
import { describe, expect, it, vi } from 'vitest'
import { CAP, searchIndex, searchIndexField } from '../src/renderer/editor/search-index'
import { searchStat } from '../src/renderer/editor/search-panel'

/**
 * 第八节 18：查找命中的位置表跟着事务增量更新（`editor/search-index.ts`）。
 *
 * 增量这条路只有一个要求：**与整份重扫逐项相同**。所以这里拿随机编辑对拍 ——
 * 每一步都用一个「同样配置、另一个对象」的查询从头扫一遍当标准答案，
 * 再数一数真正的那个查询被整份扫了几次，证明对拍的确实是增量那条路。
 */

/** 可复现的伪随机（mulberry32）：红了能按种子原样重放 */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 专挑会出事的料：重叠（aa）、大小写、NFKD 会展开的连字（ﬁ）、中文、词边界（-）、换行 */
const TOKENS = ['a', 'b', 'ab', 'AB', 'aa', 'x', ' ', '正文', '正', '文', 'ﬁ', 'fi', '-', 'é', '\n', '\n', 'ab-ab']

function words(next: () => number, n: number): string {
  let out = ''
  for (let i = 0; i < n; i++) out += TOKENS[Math.floor(next() * TOKENS.length)]
  return out
}

function stateWith(doc: string, query: SearchQuery, extra: Extension = []): EditorState {
  return EditorState.create({ doc, extensions: [search(), searchIndexField, extra] })
    .update({ effects: setSearchQuery.of(query) }).state
}

/** 标准答案：另一个对象、同样的配置，从头扫一遍 */
function truth(state: EditorState, spec: ConstructorParameters<typeof SearchQuery>[0]) {
  const starts: number[] = []
  const cursor = new SearchQuery(spec).getCursor(state)
  for (let r = cursor.next(); !r.done; r = cursor.next()) {
    starts.push(r.value.from)
    if (starts.length >= CAP) break
  }
  return { starts, capped: starts.length >= CAP }
}

/** 一步随机编辑：1–3 处互不重叠的插入 / 删除 / 替换，删除可以跨行；偶尔只挪光标 */
function randomStep(next: () => number, state: EditorState) {
  const len = state.doc.length
  if (next() < 0.15) return state.update({ selection: { anchor: Math.floor(next() * (len + 1)) } })
  const cuts = [...new Set(Array.from({ length: 2 + Math.floor(next() * 5) }, () => Math.floor(next() * (len + 1))))]
    .sort((a, b) => a - b)
  const changes: ChangeSpec[] = []
  for (let i = 0; i + 1 < cuts.length && changes.length < 3; i += 2) {
    const from = cuts[i]!
    const to = next() < 0.4 ? from : cuts[i + 1]!
    changes.push({ from, to, insert: next() < 0.3 ? '' : words(next, 1 + Math.floor(next() * 4)) })
  }
  return state.update({ changes })
}

const LINE_LOCAL: ConstructorParameters<typeof SearchQuery>[0][] = [
  { search: '正文' },
  { search: 'ab' },
  { search: 'aa' },
  { search: 'ab', caseSensitive: true },
  { search: 'ab', wholeWord: true },
  { search: 'ﬁ' },
  { search: 'fi' },
  { search: 'a.b', regexp: true },
  { search: '^a', regexp: true },
  { search: 'b$', regexp: true },
  { search: '(?<=a)b', regexp: true },
  { search: 'x*', regexp: true },
  { search: 'ab', regexp: true, wholeWord: true }
]

/** 一处命中可能跨行：只能整份重扫（结果照样要对） */
const MULTI_LINE: ConstructorParameters<typeof SearchQuery>[0][] = [
  { search: 'b\\na' },
  { search: 'b\\sa', regexp: true },
  { search: '[^x]b', regexp: true }
]

describe('查找位置表：增量与整份重扫逐项相同', () => {
  for (const spec of LINE_LOCAL) {
    it(`逐行增量：${JSON.stringify(spec)}`, () => {
      for (let seed = 1; seed <= 6; seed++) {
        const next = rng(seed * 7919 + spec.search.length)
        const query = new SearchQuery(spec)
        const scan = vi.spyOn(query, 'getCursor')
        let state = stateWith(words(next, 400), query)
        expect(searchIndex(state)).toMatchObject(truth(state, spec))
        for (let step = 0; step < 60; step++) {
          state = randomStep(next, state).state
          const got = searchIndex(state)
          expect(got, `seed ${seed} step ${step}`).toMatchObject(truth(state, spec))
        }
        // 整份扫（getCursor 不带范围）只在开头那一次：之后每一步都是逐行增量推出来的
        expect(scan.mock.calls.filter((args) => args.length === 1)).toHaveLength(1)
      }
    })
  }

  for (const spec of MULTI_LINE) {
    it(`跨行查询退回整份重扫：${JSON.stringify(spec)}`, () => {
      const next = rng(4242 + spec.search.length)
      const query = new SearchQuery(spec)
      const scan = vi.spyOn(query, 'getCursor')
      let state = stateWith(words(next, 300), query)
      expect(searchIndex(state)).toMatchObject(truth(state, spec))
      let edits = 0
      for (let step = 0; step < 40; step++) {
        const tr = randomStep(next, state)
        if (tr.docChanged) edits++
        state = tr.state
        expect(searchIndex(state), `step ${step}`).toMatchObject(truth(state, spec))
      }
      // 每改一次正文就整份扫一次，光标挪动不扫
      expect(scan.mock.calls.filter((args) => args.length === 1)).toHaveLength(1 + edits)
    })
  }

  it('截在 CAP：先前全的那份推过线之后截成前 CAP 个；已经截断的那份整份重扫', () => {
    const spec = { search: 'a' }
    let state = stateWith('a\n'.repeat(CAP - 2), new SearchQuery(spec))
    expect(searchIndex(state)).toMatchObject({ capped: false })
    // 一下子多出五处：增量推出来 CAP + 3 处，截到前 CAP 个、标记截断
    state = state.update({ changes: { from: 2, insert: 'aaaaa' } }).state
    expect(searchIndex(state)).toMatchObject({ ...truth(state, spec), capped: true })
    // 截断之后后面的不知道了，只能整份重扫 —— 删掉开头几处，后面的要补上来
    state = state.update({ changes: { from: 0, to: 9 } }).state
    expect(searchIndex(state)).toMatchObject(truth(state, spec))
  })

  it('整词规则跟着光标换了语言：整份重扫，换回来也对', () => {
    const spec = { search: 'one', wholeWord: true }
    const lang = EditorState.languageData.of((_s, pos) => (pos >= 40 ? [{ wordChars: '-' }] : []))
    let state = stateWith('one-two one\n'.repeat(8), new SearchQuery(spec), lang)
    expect(searchIndex(state)).toMatchObject(truth(state, spec))
    for (const anchor of [50, 52, 3, 60]) {
      state = state.update({ selection: { anchor }, changes: { from: anchor, insert: 'one ' } }).state
      expect(searchIndex(state), `anchor ${anchor}`).toMatchObject(truth(state, spec))
    }
  })

  it('多光标同时打字（同一行上几处改动合成一段）', () => {
    const spec = { search: 'ab' }
    let state = stateWith('xx ab xx ab\n'.repeat(20), new SearchQuery(spec))
    state = state.update({ selection: EditorSelection.create([0, 3, 4, 13, 40].map((p) => EditorSelection.cursor(p))) }).state
    searchIndex(state)
    for (const ch of ['a', 'b', '\n', 'b']) {
      state = state.update(state.replaceSelection(ch)).state
      expect(searchIndex(state), ch).toMatchObject(truth(state, spec))
    }
  })

  it('替换串变了、光标挪了都不重扫；查询变了才重扫', () => {
    const query = new SearchQuery({ search: 'ab', replace: '' })
    const scan = vi.spyOn(query, 'getCursor')
    let state = stateWith('ab ab ab', query)
    expect(searchIndex(state)?.starts).toEqual([0, 3, 6])
    state = state.update({ effects: setSearchQuery.of(new SearchQuery({ search: 'ab', replace: 'x' })) }).state
    state = state.update({ selection: { anchor: 4 } }).state
    expect(searchIndex(state)?.starts).toEqual([0, 3, 6])
    expect(scan).toHaveBeenCalledTimes(1)
    state = state.update({ effects: setSearchQuery.of(new SearchQuery({ search: 'b' })) }).state
    expect(searchIndex(state)?.starts).toEqual([1, 4, 7])
  })

  it('计数读的就是这份位置表（同一个 state 不扫第二遍）', () => {
    const query = new SearchQuery({ search: '正文' })
    const scan = vi.spyOn(query, 'getCursor')
    let state = stateWith('正文 正文\n正文', query)
    expect(searchStat(state)).toMatchObject({ total: 3, index: 1 })
    expect(searchIndex(state)?.starts).toEqual([0, 3, 6])
    // '正文正文 正文\n正文'：命中在 0 / 2 / 5 / 8，光标在 2 —— 正落在第 2 处上
    state = state.update({ changes: { from: 0, insert: '正文' }, selection: { anchor: 2 } }).state
    expect(searchStat(state)).toMatchObject({ total: 4, index: 2 })
    expect(scan.mock.calls.filter((args) => args.length === 1)).toHaveLength(1)
  })
})

/** 与 shell-swift/measure.py 的 build_fixture 同一个形状：一万行，「正文」四千多处 */
function perfDoc(): string {
  const lines = ['---', 'title: 性能基线', 'tags: [基线, 测量]', '---', '', '# 性能基线文档', '']
  let sec = 0
  while (lines.length < 10_000) {
    sec++
    lines.push(`## 第 ${sec} 节`, '')
    for (let p = 0; p < 6; p++) {
      lines.push(`第 ${sec} 节第 ${p + 1} 段：撑出长度的中文正文，带一点 **粗体**、\`行内代码\`、$x_${p}$ 与 [一个链接](#第-${sec}-节)。`, '')
    }
    if (sec % 15 === 0) lines.push('| 列一 | 列二 | 列三 |', '| --- | --- | --- |', '| 1 | 数据 | 备注 |', '')
    if (sec % 10 === 0) lines.push('```ts', `const n${sec}: number = ${sec}`, '```', '')
    if (sec === 333) lines.push('【测量点】在这里打字。', '')
  }
  return lines.join('\n') + '\n'
}

describe('开着查找打字的每键开销（第八节 18，红线三）', () => {
  /**
   * 从前每打一个字，计数（dispatch 里）和滚动条刻度（测量阶段）各把全文扫一遍；
   * 现在两边读同一份位置表，改一个字只重扫那一行。这里把两笔拆开量：
   * 整份扫一遍是多少（= 从前每一笔的价钱），增量推一步又是多少。
   *
   * 比的是**比值**不是毫秒（同 perf.test.ts 那条「打字走增量」的理由：比值把机器快慢约掉了）。
   * 本机实测整份 25ms 上下、增量 0.1ms 以内；卡在 20 倍，退回整份扫时比值会掉到 1 附近。
   */
  it('每键增量推一步 < 整份重扫的 1/20', () => {
    const doc = perfDoc()
    const spec = { search: '正文' }
    let state = stateWith(doc, new SearchQuery(spec))
    const total = searchIndex(state)!.starts.length
    expect(total).toBeGreaterThan(4000)
    expect(state.doc.lines).toBeGreaterThan(10_000)

    let full = Infinity
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      truth(state, spec)
      full = Math.min(full, performance.now() - t0)
    }

    const at = doc.indexOf('【测量点】') + 5
    const times: number[] = []
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now()
      state = state.update({ changes: { from: at + i, insert: String(i % 10) } }).state
      searchIndex(state)
      times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    const step = times[Math.floor(times.length / 2)]!
    console.log(`[perf] 查找 ${total} 处：整份重扫 ${full.toFixed(1)}ms（从前计数、刻度各一遍）vs 每键增量 ${step.toFixed(3)}ms（${(full / step).toFixed(0)}×）`)
    expect(step * 20).toBeLessThan(full)
    expect(searchIndex(state)).toMatchObject(truth(state, spec))
  })

  it('滚动条刻度不再自己扫全文，读的是同一份位置表', () => {
    const marks = readFileSync(new URL('../src/renderer/editor/scroll-marks.ts', import.meta.url), 'utf8')
    expect(marks).not.toMatch(/getCursor\(/)
    expect(marks).toMatch(/searchIndex\(view\.state\)/)
    const setup = readFileSync(new URL('../src/renderer/editor/setup.ts', import.meta.url), 'utf8')
    expect(setup).toMatch(/^\s+searchIndexField,$/m)
  })
})
