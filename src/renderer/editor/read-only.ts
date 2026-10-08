import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/**
 * 第八节 5：只读阅读模式（**按标签**）。
 *
 * 状态就是 CM 自己的 `EditorState.readOnly`，装在每个标签各自的 state 里 —— 切走时跟着
 * 冻结、切回来原样还在，不另起一份「哪些标签只读」的表（同源代码模式那条：态在 state 里）。
 *
 * 挡编辑分三层，从里到外：
 * 1. **CM 自带的那一层**：DOM 输入、粘贴、拖放、剪切，以及它自己的编辑命令（撤销、
 *    缩进、删行…）都会自查 `state.readOnly`。一次声明，整套白拿；
 * 2. **一道 changeFilter 兜底**：我们自己的格式命令、表格格子、任务勾选、图片缩放写回、
 *    大纲搬节 / 升降级、补全、LaTeX 格式化、版本回滚……全是程序化 dispatch，CM 不拦。
 *    与其在二十个入口各写一句 if（漏一个就是「只读文档被改了」，而入口还会继续长），
 *    不如在事务这一层统一挡住。各入口自己的判断照样留着 —— 那是为了**不起手**
 *    （表格不进编辑态、图片不拖出虚影），这一层是为了**万一起了手也落不进文档**；
 * 3. 编辑器根节点上一个 `cm-ro` 类：把手、表格工具栏、查找面板里替换那一行这些
 *    「编辑才用的东西」靠 CSS 收起来（`themes/live-preview.css`）。
 *
 * **外部重载不受影响**：磁盘那份变了、干净的标签静默跟上（main.ts 的 `adoptDisk`）换的是
 * 整份 state，不经过这道闸，只读这一位由它原样带过去 —— 只读管的是「我别手滑改了它」，
 * 不是「别人改了我也假装没看见」。
 */
export const readOnlyConf = new Compartment()

/**
 * 被挡下的那一下要说一声（main.ts 接：状态栏一句 + 一颗「退出只读」）。
 * 不说的话，「按了没反应」与「坏了」长得一模一样。
 */
export const readOnlyHost: { blocked: (() => void) | null } = { blocked: null }

const guard = EditorState.changeFilter.of((tr) => {
  if (!tr.docChanged) return true
  readOnlyHost.blocked?.()
  return false
})

/**
 * 打字在 DOM 那一步就挡住：CM 自己也会忽略只读时的 DOM 变更，但那是先让浏览器改了
 * DOM 再撤回来，字会闪一下。`beforeinput` 里 `preventDefault` 就一个字都不进。
 * 组字（`insertCompositionText`）在 WebKit 里取消不了，只报一声，剩下的交给 CM 撤回。
 */
const typing = EditorView.domEventHandlers({
  beforeinput(e) {
    if (!/^(insert|delete|history|format)/.test(e.inputType)) return false
    readOnlyHost.blocked?.()
    if (e.inputType === 'insertCompositionText') return false
    e.preventDefault()
    return true
  }
})

export function readOnlyExt(on: boolean): Extension {
  return on
    ? [EditorState.readOnly.of(true), guard, typing, EditorView.editorAttributes.of({ class: 'cm-ro' })]
    : []
}
