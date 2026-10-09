import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'

const navigate = StateEffect.define<number>()

/**
 * 第八节 6：**每一次 `jumpTo` 都是一次明确的跳转** —— 大纲、`[TOC]`、锚点链接、跳到行
 * 全走这儿，于是后退 / 前进只要在这一处挂一个钩子（main.ts 记位置）。不挂（单测、
 * 别的 view）就只跳。跨文档的那几条（开标签再跳）由窗口那一层自己包住整趟，
 * 里面这一下 jumpTo 不重复记 —— 那是钩子自己的事（main.ts 的 `navDepth`）。
 */
export const jumpHost: { around: ((view: EditorView, run: () => void) => void) | null } = {
  around: null
}

/** 保留文档位置而非像素位置，让晚到的图片/图表也服从这次导航。 */
export function jumpTo(view: EditorView, pos: number, head = pos): void {
  const run = (): void =>
    view.dispatch({
      // `head`：落点之后顺手选中一段（第八节 8 引用检查：选中那段坏掉的地址）。
      // **必须在同一个事务里**：分两次派的话，第二次的选区会把下面那条稳定导航取消掉
      selection: { anchor: pos, head },
      effects: [
        navigate.of(pos),
        flashAt.of(pos),
        EditorView.scrollIntoView(pos, { y: 'start', yMargin: 12 })
      ]
    })
  if (jumpHost.around) jumpHost.around(view, run)
  else run()
}

/**
 * 后退 / 前进回到一个记下来的位置（第八节 6）：光标放回 `pos`，**视口顶上那一行**摆回
 * `top` —— 「刚才读到哪儿」靠的是后者，光标可能早就停在别处了。与 `jumpTo` 同一套
 * 稳定导航（晚到的图片、公式不会把它推走），但**不闪落点**：这不是「去一个新地方」，
 * 是回到人刚刚自己待过的地方，那一行不需要再指给他看。
 */
export function revisit(view: EditorView, pos: number, top: number): void {
  view.dispatch({
    selection: { anchor: pos },
    // 边距与 jumpTo 同为 12：稳定导航（下面 `stableNavigation`）事后对齐时用的就是这个数，
    // 两边不一致的话图片晚到那一下会把视口挪动 12px
    effects: [navigate.of(top), EditorView.scrollIntoView(top, { y: 'start', yMargin: 12 })]
  })
}

// ---------------------------------------------------------------- 落点提示

/**
 * **跳完了，落在哪儿要说一声。**
 *
 * 大纲点一条、⌘T 开一个文件、⌘+点击一个 `#锚点` —— 这几条路都是「按名字找过去」，
 * 而画面是**瞬间**换的：视线得自己在新的一屏里找回光标。给落点那一行一次淡出的底色
 * 就够了，一秒不到自己消失。
 *
 * **有意不做滚动动画**：位置换得再顺，滚动动画本身会让人失焦（长文档里尤其），
 * 而这里要回答的只有一个问题 —— 「我现在在哪儿」。
 *
 * 文档一改就撤：改的往往正是落点那一行，留着它会跟着字一起挪，看起来像个 bug。
 */
const flashAt = StateEffect.define<number | null>()
const FLASH_LINE = Decoration.line({ class: 'cm-jump-flash' })
/** 亮多久（之后由 CSS 的过渡淡出，见 `editor/theme.ts`） */
export const FLASH_MS = 550

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(flashAt)) continue
      if (e.value === null) return Decoration.none
      return Decoration.set([FLASH_LINE.range(tr.state.doc.lineAt(e.value).from)])
    }
    // 文档变了就撤 —— 顺带免掉「行级装饰被映射到行中间」那类越界问题
    return tr.docChanged ? Decoration.none : value
  },
  provide: (f) => EditorView.decorations.from(f)
})

/** 当前亮着的那一行的起点；没有就是 null。导出给单测与调试 */
export function flashedLine(state: EditorState): number | null {
  const set = state.field(flashField, false)
  if (!set) return null
  let at: number | null = null
  set.between(0, state.doc.length, (from) => {
    at = from
    return false
  })
  return at
}

/**
 * 到点把它撤掉。**用 `setTimeout` 不用 rAF**（窗口不在最前面时 rAF 会被降频甚至
 * 不回调，那会让底色一直挂在那儿），**也不在 update 里直接 dispatch**（嵌套派发）。
 */
const flashClear = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null
    constructor(private readonly view: EditorView) {}
    update(u: ViewUpdate): void {
      const lit = u.transactions.some((tr) =>
        tr.effects.some((e) => e.is(flashAt) && e.value !== null)
      )
      if (!lit) return
      if (this.timer !== null) clearTimeout(this.timer)
      this.timer = setTimeout(() => {
        this.timer = null
        if (flashedLine(this.view.state) !== null) this.view.dispatch({ effects: flashAt.of(null) })
      }, FLASH_MS)
    }
    destroy(): void {
      if (this.timer !== null) clearTimeout(this.timer)
    }
  }
)

export const landingFlash: Extension = [flashField, flashClear]

export const stableNavigation = ViewPlugin.fromClass(class {
  target: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private aligning = false

  constructor(private view: EditorView) {
    // 捕获阶段也能收到 widget 内部拦截的操作；不监听 scroll，CM 自己也会滚动。
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      view.dom.addEventListener(event, this.cancel, true)
    }
  }

  private cancel = (): void => {
    this.target = null
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  update(u: ViewUpdate): void {
    for (const tr of u.transactions) {
      const start = tr.effects.find((e) => e.is(navigate))
      if (start) {
        this.cancel()
        this.target = start.value
      } else if (tr.docChanged || tr.selection || (!this.aligning && tr.scrollIntoView)) {
        this.cancel()
      }
    }
    if (this.target === null || !u.geometryChanged || this.timer !== null) return
    // 跳出 CM 的 update/measure，避免嵌套 dispatch。
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.target === null) return
      this.aligning = true
      try {
        this.view.dispatch({
          effects: EditorView.scrollIntoView(this.target, { y: 'start', yMargin: 12 })
        })
      } finally {
        this.aligning = false
      }
    }, 0)
  }

  destroy(): void {
    this.cancel()
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      this.view.dom.removeEventListener(event, this.cancel, true)
    }
  }
})

export function hasNavigationTarget(view: EditorView): boolean {
  return view.plugin(stableNavigation)?.target != null
}
