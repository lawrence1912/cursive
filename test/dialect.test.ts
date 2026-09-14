import { readFileSync } from 'node:fs'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'

function nodes(doc: string): Set<string> {
  const state = EditorState.create({ doc, extensions: [cursiveMarkdown()] })
  const tree = ensureSyntaxTree(state, doc.length, 5000)
  expect(tree, '解析超时').not.toBeNull()
  const names = new Set<string>()
  tree!.iterate({
    enter(n) {
      names.add(n.name)
    }
  })
  return names
}

describe('cursive 的 markdown 方言', () => {
  // 上面每一条都是对着片段跑的。这一条盯的是**真夹具整份**能不能在预算内解析完 ——
  // 片段全过、整份超时是可能的（增量解析的工作预算按文档长度算）
  it('真夹具 dialect.md 整份能在预算内解析完', () => {
    const doc = readFileSync('test/fixtures/dialect.md', 'utf8')
    const state = EditorState.create({ doc, extensions: [cursiveMarkdown()] })
    expect(ensureSyntaxTree(state, doc.length, 2000), '解析超时').not.toBeNull()
  })

  it('YAML front matter 解析成 Frontmatter，而不是 setext 标题', () => {
    const n = nodes('---\ntitle: 语料\ntags: [a, b]\n---\n\n# 标题\n')
    expect(n).toContain('Frontmatter')
    // 这是没接 front matter 解析时的错误结果，必须不再出现
    expect(n).not.toContain('SetextHeading2')
  })

  it('数学公式的 ^ 归 math，正文 ^ 归上标（P1-3 后各归各）', () => {
    // markdownLanguage 自带 Superscript 扩展，会把 $e^{-x^2}$ 拆坏，
    // 所以方言是 commonmark + 显式 GFM 而非 markdownLanguage。
    // P1-3 加了自己的上下标后：math 元素内容原子，^ 仍不会漏进 Superscript
    const inline = nodes('行内公式 $e^{-x^2}$ 结束\n')
    expect(inline).toContain('InlineMath')
    expect(inline).not.toContain('Superscript')
    // 正文里的成对 ^ 现在就是上标（P1-3 预期行为）
    expect(nodes('a^2^ b\n')).toContain('Superscript')
  })

  it('数学公式：行内 $ 与块级 $$ 都有节点，且 ^ 仍是上标天敌', () => {
    const inline = nodes('行内 $e^{-x^2}$ 公式\n')
    expect(inline).toContain('InlineMath')
    expect(inline).not.toContain('Superscript')
    // $$ 定界符优先于 $：第一个节点叫 InlineMath，但这不该影响块级
    expect(nodes('$$\nx = \\frac{1}{2}\n$$\n')).toContain('DisplayMath')
    expect(nodes('$$a^2+b^2=c^2$$\n')).toContain('DisplayMath')
    // 货币写法里的两个 $$ 撞在一起也不许误吃成块级
    expect(nodes('价格是 $$5，运费 $$8\n')).not.toContain('DisplayMath')
  })

  it('$ 是货币符号时不吃成公式（收紧定界规则）', () => {
    for (const doc of [
      '￥5 到 $10 之间\n',
      '共计$5，优惠$2\n',
      'a$1b$2c\n',
      '$5 和 $8\n',
      '余额 $5，支出 $20（含税）\n'
    ]) {
      expect(nodes(doc), doc).not.toContain('InlineMath')
    }
  })

  it('未闭合的 $$ 保持段落，不许把后续内容吞进公式', () => {
    expect(nodes('$$\nx = 1\n')).not.toContain('DisplayMath')
    expect(nodes('$$\n开定界后有空格\n $$\n')).not.toContain('DisplayMath')
    const stillThere = nodes('$$\nx = 1\n')
    expect(stillThere).toContain('Paragraph')
  })

  it('GFM 该有的都在', () => {
    expect(nodes('| a | b |\n|---|---|\n| 1 | 2 |\n')).toContain('Table')
    expect(nodes('~~删除~~\n')).toContain('Strikethrough')
    const task = nodes('- [x] 完成\n')
    expect(task).toContain('Task')
    expect(task).toContain('TaskMarker')
  })

  it('P1-3 方言：高亮 / 上下标 / emoji / 脚注 / TOC 各自成节点', () => {
    expect(nodes('==亮==\n')).toContain('Highlight')
    const ss = nodes('x^2^ 和 H~2~O\n')
    expect(ss).toContain('Superscript')
    expect(ss).toContain('Subscript')
    // 下标不与删除线打架（GFM 只认 ~~）
    expect(ss).not.toContain('Strikethrough')
    expect(nodes('发 :smile: 了\n')).toContain('Emoji')
    const fn = nodes('文[^1]字\n\n[^1]: 定义内容\n')
    expect(fn).toContain('FootnoteRef')
    expect(fn).toContain('FootnoteDefinition')
    expect(nodes('[TOC]\n\n# 标题\n')).toContain('TocBlock')
  })

  it('P1-3 反例：不成对 / 不认识的保持字面量', () => {
    expect(nodes('时间 10:30:45 啊\n')).not.toContain('Emoji')
    expect(nodes('发 :notanemoji: 了\n')).not.toContain('Emoji')
    expect(nodes('温度 100 度 ^ 了\n')).not.toContain('Superscript')
    expect(nodes('波浪 ~ 号\n')).not.toContain('Subscript')
    // 引用无定义 → 不产出定义节点
    expect(nodes('引用 [^1] 无定义\n')).not.toContain('FootnoteDefinition')
  })

  it('P1-6 告示块：`> [!danger]` 归 CalloutMark，不再被 Link 认领', () => {
    // 修好之前：[!danger] 是合法的 shortcut 链接引用形状，整行渲染成一个坏链接
    const cal = nodes('> [!danger] 小心\n> 正文\n')
    expect(cal).toContain('CalloutMark')
    expect(cal).toContain('Blockquote')
    expect(cal).not.toContain('Link')
    // 折叠标记连在节点里（`-` 默认折、`+` 默认展开）
    expect(nodes('> [!note]-\n> 内容\n')).toContain('CalloutMark')
  })

  it('P1-6 反例：未知类型不成卡片，但也不再假装成链接', () => {
    // 类型表里没有 xyz → 不触发告示块（那是装饰层的事），但 `[` 照样被抢下来：
    // 打错一个类型名就掉回「蓝色带下划线的坏链接」，正是这一项要消灭的东西
    const unknown = nodes('> [!xyz] 随便写\n')
    expect(unknown).toContain('CalloutMark')
    expect(unknown).toContain('Blockquote')
    expect(unknown).not.toContain('Link')
    // 只认段落的第一个字符
    expect(nodes('这段 [!note] 不是告示块\n')).not.toContain('CalloutMark')
    // 脚注的 [^1] 不受影响（两个解析器都抢在 Link 前面，互不相扰）
    expect(nodes('> 文[^1]字\n')).toContain('FootnoteRef')
    // 真链接照旧
    expect(nodes('> [文字](https://a.b) 在引用里\n')).toContain('Link')
  })

  it('CommonMark 基本结构正常', () => {
    const n = nodes('# 标题\n\n> 引用\n\n- 项\n\n```ts\nconst a = 1\n```\n\n---\n')
    for (const name of ['ATXHeading1', 'Blockquote', 'BulletList', 'FencedCode', 'HorizontalRule'])
      expect(n, name).toContain(name)
  })
})
