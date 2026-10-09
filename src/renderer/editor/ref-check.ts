import { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import { resolvePath } from '../../shared/path'
import { collectHeadings, slugs } from './headings'
import { autolinkUrl, collectRefs, linkDest, refKey, resolveLink } from './link'
import { cursiveMarkdown } from './markdown-lang'
import { primeTree } from './syntax'

/**
 * 当前文档的本地引用检查（第八节 8）。
 *
 * **显式命令、只查这一份、按需跑**：不建后台索引，也不在打字、装饰、点击的路上查文件系统
 * （`editor/link.ts` 那条「不猜文件在不在」照旧成立 —— 那儿每查一次就是每次装饰一趟 IPC）。
 * 只读不写：查完文档一个字节都不动，结果是一张清单，跳过去改是人的事。
 *
 * 认的四种东西，「指向哪儿」全部复用编辑器自己那一套，检查器不另起一套解析：
 *   · 链接（`[文字](地址)`、引用式、`<file:…>` 自动链接）走 `resolveLink` —— 与 ⌘+点击同一份
 *     去处判定，所以「检查说没问题」与「点得过去」是一回事；
 *   · `#锚点` 对本文标题表，`别的.md#锚点` 读那份文档再对 —— 锚点串是 `slugs()` 那一份，
 *     与大纲、`[TOC]`、导出的 id 同一个算法；
 *   · 图片按壳侧读图的规矩认路径（`FileSchemeHandler`：先按文档里写的原样找，
 *     找不到再百分号解码一次），所以「编辑器里画得出来」与「检查说找得到」是一回事。
 * 外部地址不查（不联网）；相对路径而文档还没保存过的，没有起点，记个数说一声。
 */

export type RefKind = 'anchor' | 'doc' | 'file' | 'image'
/** 为什么算失效：不在 / 指着一个文件夹（只对文档与图片算错）/ 没有这个标题 / 文档在但读不出来 */
export type RefReason = 'missing' | 'folder' | 'noAnchor' | 'unreadable'

export interface RefProblem {
  /** 写在文档里的那个地址（原样，清单里给人看的就是它） */
  dest: string
  /** 地址在源码里的位置：跳过去时选中这一段（引用式的是整个链接） */
  from: number
  to: number
  /** 第几行（1 起） */
  line: number
  kind: RefKind
  reason: RefReason
}

export interface RefReport {
  /** 按在文档里的先后排好 */
  problems: RefProblem[]
  /** 核对过的本地引用条数（外部地址不算） */
  checked: number
  /** 相对路径而文档还没保存过：没有起点，算不出指向哪儿 */
  unsaved: number
}

export interface RefHost {
  /** 这几条路径在不在、是文件还是目录（契约 v39 的 `statPaths`） */
  stat(paths: string[]): Promise<Array<'file' | 'dir' | null>>
  /** 一份本地文档的正文：开着标签的用标签里那份（可能还没存），否则读盘；读不出来回 null */
  text(path: string): Promise<string | null>
}

/** 一条要核对的引用：先收齐，路径再一次批量问壳（一趟 IPC，而不是一条一趟） */
type Pending =
  | { kind: 'anchor'; slug: string; at: Span }
  | { kind: 'doc'; path: string; slug: string | null; at: Span }
  | { kind: 'file'; path: string; at: Span }
  | { kind: 'image'; paths: string[]; at: Span }

interface Span {
  dest: string
  from: number
  to: number
}

/** 有协议的地址（`https:` / `data:` / `file:` …） */
const SCHEME = /^[a-zA-Z][\w+.-]*:/

/** 百分号解码，解不开就原样（同 `link.ts` 的 decodePart） */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/**
 * 图片的候选路径，与壳侧 `FileSchemeHandler` 找文件的顺序一致：先按文档里写的原样，
 * 再百分号解码一次。返回 null = 不是本地图片（`https:` / `data:` …）；`'unsaved'` = 相对路径而
 * 文档没有目录。
 */
function imagePaths(src: string, dir: string | null): string[] | 'unsaved' | null {
  let raw = src.trim()
  if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1).trim()
  if (!raw) return null
  const scheme = SCHEME.exec(raw)?.[0]
  if (scheme) {
    if (scheme.toLowerCase() !== 'file:') return null
    raw = raw.slice(scheme.length).replace(/^\/\/(localhost)?/i, '')
    if (!raw.startsWith('/')) return null
  }
  const base = dir && dir.startsWith('/') ? dir : null
  if (!raw.startsWith('/') && !base) return 'unsaved'
  const literal = resolvePath(base ?? '/', raw)
  const plain = resolvePath(base ?? '/', decoded(raw))
  return literal === plain ? [literal] : [literal, plain]
}

/**
 * 引用定义 `[id]: 地址` 里那个地址在源码里的位置。同一个 id 只认第一条（与 `collectRefs` 一致）。
 *
 * 引用式的链接 / 图片出了问题，**报在定义上**：路径写在那一行，人要改的是它；
 * 几处用法共用一个定义时也只该报一条 —— 报在每一处用法上，清单里就是一排一模一样的地址，
 * 而跳过去看到的是链接文字，看不见那个坏掉的路径
 */
function definitionSpans(state: EditorState): Map<string, Span> {
  const out = new Map<string, Span>()
  primeTree(state).iterate({
    enter: (n) => {
      if (n.name !== 'LinkReference') return
      const label = n.node.getChild('LinkLabel')
      const url = n.node.getChild('URL')
      if (!label || !url) return false
      const key = refKey(state.doc.sliceString(label.from, label.to))
      if (!out.has(key)) out.set(key, { dest: state.doc.sliceString(url.from, url.to), from: url.from, to: url.to })
      return false
    }
  })
  return out
}

/** 走一遍全文，把要核对的引用收齐。外部地址、安全闸挡掉的、空地址直接跳过 */
function collect(state: EditorState, dir: string | null): { pending: Pending[]; unsaved: number } {
  const pending: Pending[] = []
  let unsaved = 0
  let refs: Map<string, string> | null = null
  const refTable = (): Map<string, string> => (refs ??= collectRefs(state))
  let defs: Map<string, Span> | null = null
  /** 已经收进来的引用定义（`位置:种类`）：几处用法共用一个定义只查一次、只报一条 */
  const seenDefs = new Set<string>()

  /**
   * 地址在源码里的那一段：行内写法是 `URL` 子节点；引用式（没有 `URL`）是定义里的那个地址。
   * 返回 null = 这个定义已经收过了
   */
  const spanOf = (node: SyntaxNode, kind: string): Span | null => {
    const url = node.getChild('URL')
    if (url) return { dest: state.doc.sliceString(url.from, url.to), from: url.from, to: url.to }
    const label = node.getChild('LinkLabel')
    const key = refKey(state.doc.sliceString(label?.from ?? node.from, label?.to ?? node.to))
    const def = (defs ??= definitionSpans(state)).get(key)
    if (!def || seenDefs.has(`${def.from}:${kind}`)) return null
    seenDefs.add(`${def.from}:${kind}`)
    return def
  }

  const link = (href: string, at: Span): void => {
    const target = resolveLink(href, dir)
    if (!target) return
    switch (target.kind) {
      case 'external':
        return
      case 'unsaved':
        unsaved++
        return
      case 'anchor':
        pending.push({ kind: 'anchor', slug: target.slug, at })
        return
      case 'doc':
        pending.push({ kind: 'doc', path: target.path, slug: target.slug, at })
        return
      case 'file':
        pending.push({ kind: 'file', path: target.path, at })
    }
  }

  // 认到一个链接也接着往下走：`[![图](a.png)](b.md)` 是链接里套着一张图，两样都要查。
  // 往下走到的那个 `URL` 子节点由下面「父节点是谁」那条挡掉，不会再认一遍
  primeTree(state).iterate({
    enter: (n) => {
      switch (n.name) {
        case 'Link': {
          const dest = linkDest(state.doc, n.node, refTable)
          const at = dest ? spanOf(n.node, 'link') : null
          if (dest && at) link(dest, at)
          return
        }
        case 'Image': {
          const dest = linkDest(state.doc, n.node, refTable)
          const at = dest ? spanOf(n.node, 'image') : null
          if (!dest || !at) return
          const paths = imagePaths(dest, dir)
          if (paths === 'unsaved') unsaved++
          else if (paths) pending.push({ kind: 'image', paths, at })
          return
        }
        case 'Autolink': {
          const url = n.node.getChild('URL')
          const at = spanOf(n.node, 'link')
          if (url && at) link(autolinkUrl(state.doc.sliceString(url.from, url.to)), at)
          return
        }
        case 'URL': {
          // 裸地址（GFM 的 autolink 扩展）：Link / Image / Autolink 里的那个已经在上面认过了，
          // 引用定义 `[id]: 地址` 只在被用到时才算（用到它的那条链接会报出来）
          const parent = n.node.parent?.name
          if (parent === 'Link' || parent === 'Image' || parent === 'Autolink' || parent === 'LinkReference') return
          const raw = state.doc.sliceString(n.from, n.to)
          link(autolinkUrl(raw), { dest: raw, from: n.from, to: n.to })
          return
        }
      }
      return undefined
    }
  })
  return { pending, unsaved }
}

/** 一份文档的锚点表（小写，同 `anchorPos` 的比法） */
function anchorsOf(state: EditorState): Set<string> {
  primeTree(state)
  return new Set(slugs(collectHeadings(state)).map((s) => s.toLowerCase()))
}

/**
 * 查一遍。`path` 是这份文档自己的路径（未命名是 null）—— 指向自己的 `这份.md#节`
 * 直接对眼前这份的标题表，不去读盘上那份（盘上的可能还是旧的）。
 */
export async function checkRefs(
  state: EditorState,
  dir: string | null,
  path: string | null,
  host: RefHost
): Promise<RefReport> {
  const { pending, unsaved } = collect(state, dir)
  const problems: RefProblem[] = []
  const report = (at: Span, kind: RefKind, reason: RefReason): void => {
    problems.push({ dest: at.dest, from: at.from, to: at.to, line: state.doc.lineAt(at.from).number, kind, reason })
  }

  // ① 所有要问的路径一次问完
  const wanted = new Set<string>()
  for (const p of pending) {
    if (p.kind === 'doc' || p.kind === 'file') wanted.add(p.path)
    else if (p.kind === 'image') for (const c of p.paths) wanted.add(c)
  }
  const list = [...wanted]
  const kinds = new Map<string, 'file' | 'dir' | null>()
  if (list.length) {
    const got = await host.stat(list)
    list.forEach((p, i) => kinds.set(p, got[i] ?? null))
  }

  // ② 带锚点、而且在盘上的那些文档，各读一次
  let own: Set<string> | null = null
  const ownAnchors = (): Set<string> => (own ??= anchorsOf(state))
  const others = new Map<string, Promise<Set<string> | null>>()
  const anchorsAt = (doc: string): Promise<Set<string> | null> => {
    let hit = others.get(doc)
    if (!hit) {
      hit = host.text(doc).then((text) =>
        text === null ? null : anchorsOf(EditorState.create({ doc: text, extensions: [cursiveMarkdown()] }))
      )
      others.set(doc, hit)
    }
    return hit
  }

  for (const p of pending) {
    switch (p.kind) {
      case 'anchor':
        if (!ownAnchors().has(p.slug.toLowerCase())) report(p.at, 'anchor', 'noAnchor')
        break
      case 'file':
        // 文件夹也是一个合法的去处（⌘+点击交给 Finder）
        if (!kinds.get(p.path)) report(p.at, 'file', 'missing')
        break
      case 'image': {
        const found = p.paths.map((c) => kinds.get(c) ?? null)
        if (found.includes('file')) break
        report(p.at, 'image', found.includes('dir') ? 'folder' : 'missing')
        break
      }
      case 'doc': {
        const kind = kinds.get(p.path)
        if (!kind) {
          report(p.at, 'doc', 'missing')
          break
        }
        if (kind === 'dir') {
          report(p.at, 'doc', 'folder')
          break
        }
        if (!p.slug) break
        const anchors = p.path === path ? ownAnchors() : await anchorsAt(p.path)
        if (!anchors) report(p.at, 'doc', 'unreadable')
        else if (!anchors.has(p.slug.toLowerCase())) report(p.at, 'anchor', 'noAnchor')
        break
      }
    }
  }
  problems.sort((a, b) => a.from - b.from)
  return { problems, checked: pending.length, unsaved }
}
