import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'
import { inlineSegments, plainInline } from '../src/renderer/editor/inline-text'

/**
 * 0.4.0 还的第一条账：脚注定义区里的行内语法。
 *
 * `plainInline` 把语法**剥干净**（大纲要的是纯文字），而 widget 要的是「剥掉标记、
 * 但记得这段外面裹着什么」。两个函数走同一棵树、同一张标记表，所以这里成对断言 ——
 * 漂了的话说明有人只改了一边。
 */
function segs(doc: string) {
  const state = EditorState.create({ doc, extensions: [cursiveMarkdown()] })
  return inlineSegments(state, 0, state.doc.length)
}

function plain(doc: string) {
  const state = EditorState.create({ doc, extensions: [cursiveMarkdown()] })
  return plainInline(state, 0, state.doc.length)
}

describe('带样式的行内片段', () => {
  it('加粗：星号不见了，样式记下来了', () => {
    expect(segs('前 **粗** 后')).toEqual([
      { text: '前 ', cls: '' },
      { text: '粗', cls: 'cm-lp-seg-strong' },
      { text: ' 后', cls: '' }
    ])
  })

  it('斜体 / 行内代码 / 删除线各归各的类', () => {
    expect(segs('*斜*').map((s) => s.cls)).toEqual(['cm-lp-seg-em'])
    expect(segs('`码`').map((s) => s.cls)).toEqual(['cm-lp-inline-code'])
    expect(segs('~~删~~').map((s) => s.cls)).toEqual(['cm-lp-seg-strike'])
  })

  it('嵌套：粗里套斜，两个类都在', () => {
    const inner = segs('**粗*斜*粗**').find((s) => s.text === '斜')!
    expect(inner.cls.split(' ').sort()).toEqual(['cm-lp-seg-em', 'cm-lp-seg-strong'])
  })

  it('链接只留文字（地址不进脚注那一行）', () => {
    expect(segs('见 [文档](a.md)')).toEqual([
      { text: '见 ', cls: '' },
      { text: '文档', cls: 'cm-lp-link' }
    ])
  })

  it('emoji 与转义与 plainInline 一模一样（同一张表，不许漂）', () => {
    for (const doc of ['笑 :smile: 了', '星号 \\* 不是斜体', '**粗** 与 `码`']) {
      expect(segs(doc).map((s) => s.text).join('')).toBe(plain(doc))
    }
  })

  it('连着的同款片段并成一条 —— 一个字一个 span 对谁都没好处', () => {
    expect(segs('普通文字没有任何语法')).toHaveLength(1)
  })
})
