import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'
import { tagAt, tagQuery } from '../src/renderer/editor/frontmatter'

/**
 * front matter 里的标签（0.4.1）：认它、以及把它翻成一条跨文件搜索。
 *
 * 画药丸那半是 DOM，进不了 node 测试；能错的那一半住在这儿 ——
 * 「点在哪儿算点中了一颗标签」和「那条正则到底匹不匹配得上」。
 * 尤其是后者：`\b` 那种词边界对中文标签**一个都匹配不到**，而这正是这个应用
 * 最常见的标签。
 */
const FLOW = ['---', 'title: 部署手册', 'tags: [VPS, 3x-ui, 运维]', '---', '', '# 正文', ''].join(
  '\n'
)

/** 三种写法同一颗标签：双引号、单引号、裸的。带空格的标签在 YAML 里**必须**加引号 */
const QUOTED = ['---', 'tags: ["fo o", \'运维\', bare]', '---', '', '# 正文', ''].join('\n')

const BLOCK = ['---', 'tags:', '  - 运维', '  - 备份', 'draft: true', '---', '', '# 正文', ''].join(
  '\n'
)

function make(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [cursiveMarkdown()] })
}

function at(state: EditorState, text: string): number {
  const i = state.doc.toString().indexOf(text)
  if (i < 0) throw new Error(`夹具里没有：${text}`)
  return i
}

describe('认一颗标签', () => {
  it('行内数组写法', () => {
    const s = make(FLOW)
    expect(tagAt(s, at(s, 'VPS'))).toBe('VPS')
    expect(tagAt(s, at(s, '运维'))).toBe('运维')
  })

  it('块序列写法', () => {
    const s = make(BLOCK)
    expect(tagAt(s, at(s, '备份'))).toBe('备份')
  })

  it('键名、标量值、正文都不算', () => {
    const s = make(FLOW)
    expect(tagAt(s, at(s, 'title'))).toBeNull()
    expect(tagAt(s, at(s, '部署手册'))).toBeNull()
    expect(tagAt(s, at(s, '# 正文') + 2)).toBeNull()
  })

  it('引号是 YAML 的语法，不是标签的一部分（三种写法同一颗标签）', () => {
    const s = make(QUOTED)
    expect(tagAt(s, at(s, 'fo o'))).toBe('fo o')
    expect(tagAt(s, at(s, '运维'))).toBe('运维')
    expect(tagAt(s, at(s, 'bare'))).toBe('bare')
    // 块序列里加引号同样常见（标签带空格时必须加）
    const b = make(['---', 'tags:', '  - "带 空格"', '  - 裸的', '---', '', '# 正文', ''].join('\n'))
    expect(tagAt(b, at(b, '带 空格'))).toBe('带 空格')
  })

  it('引号里的转义：双引号交给 JSON 那套，单引号只有 \'\' 一条', () => {
    const s = make(['---', 'tags: ["引\\"号", \'don\'\'t\']', '---', '', '# 正文', ''].join('\n'))
    expect(tagAt(s, at(s, '引'))).toBe('引"号')
    expect(tagAt(s, at(s, 'don'))).toBe("don't")
  })

  it('撇号在标签正文里不算引号 —— 认的是语法树上那个 QuotedLiteral', () => {
    const s = make(['---', "tags: [it's, 运维]", '---', '', '# 正文', ''].join('\n'))
    expect(tagAt(s, at(s, "it's"))).toBe("it's")
  })

  /**
   * **口径：不按键名收窄**（2026-09-22 定）。`authors: [Alice]`、`aliases: [Home]` 里的
   * 数组项同样算标签、同样可点 —— 点 Alice 就是「还有哪几篇是他写的」，与点一颗标签
   * 是同一件事，而属性表里把数组画成一串药丸本来就比一行裸 YAML 好看。README 那句话
   * 照这个口径写着。**这条测试是拿来挡「顺手收窄」的**：真要只认 `tags:`，改的是
   * 这里的口径，不是某个函数的实现细节。
   */
  it('不按键名收窄 —— tags 之外的数组项同样算标签', () => {
    const s = make(['---', 'authors: [Alice]', 'aliases:', '  - Home', '---', '', '# 正文', ''].join('\n'))
    expect(tagAt(s, at(s, 'Alice'))).toBe('Alice')
    expect(tagAt(s, at(s, 'Home'))).toBe('Home')
  })

  it('front matter 之外的数组不算 —— 标签是这份文件的头，不是正文里的括号', () => {
    const s = make('# 标题\n\n正文里写一个 [a, b] 不是标签。\n')
    expect(tagAt(s, at(s, 'a,'))).toBeNull()
  })
})

describe('翻成一条搜索', () => {
  const run = (tag: string, line: string): boolean => new RegExp(tagQuery(tag)).test(line)

  it('行内数组：逗号空格分隔的都认', () => {
    expect(run('VPS', 'tags: [VPS, 3x-ui, 运维]')).toBe(true)
    expect(run('3x-ui', 'tags: [VPS, 3x-ui, 运维]')).toBe(true)
    expect(run('运维', 'tags: [VPS, 3x-ui, 运维]')).toBe(true)
  })

  it('**中文标签是这条式子存在的理由** —— `\\b运维\\b` 在同一行上一个都匹配不到', () => {
    expect(run('运维', 'tags: [VPS, 运维]')).toBe(true)
    expect(new RegExp('\\b运维\\b').test('tags: [VPS, 运维]')).toBe(false)
  })

  it('块序列：前面是空格、后面就是行尾', () => {
    expect(run('运维', '  - 运维')).toBe(true)
    expect(run('备份', '  - 备份')).toBe(true)
  })

  it('标量值也认（`tags: 运维` 这种只写一个的）', () => {
    expect(run('运维', 'tags: 运维')).toBe(true)
  })

  it('不匹配更长的同前缀标签 —— 「运维」不该搜出「运维手册」', () => {
    expect(run('运维', 'tags: [运维手册]')).toBe(false)
    expect(run('VPS', 'tags: [VPSX]')).toBe(false)
  })

  it('中文正文里不误伤：两侧没有分隔符', () => {
    expect(run('运维', '这一段讲的是运维的事。')).toBe(false)
  })

  it('正则元字符要转义 —— `c++` 不该被当成一条式子', () => {
    expect(run('c++', 'tags: [c++, rust]')).toBe(true)
    expect(() => new RegExp(tagQuery('a(b'))).not.toThrow()
  })

  /**
   * 0.4.1 修：**别的文件里那颗同名标签可能带着引号**（带空格或冒号时 YAML 就要求加），
   * 而点中的这颗可能是裸的。两边都得管：`tagAt` 剥掉点中那颗的引号，式子两侧再各
   * 放一个可选引号 —— 否则同一颗标签在两份文件里互相搜不到，而人看着两边写的是同一个词。
   */
  it('三种写法互相都搜得到', () => {
    for (const line of [
      'tags: [运维]',
      'tags: ["运维"]',
      "tags: ['运维']",
      '  - 运维',
      '  - "运维"',
      "  - '运维'"
    ]) {
      expect(run('运维', line), line).toBe(true)
    }
  })

  it('加了引号也不该匹配更长的同前缀标签', () => {
    expect(run('运维', 'tags: ["运维手册"]')).toBe(false)
    expect(run('VPS', "tags: ['VPSX']")).toBe(false)
  })

  /**
   * **`tagAt` 交过来的是解过码的值，而搜的是别的文件里的原文**：拿 `don't` 去配
   * `'don''t'` 一条都对不上。所以式子里把它**再编码回去** —— 三种写法各生成一条。
   */
  it('带转义的引号写法也要互相搜得到', () => {
    // 单引号里的 '' 表示一个 '
    for (const line of ["tags: [don't]", "tags: ['don''t']", 'tags: ["don\'t"]']) {
      expect(run("don't", line), line).toBe(true)
    }
    // 双引号里的 \" 表示一个 "
    for (const line of ['tags: ["a\\"b"]', "tags: ['a\"b']"]) {
      expect(run('a"b', line), line).toBe(true)
    }
    // 反斜杠同理
    expect(run('a\\b', 'tags: ["a\\\\b"]')).toBe(true)
  })

  /**
   * **有意画下的界**（2026-09-22）：整串写成 `\uXXXX` 的那种写法不在覆盖内。
   * 覆盖它要把每个字拆成「字本身 | `\uXXXX`」的分支（十六进制还得大小写都认），
   * 两字标签的式子就长成 `"(?:运|\\u8[fF][dD]0)(?:维|\\u7[eE][fF]f)"` —— 而这条式子
   * 是要摆进搜索框给人看、给人接着改的。为一种几乎只有生成器才写得出的写法，
   * 让所有人每次都看这么一坨，不划算。**这条测试是拿来挡「顺手修」的。**
   */
  it('整串 Unicode 转义的原文搜不到 —— 这是界，不是漏', () => {
    expect(run('运维', 'tags: ["\\u8fd0\\u7ef4"]')).toBe(false)
    // 而正常的三种写法一个都不少
    expect(run('运维', 'tags: ["运维"]')).toBe(true)
  })

  it('引号没配对的不算命中（比「两边各放一个可选引号」精确）', () => {
    expect(run('运维', 'tags: ["运维]')).toBe(false)
    expect(run('运维', "tags: [运维']")).toBe(false)
  })
})
