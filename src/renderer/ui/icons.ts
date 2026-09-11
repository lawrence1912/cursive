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

type IconName = 'chevron' | 'dots' | 'panel-left' | 'panel-right' | 'close' | 'warn'

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
    '<circle cx="8" cy="11.6" r="0.7" fill="currentColor" stroke="none"/>'
}

export function icon(name: IconName): string {
  return (
    '<svg class="ic" viewBox="0 0 16 16" width="16" height="16" fill="none" ' +
    'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
    `stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`
  )
}
