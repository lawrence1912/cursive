import { carryDecorations } from './carry'
import { pointerSelection } from './pointer-selection'
import { hasNavigationTarget } from './navigation'
import type { EditorState, Extension, Range } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'

/** P3-3 两个写作模式。真相在渲染层 localStorage（main.ts 的 `cursive.writing`） */
export interface WritingModes {
  /** 专注模式：除当前段落外一律压暗 */
  focus: boolean
  /** 打字机模式：光标行始终停在视口固定高度上 */
  typewriter: boolean
}

export const WRITING_DEFAULT: WritingModes = { focus: false, typewriter: false }

/**
 * 光标行停在视口的这个高度比例上。比正中略高一点 —— 正中会让「已写的」和
 * 「待写的」各占一半，视觉上像在读；偏上一点才像在写。
 */
const ANCHOR = 0.42

/**
 * 段落上下扫描的行数上限。CJK 长文常常整章不留空行，没有上限的话每次按键都要
 * 从光标一路 `doc.line(n)` 扫到文档两头 —— 视口一共就几十行，扫这么远没有意义。
 */
const MAX_SCAN = 400

const focusLine = Decoration.line({ class: 'cm-focus-line' })

/**
 * 专注单元 = 光标所在的**段落**（空行分隔的连续非空行），与主流 WYSIWYG 一致。
 * 有选区时取选区覆盖到的所有段落；光标停在空行上就只亮那一行（本来也没东西可亮）。
 *
 * 纯函数，不碰 DOM：test/writing-modes.test.ts 直接断言它。
 */
export function focusRange(state: EditorState): { from: number; to: number } {
  const sel = state.selection.main
  const first = state.doc.lineAt(sel.from)
  const last = sel.to === sel.from ? first : state.doc.lineAt(sel.to)
  let a = first.number
  let b = last.number
  const top = Math.max(1, a - MAX_SCAN)
  const bottom = Math.min(state.doc.lines, b + MAX_SCAN)
  const blank = (n: number): boolean => state.doc.line(n).text.trim() === ''
  // 光标本来就停在空行上时不往外扩 —— 否则「段落之间」那一下会把上下两段一起点亮
  if (!blank(a)) while (a > top && !blank(a - 1)) a--
  if (!blank(b)) while (b < bottom && !blank(b + 1)) b++
  return { from: state.doc.line(a).from, to: state.doc.line(b).to }
}

/**
 * 亮的那几行加 `.cm-focus-line`，**压暗的那一大片交给 CSS**
 * （`.cursive-focus .cm-content > *:not(.cm-focus-line)`）—— 只给少数几行发装饰，
 * 长文档里不用为屏幕外的每一行都造一个 Decoration。
 * 压暗只改文字颜色、不盖 opacity 遮罩，理由见 base.css 那一段。
 */
function focusDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const range = focusRange(state)
  const out: Range<Decoration>[] = []
  for (const vis of view.visibleRanges) {
    const from = Math.max(vis.from, range.from)
    const to = Math.min(vis.to, range.to)
    if (from > to) continue
    for (let pos = from; ; ) {
      const line = state.doc.lineAt(pos)
      out.push(focusLine.range(line.from))
      if (line.to >= to) break
      pos = line.to + 1
    }
  }
  return Decoration.set(out, true)
}

const focusPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    private wasComposing = false

    constructor(view: EditorView) {
      this.decorations = focusDecorations(view)
    }

    update(u: ViewUpdate): void {
      // 输入法铁律：合成期间不重算装饰，合成完补一次 —— 但**位置要跟着文档走**
      // （`editor/carry.ts`：不映射的行样式会落到别的行上，行高一变视口就往下跳）
      if (u.view.compositionStarted) {
        this.wasComposing = true
        if (u.docChanged) this.decorations = carryDecorations(this.decorations, u.changes, u.state.doc)
        return
      }
      if (this.wasComposing || u.docChanged || u.selectionSet || u.viewportChanged) {
        this.wasComposing = false
        this.decorations = focusDecorations(u.view)
      }
    }
  },
  { decorations: (p) => p.decorations }
)

/**
 * 打字机模式：键盘移动 / 文档变更时，把光标行拉回 ANCHOR；鼠标选区不抢滚动。
 *
 * 走的是 CM 自己的滚动目标（`EditorView.scrollIntoView`，`y:'start'` + 半屏 yMargin
 * = 把该行顶边摆到视口 42% 处），**不是手写 `scrollDOM.scrollTop`**。手写那版实测
 * 稳定偏 28px 并且改 scrollTop 也没用：CM 在 measure 里有滚动锚定，行高从估算值
 * 换成实测值时它会反向补偿 scrollTop 以免画面跳动，于是把我们的位移抵消掉了。
 * 交给它自己的 scrollTarget，这一整套补偿就站在同一边。
 *
 * dispatch 不能在 update() 里同步发（CM 不允许嵌套 dispatch），所以排到下一个宏任务；
 * 同一批变更只排一次。
 *
 * **排在 `setTimeout` 里而不是 `requestAnimationFrame` 里**：窗口被别的窗口整个盖住、
 * 或落在另一个（全屏）Space 上时，WKWebView 会把整页判成 `visibilityState: 'hidden'`，
 * **rAF 就此停摆**，而 CM 自己的 scrollTarget 照样生效 —— 于是「光标行归位」这一步
 * 单独失效，看起来像打字机算错了位置。E2E 连跑用例时必现（窗口抢不到前台），
 * 排查记录见 CONTEXT.md。用宏任务同样满足「跳出 update()」，且不看画面是否在绘。
 */
const typewriterPlugin = ViewPlugin.fromClass(
  class {
    private timer = 0

    constructor(view: EditorView) {
      // 刚打开 / 刚切模式：先把光标行摆到位，否则要等用户按第一个键才归位
      this.schedule(view)
    }

    update(u: ViewUpdate): void {
      if (u.view.compositionStarted) {
        if (this.timer) clearTimeout(this.timer)
        this.timer = 0
        return // 组字开始就取消归位，避免上一次输入排队的滚动挪动光标和候选词框
      }
      if (u.state.field(pointerSelection, false) || u.transactions.some((tr) => tr.isUserEvent('select.pointer'))) {
        if (this.timer) clearTimeout(this.timer)
        this.timer = 0
        return
      }
      if (u.docChanged || u.selectionSet) this.schedule(u.view)
    }

    destroy(): void {
      if (this.timer) clearTimeout(this.timer)
    }

    private schedule(view: EditorView): void {
      if (this.timer) return
      this.timer = window.setTimeout(() => {
        this.timer = 0
        // compositionstart 本身不一定产生 ViewUpdate，执行时还需检查一次。
        if (view.compositionStarted || hasNavigationTarget(view) || view.state.field(pointerSelection, false)) return
        view.dispatch({
          effects: EditorView.scrollIntoView(view.state.selection.main.head, {
            y: 'start',
            yMargin: view.scrollDOM.clientHeight * ANCHOR
          })
        })
      }, 0)
    }
  }
)

/**
 * 两个模式的开关都在这里组装。挂在一个 Compartment 里（main.ts 的 `writingConf`），
 * 切换 = reconfigure，和源代码模式同一套做法。
 *
 * 类名走 `editorAttributes` 而不是在 main.ts 手动 toggle：扩展一撤，类名自己就没了。
 */
export function writingModes(modes: WritingModes): Extension {
  const out: Extension[] = []
  if (modes.focus) {
    out.push(focusPlugin, EditorView.editorAttributes.of({ class: 'cursive-focus' }))
  }
  if (modes.typewriter) {
    out.push(typewriterPlugin, EditorView.editorAttributes.of({ class: 'cursive-typewriter' }))
  }
  return out
}
