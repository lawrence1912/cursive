import type { EditorState } from '@codemirror/state'
import { loadKatex, loadMermaid, renderMermaid } from '../editor/live-preview/widgets'
import { collectCodeLangs, escapeHtml, loadCodeLangs, renderBody, type ExportOpts } from './render'
import { EXPORT_CSS } from './style'

export { collectCodeLangs, escapeHtml, renderBody, type ExportOpts } from './render'
export { EXPORT_CSS } from './style'

/**
 * P4-1 导出 HTML —— 单文件组装。
 *
 * 正文渲染在 `render.ts`（纯函数，可单测）；这一层只干两件**必须有浏览器**的事：
 *   1. 先把文档里用到的代码语言加载完 —— `language-data` 是按需 import 的，
 *      不等它，代码块整块没有颜色；
 *   2. mermaid 渲染成**静态 SVG** 灌回占位处 —— 导出物里不该留运行时依赖
 *      （页面 CSP 拉不到 CDN 是一回事，更要紧的是别人打开时未必联网）。
 *
 * 图片只在 `<img data-abs>` 里写清楚去哪儿取，**字节不过 IPC 桥**（判断 3）：
 * 壳侧保存面板上那颗「嵌入图片」勾上时，由壳读盘换成 data: URI。
 */

let exportSeq = 0

export interface HtmlExport {
  html: string
  /** 建议的文件名（不含目录），壳侧保存面板拿它当默认值 */
  title: string
}

export async function exportHtmlDocument(
  state: EditorState,
  opts: ExportOpts = {}
): Promise<HtmlExport> {
  // katex 与语言包都是按需加载的，`renderBody` 是同步的一整棵递归 —— 两样都得先到手，
  // 否则公式退化成 `<code>`、代码块整块没有颜色
  await Promise.all([loadCodeLangs(collectCodeLangs(state)), loadKatex()])
  const body = renderBody(state, opts)
  let html = body.html
  for (const block of body.mermaid) {
    const svg = await renderMermaidSvg(block.src)
    // 渲染失败就把占位（= 源码）留在原地，和编辑器里 mermaid 出错时一致。
    // 替换值走函数形式：SVG 里但凡出现 `$&` `$'` 这类序列，字符串形式会把它们当成
    // 替换模式展开，图就当场碎掉
    if (svg) html = html.replace(block.placeholder, () => svg)
  }
  return { html: wrapDocument(html, body.title), title: body.title }
}

/** 一张图。失败返回 null —— 一张画不出来不该带走整份导出 */
async function renderMermaidSvg(src: string): Promise<string | null> {
  try {
    const mermaid = await loadMermaid()
    // 导出恒为浅色（见 style.ts 顶部）：图的配色是烘在 SVG 里的，
    // 跟着当前主题走的话，暗色下导出的图落在白纸上就是一团黑。
    // 和编辑器共用同一个 mermaid 实例不要紧 —— MermaidWidget 每次渲染前也会
    // 自己 initialize 一遍，配色不会被这里带偏
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' })
    await mermaid.parse(src)
    // 屏幕外渲染（见 renderMermaid）：导出时一份文档里的图是连着渲的，
    // 挂 body 上的话底部就是连闪好几下
    return await renderMermaid(mermaid, `cursive-export-${exportSeq++}`, src)
  } catch {
    return null
  }
}

/**
 * 外壳。样式**内联**、没有一个外部引用：导出的是一个文件，拷到哪儿都得是这个样子。
 */
export function wrapDocument(body: string, title: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Cursive">
<title>${escapeHtml(title)}</title>
<style>${EXPORT_CSS}</style>
</head>
<body>
<article class="cursive-doc">
${body}</article>
</body>
</html>
`
}
