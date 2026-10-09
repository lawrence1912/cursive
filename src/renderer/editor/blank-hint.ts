import type { Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'
import { t } from '../i18n'

/**
 * 空白文档里那两行提示（第八节 14）。
 *
 * 文档一个字都没有时，第一行里浮着两行淡字 ——「输入 / 插入标题、列表、表格…」与
 * 「⇧⌘P 查找所有命令」，后面一颗「不再显示」。打出第一个字就没了（它就是 placeholder 那一类
 * 东西），删空了又回来；「不再显示」关的是偏好里的「操作提示」，设置面板那一行能再打开。
 *
 * **只说这两句**：一张白纸前面，Markdown 本身不用教（会写 Markdown 的人都知道 `# ` 是标题），
 * 不说就不知道有的是**斜杠菜单**与**命令面板** —— 前者插块，后者把整份菜单变成一个搜索框，
 * 其余的功能都能从那儿搜到。别的说明挂在各自的控件上（链接与标签的悬停说明、表格手柄、
 * 图片拖角、插入下拉末行那句），用到那一下才看得见，不在这儿堆成一份说明书：
 * 不做强制的新手教程。
 *
 * 不用 CodeMirror 自带的 `placeholder()`：它整块 `pointer-events: none`、点击一律交给编辑器，
 * 里面放不了一颗按得到的按钮；它的内容也是建一次就钉死的，切语言换不了字。
 *
 * **出现得慢半拍**（CSS：停 0.4s 再淡入，见 live-preview.css）：启动时那个空白标签往往
 * 几百毫秒之内就被崩溃恢复 / 会话恢复换掉，不等的话每次开 app 都会闪一下这两行字。
 */

/** 「不再显示」接到哪儿。main.ts 接上（关偏好 + 状态栏回执）—— 编辑器这层不碰偏好 */
export const blankHintHost: { dismiss: () => void } = { dismiss: () => {} }

class BlankHintWidget extends WidgetType {
  constructor(
    readonly slash: string,
    readonly palette: string,
    readonly off: string,
    readonly offTitle: string
  ) {
    super()
  }

  /** 按文案比：切了语言才重画（重画会把那 0.4s 的淡入再走一遍） */
  override eq(o: BlankHintWidget): boolean {
    return o.slash === this.slash && o.palette === this.palette && o.off === this.off && o.offTitle === this.offTitle
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-blank-hint'
    // 读屏听的是 contentDOM 上的 aria-placeholder（`blankHint()` 里），这一块对它只是装饰
    wrap.setAttribute('aria-hidden', 'true')
    const first = document.createElement('span')
    first.className = 'cm-blank-hint-line'
    first.textContent = this.slash
    const second = document.createElement('span')
    second.className = 'cm-blank-hint-line is-sub'
    second.textContent = this.palette
    const off = document.createElement('button')
    off.type = 'button'
    off.className = 'cm-blank-hint-off'
    off.textContent = this.off
    off.title = this.offTitle
    // 它长在可编辑区里：Tab 走不进来（键盘上的路是设置面板那一行），按下也不抢焦点 ——
    // 焦点一离开编辑器，光标就没了，人得再点一下才能开始写
    off.tabIndex = -1
    off.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    off.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      blankHintHost.dismiss()
    })
    second.append(off)
    wrap.append(first, second)
    return wrap
  }

  /** 点在字上 = 点在这一行上（编辑器照常把光标放进来）；只有那颗按钮自己处理 */
  override ignoreEvent(e: Event): boolean {
    return e.target instanceof Element && e.target.closest('.cm-blank-hint-off') !== null
  }

  /**
   * 光标贴着这块画时只要一行高、落在第一行字的左沿 —— 同 CodeMirror 自带 placeholder 的处理。
   * 不给的话 drawSelection 会按整块的外框画，光标被拉成两行那么高
   */
  override coordsAt(dom: HTMLElement): { left: number; right: number; top: number; bottom: number } | null {
    const first = dom.firstElementChild
    const rect = first?.getClientRects()[0]
    if (!rect) return null
    return { left: rect.left, right: rect.left, top: rect.top, bottom: rect.bottom }
  }
}

/** 这一刻该不该摆出来：一个字都没有、而且写得进去（只读的空文档摆「输入 / …」是在骗人） */
export function blankHintShown(state: { doc: { length: number }; readOnly: boolean }): boolean {
  return state.doc.length === 0 && !state.readOnly
}

/** 这一刻的那份装饰：该摆就一颗 widget，不该摆就 none。纯函数，单测直接拿 state 喂 */
export function blankHintDecos(state: { doc: { length: number }; readOnly: boolean }): DecorationSet {
  if (!blankHintShown(state)) return Decoration.none
  const widget = new BlankHintWidget(
    t('hint.blankSlash'),
    t('hint.blankPalette'),
    t('hint.blankOff'),
    t('hint.blankOffTitle')
  )
  // side 1：排在 0 号位置**之后**，光标停在它前面（打字从提示的左边开始）
  return Decoration.set([Decoration.widget({ widget, side: 1 }).range(0)])
}

const blankHintPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(readonly view: EditorView) {
      this.decorations = blankHintDecos(view.state)
    }
    update(): void {
      // 每次都现算：便宜（不空就是 none），而且切语言（main.ts 那发 reconfigure）时字跟着换
      this.decorations = blankHintDecos(this.view.state)
    }
  },
  { decorations: (p) => p.decorations }
)

const ON: Extension = [
  blankHintPlugin,
  // 读屏：空的时候念这一句（aria-hidden 的那块它看不见）
  EditorView.contentAttributes.of((view) =>
    blankHintShown(view.state) ? { 'aria-placeholder': t('hint.blankSlash') } : null
  )
]
const OFF: Extension = []

/**
 * 空白文档提示这一整套。`on` = 偏好里的「操作提示」；关着就是空扩展。
 * 挂在 `setup.ts` 的 `hintConf` 里，开关 = 一次 reconfigure（与拼写检查同一套）。
 * 回的是两个常量：main.ts 拿 `hintConf.get(state) === blankHint(on)` 判断「已经是这样了」，
 * 拖字号滑杆时那一串 `onApply` 就不必每一下都 reconfigure 一次
 */
export function blankHint(on: boolean): Extension {
  return on ? ON : OFF
}
