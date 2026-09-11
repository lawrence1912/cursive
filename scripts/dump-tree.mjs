// 开发用：打印 cursive 方言对某份文档解析出的节点名。
// 写装饰器前先跑一次，免得 switch 里的名字拼错却毫无报错。
// 用法：node scripts/dump-tree.mjs [文件] [--full]
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { readFileSync } from 'node:fs'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang.ts'

const file = process.argv[2] ?? 'test/fixtures/kitchen-sink.md'
const full = process.argv.includes('--full')
const doc = readFileSync(file, 'utf8')

const state = EditorState.create({ doc, extensions: [cursiveMarkdown()] })
const tree = ensureSyntaxTree(state, doc.length, 20000)
if (!tree) throw new Error('解析超时')

const seen = new Map()
let depth = 0
tree.iterate({
  enter(n) {
    const text = doc.slice(n.from, n.to).replace(/\n/g, '\\n').slice(0, 32)
    if (full) console.log(`${'  '.repeat(depth)}${n.name}  ${JSON.stringify(text)}`)
    const hit = seen.get(n.name)
    if (hit) hit.count++
    else seen.set(n.name, { count: 1, sample: text })
    depth++
  },
  leave() {
    depth--
  }
})

if (!full) {
  console.log(`${file} — ${seen.size} 种节点\n`)
  for (const [name, { count, sample }] of [...seen].sort())
    console.log(`  ${name.padEnd(22)} ×${String(count).padEnd(4)} ${JSON.stringify(sample)}`)
}
