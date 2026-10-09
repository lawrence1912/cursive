import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { setLang, type Key } from '../src/renderer/i18n'
import { en } from '../src/renderer/i18n/en'
import { zh } from '../src/renderer/i18n/zh'
import { commandItems } from '../src/renderer/ui/commands'
import { allShortcuts, keyOf, withKey } from '../src/renderer/ui/shortcuts'
import type { MenuAction } from '../src/shared/types'

/**
 * 第八节 14：菜单、提示和文档里的快捷键得是同一个。
 *
 * 真相在原生菜单（`shell-swift/main.swift` 的 buildMenu），Swift 那边没有单测，
 * 这里直接读源码把整份菜单的键抠出来，再拿它去对：渲染层那张表（`ui/shortcuts.ts`）、
 * 命令面板右边那一列、字典里写死在句子里的那几句、README。
 * 从前各处各写一份：同一个键在菜单里是 `⇧⌘O`、在文件树按钮上是 `⌘⇧O`；
 * README 写着命令面板是 ⇧⌘P，而那个键被「导出 PDF」占了好几个版本（第八节 21）。
 */

const swift = readFileSync(new URL('../shell-swift/main.swift', import.meta.url), 'utf8')
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

/** 一个快捷键在文案里的样子：一串修饰键 + 一个键 */
const TOKEN = /[⌃⌥⇧⌘]+(?:F\d{1,2}|[A-Z0-9]|[←→↑↓⇥⌫⏎=+\-−[\],./\\;'`])/g
/** macOS 菜单自己画的写法：修饰键按 ⌃ ⌥ ⇧ ⌘ 排 */
const CANONICAL = /^(?=[⌃⌥⇧⌘])⌃?⌥?⇧?⌘?[^⌃⌥⇧⌘]+$/

const ARROWS: Record<string, string> = {
  NSLeftArrowFunctionKey: '←',
  NSRightArrowFunctionKey: '→',
  NSUpArrowFunctionKey: '↑',
  NSDownArrowFunctionKey: '↓'
}

/** Swift 字符串字面量里的转义：`"\\"` 是一个反斜杠，`"\t"` 是 Tab */
function swiftString(lit: string): string {
  return lit.replace(/\\(.)/g, (_, c: string) => (c === 't' ? '\t' : c))
}

/** `[.command, .shift]` / `.control` → 修饰键集合；没写 = `item()` 的默认值 `.command` */
function mods(src: string | undefined): Set<string> {
  if (!src) return new Set(['command'])
  return new Set([...src.matchAll(/\.(command|option|shift|control)\b/g)].map((m) => m[1]!))
}

/** 菜单上画出来的样子。AppKit：keyEquivalent 是大写字母 = 带 ⇧ */
function combo(m: Set<string>, raw: string): string {
  const upper = /^[A-Z]$/.test(raw)
  const glyph = raw === '\t' ? '⇥' : raw.toUpperCase()
  return (
    (m.has('control') ? '⌃' : '') +
    (m.has('option') ? '⌥' : '') +
    (m.has('shift') || upper ? '⇧' : '') +
    (m.has('command') ? '⌘' : '') +
    glyph
  )
}

interface MenuKey {
  /** `MenuAction`，或者 `native:<标题键>`（走 #selector 的那几条：退出、剪切、全屏…） */
  id: string
  combo: string
}

function menuKeys(): MenuKey[] {
  const out: MenuKey[] = []
  // 渲染层的命令：item(L("…"), "动作", key: "x", modifiers: [...])
  const itemRe =
    /item\(L\("([^"]+)"\),\s*"([^"]+)",\s*key:\s*(?:"((?:[^"\\]|\\.)*)"|arrow\((\w+)\))(?:,\s*modifiers:\s*(\[[^\]]*\]|\.\w+))?\)/g
  for (const m of swift.matchAll(itemRe)) {
    const raw = m[4] ? ARROWS[m[4]] : swiftString(m[3] ?? '')
    if (raw) out.push({ id: m[2]!, combo: combo(mods(m[5]), raw) })
  }
  // 壳自己接的：NSMenuItem(title: L("…"), action: …, keyEquivalent: "x")，修饰键另起一行设
  const nativeRe =
    /(?:let (\w+) = )?NSMenuItem\(title:\s*L\("([^"]+)"\),\s*action:[^\n]*?(?:\n\s*)?keyEquivalent:\s*"((?:[^"\\]|\\.)*)"\)/g
  for (const m of swift.matchAll(nativeRe)) {
    const raw = swiftString(m[3] ?? '')
    if (!raw) continue
    const mask = m[1] ? new RegExp(`\\b${m[1]}\\.keyEquivalentModifierMask = (\\[[^\\]]*\\]|\\.\\w+)`).exec(swift) : null
    out.push({ id: `native:${m[2]}`, combo: combo(mods(mask?.[1]), raw) })
  }
  return out
}

const MENU = menuKeys()
const BY_ACTION = new Map(MENU.filter((k) => !k.id.startsWith('native:')).map((k) => [k.id, k.combo]))
const ALL_COMBOS = new Set(MENU.map((k) => k.combo))

describe('从 main.swift 读出来的菜单快捷键', () => {
  it('读得出来（别在解析上悄悄失败）', () => {
    expect(MENU.length).toBeGreaterThan(70)
    expect(BY_ACTION.get('view:command-palette')).toBe('⇧⌘P')
    expect(BY_ACTION.get('file:export-pdf')).toBe('⌥⌘P')
    expect(BY_ACTION.get('file:next-tab')).toBe('⌃⇥')
    expect(BY_ACTION.get('go:back')).toBe('⌥⌘←')
    expect(BY_ACTION.get('view:toggle-sidebar')).toBe('⌘\\')
    const native = Object.fromEntries(MENU.filter((k) => k.id.startsWith('native:')).map((k) => [k.id, k.combo]))
    expect(native['native:menu.file.print']).toBe('⌘P')
    expect(native['native:menu.app.hideOthers']).toBe('⌥⌘H')
    expect(native['native:view.fullScreen']).toBe('⌃⌘F')
    expect(native['native:menu.file.newWindow']).toBe('⇧⌘N')
  })

  it('一个键只给一条命令（AppKit 取菜单里第一个匹配，后面那条一声不响地死掉）', () => {
    const seen = new Map<string, string[]>()
    for (const k of MENU) seen.set(k.combo, [...(seen.get(k.combo) ?? []), k.id])
    expect([...seen].filter(([, ids]) => ids.length > 1)).toEqual([])
  })
})

describe('渲染层那张表（ui/shortcuts.ts）', () => {
  it('与菜单逐条一致：一条不多、一条不少、一个字不差', () => {
    expect(allShortcuts()).toEqual(Object.fromEntries(BY_ACTION))
  })

  it('悬停说明的统一写法：「名字 (键)」，没有快捷键就只有名字', () => {
    expect(withKey('搜索', 'edit:find-in-files')).toBe('搜索 (⇧⌘F)')
    expect(withKey('导出长图', 'file:export-png')).toBe('导出长图')
    expect(keyOf('file:export-png')).toBeUndefined()
  })
})

describe('命令面板右边那一列', () => {
  afterEach(() => setLang('zh'))

  it.each(['zh', 'en'] as const)('%s：有键的命令写的就是菜单那个键，没键的不冒充', (lang) => {
    setLang(lang)
    let action = '' as MenuAction
    const rows = commandItems((a) => void (action = a)).map((item) => {
      item.run()
      return { action, hint: item.hint }
    })
    for (const { action: a, hint } of rows) {
      const want = BY_ACTION.get(a)
      if (want) expect(hint, a).toBe(want)
      else if (hint) expect(hint.match(TOKEN), `${a} 的「${hint}」不是菜单里的键`).toBeNull()
    }
  })
})

/**
 * 字典里写死在句子里的快捷键，各自说的是哪条命令。
 * 新写一句带快捷键的文案，先登记在这儿 —— 下面那条会逐个核对它与菜单对不对得上
 */
const SAYS: Partial<Record<Key, MenuAction>> = {
  // 格式栏按钮的悬停说明（命令面板拆它当名字，那一列另取 keyOf）
  'fb.bold': 'fmt:bold',
  'fb.italic': 'fmt:italic',
  'fb.underline': 'fmt:underline',
  'fb.strike': 'fmt:strikethrough',
  'fb.code': 'fmt:code-inline',
  'fb.link': 'fmt:link',
  'fb.quote': 'fmt:quote',
  'fb.ulist': 'fmt:ulist',
  'fb.olist': 'fmt:olist',
  'fb.task': 'fmt:task',
  'fb.codeBlock': 'fmt:code-block',
  'fb.highlight': 'fmt:highlight',
  'fb.sup': 'fmt:superscript',
  'fb.sub': 'fmt:subscript',
  'fb.mathInline': 'fmt:math-inline',
  // 查找面板三颗按钮
  'sp.replaceTitle': 'edit:replace',
  'sp.prevTitle': 'edit:find-prev',
  'sp.nextTitle': 'edit:find-next',
  // 句子里顺带提一句
  'status.roTitle': 'view:toggle-read-only',
  'sb.orOpen': 'file:open-folder',
  'pl.noFolder': 'file:open-folder',
  'note.tagNoFolder': 'file:open-folder',
  'latex.done': 'edit:undo',
  'hi.hint': 'edit:undo',
  'note.rolledBack': 'edit:undo',
  'note.gridPasted': 'edit:undo',
  'hint.blankPalette': 'view:command-palette'
}

describe('字典里写死在句子里的快捷键', () => {
  it.each([
    ['zh', zh],
    ['en', en]
  ] as const)('%s：每一句都登记过、写法对、与菜单一致', (_lang, dict) => {
    for (const [key, text] of Object.entries(dict) as [Key, string][]) {
      const found = text.match(TOKEN) ?? []
      if (!found.length) continue
      const action = SAYS[key]
      expect(action, `「${key}」里写着 ${found.join(' ')}，先在 SAYS 里登记它说的是哪条命令`).toBeDefined()
      for (const k of found) expect(k, `${key}`).toBe(BY_ACTION.get(action!))
    }
  })

  it('登记表里没有过期的条目（那句话已经不带快捷键了，就从表里删掉）', () => {
    for (const key of Object.keys(SAYS) as Key[]) {
      expect(zh[key].match(TOKEN), `zh ${key}`).not.toBeNull()
      expect(en[key].match(TOKEN), `en ${key}`).not.toBeNull()
    }
  })
})

/** 去掉注释，只留代码（注释里怎么写快捷键都行，它们不上屏） */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')
}

function sources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(dir, f))
}

describe('源码里不许再手写快捷键', () => {
  it('渲染层的代码里（字典与 ui/shortcuts.ts 之外）一个都没有 —— 一律 keyOf / withKey', () => {
    const root = new URL('../src/renderer', import.meta.url).pathname
    const hits: string[] = []
    for (const file of sources(root)) {
      const rel = file.slice(root.length + 1)
      if (rel.startsWith('i18n/') || rel === 'ui/shortcuts.ts') continue
      for (const k of codeOnly(readFileSync(file, 'utf8')).match(TOKEN) ?? []) hits.push(`${rel}: ${k}`)
    }
    expect(hits).toEqual([])
  })
})

/**
 * README 没写的菜单快捷键。都是 macOS 自己的那几条（每个应用都一样，写进去只是占地方）
 */
const UNDOCUMENTED: Record<string, string> = {
  '⌘Q': '退出（系统通行）',
  '⌘H': '隐藏（系统通行）',
  '⌘M': '最小化（系统通行）',
  '⌘X': '剪切（系统通行）',
  '⌘C': '拷贝（系统通行）',
  '⌘V': '粘贴（系统通行）',
  '⇧⌘Z': '重做（系统通行）'
}

describe('README', () => {
  /** 正文里的快捷键（围栏代码块不算）；`⌘1 – ⌘6` 这种区间展开 */
  function readmeKeys(): string[] {
    let fenced = false
    const body = readme
      .split('\n')
      .filter((line) => {
        if (/^\s*(```|~~~)/.test(line)) {
          fenced = !fenced
          return false
        }
        return !fenced
      })
      .join('\n')
    const keys = body.match(TOKEN) ?? []
    for (const m of body.matchAll(/([⌃⌥⇧⌘]+)(\d)\s*[–-]\s*\1(\d)/g)) {
      for (let n = Number(m[2]) + 1; n < Number(m[3]); n++) keys.push(`${m[1]}${n}`)
    }
    return keys
  }

  it('写到的每一个键都是菜单里真有的，写法与菜单一致', () => {
    const keys = readmeKeys()
    expect(keys.length).toBeGreaterThan(40)
    expect(keys.filter((k) => !CANONICAL.test(k))).toEqual([])
    expect(keys.filter((k) => !ALL_COMBOS.has(k))).toEqual([])
  })

  it('菜单里带键的命令都写进去了（系统通行的那几条除外）', () => {
    const written = new Set(readmeKeys())
    const missing = [...ALL_COMBOS].filter((k) => !written.has(k) && !(k in UNDOCUMENTED))
    expect(missing).toEqual([])
    // 豁免名单也不许留着已经写进去、或者菜单里已经没有的键
    expect(Object.keys(UNDOCUMENTED).filter((k) => written.has(k) || !ALL_COMBOS.has(k))).toEqual([])
  })
})
