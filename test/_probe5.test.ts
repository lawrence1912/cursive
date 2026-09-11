import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'

describe('probe5', () => {
  it('dialect.md full parse', () => {
    const doc = readFileSync('test/fixtures/dialect.md', 'utf8')
    const state = EditorState.create({ doc, extensions: [cursiveMarkdown()] })
    const tree = ensureSyntaxTree(state, doc.length, 2000)
    console.log('TREE:', tree !== null)
    const names: Record<string, number> = {}
    tree?.iterate({ enter(n) { names[n.name] = (names[n.name] ?? 0) + 1; return } })
    console.log('INTERESTING:', Object.entries(names).filter(([k]) => /Footnote|Toc|Emoji|Highlight|Superscript|Subscript/.test(k)))
    expect(tree).not.toBeNull()
  })
})
