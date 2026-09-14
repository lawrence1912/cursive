import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { cursiveMarkdown } from '../src/renderer/editor/markdown-lang'
import { plainInline } from '../src/renderer/editor/inline-text'
import { parseImage } from '../src/renderer/editor/live-preview/decorate'

/**
 * 尺寸语法 `![alt](src =600x400)`。
 *
 * 这条语法的难点全在解析层：CommonMark 里链接目的地不能带空格，`=600x400` 也不是合法的
 * 链接标题，所以内置解析器只认下 `![alt]` 一点点（shortcut 形状），后面那串 `(…)` 落进正文 ——
 * 装饰层拿到的切片对不上 parseImage，屏幕上就是「alt + 一串源码」。`markdown-lang.ts` 的
 * SizedImage 行内解析器补的就是这一段；这里盯住它补出来的节点形状：
 * **必须与内置图片同构**，否则表格格内、大纲取词、导出这些按节点名走的路径又会各差一条。
 */
function tree(doc: string): string[] {
  const state = EditorState.create({ doc, extensions: [cursiveMarkdown()] })
  const parsed = ensureSyntaxTree(state, doc.length, 5000)!
  const out: string[] = []
  parsed.iterate({
    enter(n) {
      // Document / Paragraph 只是容器，不产出节点
      if (n.name === 'Document' || n.name === 'Paragraph') return
      out.push(`${n.name}[${n.from},${n.to})=${JSON.stringify(doc.slice(n.from, n.to))}`)
    }
  })
  return out
}

function titleText(doc: string, from: number): string {
  const state = EditorState.create({ doc, extensions: [cursiveMarkdown()] })
  ensureSyntaxTree(state, doc.length, 5000)
  return plainInline(state, from, doc.length)
}

describe('尺寸图片：解析层', () => {
  it('整段是一个 Image 节点，子节点与内置图片同构', () => {
    expect(tree('![图](a.png =600x400)')).toEqual([
      'Image[0,20)="![图](a.png =600x400)"',
      'LinkMark[0,2)="!["',
      'LinkMark[3,4)="]"',
      'LinkMark[4,5)="("',
      'URL[5,10)="a.png"',
      'SizeMark[10,19)=" =600x400"',
      'LinkMark[19,20)=")"'
    ])
  })

  it('只写宽（不写高）照样认', () => {
    expect(tree('![图](a.png =300x)')).toEqual([
      'Image[0,17)="![图](a.png =300x)"',
      'LinkMark[0,2)="!["',
      'LinkMark[3,4)="]"',
      'LinkMark[4,5)="("',
      'URL[5,10)="a.png"',
      'SizeMark[10,16)=" =300x"',
      'LinkMark[16,17)=")"'
    ])
  })

  it('目的地写成 <带空格.png> 也认', () => {
    expect(tree('![图](<a b.png> =600x400)')).toEqual([
      'Image[0,24)="![图](<a b.png> =600x400)"',
      'LinkMark[0,2)="!["',
      'LinkMark[3,4)="]"',
      'LinkMark[4,5)="("',
      'URL[5,14)="<a b.png>"',
      'SizeMark[14,23)=" =600x400"',
      'LinkMark[23,24)=")"'
    ])
  })

  it('夹在正文中间不吃掉前后文', () => {
    expect(tree('前 ![图](a.png =600x400) 后')).toEqual([
      'Image[2,22)="![图](a.png =600x400)"',
      'LinkMark[2,4)="!["',
      'LinkMark[5,6)="]"',
      'LinkMark[6,7)="("',
      'URL[7,12)="a.png"',
      'SizeMark[12,21)=" =600x400"',
      'LinkMark[21,22)=")"'
    ])
  })

  it('不认识的写法不认领：`= 600 x 400` 退回内置行为', () => {
    // parseImage 本来就不支持带空格的这种写法，解析层认领它只会得到一张
    // 「有尺寸却读不出宽高」的图片，比原样显示更糟 —— 认不出就别管。
    expect(tree('![图](a.png = 600 x 400)')).toEqual([
      'Image[0,4)="![图]"',
      'LinkMark[0,2)="!["',
      'LinkMark[3,4)="]"'
    ])
  })

  it('普通图片、带标题的、引用式的都没被挤掉', () => {
    expect(tree('![图](a.png)')[0]).toBe('Image[0,11)="![图](a.png)"')
    expect(tree('![图](a.png "标题")')).toContain('Image[0,16)="![图](a.png \\"标题\\")"')
    expect(tree('![图][ref]')).toContain('Image[0,9)="![图][ref]"')
  })

  it('节点切片正好喂得上 parseImage（装饰层与导出层读的就是这一段）', () => {
    expect(parseImage('![图](a.png =600x400)')).toEqual({
      alt: '图',
      src: 'a.png',
      width: 600,
      height: 400
    })
    expect(parseImage('![图](a.png =300x)')).toEqual({ alt: '图', src: 'a.png', width: 300, height: undefined })
    // 上面那条「目的地写成 <带空格.png> 也认」只证明了**解析器**认。这一半才是端到端：
    // 解析器给了节点、parseImage 却读不出 src 的话，装饰层 return 掉、导出退回
    // escapeHtml(raw)，屏幕上和导出物里都是一行裸源码（真发生过）
    expect(parseImage('![图](<a b.png> =600x400)')).toEqual({
      alt: '图',
      src: 'a b.png',
      width: 600,
      height: 400
    })
  })
})

describe('尺寸图片：只取人看的文字（大纲 / TOC / 表格格内）', () => {
  it('标题里带图片时只留 alt —— 不带路径，也不带源码', () => {
    for (const src of ['![图](a.png)', '![图](a.png =600x400)']) {
      expect(titleText(`## 标题 ${src}`, 3)).toBe('标题 图')
    }
  })
})
