import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { count, group, readLabel, readMinutes, shape } from '../src/shared/wordcount'
import { cursorLabel, measure, selectedText, statRows } from '../src/renderer/ui/stats'

describe('字数统计（P3-8）', () => {
  it('中英混排：汉字按字、拉丁按词', () => {
    const c = count('你好 world，再见 CodeMirror 6')
    expect(c.cjk).toBe(4)
    expect(c.latin).toBe(3) // world / CodeMirror / 6
    expect(c.words).toBe(7)
  })

  it('字符数按码点算 —— emoji 是一个不是两个', () => {
    const c = count('🎉ab')
    expect(c.chars).toBe(3)
    expect([...'🎉'].length).toBe(1)
    expect('🎉'.length).toBe(2) // UTF-16 口径是 2，别退回去
  })

  it('不含空格的字符数把换行和制表符也刨掉', () => {
    const c = count('a b\tc\nd ')
    expect(c.chars).toBe(8)
    expect(c.charsNoSpace).toBe(4)
  })

  it('空文档全是 0', () => {
    expect(count('')).toEqual({ words: 0, cjk: 0, latin: 0, chars: 0, charsNoSpace: 0 })
    expect(shape('')).toEqual({ paragraphs: 0, lines: 0 })
  })
})

describe('段落与行', () => {
  it('空行分段，连续空行不算出空段落', () => {
    expect(shape('第一段\n还是第一段\n\n\n第二段\n').paragraphs).toBe(2)
  })

  it('只有空白的「空行」照样分段（缩进块之间常是这样）', () => {
    expect(shape('一\n   \n二').paragraphs).toBe(2)
  })

  it('行数与 CodeMirror 的 doc.lines 同口径', () => {
    for (const doc of ['a', 'a\n', 'a\nb', 'a\nb\n\n']) {
      expect(shape(doc).lines).toBe(EditorState.create({ doc }).doc.lines)
    }
  })
})

describe('阅读时间', () => {
  it('中文 300 字/分、英文 200 词/分，各按各的算再相加', () => {
    expect(readMinutes(count('字'.repeat(600)))).toBeCloseTo(2)
    expect(readMinutes(count('word '.repeat(400)))).toBeCloseTo(2)
    // 混排：600 汉字(2 分) + 200 英文词(1 分)
    expect(readMinutes(count('字'.repeat(600) + ' ' + 'word '.repeat(200)))).toBeCloseTo(3)
  })

  it('不足一分钟不说「0 分钟」，空文档干脆不显示', () => {
    expect(readLabel(count('只有几个字'))).toBe('不到 1 分钟')
    expect(readLabel(count('字'.repeat(1500)))).toBe('约 5 分钟')
    expect(readLabel(count('   \n  '))).toBe('')
  })
})

describe('千分位', () => {
  it('三位一撇，四位以下不动', () => {
    expect(group(0)).toBe('0')
    expect(group(999)).toBe('999')
    expect(group(1000)).toBe('1,000')
    expect(group(1234567)).toBe('1,234,567')
  })
})

describe('光标行列', () => {
  const st = (doc: string, anchor: number) => EditorState.create({ doc, selection: { anchor } })

  it('两个数都从 1 起', () => {
    expect(cursorLabel(st('abc\ndef', 0))).toBe('行 1 · 列 1')
    expect(cursorLabel(st('abc\ndef', 5))).toBe('行 2 · 列 2')
  })

  it('列按码点数 —— emoji 后面是第 2 列不是第 3 列', () => {
    expect(cursorLabel(st('🎉x', 2))).toBe('行 1 · 列 2')
  })

  it('行末与文末不越界', () => {
    const doc = 'abc\ndef'
    expect(cursorLabel(st(doc, doc.length))).toBe('行 2 · 列 4')
  })
})

describe('选区统计', () => {
  const doc = '你好世界\nhello world'

  it('没有选区返回 null（状态栏就显示全文那份）', () => {
    expect(selectedText(EditorState.create({ doc, selection: { anchor: 3 } }))).toBeNull()
  })

  it('单选区取原文', () => {
    const state = EditorState.create({ doc, selection: { anchor: 0, head: 4 } })
    expect(selectedText(state)).toBe('你好世界')
    expect(measure(selectedText(state)!).words).toBe(4)
  })

  it('多光标把各段接起来一起数，空的那些不算', () => {
    const state = EditorState.create({
      doc,
      // 不开这条 CM 只留主选区，多光标断言就成了假的
      extensions: [EditorState.allowMultipleSelections.of(true)],
      selection: EditorSelection.create([
        EditorSelection.range(0, 2),
        EditorSelection.cursor(4),
        EditorSelection.range(5, 10)
      ])
    })
    expect(selectedText(state)).toBe('你好\nhello')
    expect(measure(selectedText(state)!).words).toBe(3)
  })
})

describe('统计面板的行', () => {
  it('没有选区时选中列全是空串（整列不渲染）', () => {
    const rows = statRows(measure('你好 world'), null)
    expect(rows.map((r) => r.label)).toEqual([
      '词',
      '字符',
      '不含空格',
      '中日韩字',
      '拉丁词',
      '段落',
      '行',
      '阅读时间'
    ])
    expect(rows.every((r) => r.sel === '')).toBe(true)
    expect(rows[0]!.all).toBe('3')
  })

  it('有选区时两列各算各的，千分位照样生效', () => {
    const rows = statRows(measure('字'.repeat(1200)), measure('你好'))
    expect(rows[0]).toEqual({ label: '词', all: '1,200', sel: '2' })
    // 全文 4 分钟；选中两个字不足一分钟 —— 这一行不能是空的
    expect(rows[7]).toEqual({ label: '阅读时间', all: '约 4 分钟', sel: '不到 1 分钟' })
  })
})

describe('倒挂选区（CM 映射的产物）', () => {
  /**
   * 一次把选区整段吞掉的改写（整理表格 / 大纲搬节 / 覆盖粘贴）之后，CM 的
   * `SelectionRange.map` 会拿 assoc=+1 算 from、assoc=−1 算 to，且**不再归一化** ——
   * 于是留下一个 `from > to` 的区间：`empty` 是 false，切出来却是空串。
   * 状态栏因此显示过「已选 0 词 · 0 字符」。
   */
  it('from > to 的区间当成没有选区', () => {
    const doc = '第一行\n第二行\n第三行'
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.indexOf('第二行'), head: doc.indexOf('第二行') + 3 }
    })
    const next = state.update({
      changes: { from: 0, to: state.doc.length, insert: '换成完全另一份内容' }
    }).state
    const r = next.selection.main
    expect(r.empty).toBe(false)
    expect(r.from > r.to).toBe(true)
    expect(selectedText(next)).toBeNull()
  })
})
