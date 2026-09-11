import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decode, encode } from '../src/shared/textfile'

/** 本项目的核心承诺：打开 → 不编辑 → 保存，字节必须完全一致 */
function roundtrip(raw: string): string {
  const { text, fingerprint } = decode(raw)
  return encode(text, fingerprint)
}

describe('换行与 BOM 指纹', () => {
  it.each([
    ['LF', 'a\nb\nc\n'],
    ['CRLF', 'a\r\nb\r\nc\r\n'],
    ['CR', 'a\rb\rc\r'],
    ['无尾换行', 'a\nb'],
    ['空文件', ''],
    ['单行无换行', '# 标题'],
    ['BOM + LF', '﻿# 标题\n正文\n'],
    ['BOM + CRLF', '﻿# 标题\r\n正文\r\n'],
    ['只有换行', '\n\n\n'],
    ['CJK 与 emoji', '中文段落 🚀\n第二行\n']
  ])('%s 往返零损耗', (_name, raw) => {
    expect(roundtrip(raw)).toBe(raw)
  })

  it('剥掉 BOM 后正文第一个字符是 #，标题才解析得出来', () => {
    expect(decode('﻿# 标题').text).toBe('# 标题')
  })

  it('CRLF 文件在编辑器里是 LF', () => {
    expect(decode('a\r\nb').text).toBe('a\nb')
  })

  it('混合换行取占多数的那种', () => {
    expect(decode('a\r\nb\r\nc\n').fingerprint.eol).toBe('\r\n')
    expect(decode('a\nb\nc\r\n').fingerprint.eol).toBe('\n')
  })
})

describe('语料文件往返', () => {
  const dir = join(import.meta.dirname, 'fixtures')
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'))

  it('语料目录非空', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files)('%s 字节不变', (file) => {
    const raw = readFileSync(join(dir, file), 'utf8')
    expect(roundtrip(raw)).toBe(raw)
  })
})
