import TurndownService from 'turndown'
import { beforeAll, describe, expect, it } from 'vitest'
import { configureTurndown } from '../src/renderer/editor/paste-rules'

/**
 * 0.2.0 粘贴保真。
 *
 * 用的是真 turndown（node 下它自带 domino，不需要 jsdom），所以这份断言
 * 守的是**整条转换链**，不是某个正则。每一条的由来都是「编辑器认得这个写法，
 * 而 turndown 默认会把它抹平」—— 改规则时先看这里还绿不绿。
 */
let td: TurndownService

beforeAll(() => {
  td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**'
  })
  configureTurndown(td)
})

const md = (html: string): string => td.turndown(html)

describe('表格', () => {
  it('thead + tbody → GFM 表格（原先碎成七个段落）', () => {
    expect(
      md(
        `<table><thead><tr><th>语言</th><th>年份</th></tr></thead>` +
          `<tbody><tr><td>Swift</td><td>2014</td></tr><tr><td>Rust</td><td>2010</td></tr></tbody></table>`
      )
    ).toBe(['| 语言 | 年份 |', '| --- | --- |', '| Swift | 2014 |', '| Rust | 2010 |'].join('\n'))
  })

  it('全是 td 的表（Excel / Numbers 复制出来的形状）→ 第一行提为表头', () => {
    expect(md('<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>')).toBe(
      ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n')
    )
  })

  it('align 属性与内联 text-align 都转成对齐记号', () => {
    expect(
      md(
        '<table><tr><th align="left">L</th><th style="text-align:center">C</th>' +
          '<th style="TEXT-ALIGN: right">R</th></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>'
      )
    ).toBe(['| L | C | R |', '| :--- | :---: | ---: |', '| 1 | 2 | 3 |'].join('\n'))
  })

  it('格内行内标记照常转换', () => {
    expect(md('<table><tr><th>x</th></tr><tr><td><strong>粗</strong> <code>c</code></td></tr></table>')).toBe(
      ['| x |', '| --- |', '| **粗** `c` |'].join('\n')
    )
  })

  it('格里的竖线转义，换行压成空格 —— 否则整张表当场散架', () => {
    expect(md('<table><tr><th>h</th></tr><tr><td><p>一</p><p>二 | 三</p></td></tr></table>')).toBe(
      ['| h |', '| --- |', '| 一 二 \\| 三 |'].join('\n')
    )
  })

  it('空格子留着（列数不能塌）', () => {
    expect(md('<table><tr><th>a</th><th>b</th></tr><tr><td></td><td>2</td></tr></table>')).toBe(
      ['| a | b |', '| --- | --- |', '|  | 2 |'].join('\n')
    )
  })

  it('colspan 退化成补空格子，列数对得上', () => {
    expect(md('<table><tr><th colspan="2">跨两列</th></tr><tr><td>1</td><td>2</td></tr></table>')).toBe(
      ['| 跨两列 | |', '| --- | --- |', '| 1 | 2 |'].join('\n')
    )
  })

  it('colgroup 不留空行，caption 摆到表前面', () => {
    expect(
      md('<table><caption>表一</caption><colgroup><col></colgroup><tr><td>a</td></tr></table>')
    ).toBe(['表一', '| a |', '| --- |'].join('\n'))
  })

  it('表格前后各空一行，和前后文不粘连', () => {
    expect(md('<p>前</p><table><tr><td>a</td></tr></table><p>后</p>')).toBe(
      ['前', '', '| a |', '| --- |', '', '后'].join('\n')
    )
  })
})

describe('方言与任务项', () => {
  it('mark / sup / sub → ==高亮== · ^上标^ · ~下标~', () => {
    expect(md('<p><mark>要点</mark> x<sup>2</sup> H<sub>2</sub>O</p>')).toBe('==要点== x^2^ H~2~O')
  })

  it('del / s → ~~删除线~~', () => {
    expect(md('<p><del>甲</del><s>乙</s></p>')).toBe('~~甲~~~~乙~~')
  })

  it('空标记不留空壳（`====` 不是标记）', () => {
    expect(md('<p>a<mark></mark>b</p>')).toBe('ab')
  })

  it('任务项带勾选态，且 `- [x] ` 恰好一个空格 —— fmt.ts 的正则按这个认', () => {
    const out = md(
      '<ul><li><input type="checkbox" checked>做完的</li><li><input type="checkbox">没做的</li></ul>'
    )
    expect(out).toBe(['- [x] 做完的', '- [ ] 没做的'].join('\n'))
    expect(/^[-*+]\s\[[ xX]\]([ \t]|$)/.test(out.split('\n')[0]!)).toBe(true)
  })

  it('普通列表不受影响（还是 turndown 那套缩进）', () => {
    expect(md('<ul><li>甲</li><li>乙</li></ul>')).toBe(['-   甲', '-   乙'].join('\n'))
  })

  it('嵌套子列表里的勾不会被外层认领', () => {
    expect(md('<ul><li>外层<ul><li><input type="checkbox" checked>内层</li></ul></li></ul>')).toBe(
      ['-   外层', '    - [x] 内层'].join('\n')
    )
  })
})

describe('Word / Excel 带来的垃圾', () => {
  it('<style> 整枝丢掉 —— 默认会把 CSS 正文当正文吐出来', () => {
    expect(md('<style>.a{color:red}</style><p>hi</p>')).toBe('hi')
    expect(md('<p>hi</p><script>alert(1)</script>')).toBe('hi')
  })
})
