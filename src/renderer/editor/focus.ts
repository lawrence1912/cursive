import type { EditorView } from '@codemirror/view'

/**
 * 做一件事，但**不许视口跟着滚**。
 *
 * 起因是 WebKit 的一条脾气：`focus()` 会把当前 DOM 选区滚进视口，而编辑器失焦
 * 期间 CM 压根不写 DOM 选区 —— 留在那儿的是上一次焦点离开时的旧位置。于是
 * 「焦点在查找框/语言选择器里 → 点个命令」会让画面啪地跳到半篇之外
 * （E2E 实测 scrollTop 228 → 1063）。CM 自己已经用了 `preventScroll`，
 * 挡不住这一路，只能量一把再放回去。
 *
 * 只给**不该移动视口**的动作用。大纲跳转、查找下一个那几处是故意要滚的
 * （它们自带 scrollIntoView 效应），别顺手套上这个。
 */
export function keepScroll(view: EditorView, run: () => void): void {
  const top = view.scrollDOM.scrollTop
  run()
  if (view.scrollDOM.scrollTop !== top) view.scrollDOM.scrollTop = top
}

/** 把焦点还给编辑器，视口留在原地 */
export function focusKeepScroll(view: EditorView): void {
  keepScroll(view, () => view.focus())
}
