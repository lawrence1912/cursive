import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'

/**
 * lezer-markdown 把 `**` `#` `>` 这类语法标记统一标成 processingInstruction。
 * M0 先把它们调淡；M1 会用装饰器把它们真正藏起来，这里的类名就是那时的挂载点。
 */
export const markdownHighlight = HighlightStyle.define([
  // 标题字号交给 live-preview 的行级类（.cm-lp-h1…），
  // 这样源代码模式关掉插件后就是纯文本，符合预期
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, class: 'cm-md-em' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--muted)' },
  { tag: t.url, color: 'var(--muted)' },
  { tag: t.processingInstruction, class: 'cm-md-mark' },
  { tag: t.contentSeparator, color: 'var(--mark-reveal)' },

  // ---- 代码块里的嵌套语言 ----
  // 围栏语言由 `codeLanguages: resolveCodeLang`（markdown-lang.ts，language-data 按需
  // 动态加载 + 后缀兜底）挑解析器，这里只负责「拿到 tag 之后涂什么色」。
  // 两条原则，都是实测出来的，别凭直觉改：
  //
  // ① 颜色一律走 CSS 变量。写死 hex 的那版只对浅色成立 —— 深绿 #2c8f5a 落在暗色
  //    --code-bg #262a30 上几乎看不见。新增 token 要按 base.css 的规矩改三处
  //    （:root + 媒体查询 + [data-theme="dark"]）。
  // ② tag 列表按「真语言真的发什么 tag」配：yaml/json 的键是 propertyName，
  //    css 的属性名也是 propertyName、选择器是 className、`red` 是 atom，
  //    diff 的增删行是 inserted/deleted，bash 的 `-la` 这类参数是 propertyName。
  //    老版本只有 keyword/string/number/comment/function/typeName 六条，
  //    结果最常写的 bash / yaml / json / diff / css 五种块**整块没有颜色**
  //    （test/highlight.test.ts 就是守这个的）。
  // labelName 故意不涂：它在 markdown 层是围栏行的 ```ts。那一行平时整条换成了语言条
  // （decorate.ts 的 decorateFence），只有光标落上去才回显源码，回显那一下要压到最轻
  // （.cm-lp-code-open），涂了就跟代码抢注意力。
  {
    tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.self],
    color: 'var(--hl-keyword)'
  },
  { tag: [t.string, t.special(t.string), t.regexp, t.escape, t.character], color: 'var(--hl-string)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.literal], color: 'var(--hl-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--muted)', fontStyle: 'italic' },
  {
    tag: [t.function(t.variableName), t.definition(t.variableName), t.function(t.propertyName), t.macroName],
    color: 'var(--hl-func)'
  },
  { tag: [t.typeName, t.className, t.namespace, t.tagName, t.standard(t.name)], color: 'var(--hl-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--hl-prop)' },
  { tag: [t.operator, t.derefOperator, t.compareOperator, t.logicOperator, t.arithmeticOperator], color: 'var(--muted)' },
  { tag: [t.meta, t.annotation, t.documentMeta], color: 'var(--muted)' },
  { tag: t.inserted, color: 'var(--hl-ins)' },
  { tag: [t.deleted, t.invalid], color: 'var(--hl-del)' }
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
  '&.cursive-source .cm-md-mark': { color: 'var(--accent)', opacity: '1' },
  // 查找面板不再占版面：CM 默认把 .cm-panels 钉成通栏 sticky 条（贴顶或贴底），
  // 这里改成绝对定位 + 靠右收窄，面板于是**浮在编辑区右上角** —— 正文不被顶走，
  // 底部那条悬浮格式栏也不用再量着查找条的高度往上让。
  // 容器自己不画任何东西，长相全在 base.css 的 .cs-panel
  // （`.cm-editor` 本来就是 position:relative，绝对定位有参照）
  //
  // **`height: 0` 是必需的，不是随手写的**：CM 的面板插件会按容器的实测高度
  // 报一份 `scrollMargins`（贴顶面板天然会挡住上面几行，滚动要让开它）。
  // 而这块面板是浮在右上角的一张小卡、压根不盖正文那一栏，那份边距却是**通栏**的 ——
  // 它会连打字机模式的「光标行停在 42%」一起顶下去（实测偏 96px ≈ 12%，
  // E2E 的 writingProbe.ratio 当场变成 0.55）。容器高度归零、内容 overflow 出来，
  // 报上去的边距就是 0，面板照样看得见点得着。
  '.cm-panels': {
    position: 'absolute',
    left: 'auto',
    right: '0',
    width: 'max-content',
    maxWidth: '100%',
    height: '0',
    overflow: 'visible',
    backgroundColor: 'transparent',
    color: 'var(--fg)',
    border: 'none',
    fontFamily: 'var(--sans)'
  },
  // 命中底色也归主题 token 管：写死的那版黄色落在暗色纸上会糊成一团
  '.cm-searchMatch': { backgroundColor: 'var(--match)' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--match-on)' }
})

export const cursiveTheme: Extension = [editorTheme, syntaxHighlighting(markdownHighlight)]
