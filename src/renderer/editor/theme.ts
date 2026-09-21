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

/**
 * **`--zoom` 只出现在这两处**（0.4.1，`ui/zoom.ts`）：正文字号与正文栏宽。
 * ⌘+ / ⌘− / 捏合缩的就是这两个数 —— 侧栏、标签、状态栏、格式栏一律不乘它，
 * 「放大」在这个应用里的意思是「字大一点」，不是「整个界面变粗」。
 * 栏宽也要乘：不乘的话一行能放下的字数会随缩放缩水（版心是按 38 字定的，
 * 见 base.css 的 `--column`），而那是排版决定，不该被缩放顺手改掉。
 */
const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'calc(var(--body-size) * var(--zoom))',
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
    maxWidth: 'calc(var(--column) * var(--zoom))',
    margin: '0 auto',
    padding: '48px var(--lp-gutter) 0',
    caretColor: 'var(--fg)'
  },
  // 落点提示（`editor/navigation.ts`）：跳过去的那一行先亮一下，再淡出。
  // **亮是瞬时的、灭才有过渡** —— 过渡挂在 `.cm-line` 上、而亮着的那一份自己
  // `transition: none`：加类时按「加完之后」的样式算，也就是不过渡；撤类时按
  // 撤完之后的样式算，于是淡出。系统开了「减弱动态效果」时 base.css 会把它压成瞬时。
  '.cm-line': { padding: '0', transition: 'background-color 480ms ease' },
  '.cm-line.cm-jump-flash': { backgroundColor: 'var(--accent-wash)', transition: 'none' },
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
  '.cm-searchMatch-selected': { backgroundColor: 'var(--match-on)' },

  // ---- 0.2.0 自动补全面板 ----
  // CM 自带的 baseTheme 是给代码编辑器配的（等宽字、亮蓝实心选中条），落在这张纸上很突兀。
  // 这里**照抄 base.css 的 `.ctx-menu`**（右键菜单 / 语言选择器同一身皮）：
  // 同样的毛玻璃、同样的圆角与投影、同样的 `--accent-wash` 悬停底色。
  // 浮层就该长一个样 —— 各写一套的话迟早在某次调色里走样
  '.cm-tooltip.cm-tooltip-autocomplete': {
    padding: '5px',
    border: '1px solid var(--border)',
    borderRadius: '10px',
    background: 'color-mix(in srgb, var(--surface) 94%, transparent)',
    backdropFilter: 'saturate(1.6) blur(14px)',
    WebkitBackdropFilter: 'saturate(1.6) blur(14px)',
    boxShadow: '0 10px 30px rgb(0 0 0 / 18%), 0 1px 3px rgb(0 0 0 / 8%)',
    color: 'var(--fg)',
    // chrome 的字体跟界面走，不跟正文走（正文可能是衬线、可能被调到 24px）
    fontFamily: 'var(--sans)',
    fontSize: 'var(--chrome-size)'
  },
  // 高度按**整行**给（28 × 10 行）。CM 默认的 10em 在这张网格上是 7.4 行 ——
  // 半行露在下沿看着像渲染坏了，而十行正好够扫完斜杠命令的第一屏
  '.cm-tooltip-autocomplete > ul': { maxHeight: '280px', fontFamily: 'var(--sans)' },
  // 行的度量**照抄格式栏插入下拉那一份 `.fb-kind`**（28 高 / 0 8 内边距 / 7 圆角 /
  // 6 间距 / 16 图标列）：两处列的是同一批块，长相不该有第二种。
  // `alignItems` 不能写回 `lineHeight` —— 行里现在有 SVG 图标，文字基线对不住它
  '.cm-tooltip-autocomplete > ul > li': {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    height: '28px',
    padding: '0 8px',
    borderRadius: '7px'
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    background: 'var(--accent-wash)',
    color: 'var(--fg)'
  },
  // 图标列：`.fb-item-ic` 的同款（16 宽、平时压淡、当前那一行提到正文色）
  '.cm-slash-ic': {
    display: 'flex',
    alignItems: 'center',
    flex: 'none',
    width: '16px',
    color: 'var(--muted)'
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-slash-ic': { color: 'var(--fg)' },
  // 名字占满中间，长了就省略号。**必须给 `minWidth: 0`**：flex 子项的默认
  // `min-width: auto` 会顶着内容撑开，`text-overflow` 于是一辈子不生效
  // （标签栏那条 `.tab-title` 踩过同一个坑），而 CM 画在 li 上的那份省略号
  // 对 flex 布局不起作用
  '.cm-completionLabel': {
    flex: '1',
    minWidth: '0',
    overflow: 'hidden',
    textOverflow: 'ellipsis'
  },
  // 右边那一列是辅助信息（斜杠关键词 / emoji 字符 / 语言写法 / 脚注正文）。
  // 度量**照抄命令面板的 `.pl-hint`**：12px、`--mark-idle`、最多占 45% ——
  // 「名字在左、提示在右」这件事那边已经定过一次调子了。
  // 45% 这一条是给脚注源兜底的：它的 detail 是定义正文（最长 40 字），
  // 不封顶的话面板会被一条脚注拉到 700px
  '.cm-completionDetail': {
    flex: 'none',
    maxWidth: '45%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    marginLeft: 'auto',
    paddingLeft: '12px',
    fontStyle: 'normal',
    fontSize: 'var(--chrome-label)',
    // 尺寸抄 `.pl-hint`，颜色**故意不抄**（那边是 `--mark-idle`，装饰档 2.6:1）：
    // 命令面板右边那一列是「你早就会按的快捷键」，而这里是**你要照着打的那个词**，
    // 第一次用的人正是靠它学会 `/callout` 怎么拼。`--muted` 是 5.1:1，够读
    color: 'var(--muted)'
  },
  // 命中的字：加粗 + accent，与命令面板的 `.pl-label b` 同一套
  '.cm-completionMatchedText': {
    textDecoration: 'none',
    fontWeight: '700',
    color: 'var(--accent)'
  }
})

export const cursiveTheme: Extension = [editorTheme, syntaxHighlighting(markdownHighlight)]
