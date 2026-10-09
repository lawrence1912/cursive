import { readFileSync } from 'node:fs'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { blankHint, blankHintDecos, blankHintShown } from '../src/renderer/editor/blank-hint'
import { linkTitle } from '../src/renderer/editor/link'
import { buildDecorations } from '../src/renderer/editor/live-preview/decorate'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'
import { setLang } from '../src/renderer/i18n'
import { normalizePrefs } from '../src/renderer/ui/prefs'
import { keyOf } from '../src/renderer/ui/shortcuts'

/**
 * 第八节 14：改善已有功能的可发现性。
 * 空白文档那两行（`editor/blank-hint.ts`）、链接的悬停说明、偏好里的「操作提示」开关。
 * 弹出来的样子、点「不再显示」、设置面板那一行由 `release.sh` 的 E2E（`hintProbe`）在真窗口里看
 */

interface HintWidget {
  slash: string
  palette: string
  off: string
  eq(o: unknown): boolean
}

function widgetOf(state: { doc: { length: number }; readOnly: boolean }): HintWidget | null {
  let found: HintWidget | null = null
  blankHintDecos(state).between(0, 0, (_from, _to, value) => {
    found = (value.spec as { widget: HintWidget }).widget
  })
  return found
}

describe('空白文档提示：什么时候摆出来', () => {
  afterEach(() => setLang('zh'))

  it('一个字都没有、写得进去 → 摆；有字 / 只读 → 不摆', () => {
    const blank = EditorState.create({ doc: '' })
    expect(blankHintShown(blank)).toBe(true)
    expect(blankHintDecos(blank).size).toBe(1)
    // 排在 0 号位置之后：光标停在提示前面，打字从左边开始
    blankHintDecos(blank).between(0, 0, (from, to, value) => {
      expect([from, to]).toEqual([0, 0])
      expect((value.spec as { side: number }).side).toBe(1)
    })

    expect(blankHintShown(EditorState.create({ doc: 'a' }))).toBe(false)
    expect(blankHintDecos(EditorState.create({ doc: '\n' })).size).toBe(0)
    // 只读的空文档摆「输入 / …」是在骗人
    const ro = EditorState.create({ doc: '', extensions: EditorState.readOnly.of(true) })
    expect(blankHintShown(ro)).toBe(false)
    expect(blankHintDecos(ro).size).toBe(0)
  })

  it('说的是斜杠菜单与命令面板；命令面板的键与菜单是同一个', () => {
    const w = widgetOf(EditorState.create({ doc: '' }))!
    expect(w.slash).toContain('/')
    expect(w.palette).toContain(keyOf('view:command-palette')!)
    expect(w.off).toBe('不再显示')
  })

  it('切了语言就换一份（eq 按文案比；同一种语言下不重画，那 0.4s 的淡入不会再走一遍）', () => {
    const zhW = widgetOf(EditorState.create({ doc: '' }))!
    expect(zhW.eq(widgetOf(EditorState.create({ doc: '' })))).toBe(true)
    setLang('en')
    const enW = widgetOf(EditorState.create({ doc: '' }))!
    expect(enW.palette).toContain('⇧⌘P')
    expect(zhW.eq(enW)).toBe(false)
  })

  it('开关是两个常量：main.ts 靠同一性判断「已经是这样了」，拖滑杆时不必每下都 reconfigure', () => {
    expect(blankHint(true)).toBe(blankHint(true))
    expect(blankHint(false)).toBe(blankHint(false))
    expect(blankHint(false)).toEqual([])
    expect(blankHint(true)).not.toBe(blankHint(false))
  })
})

describe('偏好里的「操作提示」', () => {
  it('老偏好里没有这一项 → 开着；明说过不要的才关着', () => {
    expect(normalizePrefs({}).hints).toBe(true)
    expect(normalizePrefs({ hints: false }).hints).toBe(false)
    expect(normalizePrefs({ hints: true }).hints).toBe(true)
  })
})

describe('链接的悬停说明：通向哪儿 + 怎么打开', () => {
  afterEach(() => setLang('zh'))

  it('有地址就两行，没有就只说怎么打开；跟着语言走', () => {
    expect(linkTitle('#小节')).toBe('#小节\n⌘ + 点击打开')
    expect(linkTitle()).toBe('⌘ + 点击打开')
    setLang('en')
    expect(linkTitle('a.md')).toBe('a.md\n⌘ + click to open')
  })

  /** 装饰器只读 state + visibleRanges，假 view 就够跑（同 code.test.ts） */
  function linkTitles(doc: string): string[] {
    const state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [cursiveMarkdown()] })
    ensureSyntaxTree(state, doc.length, 5000)
    const view = { state, visibleRanges: [{ from: 0, to: doc.length }] } as unknown as EditorView
    const out: [number, string][] = []
    buildDecorations(view).between(0, doc.length, (from, to, value) => {
      const spec = value.spec as { class?: string; attributes?: { title?: string } }
      if (spec.class?.split(' ').includes('cm-lp-link'))
        out.push([from, `${doc.slice(from, to)} → ${spec.attributes?.title ?? '(无)'}`])
    })
    // RangeSet.between 不保证顺序（分层存放），按位置排一下再比
    return out.sort((a, b) => a[0] - b[0]).map(([, s]) => s)
  }

  it('行内、引用式、<地址>、裸链接四种写法都说得出怎么打开', () => {
    const doc = '[跳](#小节) 与 [引][r] 与 <https://a.b> 与 https://example.com 。\n\n[r]: https://r.s\n\n末行\n'
    expect(linkTitles(doc)).toEqual([
      '[跳](#小节) → #小节\n⌘ + 点击打开',
      '[引][r] → ⌘ + 点击打开',
      '<https://a.b> → ⌘ + 点击打开',
      'https://example.com → ⌘ + 点击打开'
    ])
  })
})

describe('接线', () => {
  const main = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8')
  const setup = readFileSync(new URL('../src/renderer/editor/setup.ts', import.meta.url), 'utf8')

  it('每个新 state 都按当下的偏好挂上（hintsNow 是种子）', () => {
    expect(setup).toContain('hintConf.of(blankHint(hintsNow.on))')
  })

  it('偏好一变、切回一个冻结的标签，都对齐一次（同拼写检查）', () => {
    const at = main.indexOf('const prefs = new Prefs(')
    const onApply = main.slice(at, main.indexOf('prefs.apply()', at))
    expect(onApply).toContain('syncHints()')
    const activate = main.slice(main.indexOf('view.setState(tab.state)'), main.indexOf('outline.setDoc('))
    expect(activate).toContain('syncHints()')
  })

  it('「不再显示」关的是偏好，回执里给一颗撤销', () => {
    const dismiss = main.slice(main.indexOf('blankHintHost.dismiss ='), main.indexOf('blankHintHost.dismiss =') + 300)
    expect(dismiss).toContain('prefs.setHints(false)')
    expect(dismiss).toContain('prefs.setHints(true)')
  })
})
