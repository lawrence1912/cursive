/**
 * Chrome 图标：内联 SVG，15px，1.5px 描边，颜色跟随 currentColor。
 *
 * 为什么不引图标库：页面 CSP 是 `default-src 'self'`，CDN 根本拉不到；
 * 而原先那套 » « ⋯ × ▸ 是拿 Unicode 字符当图标 —— 不同字体里的字形、
 * 基线、视觉大小都不一样，横竖对不齐，读屏也拿不到稳定的名字。
 *
 * SVG 一律 aria-hidden；**可交互的宿主元素必须自己带 aria-label**
 * （title 只在鼠标悬停时有效，读屏不保证读得到）。
 */

export type IconName =
  | 'chevron'
  | 'chevron-down'
  | 'chevron-up'
  | 'check'
  | 'dots'
  | 'panel-left'
  | 'panel-right'
  | 'close'
  | 'warn'
  // 格式栏（P2-8）：同一套 16 网格 / 1.5 描边，别为它另起一套视觉
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'code'
  | 'link'
  | 'quote'
  | 'ulist'
  | 'olist'
  | 'task'
  | 'code-block'
  | 'pilcrow'
  // 告示块（P1-6）：13 种类型映射到这 9 个图标 + 复用 warn / quote / task
  | 'info'
  | 'summary'
  | 'flame'
  | 'check-circle'
  | 'help'
  | 'x-circle'
  | 'zap'
  | 'bug'
  | 'list'
  // 文件树工具栏（P3-1 收尾 / P3-2）与标题栏右块
  | 'file-plus'
  | 'folder-plus'
  | 'folder-open'
  | 'search'
  | 'arrow-left'
  | 'pencil'
  | 'reveal'
  | 'moon'
  | 'sun'
  | 'column'
  // 命令表补齐（P2-9）：行内 4 个 + 插入下拉 6 个（告示块复用 info，目录复用 list）
  | 'highlight'
  | 'sup'
  | 'sub'
  | 'sigma'
  | 'sigma-box'
  | 'table'
  | 'image'
  | 'hr'
  | 'flow'
  | 'footnote'
  | 'plus'
  | 'collapse'

const PATHS: Record<IconName, string> = {
  chevron: '<path d="M6.25 3.5 10.75 8l-4.5 4.5"/>',
  dots:
    '<circle cx="3.6" cy="8" r="1.15" fill="currentColor" stroke="none"/>' +
    '<circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none"/>' +
    '<circle cx="12.4" cy="8" r="1.15" fill="currentColor" stroke="none"/>',
  'panel-left': '<rect x="2" y="3" width="12" height="10" rx="2.2"/><path d="M6.4 3v10"/>',
  'panel-right': '<rect x="2" y="3" width="12" height="10" rx="2.2"/><path d="M9.6 3v10"/>',
  close: '<path d="m4.6 4.6 6.8 6.8M11.4 4.6l-6.8 6.8"/>',
  warn:
    '<path d="M8 2.6 14.6 13.4H1.4z"/><path d="M8 6.6v3"/>' +
    '<circle cx="8" cy="11.6" r="0.7" fill="currentColor" stroke="none"/>',
  'chevron-down': '<path d="M3.5 6.25 8 10.75l4.5-4.5"/>',
  'chevron-up': '<path d="M3.5 9.75 8 5.25l4.5 4.5"/>',
  check: '<path d="m3.4 8.4 3 3 6.2-6.8"/>',
  bold: '<path d="M5.2 2.9h3.5a2.55 2.55 0 0 1 0 5.1H5.2zM5.2 8h4.1a2.65 2.65 0 0 1 0 5.3H5.2z"/>',
  italic: '<path d="M12.4 3H8.9M9.1 13H5.6M10.3 3 7.7 13"/>',
  underline: '<path d="M4.6 2.8v4.6a3.4 3.4 0 0 0 6.8 0V2.8M3.6 13.5h8.8"/>',
  strike:
    '<path d="M11.1 4.3c-.4-1-1.5-1.6-3-1.6-1.8 0-3 .8-3 1.9 0 .9.6 1.5 1.7 1.9"/>' +
    '<path d="M11 10.2c.2 1.4-1 2.4-2.9 2.4-1.8 0-3-.8-3.2-2"/><path d="M2.4 8h11.2"/>',
  code: '<path d="M6.2 4.4 2.8 8l3.4 3.6M9.8 4.4 13.2 8l-3.4 3.6"/>',
  link:
    '<path d="M6.8 9.2a2.6 2.6 0 0 0 3.8.2l1.9-1.9a2.65 2.65 0 0 0-3.7-3.8l-1 1"/>' +
    '<path d="M9.2 6.8a2.6 2.6 0 0 0-3.8-.2L3.5 8.5a2.65 2.65 0 0 0 3.7 3.8l1-1"/>',
  quote: '<path d="M3 3.6v8.8M6.2 5.2h7M6.2 8h7M6.2 10.8h4.6"/>',
  ulist:
    '<path d="M6 4.2h7.4M6 8h7.4M6 11.8h7.4"/>' +
    '<circle cx="3.1" cy="4.2" r="1" fill="currentColor" stroke="none"/>' +
    '<circle cx="3.1" cy="8" r="1" fill="currentColor" stroke="none"/>' +
    '<circle cx="3.1" cy="11.8" r="1" fill="currentColor" stroke="none"/>',
  olist:
    '<path d="M6.2 4.2h7.2M6.2 8h7.2M6.2 11.8h7.2"/>' +
    '<path d="m2 3.5.9-.7v2.9" stroke-width="1.2"/>' +
    '<path d="M2 7.1c0-.4.4-.7.9-.7s.9.3.9.7c0 .8-1.8 1.2-1.8 2.1h1.9" stroke-width="1.2"/>',
  task:
    '<rect x="2.4" y="2.6" width="11.2" height="11.2" rx="2.6"/>' +
    '<path d="m5.2 8.2 2 2 3.8-4.2"/>',
  'code-block':
    '<rect x="1.8" y="3.2" width="12.4" height="9.6" rx="2.2"/>' +
    '<path d="M6.5 6.7 4.9 8.3l1.6 1.6M9.5 6.7l1.6 1.6-1.6 1.6"/>',
  pilcrow: '<path d="M12.4 3H8.6a2.9 2.9 0 0 0 0 5.8h1M9.6 3v10M12.4 3v10"/>',
  info:
    '<circle cx="8" cy="8" r="6.2"/><path d="M8 7.5v3.6"/>' +
    '<circle cx="8" cy="5.1" r="0.75" fill="currentColor" stroke="none"/>',
  summary: '<path d="M4 2.6h4.8L12 5.8v7.6H4z"/><path d="M8.6 2.7v3.2h3.2M6.2 8.6h3.6M6.2 10.9h2.4"/>',
  flame:
    '<path d="M8 2.2c3 2.6 4.1 4.5 4.1 6.4a4.1 4.1 0 0 1-8.2 0c0-1.2.5-2.3 1.5-3.3' +
    '.1 1.1.6 1.8 1.4 2.1C6.7 5.6 7.1 3.9 8 2.2z"/>',
  'check-circle': '<circle cx="8" cy="8" r="6.2"/><path d="m5.3 8.2 1.9 1.9 3.5-3.9"/>',
  help:
    '<circle cx="8" cy="8" r="6.2"/>' +
    '<path d="M6.3 6.3a1.75 1.75 0 1 1 2.4 1.65c-.45.2-.7.6-.7 1.05v.35"/>' +
    '<circle cx="8" cy="11.4" r="0.75" fill="currentColor" stroke="none"/>',
  'x-circle': '<circle cx="8" cy="8" r="6.2"/><path d="m5.9 5.9 4.2 4.2M10.1 5.9l-4.2 4.2"/>',
  zap: '<path d="M8.9 1.9 3.7 8.9h3.6l-.2 5.2L12.3 7H8.7z"/>',
  bug:
    '<rect x="5" y="5.4" width="6" height="7.4" rx="3"/>' +
    '<path d="M5 8.4H2.7M11 8.4h2.3M5.5 5.9 4.2 4.5M10.5 5.9l1.3-1.4M5.4 11.4 4 12.6M10.6 11.4l1.4 1.2"/>',
  list: '<path d="M6 4.3h7.4M6 8h7.4M6 11.7h7.4M2.7 4.3h.01M2.7 8h.01M2.7 11.7h.01"/>',
  'file-plus':
    '<path d="M11.2 8.1V6.2L8.2 3.2H3.7v9.6h4"/><path d="M8.1 3.3v3h3"/>' +
    '<path d="M11.6 9.5v4.1M9.6 11.6h4"/>',
  'folder-plus':
    '<path d="M2.8 13.4h9.4a.9.9 0 0 0 .9-.9V5.8a.9.9 0 0 0-.9-.9H7.3L5.9 3.2H2.8' +
    'a.9.9 0 0 0-.9.9v8.4a.9.9 0 0 0 .9.9z"/><path d="M7.5 7.2v4.1M5.5 9.3h4"/>',
  'folder-open':
    '<path d="M1.9 12.5V4.1a.9.9 0 0 1 .9-.9h3.1l1.4 1.7h4.9a.9.9 0 0 1 .9.9v1.5"/>' +
    '<path d="M2.7 13.4h9.5l1.7-4.6a.7.7 0 0 0-.7-1H4.6a.7.7 0 0 0-.7.5z"/>',
  search: '<circle cx="7.1" cy="7.1" r="4.4"/><path d="m10.5 10.5 2.9 2.9"/>',
  'arrow-left': '<path d="M13.2 8H3.4M7.6 3.8 3.4 8l4.2 4.2"/>',
  pencil:
    '<path d="M11.2 2.6a1.7 1.7 0 0 1 2.4 2.4L5.4 13.2l-3.2.8.8-3.2z"/>' +
    '<path d="m10.1 3.7 2.4 2.4"/>',
  reveal:
    '<path d="M9.4 2.6h4v4M13.4 2.6 7.7 8.3"/>' +
    '<path d="M11.5 9.6v3a.9.9 0 0 1-.9.9h-7a.9.9 0 0 1-.9-.9v-7a.9.9 0 0 1 .9-.9h3"/>',
  moon: '<path d="M13.3 9.7A5.7 5.7 0 0 1 6.1 2.4a5.9 5.9 0 1 0 7.2 7.3z"/>',
  sun:
    '<circle cx="8" cy="8" r="3.1"/>' +
    '<path d="M8 1.5v1.5M8 13v1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1' +
    'M1.5 8H3M13 8h1.5M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/>',
  // ---- P2-9 命令表补齐 ----
  // 高亮：斜着的马克笔 + 笔下那条基线
  highlight: '<path d="M9.8 2.7 13.3 6.2l-6.1 6.1H3.7V8.8z"/><path d="M2.6 14.6h10.8"/>',
  // 上标 / 下标：一个 x 加一个 2，2 的高低就是全部区别
  sup: '<path d="M2.6 5.1 7.7 11.9M7.7 5.1 2.6 11.9"/>' +
    '<path d="M10.5 5.2a1.5 1.5 0 1 1 2.7 1L10.5 9h3"/>',
  sub: '<path d="M2.6 4.1 7.7 10.9M7.7 4.1 2.6 10.9"/>' +
    '<path d="M10.5 9.2a1.5 1.5 0 1 1 2.7 1L10.5 13h3"/>',
  // 公式：一个 Σ；块级那个再套个框（下拉里与行内那颗并排出现，得能一眼分开）
  sigma: '<path d="M11.9 3.4H4.3l4.1 4.6-4.1 4.6h7.6"/>',
  'sigma-box':
    '<rect x="2" y="2.6" width="12" height="10.8" rx="2.2"/>' +
    '<path d="M10.4 5.7H5.9l2.4 2.7-2.4 2.7h4.5"/>',
  table: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M2 6.4h12M6 6.4V13M10 6.4V13"/>',
  image:
    '<rect x="2" y="3" width="12" height="10" rx="2.2"/><circle cx="5.9" cy="6.6" r="1.1"/>' +
    '<path d="m2.4 11.5 3.3-3 3 2.6 2-1.7 2.9 2.6"/>',
  // 分隔线：中间一条通长的线，上下各一段短的（= 被隔开的两段正文）
  hr: '<path d="M2.2 8h11.6"/><path d="M4.4 4.2h7.2M4.4 11.8h7.2"/>',
  // 流程图（mermaid）：一个节点分出两个
  flow:
    '<rect x="5.6" y="1.9" width="4.8" height="3.4" rx="1"/>' +
    '<rect x="1.6" y="10.7" width="4.4" height="3.4" rx="1"/>' +
    '<rect x="10" y="10.7" width="4.4" height="3.4" rx="1"/>' +
    '<path d="M8 5.3v2.4M3.8 10.7V7.7h8.4v3"/>',
  // 脚注：三行正文 + 右上角一个抬高的星号
  footnote:
    '<path d="M2.4 4.2h6.4M2.4 7.6h6.4M2.4 11h4.2"/>' +
    '<path d="M11.6 2.4v3.8M9.9 3.3l3.4 2M13.3 3.3l-3.4 2"/>',
  plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
  // 完全折叠：上下两个箭头一起指向中间那条线（= 把展开的层级压回去）
  collapse:
    '<path d="M2.4 8h11.2"/><path d="M5.4 4 8 6.6 10.6 4"/><path d="M5.4 12 8 9.4l2.6 2.6"/>',
  // 栏宽：两条栏杆 + 中间的双向箭头
  column:
    '<path d="M2.6 2.9v10.2M13.4 2.9v10.2"/>' +
    '<path d="M5.3 8h5.4M5.3 8 7 6.3M5.3 8 7 9.7M10.7 8 9 6.3M10.7 8 9 9.7"/>'
}

export function icon(name: IconName): string {
  return (
    '<svg class="ic" viewBox="0 0 16 16" width="16" height="16" fill="none" ' +
    'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
    `stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`
  )
}
