import type { Key } from './zh'

/**
 * 英文文案。类型 `Record<Key, string>` —— zh.ts 里的每个 key 这里都必须有，
 * 缺一条 typecheck 就不过（见 zh.ts 顶部的约定）。
 */
const en: Record<Key, string> = {
  // ---------- 通用 ----------
  'app.untitled': 'Untitled',

  // ---------- 状态栏 ----------
  'status.regexInvalid': 'Invalid regex',
  'status.noMatch': 'No matches',
  'status.match': '{index} of {total}{cap}',
  'status.selected': '{words} words · {chars} chars selected',
  'status.count': '{words} words · {chars} chars',
  'status.saved': 'Saved {time}',
  'status.source': 'Source',
  'status.preview': 'Preview',
  'status.detailTitle': 'Click for detailed stats',

  // ---------- 标题栏按钮 ----------
  'tb.sidebar': 'Show/Hide File Tree',
  'tb.outline': 'Show/Hide Outline',
  'tb.column': 'Column width',
  'tb.theme': 'Dark mode',
  'tb.toLight': 'Switch to Light',
  'tb.toDark': 'Switch to Dark',

  // ---------- 标签栏 ----------
  'tab.stale': 'File modified externally; unsaved changes in this tab are stale',
  'tab.close': 'Close {title}',

  // ---------- 文件树 ----------
  'sb.newFile': 'New File',
  'sb.newFolder': 'New Folder',
  'sb.collapseAll': 'Collapse all',
  'sb.search': 'Search in Folder',
  'sb.openFolder': 'Open Another Folder',
  'sb.openFolderBtn': 'Open Folder',
  'sb.orOpen': 'or press ⌘⇧O',
  'sb.resize': 'Drag to resize',
  'sb.rename': 'Rename…',
  'sb.deleteDir': 'Delete Folder',
  'sb.deleteFile': 'Delete File',
  'sb.reveal': 'Reveal in Finder',

  // ---------- 跨文件搜索 ----------
  'fs.placeholder': 'Search in folder',
  'fs.clear': 'Clear',
  'fs.opts': 'Search options',
  'fs.case': 'Match case',
  'fs.word': 'Whole words',
  'fs.regex': 'Regular expression',
  'fs.hits': '{n} hits · {files} files',
  'fs.noMatch': 'No matches',
  'fs.truncated': ' (results truncated)',
  'fs.noFolder': 'Open a folder first',
  'fs.searching': 'Searching…',
  'fs.line': 'Line {line}',

  // ---------- 大纲 ----------
  'ol.title': 'Outline',
  'ol.levels': 'Heading levels to show',
  'ol.level': 'Up to H{n}',
  'ol.filter': 'Filter headings',
  'ol.clear': 'Clear filter',
  'ol.empty': 'No headings in this document',
  'ol.noMatch': 'No matching headings',
  'ol.expand': 'Expand',
  'ol.collapse': 'Collapse',
  'ol.words': '{n} words in this section',
  'ol.copyAnchor': 'Copy section anchor',
  'ol.newSibling': 'New heading below',
  'ol.promote': 'Promote',
  'ol.demote': 'Demote',

  // ---------- 格式栏 ----------
  'fb.bold': 'Bold  ⌘B',
  'fb.italic': 'Italic  ⌘I',
  'fb.underline': 'Underline  ⌘U',
  'fb.strike': 'Strikethrough  ⇧⌘X',
  'fb.code': 'Inline code  ⌃⌘C',
  'fb.link': 'Link  ⌘K',
  'fb.quote': 'Quote  ⇧⌘Q',
  'fb.ulist': 'Bullet list  ⇧⌘[',
  'fb.olist': 'Numbered list  ⇧⌘]',
  'fb.task': 'Task item  ⇧⌘C',
  'fb.codeBlock': 'Code block  ⇧⌘K',
  'fb.p': 'Body text',
  'fb.h': 'Heading {n}',
  'fb.pick': 'Block type',
  'fb.pickTitle': 'Block type (body / headings 1–6)',
  'fb.toolbar': 'Format',
  // ---- P2-9 命令表补齐 ----
  'fb.highlight': 'Highlight  ⇧⌘H',
  'fb.sup': 'Superscript  ⌃⌘=',
  'fb.sub': 'Subscript  ⌃⌘-',
  'fb.mathInline': 'Inline math  ⌃⌘M',
  'fb.insert': 'Insert',
  'fb.insertTitle': 'Insert table / image / divider / math block…',
  'fb.table': 'Table',
  'fb.image': 'Image',
  'fb.hr': 'Divider',
  'fb.mathBlock': 'Math block',
  'fb.callout': 'Callout',
  'fb.mermaid': 'Diagram',
  'fb.footnote': 'Footnote',
  'fb.toc': 'Table of contents',

  // ---------- 设置面板 ----------
  'pf.title': 'Settings',
  'pf.close': 'Close settings',
  'pf.theme': 'Theme',
  'pf.theme.system': 'System',
  'pf.theme.light': 'Light',
  'pf.theme.dark': 'Dark',
  'pf.theme.sepia': 'Sepia',
  'pf.font': 'Body font',
  'pf.font.serif': 'Serif',
  'pf.font.sans': 'Sans-serif',
  'pf.size': 'Font size',
  'pf.leading': 'Line height',
  'pf.column': 'Column width',
  'pf.lang': 'Language',
  'pf.custom': 'Custom style',
  'pf.customHint': 'Put .css files in {dir} and relaunch',
  'pf.none': 'None',
  'pf.hint': 'Changes apply instantly and are remembered',
  'pf.reset': 'Reset to defaults',

  // ---------- 统计 ----------
  'st.cursor': 'Line {line} · Col {col}',
  'st.title': 'Document Stats',
  'st.close': 'Close stats',
  'st.all': 'Whole doc',
  'st.sel': 'Selection',
  'st.words': 'Words',
  'st.chars': 'Characters',
  'st.charsNoSpace': 'No spaces',
  'st.cjk': 'CJK chars',
  'st.latin': 'Latin words',
  'st.paragraphs': 'Paragraphs',
  'st.lines': 'Lines',
  'st.readTime': 'Reading time',

  // ---------- 阅读时长 ----------
  'wc.lessThan1m': 'less than 1 min',
  'wc.minutes': '~{n} min',

  // ---------- 文档内查找替换 ----------
  'sp.title': 'Find in document',
  'sp.showReplace': 'Show replace',
  'sp.hideReplace': 'Hide replace',
  'sp.replaceTitle': 'Replace  ⌥⌘R',
  'sp.find': 'Find',
  'sp.findOpts': 'Find options',
  'sp.prev': 'Previous',
  'sp.prevTitle': 'Previous  ⇧⌘G',
  'sp.next': 'Next',
  'sp.nextTitle': 'Next  ⌘G',
  'sp.selectAll': 'Select all',
  'sp.selectAllTitle': 'Select all matches',
  'sp.close': 'Close',
  'sp.closeTitle': 'Close  Esc',
  'sp.replace': 'Replace with',
  'sp.replaceBtn': 'Replace',
  'sp.replaceAll': 'Replace all',

  // ---------- CodeMirror 查找的读屏播报 ----------
  // 英文这四条与 CodeMirror 自带的原文一致（它的默认值就是这些）
  'cm.currentMatch': 'current match',
  'cm.onLine': 'on line',
  'cm.replacedMatches': 'Replaced $ matches',
  'cm.replacedOnLine': 'replaced match on line $',

  // ---------- 标题取数 ----------
  'hd.empty': '(empty heading)',
  'hd.new': 'New heading',

  // ---------- 块级 widget ----------
  'w.toc': 'Contents',
  'w.imgBroken': 'Image failed to load',
  'w.calloutExpand': 'Expand callout',
  'w.calloutCollapse': 'Collapse callout',

  // ---------- 代码块语言条 ----------
  'cd.plain': 'Plain text',
  'cd.mermaid': 'Mermaid diagram',
  'cd.copy': 'Copy',
  'cd.copied': 'Copied',
  'cd.copyCode': 'Copy code',
  'cd.langAria': 'Code language: {name}',
  'cd.change': 'Click to change language',
  'cd.changeHint': '{spec} — click to change',
  'cd.changeHintFull': 'Click to change language (or move the cursor onto the fence line to edit it)',
  'cd.filter': 'Filter languages',
  'cd.noMatch': 'No matching languages',

  // ---------- 表格就地编辑 ----------
  'tbl.colAlignLeft': 'Align column left',
  'tbl.colAlignCenter': 'Align column center',
  'tbl.colAlignRight': 'Align column right',
  'tbl.rowUp': 'Row above',
  'tbl.rowUpTitle': 'Insert a row above',
  'tbl.rowDown': 'Row below',
  'tbl.rowDownTitle': 'Insert a row below',
  'tbl.rowDel': 'Delete row',
  'tbl.rowDelTitle': 'Delete this row (header cannot be deleted)',
  'tbl.colLeft': 'Col left',
  'tbl.colLeftTitle': 'Insert a column on the left',
  'tbl.colRight': 'Col right',
  'tbl.colRightTitle': 'Insert a column on the right',
  'tbl.colDel': 'Delete column',
  'tbl.colDelTitle': 'Delete this column',
  'tbl.tidy': 'Tidy',
  'tbl.tidyTitle': 'Tidy alignment: pad column widths in the source (spaces only, content untouched)',
  'tbl.delete': 'Delete table',
  'tbl.deleteTitle': 'Delete the whole table'
}

export { en }
