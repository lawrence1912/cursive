import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'

/**
 * lezer-markdown 把 `**` `#` `>` 这类语法标记统一标成 processingInstruction。
 * M0 先把它们调淡；M1 会用装饰器把它们真正藏起来，这里的类名就是那时的挂载点。
 */
const markdownHighlight = HighlightStyle.define([
  // 标题字号交给 live-preview 的行级类（.cm-lp-h1…），
  // 这样源代码模式关掉插件后就是纯文本，符合预期
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, class: 'cm-md-em' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--muted)' },
  { tag: t.url, color: 'var(--muted)' },
  { tag: t.processingInstruction, class: 'cm-md-mark' },
  { tag: t.contentSeparator, color: 'var(--mark-reveal)' },
  // 代码块内的嵌套语言
  { tag: t.keyword, color: '#a353b8' },
  { tag: [t.string, t.special(t.string)], color: '#2c8f5a' },
  { tag: [t.number, t.bool, t.null], color: '#b4622a' },
  { tag: t.comment, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.definition(t.variableName)], color: '#2f7bd4' },
  { tag: t.typeName, color: '#b4622a' }
])

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--body-size)',
    color: 'var(--fg)',
    backgroundColor: 'var(--bg)'
  },
  '.cm-scroller': {
    fontFamily: 'var(--body-font)',
    lineHeight: 'var(--body-leading)',
    overflowY: 'auto',
    // 底部留白，让最后一行也能滚到舒服的位置（打字机模式的地基）
    paddingBottom: '40vh'
  },
  '.cm-content': {
    maxWidth: 'var(--column)',
    margin: '0 auto',
    padding: '48px 32px 0',
    caretColor: 'var(--fg)'
  },
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--sel)'
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-selectionMatch': { backgroundColor: 'transparent', boxShadow: 'inset 0 -1px 0 var(--mark-idle)' },
  // 语法标记：源码模式下恢复正常对比度
  '.cm-md-mark': { color: 'var(--mark-reveal)' },
  '&.typmd-source .cm-md-mark': { color: 'var(--accent)', opacity: '1' },
  '.cm-panels': {
    backgroundColor: 'var(--surface)',
    color: 'var(--fg)',
    borderTop: '1px solid var(--border)',
    fontFamily: 'var(--sans)'
  },
  '.cm-panel input, .cm-panel button': { fontFamily: 'var(--sans)', fontSize: '12px' },
  '.cm-searchMatch': { backgroundColor: 'rgba(255, 200, 0, 0.35)' },
  '.cm-searchMatch-selected': { backgroundColor: 'rgba(255, 160, 0, 0.6)' }
})

export const typmdTheme: Extension = [editorTheme, syntaxHighlighting(markdownHighlight)]
