/**
 * KaTeX 的懒加载落脚点（P4-6②）。
 *
 * 这个模块存在的唯一理由是**让 katex 只能被动态 import 够着**：JS（261 KB）与 CSS
 * 装在同一个模块里，谁 `import('./katex')` 谁就顺带把样式一起拉进来，Vite 会把两者
 * 切进同一个 chunk。首屏因此一个字节都不背 —— 没有公式的文档永远不会加载它。
 *
 * **别在任何静态 import 链上引用这个文件**（`editor/live-preview/widgets.ts` 的
 * `loadKatex()` 是唯一入口），否则 katex 会被拽回主 chunk，这一层就白做了。
 */
import 'katex/dist/katex.min.css'
import katex from 'katex'

export default katex
