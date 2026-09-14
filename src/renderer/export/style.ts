/**
 * 导出用样式表（P4-1）。
 *
 * 为什么不直接内联 `themes/*.css`：那两份是给 CodeMirror 的 DOM 写的
 * （`.cm-lp-*` 全挂在行元素和 widget 上），导出的是语义 HTML，一条也对不上。
 * 这里重写一份**同样长相**的：token 名字、字号梯子、卡片圆角、配色全部照抄
 * `themes/base.css` 与 `themes/live-preview.css`，改那两份记得回来看一眼。
 *
 * **只有浅色一套**，而且是钉死的：导出物会被丢进别人的浏览器、会被打印、
 * 会被 P4-2 的真分页 PDF 拿去当地基 —— 跟着阅读者的系统外观走的话，
 * 同一份文档在两台机器上会是两个样子（现在的 PDF 导出把浅色值钉死，同一个道理）。
 */
export const EXPORT_CSS = `
:root {
  color-scheme: light;
  --bg: #ffffff;
  --fg: #24292f;
  --muted: #6b7280;
  --mark-idle: #9aa3ae;
  --accent: #0969da;
  --border: #e6e8eb;
  /* 与 themes/base.css 同名同值：比 --border 更淡的一档，表格行间用它 */
  --divider: #ededf0;
  --code-bg: #f4f5f7;
  --surface: #fafbfc;
  --match: rgb(255 196 0 / 32%);
  --hl-keyword: #a353b8;
  --hl-string: #2c8f5a;
  --hl-number: #b4622a;
  --hl-func: #2f7bd4;
  --hl-type: #8a6d1f;
  --hl-prop: #1f7a86;
  --hl-ins: #2c8f5a;
  --hl-del: #c0392b;
  --cal-note: #3b7fd4;
  --cal-tip: #2f8f5b;
  --cal-warn: #b4622a;
  --cal-danger: #c0392b;
  --cal-example: #8a5cd6;
  --cal-quote: #6b7280;
  --serif: "Georgia", "Songti SC", "Noto Serif CJK SC", serif;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, "JetBrains Mono",
    "Sarasa Mono SC", monospace;
}

html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--serif);
  font-size: 16px;
  line-height: 1.75;
}
.cursive-doc {
  box-sizing: border-box;
  max-width: 42rem;
  margin: 0 auto;
  padding: 48px 32px 30vh;
  overflow-wrap: break-word;
}

/* ---------- 标题：上疏下密，标题归属它下面的内容 ---------- */
.cursive-doc h1, .cursive-doc h2, .cursive-doc h3,
.cursive-doc h4, .cursive-doc h5, .cursive-doc h6 {
  font-weight: 700;
  line-height: 1.35;
  margin: 1.2em 0 0;
  scroll-margin-top: 12px;
}
.cursive-doc h1 { font-size: 2em; }
.cursive-doc h2 { font-size: 1.5em; }
.cursive-doc h3 { font-size: 1.25em; }
.cursive-doc h4 { font-size: 1.08em; }
.cursive-doc h5 { font-size: 1em; }
.cursive-doc h6 { font-size: 0.94em; color: var(--muted); }
.cursive-doc p { margin: 0.85em 0; }

/* 中文强调用着重号，不用斜体：PingFang / Songti 都没有真斜体字形，
   font-style: italic 得到的是浏览器机械倾斜，在中文排印里是错的 */
.cursive-doc em {
  font-style: normal;
  -webkit-text-emphasis: dot currentColor;
  text-emphasis: dot currentColor;
  -webkit-text-emphasis-position: under right;
  text-emphasis-position: under right;
}
.cursive-doc del { color: var(--muted); }
.cursive-doc mark { background: var(--match); color: inherit; border-radius: 2px; }
.cursive-doc sup, .cursive-doc sub { font-size: 0.75em; line-height: 0; }
.cursive-doc a { color: var(--accent); text-decoration: none;
  border-bottom: 1px solid color-mix(in srgb, var(--accent) 35%, transparent); }
.cursive-doc a:hover { border-bottom-color: var(--accent); }
.cursive-doc .emoji { font-family: "Apple Color Emoji", "Segoe UI Emoji", sans-serif; }

.cursive-doc hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 1.6em 0;
}

/* ---------- 行内代码 ---------- */
.cursive-doc code {
  font-family: var(--mono);
  font-size: 0.9em;
  background: var(--code-bg);
  border-radius: 4px;
  padding: 0.1em 0.34em;
}

/* ---------- 代码块：一张圆角卡片，顶上一条语言名 ---------- */
.cursive-doc figure.code {
  margin: 1em 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--code-bg);
  overflow: hidden;
}
.cursive-doc figure.code figcaption {
  font-family: var(--sans);
  font-size: 11px;
  line-height: 17px;
  letter-spacing: 0.02em;
  color: var(--mark-idle);
  padding: 5px 12px 0;
}
.cursive-doc figure.code pre {
  margin: 0;
  padding: 8px 12px 12px;
  overflow-x: auto;
}
.cursive-doc pre code {
  font-size: 0.9em;
  line-height: 1.6;
  background: none;
  padding: 0;
  border-radius: 0;
  white-space: pre;
}

/* 代码配色：与 editor/theme.ts 的 markdownHighlight 同一套 --hl-* 变量。
   类名来自 @lezer/highlight 的 classHighlighter（tok-*），和编辑器里
   CM 自己生成的那套类名不同，但涂的是同一批颜色 */
.tok-keyword { color: var(--hl-keyword); }
.tok-string, .tok-string2 { color: var(--hl-string); }
.tok-number, .tok-bool, .tok-atom, .tok-literal { color: var(--hl-number); }
.tok-comment { color: var(--muted); font-style: italic; }
.tok-variableName.tok-definition, .tok-macroName { color: var(--hl-func); }
.tok-typeName, .tok-className, .tok-namespace { color: var(--hl-type); }
.tok-propertyName, .tok-attributeName { color: var(--hl-prop); }
.tok-operator, .tok-punctuation, .tok-meta { color: var(--muted); }
.tok-inserted { color: var(--hl-ins); }
.tok-deleted, .tok-invalid { color: var(--hl-del); }
.tok-link { color: var(--accent); }

/* ---------- 引用 ---------- */
.cursive-doc blockquote {
  margin: 1em 0;
  padding: 0 0 0 0.9em;
  border-left: 2px solid var(--mark-idle);
  color: var(--muted);
}

/* ---------- 告示块（P1-6 的 6 档配色，底色由主色兑出来） ---------- */
.cursive-doc .callout {
  --cal: var(--cal-note);
  margin: 1em 0;
  padding: 0.6em 0.85em;
  border-left: 3px solid var(--cal);
  border-radius: 0 6px 6px 0;
  background: color-mix(in srgb, var(--cal) 8%, transparent);
}
.cursive-doc .callout-tip { --cal: var(--cal-tip); }
.cursive-doc .callout-warn { --cal: var(--cal-warn); }
.cursive-doc .callout-danger { --cal: var(--cal-danger); }
.cursive-doc .callout-example { --cal: var(--cal-example); }
.cursive-doc .callout-quote { --cal: var(--cal-quote); }
.cursive-doc .callout-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--sans);
  font-weight: 600;
  color: var(--cal);
}
.cursive-doc .callout-head .ic { width: 16px; height: 16px; flex: none; }
.cursive-doc .callout-body > :first-child { margin-top: 0.35em; }
.cursive-doc .callout-body > :last-child { margin-bottom: 0; }

/* ---------- 表格 ---------- */
.cursive-doc .table-wrap { overflow-x: auto; margin: 1em 0; }
.cursive-doc table {
  border-collapse: collapse;
  font-size: 0.92em;
  line-height: 1.55;
}
/* 表格与编辑器里保持一致：只留横线、表头不铺底、不要斑马纹。
   印在纸上这一套尤其对 —— 网格线和斑马纹是打印机最容易糊成一片的东西 */
.cursive-doc th, .cursive-doc td {
  border: none;
  border-bottom: 1px solid var(--divider);
  padding: 6px 12px;
}
.cursive-doc thead th { border-bottom: 1px solid var(--border); font-weight: 600; }
.cursive-doc tbody tr:last-child td { border-bottom: none; }

/* ---------- 列表 ---------- */
.cursive-doc ul, .cursive-doc ol { padding-left: 1.6em; margin: 0.7em 0; }
/* 嵌套的那一层不再另加外边距：紧凑列表里「项 → 子项」之间会白白空出一行 */
.cursive-doc li > ul, .cursive-doc li > ol { margin: 0.15em 0; }
.cursive-doc li { margin: 0.15em 0; }
.cursive-doc li::marker { color: var(--accent); }
.cursive-doc li.task { list-style: none; margin-left: -1.3em; }
.cursive-doc li.task input {
  appearance: none;
  width: 1em;
  height: 1em;
  margin: 0 0.45em 0 0;
  vertical-align: -0.12em;
  border: 1.5px solid var(--muted);
  border-radius: 0.28em;
  background: transparent;
}
.cursive-doc li.task input:checked {
  background: var(--accent) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='none' stroke='%23fff' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round' d='M3.5 8.5l3 3 6-6'/%3E%3C/svg%3E") center/100% no-repeat;
  border-color: var(--accent);
}

/* ---------- 图片 ---------- */
.cursive-doc img { max-width: 100%; height: auto; border-radius: 4px; }

/* ---------- 数学（MathML，不依赖 KaTeX 的字体） ---------- */
.cursive-doc .math-block { margin: 1em 0; text-align: center; overflow-x: auto; }
.cursive-doc math { font-size: 1.05em; }

/* ---------- mermaid ---------- */
.cursive-doc figure.mermaid { margin: 1em 0; text-align: center; }
.cursive-doc figure.mermaid svg { max-width: 100%; height: auto; }
.cursive-doc .mermaid-src {
  font-family: var(--mono);
  font-size: 0.85em;
  color: var(--muted);
  background: var(--code-bg);
  border: 1px dashed var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  text-align: left;
  overflow-x: auto;
}

/* ---------- 目录 / 脚注 / front matter ---------- */
.cursive-doc .toc {
  margin: 1.2em 0;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  font-family: var(--sans);
  font-size: 0.92em;
}
.cursive-doc .toc-title { font-weight: 600; margin-bottom: 4px; }
.cursive-doc .toc ul { list-style: none; padding: 0; margin: 0; }
.cursive-doc .toc li { margin: 1px 0; }
.cursive-doc .toc a { border-bottom: none; }

.cursive-doc .footnotes {
  margin-top: 2em;
  padding-top: 0.6em;
  border-top: 1px solid var(--border);
  font-size: 0.92em;
  color: var(--muted);
}
.cursive-doc .footnotes ol { list-style: none; padding-left: 0; }
.cursive-doc .footnote-label {
  font-family: var(--mono);
  font-size: 0.86em;
  color: var(--accent);
}
.cursive-doc .footnote-ref a { border-bottom: none; }
.cursive-doc .footnote-back { border-bottom: none; margin-left: 4px; }

.cursive-doc .frontmatter, .cursive-doc .raw-html {
  font-family: var(--mono);
  font-size: 0.82em;
  line-height: 1.7;
  color: var(--muted);
  background: var(--code-bg);
  border-radius: 6px;
  padding: 8px 12px;
  overflow-x: auto;
  white-space: pre-wrap;
}

/* ---------- 打印 / 导出 PDF（P4-2 真分页）----------
   **这里不写 \`@page { size }\`**：纸张与页边距的真相只有一份，在壳侧的 NSPrintInfo
   （分页是它做的，走 printOperation）。两处各说一套时 WebKit 的行为没有定义，
   CSS 只管排版与断页规则。 */
@media print {
  /* 五号字（10.5pt）是中文文档的常规；正文以下全是 em，跟着一起缩 */
  body { font-size: 10.5pt; line-height: 1.7; }
  .cursive-doc { max-width: none; padding: 0; }
  /* 标题不许落在页脚上 —— 下面一行内容都没有的标题是最刺眼的分页事故 */
  .cursive-doc h1, .cursive-doc h2, .cursive-doc h3,
  .cursive-doc h4, .cursive-doc h5, .cursive-doc h6 { break-after: avoid; }
  .cursive-doc p, .cursive-doc li { orphans: 3; widows: 3; }
  /* 表格 / 告示块 / 图 / 公式整块搬页；**代码块不锁** —— 一段比一页还长的代码
     锁住只会在前一页留一大片空白，然后照样被切开 */
  .cursive-doc table, .cursive-doc .callout,
  .cursive-doc figure.mermaid, .cursive-doc .math-block,
  .cursive-doc img { break-inside: avoid; }
  .cursive-doc figure.code { break-inside: auto; }
  /* 跨页表格每页重画表头 */
  .cursive-doc thead { display: table-header-group; }
  /* 纸上没有横向滚动条：代码与表格宁可折行，也不能被裁掉一截 */
  .cursive-doc pre { overflow: visible; }
  .cursive-doc pre code { white-space: pre-wrap; word-break: break-word; }
  .cursive-doc .table-wrap { overflow: visible; }
}
`
