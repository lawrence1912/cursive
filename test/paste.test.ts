import { describe, expect, it } from 'vitest'
import { choosePasteContent } from '../src/renderer/editor/paste'

describe('P2-4 choosePasteContent', () => {
  it('无 HTML → 用纯文本', () => {
    expect(choosePasteContent('hello', null, () => 'X')).toEqual({ text: 'hello', converted: false })
  })

  it('HTML 转出不同内容 → 用转换结果（网页/飞书/Notion）', () => {
    expect(choosePasteContent('hello', '<p>hi</p>', () => 'hi')).toEqual({ text: 'hi', converted: true })
  })

  it('转换结果与纯文本一致 → 用纯文本（本编辑器自复制，避免往返损失）', () => {
    expect(choosePasteContent('**bold**', '<strong>bold</strong>', () => '**bold**')).toEqual({
      text: '**bold**',
      converted: false
    })
  })

  it('转换抛错 → 回退纯文本', () => {
    expect(
      choosePasteContent('x', '<p>y</p>', () => {
        throw new Error('boom')
      })
    ).toEqual({ text: 'x', converted: false })
  })
})
