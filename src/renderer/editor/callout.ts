import { MapMode, StateEffect, StateField, type EditorState } from '@codemirror/state'
import type { IconName } from '../ui/icons'

/**
 * 告示块 Callout 的类型表与折叠状态（P1-6）。
 *
 * 语法取 Obsidian 那套 `> [!TYPE]`，别名表顺带把 GitHub 的
 * NOTE / TIP / IMPORTANT / WARNING / CAUTION 一起吃下 —— 两边语法一次实现。
 *
 * 本文件只管「数据」和「状态」，三个使用方各司其职：
 * 解析 `markdown-lang.ts`（CalloutMark 必须抢在 Link 之前）、
 * 装饰 `live-preview/decorate.ts`（行级，不是块级替换 —— 否则块里没法打字）、
 * 图标 `ui/icons.ts`（这里只引类型名，不引运行时）。
 */

/** 配色档位。13 种类型共用 6 档：语义挨着的本来就不该各来一种颜色 */
export type CalloutTone = 'note' | 'tip' | 'warn' | 'danger' | 'example' | 'quote'

export interface CalloutSpec {
  /** 别名解析后的规范类型名 */
  type: string
  tone: CalloutTone
  /** 没写自定义标题时补上去的中文名 */
  label: string
  icon: IconName
}

const TYPES: Record<string, CalloutSpec> = {}

/** 第一个名字是规范名，其余是别名（大小写在 matchCallout 里统一压成小写） */
function def(tone: CalloutTone, label: string, icon: IconName, ...names: string[]): void {
  for (const name of names) TYPES[name] = { type: names[0]!, tone, label, icon }
}

def('note', '笔记', 'info', 'note')
def('note', '信息', 'info', 'info')
def('note', '摘要', 'summary', 'abstract', 'summary', 'tldr')
def('note', '待办', 'task', 'todo')
def('tip', '提示', 'flame', 'tip', 'hint', 'important')
def('tip', '成功', 'check-circle', 'success', 'check', 'done')
def('warn', '疑问', 'help', 'question', 'help', 'faq')
def('warn', '注意', 'warn', 'warning', 'caution', 'attention')
def('danger', '失败', 'x-circle', 'failure', 'fail', 'missing')
def('danger', '危险', 'zap', 'danger', 'error')
def('danger', '缺陷', 'bug', 'bug')
def('example', '示例', 'list', 'example')
def('quote', '引用', 'quote', 'quote', 'cite')

export interface CalloutMatch extends CalloutSpec {
  /** `[!danger]-` 整段的长度，装饰层按它算替换范围 */
  length: number
  /** 写了 `-` 或 `+` 才给折叠三角（同 Obsidian：不写就是一张摊开的卡片） */
  foldable: boolean
  /** `-` = 默认折起 */
  folded: boolean
}

/**
 * `[!type]` 的**形状**（认不认识这个类型另说）。解析器拿它抢 `[`：
 * 打错一个类型名不该掉回「一行蓝色带下划线的坏链接」，那正是 P1-6 要消灭的东西。
 */
export const CALLOUT_SHAPE = /^\[!([a-zA-Z][\w-]*)\]([-+]?)/

/**
 * 认领 `[!type]` / `[!type]-` / `[!type]+`。
 * 类型表里没有的返回 null —— 不成卡片、仍旧是普通引用，只是 `[!xyz]`
 * 以字面量示人（由上面那条形状规则保证，不会被 Link 认领）。
 */
export function matchCallout(text: string): CalloutMatch | null {
  const m = CALLOUT_SHAPE.exec(text)
  if (!m) return null
  const spec = TYPES[m[1]!.toLowerCase()]
  if (!spec) return null
  return { ...spec, length: m[0].length, foldable: m[2] !== '', folded: m[2] === '-' }
}

// ---------- 折叠状态 ----------

/** 折叠开关，值是告示块的起点 */
export const toggleCalloutFold = StateEffect.define<number>()

/**
 * 折叠状态。**不写回文档**（保存零损耗那条红线），也不存行号 ——
 * 存块起点，文档一改就跟着 changes 映射；块被删掉（映射不过去）就丢弃。
 * 集合里装的是「与默认态相反」的那些块，所以默认折起的 `[!note]-`
 * 展开后同样只占一个条目。
 */
export const calloutFoldField = StateField.define<Set<number>>({
  create: () => new Set(),
  update(value, tr) {
    if (tr.docChanged) {
      const next = new Set<number>()
      for (const pos of value) {
        const mapped = tr.changes.mapPos(pos, 1, MapMode.TrackDel)
        if (mapped !== null) next.add(mapped)
      }
      value = next
    }
    for (const effect of tr.effects) {
      if (!effect.is(toggleCalloutFold)) continue
      const next = new Set(value)
      if (!next.delete(effect.value)) next.add(effect.value)
      value = next
    }
    return value
  }
})

/** 此刻折起没有：默认态（`-`）异或用户手动翻过的那一下 */
export function calloutFolded(state: EditorState, from: number, byDefault: boolean): boolean {
  return state.field(calloutFoldField, false)?.has(from) ? !byDefault : byDefault
}
