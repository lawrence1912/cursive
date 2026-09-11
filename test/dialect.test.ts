import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { typmdMarkdown } from '../src/renderer/editor/markdown-lang'

function nodes(doc: string): Set<string> {
  const state = EditorState.create({ doc, extensions: [typmdMarkdown()] })
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

describe('typmd 的 markdown 方言', () => {
  it('YAML front matter 解析成 Frontmatter，而不是 setext 标题', () => {
    const n = nodes('---\ntitle: 语料\ntags: [a, b]\n---\n\n# 标题\n')
    expect(n).toContain('Frontmatter')
    // 这是没接 front matter 解析时的错误结果，必须不再出现
    expect(n).not.toContain('SetextHeading2')
  })

  it('数学公式里的 ^ 不会被当成上标', () => {
    // markdownLanguage 自带 Superscript 扩展，会把 $e^{-x^2}$ 拆坏，
    // 所以方言是 commonmark + 显式 GFM 而非 markdownLanguage
    expect(nodes('行内公式 $e^{-x^2}$ 结束\n')).not.toContain('Superscript')
    expect(nodes('a^2^ b\n')).not.toContain('Superscript')
  })

  it('GFM 该有的都在', () => {
    expect(nodes('| a | b |\n|---|---|\n| 1 | 2 |\n')).toContain('Table')
    expect(nodes('~~删除~~\n')).toContain('Strikethrough')
    const task = nodes('- [x] 完成\n')
    expect(task).toContain('Task')
    expect(task).toContain('TaskMarker')
  })

  it('CommonMark 基本结构正常', () => {
    const n = nodes('# 标题\n\n> 引用\n\n- 项\n\n```ts\nconst a = 1\n```\n\n---\n')
    for (const name of ['ATXHeading1', 'Blockquote', 'BulletList', 'FencedCode', 'HorizontalRule'])
      expect(n, name).toContain(name)
  })
})
