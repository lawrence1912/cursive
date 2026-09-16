import { syntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import { describe, expect, it } from 'vitest'
import {
  anchorPos,
  autolinkUrl,
  destLiteral,
  linkAt,
  linkDest,
  resolveLink,
  safeUrl,
  spacedDest
} from '../src/renderer/editor/link'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'
import { resolvePath } from '../src/shared/path'

const DIR = '/Users/me/notes'

function mk(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [cursiveMarkdown()] })
}

/** 某个位置上的 Link 节点（linkDest 的入参，点击那条路在 linkAt 里现找） */
function linkNode(state: EditorState, at: number): SyntaxNode {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(at, 1); n; n = n.parent) {
    if (n.name === 'Link') return n
  }
  throw new Error('这儿没有 Link 节点')
}

/** 点击那条路的全部逻辑：位置 → 链接 → 去处（`followLink` 去掉「真的打开」那一步） */
function follow(doc: string, at: number, dir: string | null = DIR) {
  const href = linkAt(mk(doc), at)
  return href ? resolveLink(href, dir) : null
}

describe('resolveLink：地址 → 去处', () => {
  it('外部地址原样交给系统', () => {
    expect(resolveLink('https://example.com/a?b=1#c', DIR)).toEqual({
      kind: 'external',
      url: 'https://example.com/a?b=1#c'
    })
    expect(resolveLink('mailto:a@b.com', DIR)).toEqual({ kind: 'external', url: 'mailto:a@b.com' })
    // 协议不认识也照样交出去（obsidian:// zoommtg:// 这类由系统去分派）
    expect(resolveLink('zoommtg://zoom.us/join', DIR)).toMatchObject({ kind: 'external' })
  })

  it('外部地址的 `#` 不是锚点，要整条交出去', () => {
    // 切 `#` 那一刀只对本地路径成立：网址里的 fragment 是浏览器的事
    expect(resolveLink('https://x.com/doc#section', DIR)).toEqual({
      kind: 'external',
      url: 'https://x.com/doc#section'
    })
  })

  it('本文锚点', () => {
    expect(resolveLink('#我的标题', DIR)).toEqual({ kind: 'anchor', slug: '我的标题' })
    // 百分号编码的锚点（从浏览器地址栏拷回来的那种）
    expect(resolveLink('#%E6%A0%87%E9%A2%98', DIR)).toEqual({ kind: 'anchor', slug: '标题' })
    // 光一个 `#` 不是去处
    expect(resolveLink('#', DIR)).toBeNull()
  })

  it('本地文档：相对路径按文档所在目录算，`.` 与 `..` 一并消掉', () => {
    expect(resolveLink('other.md', DIR)).toEqual({
      kind: 'doc',
      path: '/Users/me/notes/other.md',
      slug: null
    })
    expect(resolveLink('./sub/./x.markdown', DIR)).toMatchObject({
      path: '/Users/me/notes/sub/x.markdown'
    })
    expect(resolveLink('../别处/x.md', DIR)).toMatchObject({ path: '/Users/me/别处/x.md' })
    expect(resolveLink('/tmp/abs.md', DIR)).toMatchObject({ path: '/tmp/abs.md' })
  })

  it('本地文档 + 锚点：先切 `#` 再解码', () => {
    expect(resolveLink('other.md#第-二-节', DIR)).toEqual({
      kind: 'doc',
      path: '/Users/me/notes/other.md',
      slug: '第-二-节'
    })
    // 文件名里真有 `#` 的人必须写成 %23 —— 切在解码之前，它才不会被当成锚点分隔符
    expect(resolveLink('a%23b.md', DIR)).toEqual({
      kind: 'doc',
      path: '/Users/me/notes/a#b.md',
      slug: null
    })
  })

  it('带空格的文件名：尖括号写法与百分号编码都认', () => {
    expect(resolveLink('<我的 笔记.md>', DIR)).toMatchObject({ path: '/Users/me/notes/我的 笔记.md' })
    expect(resolveLink('我的%20笔记.md', DIR)).toMatchObject({ path: '/Users/me/notes/我的 笔记.md' })
  })

  it('不是文档的本地文件交给系统（后缀按文件名算，不按整条路径）', () => {
    expect(resolveLink('assets/图.png', DIR)).toEqual({
      kind: 'file',
      path: '/Users/me/notes/assets/图.png'
    })
    // 目录名里带 .md 不能把里面的图片也当成文档
    expect(resolveLink('归档.md/图.png', DIR)).toMatchObject({ kind: 'file' })
    // 没有后缀（目录）：交给 Finder
    expect(resolveLink('归档', DIR)).toEqual({ kind: 'file', path: '/Users/me/notes/归档' })
  })

  it('file:// 是写成 URL 的本地路径', () => {
    expect(resolveLink('file:///tmp/x.md#节', DIR)).toEqual({
      kind: 'doc',
      path: '/tmp/x.md',
      slug: '节'
    })
    expect(resolveLink('file://localhost/tmp/x.png', DIR)).toEqual({
      kind: 'file',
      path: '/tmp/x.png'
    })
  })

  it('未命名文档 + 相对链接：算不出绝对路径，但要说得出话', () => {
    expect(resolveLink('other.md', null)).toEqual({ kind: 'unsaved', path: 'other.md' })
    // 绝对路径不需要起点，照跳
    expect(resolveLink('/tmp/x.md', null)).toMatchObject({ kind: 'doc', path: '/tmp/x.md' })
    // 锚点也不需要
    expect(resolveLink('#标题', null)).toMatchObject({ kind: 'anchor' })
  })

  it('危险协议一律不认（与导出 HTML 同一条闸）', () => {
    expect(resolveLink('javascript:alert(1)', DIR)).toBeNull()
    expect(resolveLink('vbscript:x', DIR)).toBeNull()
    expect(resolveLink('data:text/html,<script>x</script>', DIR)).toBeNull()
    expect(safeUrl('data:image/png;base64,AAA')).not.toBeNull()
  })

  it('空地址不是链接', () => {
    expect(resolveLink('', DIR)).toBeNull()
    expect(resolveLink('   ', DIR)).toBeNull()
  })
})

describe('autolinkUrl：裸链接补协议', () => {
  it('邮箱补 mailto、www 补 https', () => {
    expect(autolinkUrl('a@b.com')).toBe('mailto:a@b.com')
    expect(autolinkUrl('www.example.com')).toBe('https://www.example.com')
  })

  it('已经有协议的原样不动', () => {
    expect(autolinkUrl('https://x.com')).toBe('https://x.com')
    expect(autolinkUrl('mailto:a@b.com')).toBe('mailto:a@b.com')
  })
})

describe('linkAt：位置 → 链接', () => {
  it('行内链接：点在链接文字上', () => {
    const doc = '见 [别的文档](./other.md) 结束\n'
    expect(follow(doc, doc.indexOf('别的'))).toEqual({
      kind: 'doc',
      path: '/Users/me/notes/other.md',
      slug: null
    })
  })

  it('链接标题不算进地址', () => {
    const state = mk('[x](a.md "说明")\n')
    expect(linkAt(state, 1)).toBe('a.md')
  })

  it('引用式链接查定义（`[文字][id]` 与简写 `[id]`）', () => {
    const doc = '看 [文字][id] 和 [简写]\n\n[id]: ./a.md\n[简写]: https://x.com\n'
    expect(follow(doc, doc.indexOf('文字'))).toMatchObject({ path: '/Users/me/notes/a.md' })
    expect(follow(doc, doc.indexOf('简写'))).toEqual({ kind: 'external', url: 'https://x.com' })
  })

  it('引用标签不分大小写', () => {
    const doc = '[文字][ID]\n\n[id]: ./a.md\n'
    expect(follow(doc, 2)).toMatchObject({ path: '/Users/me/notes/a.md' })
  })

  it('没有定义的引用式链接：不是能跳的链接', () => {
    expect(follow('[文字][缺失]\n', 2)).toBeNull()
  })

  it('`<地址>` 与裸链接、裸邮箱', () => {
    expect(follow('<https://x.com>\n', 3)).toEqual({ kind: 'external', url: 'https://x.com' })
    expect(follow('去 https://x.com 看\n', 5)).toEqual({ kind: 'external', url: 'https://x.com' })
    expect(follow('写信 a@b.com\n', 4)).toEqual({ kind: 'external', url: 'mailto:a@b.com' })
  })

  it('引用定义那一行的地址也跟得过去，而且**不补协议**', () => {
    // `[doc]: ./别的.md` 补上 https:// 就成了一条打不开的网址
    const doc = '[doc]: ./别的.md\n'
    expect(follow(doc, doc.indexOf('./'))).toMatchObject({
      kind: 'doc',
      path: '/Users/me/notes/别的.md'
    })
  })

  it('表格格子里的链接照样认（格内与正文是同一棵树）', () => {
    const doc = '| a |\n|---|\n| [去](x.md) |\n'
    expect(follow(doc, doc.indexOf('去'))).toMatchObject({ path: '/Users/me/notes/x.md' })
  })

  it('不是链接的地方返回 null —— ⌘+点击要还给编辑器去加光标', () => {
    expect(linkAt(mk('普通段落\n'), 2)).toBeNull()
    expect(linkAt(mk('`代码里的 https://x.com`\n'), 3)).toBeNull()
  })

  it('图片不是链接（点它是放大，不是跳转）', () => {
    const doc = '![图](a.png)\n'
    expect(linkAt(mk(doc), doc.indexOf('图'))).toBeNull()
  })
})

describe('目的地带空格：认得出来的那一半（方言放宽，见 markdown-lang.ts）', () => {
  it('带空格的本地文档：裸写就认，锚点照跳', () => {
    const doc = '- 部署手册：[vps](VPS 从 0 到 1 部署 3x-ui.md) 后面还有字\n'
    expect(follow(doc, doc.indexOf('vps'))).toEqual({
      kind: 'doc',
      path: '/Users/me/notes/VPS 从 0 到 1 部署 3x-ui.md',
      slug: null
    })
    const anchored = '[vps](./我的 笔记.md#小节)\n'
    expect(follow(anchored, 2)).toEqual({
      kind: 'doc',
      path: '/Users/me/notes/我的 笔记.md',
      slug: '小节'
    })
  })

  it('带空格的图片与其它文件也一样', () => {
    const img = '![图](我的 图.png)\n'
    // 图片不是链接（点它是放大），但节点得在 —— 这条由 image.test.ts 的 parseImage 守
    expect(linkAt(mk(img), img.indexOf('图]'))).toBeNull()
    const pdf = '[报告](归档/2026 年报.pdf)\n'
    expect(follow(pdf, 2)).toEqual({ kind: 'file', path: '/Users/me/notes/归档/2026 年报.pdf' })
  })

  it('三种写法落到同一个地方', () => {
    const angle = follow('[a](<./我的 笔记.md>)\n', 1)
    const pct = follow('[a](./我的%20笔记.md)\n', 1)
    const bare = follow('[a](./我的 笔记.md)\n', 1)
    expect(bare).toEqual(angle)
    expect(pct).toEqual(angle)
  })
})

describe('destLiteral：app 自己插入的链接写标准形状', () => {
  it('带空格括进 <…>，不带空格原样', () => {
    expect(destLiteral('assets/我的 图.png')).toBe('<assets/我的 图.png>')
    expect(destLiteral('assets/pic.png')).toBe('assets/pic.png')
  })

  it('路径里本来就有尖括号 → 退回百分号编码（<> 会被当成定界符）', () => {
    expect(destLiteral('assets/a <b> c.png')).toBe('assets/a%20<b>%20c.png')
  })
})

describe('spacedDest：连是不是文件都看不出来的那一半', () => {
  it('没有后缀 → 不当链接，但点了要说一句', () => {
    const line = '- 部署手册：[部署手册](我的 笔记 没有后缀) 后面还有字\n'
    expect(linkAt(mk(line), line.indexOf('部署手册]'))).toBeNull()
    expect(spacedDest(mk(line), line.indexOf('部署手册]'))).toBe('我的 笔记 没有后缀')
  })

  it('带协议的地址里有空格 —— 只能是打错了', () => {
    const line = '[官网](http://a b.com)\n'
    expect(linkAt(mk(line), 2)).toBeNull()
    expect(spacedDest(mk(line), 2)).toBe('http://a b.com')
  })

  it('点在别处不认', () => {
    const line = '- 部署手册：[部署手册](我的 笔记 没有后缀) 后面还有字\n'
    expect(spacedDest(mk(line), line.indexOf('后面还有字'))).toBeNull()
  })

  it('两端的空白 CommonMark 本来就允许，不算病根', () => {
    const ok = '[文字]( a.md )\n'
    expect(spacedDest(mk(ok), 2)).toBeNull()
    expect(linkAt(mk(ok), 2)).toBe('a.md')
  })

  it('行内代码里的同款文字不算 —— 那儿写的是示例', () => {
    const code = '写法：`[文字](我的 笔记 没后缀)` 不行\n'
    expect(spacedDest(mk(code), code.indexOf('文字'))).toBeNull()
  })
})

describe('linkDest：一个 Link 节点指向哪儿', () => {
  it('尖括号目的地脱掉括号（否则拼出来的路径带着 `<`，文件必然找不到）', () => {
    expect(linkAt(mk('[a](<我的 图.md>)\n'), 1)).toBe('我的 图.md')
  })

  it('行内写法一次全文遍历都不付 —— refs 传函数就是为了让它一次也不跑', () => {
    const state = mk('[a](x.md)\n\n[id]: y.md\n')
    let calls = 0
    const refs = () => {
      calls++
      return new Map<string, string>()
    }
    expect(linkDest(state.doc, linkNode(state, 1), refs)).toBe('x.md')
    expect(calls).toBe(0)
  })

  it('引用写法才去查定义表', () => {
    const state = mk('[a][id]\n\n[id]: y.md\n')
    let calls = 0
    const refs = () => {
      calls++
      return new Map([['id', 'y.md']])
    }
    expect(linkDest(state.doc, linkNode(state, 1), refs)).toBe('y.md')
    expect(calls).toBe(1)
  })
})

describe('anchorPos：锚点 → 标题位置', () => {
  const doc = '# 开头\n\n## 第二节\n\n正文\n\n## Hello World\n\n## 第二节\n'

  it('跳到对应标题（锚点串与 [TOC]、大纲、导出 id 同一份算法）', () => {
    expect(anchorPos(mk(doc), '第二节')).toBe(doc.indexOf('## 第二节'))
    expect(anchorPos(mk(doc), 'hello-world')).toBe(doc.indexOf('## Hello World'))
  })

  it('重名标题依次加 -1', () => {
    expect(anchorPos(mk(doc), '第二节-1')).toBe(doc.lastIndexOf('## 第二节'))
  })

  it('链接里大小写写错也跳得动', () => {
    expect(anchorPos(mk(doc), 'Hello-World')).toBe(doc.indexOf('## Hello World'))
  })

  it('没有这个锚点返回 null（调用方据此说一句话）', () => {
    expect(anchorPos(mk(doc), '不存在')).toBeNull()
  })
})

describe('resolvePath', () => {
  it('拼接并消解 . 与 ..', () => {
    expect(resolvePath('/a/b', 'c.md')).toBe('/a/b/c.md')
    expect(resolvePath('/a/b', './c.md')).toBe('/a/b/c.md')
    expect(resolvePath('/a/b', '../c.md')).toBe('/a/c.md')
    expect(resolvePath('/a/b', '../../c.md')).toBe('/c.md')
  })

  it('`..` 退到根就停住（根没有上一级）', () => {
    expect(resolvePath('/a', '../../../x.md')).toBe('/x.md')
  })

  it('rel 本身是绝对路径就忽略 dir', () => {
    expect(resolvePath('/a/b', '/x/y.md')).toBe('/x/y.md')
  })
})
