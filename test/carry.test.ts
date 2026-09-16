import { ChangeSet, EditorState, Text } from '@codemirror/state'
import { Decoration, type DecorationSet, type EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { carryDecorations } from '../src/renderer/editor/carry'
import { buildDecorations } from '../src/renderer/editor/live-preview/decorate'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'

const HIDE = Decoration.replace({})
const LINE = Decoration.line({ class: 'cm-focus-line' })

/** 把一份装饰摊成 [from, to] 数组，好断言 */
function ranges(set: ReturnType<typeof Decoration.set>, len: number): [number, number][] {
  const out: [number, number][] = []
  set.between(0, len, (from, to) => {
    out.push([from, to])
  })
  return out
}

function apply(
  doc: string,
  specs: [number, number, typeof HIDE | typeof LINE][],
  change: { from: number; to?: number; insert: string }
) {
  const before = Text.of(doc.split('\n'))
  const set = Decoration.set(
    specs.map(([from, to, deco]) => deco.range(from, to)),
    true
  )
  const changes = ChangeSet.of(change, before.length)
  const after = changes.apply(before)
  return { set: carryDecorations(set, changes, after), after }
}

describe('carryDecorations：不重算的那几轮，装饰位置必须跟着文档走', () => {
  it('连续组字、选词和换行后，下方代码围栏与标题仍保持正确布局', () => {
    const doc = '正在输入\n\n' + '## 标题\n\n```js\nconst value = 123;\n```\n\n'.repeat(40)
    let state = EditorState.create({
      doc,
      selection: { anchor: 4 },
      extensions: [cursiveMarkdown()]
    })
    const build = () => buildDecorations({
      state, visibleRanges: [{ from: 0, to: state.doc.length }]
    } as unknown as EditorView)
    const snapshot = (set: DecorationSet) => {
      const out: unknown[] = []
      set.between(0, state.doc.length, (from, to, value) => {
        out.push([from, to, value.spec.class, value.spec.widget?.constructor.name])
      })
      return out
    }
    let decorations = build()
    let previous = ''
    for (const insert of ['n', 'ni', 'nih', 'nihao', '你好', '你好\n', '你好\n中文']) {
      const tr = state.update({
        changes: { from: 4, to: 4 + previous.length, insert },
        selection: { anchor: 4 + insert.length },
        userEvent: 'input.type.compose'
      })
      state = tr.state
      decorations = carryDecorations(decorations, tr.changes, state.doc)
      // 冻结期间只能映射；结果必须与重新解析的布局一致，尤其不能把
      // cm-lp-fence-off（会压缩行高）挪到正文或代码体上。
      expect(snapshot(decorations)).toEqual(snapshot(build()))
      previous = insert
    }
  })

  it('变更在装饰之前 —— 整体后移，长度不变', () => {
    // `一二**粗**三`：藏掉两对 `**`
    const doc = '一二**粗**三'
    const { set, after } = apply(doc, [[2, 4, HIDE], [5, 7, HIDE]], { from: 0, insert: '你好' })
    expect(ranges(set, after.length)).toEqual([
      [4, 6],
      [7, 9]
    ])
  })

  it('变更在装饰之后 —— 一个像素都不动', () => {
    const doc = '**粗**尾'
    const { set, after } = apply(doc, [[0, 2, HIDE], [3, 5, HIDE]], { from: 6, insert: '你好' })
    expect(ranges(set, after.length)).toEqual([
      [0, 2],
      [3, 5]
    ])
  })

  it('不映射就会让替换装饰跨行 —— 插进换行符时把它摘掉，其余原样留着', () => {
    // 第二条装饰 [8,10] 盖着 `**`；在它中间插一个换行，它就跨行了 ——
    // CM 会当场抛 `Decorations that replace line breaks may not be specified via plugins`
    const doc = '首行\n**粗**\n尾行'
    const { set, after } = apply(doc, [[3, 5, HIDE], [6, 8, HIDE]], { from: 7, insert: '\n' })
    const got = ranges(set, after.length)
    expect(got).toContainEqual([3, 5])
    for (const [from, to] of got) {
      expect(after.lineAt(from).number).toBe(after.lineAt(to).number)
    }
  })

  it('行装饰只认行首 —— 删掉前面那个换行符时由 map 自己丢掉', () => {
    const doc = '第一行\n第二行'
    // `Decoration.line` 的 mapMode 是 TrackBefore：前一个字符被删就返回 -1
    const { set, after } = apply(doc, [[0, 0, LINE], [4, 4, LINE]], { from: 3, to: 4, insert: '' })
    for (const [from] of ranges(set, after.length)) {
      expect(after.lineAt(from).from).toBe(from)
    }
  })

  it('纯行内变更（中文连打的那一种）不触发过滤，位置逐字跟随', () => {
    const doc = '正文 **粗** 收尾'
    const { set, after } = apply(doc, [[3, 5, HIDE], [6, 8, HIDE]], { from: 0, insert: '你' })
    expect(ranges(set, after.length)).toEqual([
      [4, 6],
      [7, 9]
    ])
    expect(after.lines).toBe(1)
  })
})
