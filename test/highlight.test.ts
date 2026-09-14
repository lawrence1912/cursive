import { LanguageDescription, ensureSyntaxTree } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { EditorState } from '@codemirror/state'
import { highlightTree } from '@lezer/highlight'
import { beforeAll, describe, expect, it } from 'vitest'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'
import { markdownHighlight } from '../src/renderer/editor/theme'

/**
 * 围栏代码块的嵌套语法高亮（P1-4）。
 *
 * 两条路必须同时成立，缺一块就没颜色，而且都不报错、只是「看起来很素」：
 *   ① 解析：`codeLanguages: languages` 让 @lezer/markdown 把 CodeText 挂成
 *      对应语言的子树（按需动态 import，所以测试里要先 await load）；
 *   ② 上色：markdownHighlight 得真的有一条规则认领那棵子树发出来的 tag。
 * 历史上 ② 只配了 keyword/string/number/comment/function/typeName 六条，
 * 于是 yaml 的键（propertyName）、css 的属性（propertyName）和选择器（className）、
 * diff 的增删（inserted/deleted）全部落空 —— 最常写的几种块整块是纯文本色。
 */

const LANGS = ['js', 'bash', 'yaml', 'json', 'css', 'diff', 'python']

beforeAll(async () => {
  // language-data 是动态 import：没 await 完，解析器拿到的是「跳过」占位解析器，
  // 子树根本不存在（这时候断言全挂，但看起来像高亮配错了，很费时间）
  await Promise.all(
    LANGS.map((l) => LanguageDescription.matchLanguageName(languages, l, true)!.load())
  )
})

/** 文档里所有「拿到了颜色」的片段：源码文本 → 生成的类名 */
function styled(doc: string): Map<string, string> {
  const state = EditorState.create({ doc, extensions: [cursiveMarkdown()] })
  const tree = ensureSyntaxTree(state, doc.length, 10000)
  expect(tree, '解析超时').not.toBeNull()
  const out = new Map<string, string>()
  highlightTree(tree!, markdownHighlight, (from, to, cls) => {
    if (cls) out.set(doc.slice(from, to), cls)
  })
  return out
}

function fence(lang: string, body: string): string {
  return '```' + lang + '\n' + body + '\n```\n'
}

describe('代码块语法高亮', () => {
  it('js：关键字 / 字符串 / 数字 / 注释各有各的颜色', () => {
    const s = styled(fence('js', 'const a = 1 // 说明\nfoo("s")'))
    for (const tok of ['const', '1', '// 说明', '"s"']) expect(s.has(tok), tok).toBe(true)
    // 四者不能涂成同一个色，否则等于没高亮
    expect(new Set([s.get('const'), s.get('1'), s.get('// 说明'), s.get('"s"')]).size).toBe(4)
  })

  it('yaml / json：键（propertyName）必须上色', () => {
    expect(styled(fence('yaml', 'key: value\nnum: 3')).has('key')).toBe(true)
    expect(styled(fence('json', '{ "name": "cursive" }')).has('"name"')).toBe(true)
  })

  it('css：属性名、选择器、关键字色值都要上色', () => {
    const s = styled(fence('css', '.a { color: red; }'))
    expect(s.has('color'), 'propertyName').toBe(true)
    expect(s.has('a'), 'className').toBe(true)
    expect(s.has('red'), 'atom').toBe(true)
  })

  it('diff：+ 行与 − 行是两种颜色', () => {
    const s = styled(fence('diff', '- old\n+ new'))
    expect(s.get('- old')).toBeTruthy()
    expect(s.get('+ new')).toBeTruthy()
    expect(s.get('- old')).not.toBe(s.get('+ new'))
  })

  it('bash：参数 / 字符串 / 注释都要上色', () => {
    const s = styled(fence('bash', 'ls -la "foo" # 说明'))
    for (const tok of ['-la', '"foo"', '# 说明']) expect(s.has(tok), tok).toBe(true)
  })

  it('围栏行的语言名（labelName）不上色 —— 那行要压到最轻', () => {
    expect(styled(fence('python', 'x = 1')).has('python')).toBe(false)
  })

  it('所有颜色走 CSS 变量，没有写死的 hex —— 否则暗色主题必然糊', () => {
    const css = markdownHighlight.module?.getRules() ?? ''
    expect(css.length).toBeGreaterThan(0)
    expect(css.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull()
  })
})
