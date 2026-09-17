import { loadKatex, loadMermaid } from './live-preview/widgets'

/**
 * **按需模块的预热**（0.2.x）。
 *
 * katex 与 mermaid 是动态 import 的（P4-6② 砍首屏 JS：261 KB 的 katex 不进主 chunk），
 * 代价是「模块到手之前公式先显示成 `$$…$$` 源码、到手再换掉」（`widgets.ts` 的
 * `fillMath`）—— 打开一份公式文档，第一眼看到的是源码，闪一下才变成公式。
 * 预热买的就是这一下：滚到第一个公式之前它已经在手里。
 *
 * 分寸在于**只热这份文档用得上的**：没有公式的文档一个字节都不多背，P4-6② 的成果
 * 原样保留。判据是下面两个「像不像」——它们不是解析器，也不必是：
 * 认错了只多拖一个 chunk（在空闲里），漏认了只回到没预热的样子。
 */

/**
 * 像不像有公式：要的是一对**闭合**的定界符。
 * `$5` 这种价格写法配不上对 —— 否则每份带价钱的文档都要白拖 261 KB。
 */
const MATH_HINT = /\$\$|\$[^\s$][^$\n]*\$/

export function needsKatex(text: string): boolean {
  return MATH_HINT.test(text)
}

/** mermaid 只认围栏上的语言标记，写在行首（缩进的围栏同样算） */
export function needsMermaid(text: string): boolean {
  return /(^|\n)[ \t]*(```|~~~)[ \t]*mermaid\b/i.test(text)
}

/**
 * 排在 `setTimeout` 里而不是 `requestAnimationFrame` 里：窗口被别的窗口盖住时 rAF 会被
 * 系统降频、甚至一次都不回调（P3-8 打字机滚动与 P4-2 离屏打印都踩过同一个坑），
 * 而预热恰恰是「没人看着的时候做」最合适。延迟是为了不和启动那一串抢线程。
 *
 * 两个 loader 自己带记忆（`??=`），重复调用无害，所以切标签不必去重。
 */
export const WARM_DELAY = 400

export function warmLazyModules(text: string, delay = WARM_DELAY): number {
  return window.setTimeout(() => {
    if (needsMermaid(text)) void loadMermaid()
    if (needsKatex(text)) void loadKatex()
  }, delay)
}
