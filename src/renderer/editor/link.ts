import { syntaxTree } from '@codemirror/language'
import type { EditorState, Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { resolvePath } from '../../shared/path'
import { t } from '../i18n'
import { collectHeadings, slugs } from './headings'
import { jumpTo } from './navigation'
import { parsedTree } from './syntax'

/**
 * 链接跳转 —— **一处回答「这个地址指的是什么」**，正文、表格格内、导出三条路共用。
 *
 * 分四种去处，因为它们的归宿真的不同：
 *   · 外部地址（`https:` / `mailto:` / 别的协议）→ 交给系统（`openExternal`）；
 *   · 本文锚点（`#标题`）→ 本文档里滚过去，锚点串走 `headings.ts` 的 `slugs()`，
 *     与 `[TOC]`、大纲「复制本节锚点」、导出 HTML 的 id、以及补全里 `](#` 那个源
 *     **是同一份算法** —— 补出来的锚点点得动，靠的就是这一点；
 *   · 本地文档（`./别的.md`，可带 `#锚点`）→ 在**这个窗口**开一个标签（已经开着就激活它），
 *     与文件树点一个文件、快速打开选一条同一条路。不开新窗口：一个窗口 = 一个工作区，
 *     而顺着链接读下去是同一个工作区里的事；
 *   · 本地的其它文件（PDF / 图片 / 目录）→ 同样交给系统，由默认应用或 Finder 接手。
 *
 * 三件不做的事，各有理由：
 *   · **不跟着浏览器走** —— `javascript:` / 非图片 `data:` 一律不认（与导出 HTML 的
 *     `safeUrl` 同一条规矩：导出物里是死字，编辑器里就不该是活链接）；
 *   · **不猜文件在不在** —— 存在性由真正去开它的那一步（`read` / `NSWorkspace.open`）回答，
 *     这里现查一次文件系统等于给每次装饰、每次点击都加一趟 IPC；
 *   · **不改文档** —— 跳转只动选区和滚动位置，红线一（保存零损耗）与它无关。
 */

/** 能在标签里打开的后缀。与壳侧 `DocScan.exts`（跨文件搜索 / 快速打开的白名单）同一份名单 */
const DOC_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd', 'txt'])

/** 这条路径是不是一份能在标签里打开的文档（按**文件名**的后缀算，同 `resolveLink`） */
export function isDocPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot >= 0 && DOC_EXTS.has(name.slice(dot + 1).toLowerCase())
}

/**
 * 链接地址的安全闸。`javascript:` / `data:text/html` 这类在导出的文件里会变成可执行的东西，
 * 在编辑器里点一下同样不该有任何效果 —— 两边共用这一份判断（导出走的就是这个函数）。
 */
export function safeUrl(url: string): string | null {
  const scheme = /^[a-zA-Z][\w+.-]*:/.exec(url.trim())
  if (!scheme) return url
  const lower = scheme[0].toLowerCase()
  if (lower === 'javascript:' || lower === 'vbscript:') return null
  if (lower === 'data:' && !/^data:image\//i.test(url.trim())) return null
  return url
}

/** CommonMark 的尖括号目的地：`<我的 文件.md>` 是文件名带空格时唯一的写法 */
function stripAngles(dest: string): string {
  const raw = dest.trim()
  return raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1).trim() : raw
}

/**
 * 百分号编码 → 真实的路径 / 锚点。`我的%20笔记.md`、`#%E6%A0%87%E9%A2%98` 都得还原，
 * 否则拼出来的绝对路径在磁盘上并不存在。解不开（地址里有个孤零零的 `%`）就原样用 ——
 * 宁可按字面去找，也不能整条链接失效。
 */
function decodePart(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/**
 * 裸链接（GFM autolink）补上省略掉的协议。解析器只在「长得像 URL / 邮箱」时才给节点，
 * 所以这里不判断像不像，只补那一截：`a@b.com` → `mailto:`、`www.x.com` → `https:`。
 * 不补的话 `URL(string:)` 拿到的是个没有协议的相对地址，`NSWorkspace.open` 直接不理，
 * 症状就是「点了没反应」。导出 HTML 写 href 用的也是这一份。
 */
export function autolinkUrl(text: string): string {
  const raw = text.trim()
  if (/^[a-zA-Z][\w+.-]*:/.test(raw)) return raw
  return raw.includes('@') ? `mailto:${raw}` : `https://${raw}`
}

/** 引用定义的键：脱掉方括号、去空白、小写（CommonMark 的引用标签不分大小写） */
export function refKey(label: string): string {
  return label.replace(/^\[|\]$/g, '').trim().toLowerCase()
}

/**
 * 全文的链接引用定义表：`[id]: url "标题"`。
 * **要扫全文**（定义一般摆在文末），所以调用点都是懒的 —— 见 `linkDest` 的 `refs` 参数。
 */
export function collectRefs(state: EditorState): Map<string, string> {
  const refs = new Map<string, string>()
  parsedTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'LinkReference') return
      const label = node.node.getChild('LinkLabel')
      const url = node.node.getChild('URL')
      if (!label || !url) return false
      const key = refKey(state.doc.sliceString(label.from, label.to))
      if (!refs.has(key)) refs.set(key, state.doc.sliceString(url.from, url.to))
      return false
    }
  })
  return refs
}

/**
 * 一个 `Link` 节点指向哪儿。行内写法读 `URL` 子节点；引用写法（`[文字][id]` 与简写 `[id]`）
 * 查定义表。**`refs` 传的是函数**：行内写法占绝大多数，它一次全文遍历都不该付
 * （导出那边把现成的表包一层给进来，点击这边才现扫一次）。
 */
export function linkDest(
  doc: Text,
  node: SyntaxNode,
  refs: () => Map<string, string>
): string | null {
  const url = node.getChild('URL')
  if (url) return stripAngles(doc.sliceString(url.from, url.to))
  const label = node.getChild('LinkLabel')
  const key = refKey(doc.sliceString(label?.from ?? node.from, label?.to ?? node.to))
  return refs().get(key) ?? null
}

/**
 * **写**进文档的目的地。方言放宽的是「读」：Cursive 认得 `![图](我的 图.png)`，
 * 可这份文档还要进 GitHub / Obsidian / pandoc —— 那边只认 CommonMark。
 * 所以 app 自己插入的链接一律写标准形状：带空白就括进 `<…>`，
 * 路径里本来就有尖括号（极罕见，`<>` 会被当成定界符）则退回百分号编码。
 */
export function destLiteral(path: string): string {
  if (!/\s/.test(path)) return path
  return /[<>]/.test(path) ? path.replace(/ /g, '%20') : `<${path}>`
}

export type LinkTarget =
  /** 交给系统浏览器 / 邮件客户端 */
  | { kind: 'external'; url: string }
  /** 本文档里的标题锚点 */
  | { kind: 'anchor'; slug: string }
  /** 本地文档：开标签，`slug` 非空时再跳到那个标题 */
  | { kind: 'doc'; path: string; slug: string | null }
  /** 本地的其它文件 / 目录：交给默认应用或 Finder */
  | { kind: 'file'; path: string }
  /** 相对链接 + 没落过盘的文档：没有起点算不出绝对路径。单列一种是为了能说人话 */
  | { kind: 'unsaved'; path: string }

/**
 * 地址 → 去处。`dir` 是当前文档所在目录（`docDir` facet），未命名文档是 null。
 * 返回 null = 这不是一个能跳的链接（空地址、被安全闸拦下的协议），调用方应当**不拦截**
 * 这次点击，把它交还给编辑器。
 */
export function resolveLink(href: string, dir: string | null): LinkTarget | null {
  const raw = stripAngles(href)
  if (!raw || !safeUrl(raw)) return null

  // 纯锚点：`#标题`
  if (raw.startsWith('#')) {
    const slug = decodePart(raw.slice(1)).trim()
    return slug ? { kind: 'anchor', slug } : null
  }

  const scheme = /^[a-zA-Z][\w+.-]*:/.exec(raw)?.[0]
  let rest = raw
  if (scheme) {
    // `file:` 是「写成 URL 的本地路径」，其余协议一概交给系统
    if (scheme.toLowerCase() !== 'file:') return { kind: 'external', url: raw }
    rest = raw.slice(scheme.length).replace(/^\/\/(localhost)?/i, '')
    if (!rest.startsWith('/')) return null
  }

  // 先切 `#` 再解码：文件名里真有 `#` 的人必须写成 `%23`，这个顺序才认得出来
  const cut = rest.indexOf('#')
  const path = decodePart(cut < 0 ? rest : rest.slice(0, cut))
  const slug = cut < 0 ? null : decodePart(rest.slice(cut + 1)).trim() || null
  if (!path) return null

  // 目录必须是绝对路径才拼得出东西来（同 `decorate.ts` 的 resolveSrc）
  const base = dir && dir.startsWith('/') ? dir : null
  if (!path.startsWith('/') && !base) return { kind: 'unsaved', path }
  const abs = resolvePath(base ?? '/', path)
  // 后缀按**文件名**算，不是按整条路径 —— `/我的.md/图.png` 里那个 `.md` 是目录名
  const name = abs.slice(abs.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  const ext = dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
  return DOC_EXTS.has(ext) ? { kind: 'doc', path: abs, slug } : { kind: 'file', path: abs }
}

/**
 * 某个位置上的链接指向哪儿（**文档里写的那个地址**，还没解析成去处）。四种形状都认：
 *   · `[文字](地址)` 与引用式 `[文字][id]` / `[id]`（`Link`）；
 *   · `<https://…>`（`Autolink`）；
 *   · 裸 `https://…` 与裸邮箱（GFM 直接给一个 `URL` 节点，外面没有壳）；
 *   · 引用定义 `[id]: 地址` 里的那个地址（同样是光杆 `URL`，但它是**目的地**，
 *     所以不补协议 —— `[doc]: ./别的.md` 补上 `https://` 就成了一条打不开的网址）。
 *
 * 用现成的树（`syntaxTree`）而不是 `parsedTree`：点击只会落在视口里，那一段一定解析过；
 * 在这儿 ensure 一次是 5ms，而它换不来任何东西。
 */
export function linkAt(state: EditorState, pos: number): string | null {
  const doc = state.doc
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === 'Link') return linkDest(doc, n, () => collectRefs(state))
    if (n.name === 'Autolink') {
      const url = n.getChild('URL')
      return url ? autolinkUrl(doc.sliceString(url.from, url.to)) : null
    }
    if (n.name === 'URL') {
      // 行内链接 / `<>` 里的那个 URL：让上面两条分支去管，这里继续往上走
      const parent = n.parent?.name
      if (parent === 'Link' || parent === 'Autolink') continue
      const raw = doc.sliceString(n.from, n.to)
      return parent === 'LinkReference' ? raw : autolinkUrl(raw)
    }
  }
  return null
}

/** 锚点串 → 标题位置。没有这个锚点返回 null（调用方据此说一句话，而不是静静地什么都不做） */
export function anchorPos(state: EditorState, slug: string): number | null {
  const items = collectHeadings(state)
  // `slugs()` 出来的串是小写的；链接里写成 `#My-Title` 的人也该跳得动
  const i = slugs(items).indexOf(slug.toLowerCase())
  return i < 0 ? null : items[i]!.pos
}

/**
 * 「开一个标签」和「在状态栏说一句话」这两件事归窗口管（前者要过 IPC 读盘、
 * 后者要碰状态栏 DOM），编辑器扩展只当钩子调 —— 与 `setup.ts` 的 `writingNow`
 * 同一种东西：扩展要读、但它不属于任何一个 EditorState。
 * 默认是空实现，所以单测里引进来即可用，不必先装配一个窗口。
 */
export interface LinkHost {
  /** 打开本地文档（已经开着就激活那个标签），`slug` 非空时再跳到那个标题 */
  openDoc(path: string, slug: string | null): void
  /** 一次性反馈：找不到文件 / 没有这个锚点 / 系统没接手 */
  note(message: string): void
}

export const linkHost: LinkHost = {
  openDoc: () => {},
  note: () => {}
}

/**
 * 本地路径 → `file://` URL。编码规则与 `decorate.ts` 给图片拼 `safe-file://` 的那一份一致：
 * `encodeURI` 不管 `?` 和 `#`，而文件名里真可能有 —— 不补这一手，`NSWorkspace` 会把
 * 后半截当查询串扔掉，然后「打不开」。
 */
function fileUrl(path: string): string {
  return `file://${encodeURI(path).replace(/[?#]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`
}

/** 交给系统。`openExternal` 回一个「系统真的接手了吗」，没接手就在状态栏说一句 */
async function handOff(url: string, label: string): Promise<void> {
  if (!(await window.api.openExternal(url))) linkHost.note(t('link.failed', { target: label }))
}

/** 把去处真的打开。锚点就地跳，文档交给窗口，其余交给系统 */
export function openTarget(view: EditorView, target: LinkTarget): void {
  switch (target.kind) {
    case 'external':
      void handOff(target.url, target.url)
      return
    case 'file':
      void handOff(fileUrl(target.path), target.path)
      return
    case 'doc':
      linkHost.openDoc(target.path, target.slug)
      return
    case 'anchor': {
      const pos = anchorPos(view.state, target.slug)
      if (pos === null) {
        linkHost.note(t('link.noAnchor', { slug: target.slug }))
        return
      }
      jumpTo(view, pos)
      return
    }
    case 'unsaved':
      linkHost.note(t('link.unsaved', { path: target.path }))
  }
}

/**
 * 点在一段「看着像链接、解析器却不认」的文字上：**目的地里有空格，而且看不出是哪个文件**。
 *
 * 带空格的目的地本身已经认了（`markdown-lang.ts` 的 `SpacedLink`：不带协议、以 `/` 或
 * `.后缀` 结尾就当链接）。剩下这两种还是认不出来，而它们恰恰是写错的高发区：
 *   · `[文档](我的 笔记)` —— 没有后缀，看不出指的是文件还是一句话；
 *   · `[官网](http://a b.com)` —— 带协议的地址里有空格，只能是打错了。
 * 这里**只在点击落空之后**才现扫一行源码（平时一次都不跑），找到就说一句人话。
 *
 * 行内代码里的同款文字不算 —— 那儿写的就是一段示例，不是坏链接。
 * 导出给单测：这是本文件里唯一一处正则启发式，值得单独钉住。
 */
export function spacedDest(state: EditorState, pos: number): string | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === 'InlineCode' || n.name === 'CodeText' || n.name === 'FencedCode') return null
  }
  const line = state.doc.lineAt(pos)
  for (const m of line.text.matchAll(/\[[^\]\n]*\]\(([^()\n]*)\)/g)) {
    const from = line.from + m.index
    if (pos < from || pos > from + m[0].length) continue
    const dest = m[1]!.trim()
    // 两端的空白 CommonMark 是允许的，中间的才是病根
    return /\s/.test(dest) ? dest : null
  }
  return null
}

/**
 * 跟着某个位置上的链接走。返回 false = 这儿没有能跳的链接，这次点击应当交还给编辑器
 * （⌘+点击在 CodeMirror 里本来是「加一个光标」，不是链接就不该把它吃掉）。
 */
export function followLink(view: EditorView, pos: number, dir: string | null): boolean {
  const href = linkAt(view.state, pos)
  if (!href) {
    // 看着像链接但地址里有空格：吃掉这一下并说明白为什么 —— 点在这种地方的人
    // 想的是「跟过去」，不是「加一个光标」
    const spaced = spacedDest(view.state, pos)
    if (!spaced) return false
    linkHost.note(t('link.spaced', { dest: spaced }))
    return true
  }
  const target = resolveLink(href, dir)
  if (!target) return false
  openTarget(view, target)
  return true
}
