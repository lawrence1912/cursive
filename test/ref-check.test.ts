import { EditorState } from '@codemirror/state'
import { beforeAll, describe, expect, it } from 'vitest'
import { checkRefs, type RefHost } from '../src/renderer/editor/ref-check'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'

/**
 * 第八节 8：当前文档的本地引用检查（`editor/ref-check.ts`）。
 *
 * 壳那一侧换成一个假的文件系统：哪些路径是文件、哪些是目录、哪些文档读得出什么。
 * 顺带数一数问了几次 —— 路径要**一次问完**（一趟 IPC），每份被链接的文档只读一次。
 */

beforeAll(() => {
  ;(globalThis as { document?: unknown }).document ??= { documentElement: { dataset: {} } }
})

const DIR = '/notes'

function host(files: Record<string, string | null>, dirs: string[] = []) {
  const calls = { stat: 0, text: [] as string[] }
  const h: RefHost = {
    stat: async (paths) => {
      calls.stat++
      return paths.map((p) => (dirs.includes(p) ? 'dir' : p in files ? 'file' : null))
    },
    text: async (path) => {
      calls.text.push(path)
      return files[path] ?? null
    }
  }
  return { h, calls }
}

function state(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [cursiveMarkdown()] })
}

/** 只看「哪一段地址、为什么」：位置另外单测 */
function brief(report: Awaited<ReturnType<typeof checkRefs>>) {
  return report.problems.map((p) => `${p.dest} ${p.kind}:${p.reason}`)
}

describe('本地引用检查', () => {
  it('四种引用各认得出好的与坏的，外部地址不查', async () => {
    const doc = [
      '# 本文',
      '',
      '## 第二节',
      '',
      '[好锚点](#第二节) [坏锚点](#没有这一节)',
      '[好文档](other.md) [坏文档](missing.md) [文件夹当文档](folder.md)',
      '[好文档的好锚点](other.md#那一节) [好文档的坏锚点](other.md#不存在) [读不出来的](gbk.md#节)',
      '[好文件](a.pdf) [坏文件](b.pdf) [文件夹](assets)',
      '![好图](assets/x.png) ![坏图](assets/missing.png) ![指着文件夹](assets)',
      '[外部](https://example.com) [邮件](mailto:a@b.com) ![网图](https://example.com/x.png)'
    ].join('\n')
    const { h, calls } = host(
      {
        '/notes/other.md': '# 别处\n\n## 那一节\n',
        '/notes/gbk.md': null,
        '/notes/a.pdf': '',
        '/notes/assets/x.png': ''
      },
      ['/notes/folder.md', '/notes/assets']
    )
    const report = await checkRefs(state(doc), DIR, '/notes/self.md', h)
    expect(brief(report)).toEqual([
      '#没有这一节 anchor:noAnchor',
      'missing.md doc:missing',
      'folder.md doc:folder',
      'other.md#不存在 anchor:noAnchor',
      'gbk.md#节 doc:unreadable',
      'b.pdf file:missing',
      'assets/missing.png image:missing',
      'assets image:folder'
    ])
    // 外部地址三条不算进「核对过的」
    expect(report.checked).toBe(14)
    expect(report.unsaved).toBe(0)
    // 路径一次问完；被链接的文档每份只读一次（other.md 两条带锚点的链接共用一次读）
    expect(calls.stat).toBe(1)
    expect(calls.text.sort()).toEqual(['/notes/gbk.md', '/notes/other.md'])
  })

  it('图片按壳侧读图的规矩认：先原样，找不到再百分号解码一次', async () => {
    const doc = [
      '![编码过的中文名](assets/%E4%B8%AD%E6%96%87%20%E5%9B%BE.png)',
      '![尖括号加尺寸](<assets/中文 图.png> =60x40)',
      '![文件名里真有百分号](assets/100%25.png)',
      '![上一级](../shared/y.png)'
    ].join('\n\n')
    const { h } = host({ '/notes/assets/中文 图.png': '', '/notes/assets/100%25.png': '', '/shared/y.png': '' })
    const report = await checkRefs(state(doc), DIR, null, h)
    expect(brief(report)).toEqual([])
    expect(report.checked).toBe(4)
  })

  it('链接按 ⌘+点击的那一套解析：尖括号、百分号、裸空格三种写法指向同一个文件', async () => {
    const doc = [
      '[尖括号](<./我的 目标 文档.md#空格小节>)',
      '[百分号](./%E6%88%91%E7%9A%84%20%E7%9B%AE%E6%A0%87%20%E6%96%87%E6%A1%A3.md)',
      '[裸空格](./我的 目标 文档.md#空格小节)'
    ].join('\n\n')
    const { h, calls } = host({ '/notes/我的 目标 文档.md': '# 带空格\n\n## 空格小节\n' })
    const report = await checkRefs(state(doc), DIR, null, h)
    expect(brief(report)).toEqual([])
    expect(calls.text).toEqual(['/notes/我的 目标 文档.md'])
  })

  it('引用式链接与图片查定义表，报在定义的地址上（几处用法共用一个定义只报一条）', async () => {
    const doc = [
      '[文字][坏] 与 ![图][好图] 与 <file:///tmp/没有.md> 与 [又用了一次][坏] 与 [坏]',
      '',
      '`[代码里](missing-in-code.md)`',
      '',
      '```md',
      '[围栏里](missing-in-fence.md)',
      '```',
      '',
      '[坏]: ./gone.md',
      '[好图]: ./pic.png'
    ].join('\n')
    const { h } = host({ '/notes/pic.png': '' })
    const report = await checkRefs(state(doc), DIR, null, h)
    // 自动链接里的 file: 地址也认；行内代码与围栏里的不是链接
    expect(brief(report)).toEqual(['file:///tmp/没有.md doc:missing', './gone.md doc:missing'])
    const def = report.problems[1]!
    expect(doc.slice(def.from, def.to)).toBe('./gone.md')
    expect(def.line).toBe(9)
  })

  it('链接里套着的图片也查；表格格子里的链接也查', async () => {
    const doc = '[![徽章](badge.png)](missing.md)\n\n| 甲 | 乙 |\n| --- | --- |\n| [格里](gone.pdf) | 1 |\n'
    const { h } = host({})
    const report = await checkRefs(state(doc), DIR, null, h)
    // 按在文档里的先后：图片在链接文字里，比链接的地址靠前
    expect(brief(report)).toEqual(['badge.png image:missing', 'missing.md doc:missing', 'gone.pdf file:missing'])
  })

  it('指向自己的 `这份.md#节` 对眼前这份的标题表（盘上那份可能还是旧的）', async () => {
    const doc = '# 新写的标题\n\n[自己](self.md#新写的标题) [自己坏的](self.md#盘上才有的)\n'
    const { h, calls } = host({ '/notes/self.md': '# 盘上才有的\n' })
    const report = await checkRefs(state(doc), DIR, '/notes/self.md', h)
    expect(brief(report)).toEqual(['self.md#盘上才有的 anchor:noAnchor'])
    expect(calls.text).toEqual([])
  })

  it('没保存过的文档：相对路径记个数，绝对路径与锚点照查', async () => {
    const doc = '# 标题\n\n[相对](a.md) ![相对图](b.png) [绝对](/tmp/gone.md) [锚点](#没有)\n'
    const { h } = host({})
    const report = await checkRefs(state(doc), null, null, h)
    expect(brief(report)).toEqual(['/tmp/gone.md doc:missing', '#没有 anchor:noAnchor'])
    expect(report.unsaved).toBe(2)
    expect(report.checked).toBe(2)
  })

  it('位置：选中的是写在文档里的那段地址（尖括号原样），行号从 1 起', async () => {
    const doc = '第一行\n\n看这儿：[坏](<不在 的.md>)\n'
    const { h } = host({})
    const report = await checkRefs(state(doc), DIR, null, h)
    const [p] = report.problems
    expect(p).toMatchObject({ dest: '<不在 的.md>', line: 3, kind: 'doc', reason: 'missing' })
    expect(doc.slice(p!.from, p!.to)).toBe('<不在 的.md>')
  })

  it('什么都没有：一条问题都没有，也一次都不问壳', async () => {
    const { h, calls } = host({})
    const report = await checkRefs(state('# 只有标题\n\n一段正文，[外链](https://a.com)。\n'), DIR, null, h)
    expect(report).toEqual({ problems: [], checked: 0, unsaved: 0 })
    expect(calls.stat).toBe(0)
  })
})
