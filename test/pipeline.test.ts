import { EditorState } from '@codemirror/state'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decode, encode } from '../src/shared/textfile'

/**
 * 全链路保真：磁盘字节 → decode → CodeMirror state → doc.toString() → encode → 磁盘字节。
 * 这就是「打开、不编辑、保存，diff 为空」在代码层面的等价断言。
 */
function fullRoundtrip(raw: string): string {
  const { text, fingerprint } = decode(raw)
  const state = EditorState.create({ doc: text })
  return encode(state.doc.toString(), fingerprint)
}

describe('磁盘 → CodeMirror → 磁盘', () => {
  const dir = join(import.meta.dirname, 'fixtures')

  it.each(readdirSync(dir).filter((f) => f.endsWith('.md')))('%s 字节不变', (file) => {
    const raw = readFileSync(join(dir, file), 'utf8')
    expect(fullRoundtrip(raw)).toBe(raw)
  })

  it.each([
    ['CRLF 文档', 'a\r\nb\r\n'],
    ['BOM + CRLF', '﻿# 标题\r\n\r\n正文\r\n'],
    ['连续空行', 'a\n\n\n\nb\n'],
    ['行尾空格（markdown 硬换行）', 'a  \nb\n'],
    ['制表符缩进', '- a\n\t- b\n'],
    ['无尾换行', '最后一行']
  ])('%s', (_n, raw) => {
    expect(fullRoundtrip(raw)).toBe(raw)
  })

  it('改一处，只有那一处变', () => {
    const raw = '# 标题\r\n\r\n第一段\r\n第二段\r\n'
    const { text, fingerprint } = decode(raw)
    const state = EditorState.create({ doc: text })
    const at = text.indexOf('第一段')
    const next = state.update({ changes: { from: at, to: at + 3, insert: '改过的段' } }).state
    expect(encode(next.doc.toString(), fingerprint)).toBe('# 标题\r\n\r\n改过的段\r\n第二段\r\n')
  })
})
