import { describe, expect, it } from 'vitest'
import { parseGoto } from '../src/renderer/ui/goto'

describe('跳到行的查询解析', () => {
  it('只写行号 = 当前文档', () => {
    expect(parseGoto(':120')).toEqual({ name: '', line: 120 })
    expect(parseGoto('  :12  ')).toEqual({ name: '', line: 12 })
  })

  it('文件名 + 行号', () => {
    expect(parseGoto('readme:120')).toEqual({ name: 'readme', line: 120 })
    expect(parseGoto('src/ui/palette.ts:88')).toEqual({ name: 'src/ui/palette.ts', line: 88 })
    // 名字那半也 trim —— 从别处复制来的常带一个空格
    expect(parseGoto('notes :7')).toEqual({ name: 'notes', line: 7 })
  })

  it('末尾不是数字就与行号无关 —— 这些照旧只当文件名匹配', () => {
    expect(parseGoto('readme')).toBeNull()
    expect(parseGoto('a:b')).toBeNull()
    expect(parseGoto('draft:')).toBeNull()
    expect(parseGoto('https://example.com')).toBeNull()
    expect(parseGoto('C:\\notes\\a.md')).toBeNull()
    expect(parseGoto('')).toBeNull()
  })

  it('0 夹成第 1 行，前导零照收 —— 为这个报错没道理', () => {
    expect(parseGoto(':0')).toEqual({ name: '', line: 1 })
    expect(parseGoto(':007')).toEqual({ name: '', line: 7 })
  })

  it('多个冒号时按最后一个断开（前面那截整个当文件名）', () => {
    expect(parseGoto('a:b:30')).toEqual({ name: 'a:b', line: 30 })
  })
})
