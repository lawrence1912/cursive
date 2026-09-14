/**
 * 中文文案 —— **key 清单的真相源**。
 *
 * `en.ts` 的类型是 `Record<Key, string>`，key 来自这里：中文里加了新条目而英文没跟上，
 * typecheck 直接报错，不会出现半个应用突然说英文的情况。
 *
 * 约定：
 * - `{name}` 是占位符，`t()` 用 args 替换；除此之外不要在值里放花括号
 * - 快捷键写进文案本身（`粗体  ⌘B`），两端空格是故意的，菜单里好看
 * - callout 类型名（笔记/提示…）是 Markdown 方言的渲染内容，不在这里
 */

const zh = {
  // ---------- 通用 ----------
  'app.untitled': '未命名',

  // ---------- 状态栏（main.ts / index.html）----------
  'status.regexInvalid': '正则无效',
  'status.noMatch': '无匹配',
  'status.match': '第 {index} 处 / 共 {total}{cap} 处',
  'status.selected': '已选 {words} 词 · {chars} 字符',
  'status.count': '{words} 词 · {chars} 字符',
  'status.saved': '已保存 {time}',
  'status.source': '源代码',
  'status.preview': '预览',
  'status.detailTitle': '点击查看详细统计',

  // ---------- 标题栏按钮（main.ts）----------
  'tb.sidebar': '显示/隐藏文件树',
  'tb.outline': '显示/隐藏大纲',
  'tb.column': '栏宽',
  'tb.theme': '深色模式',
  'tb.toLight': '切换浅色',
  'tb.toDark': '切换深色',

  // ---------- 标签栏（tabbar.ts）----------
  'tab.stale': '文件在外部被修改，此标签的未保存改动已过期',
  'tab.close': '关闭 {title}',

  // ---------- 文件树（sidebar.ts）----------
  'sb.newFile': '新建文件',
  'sb.newFolder': '新建文件夹',
  'sb.collapseAll': '完全折叠',
  'sb.search': '在文件夹中搜索',
  'sb.openFolder': '打开其他文件夹',
  'sb.openFolderBtn': '打开文件夹',
  'sb.orOpen': '或按 ⌘⇧O',
  'sb.resize': '拖动调整宽度',
  'sb.rename': '重命名…',
  'sb.deleteDir': '删除文件夹',
  'sb.deleteFile': '删除文件',
  'sb.reveal': '在 Finder 中显示',

  // ---------- 跨文件搜索（file-search.ts）----------
  'fs.placeholder': '在文件夹中搜索',
  'fs.clear': '清空',
  'fs.opts': '搜索选项',
  'fs.case': '区分大小写',
  'fs.word': '全词匹配',
  'fs.regex': '正则表达式',
  'fs.hits': '{n} 处 · {files} 个文件',
  'fs.noMatch': '没有匹配',
  'fs.truncated': '（结果过多，已截断）',
  'fs.noFolder': '先打开一个文件夹',
  'fs.searching': '搜索中…',
  'fs.line': '第 {line} 行',

  // ---------- 大纲（outline.ts）----------
  'ol.title': '大纲',
  'ol.levels': '显示到第几级标题',
  'ol.level': '只看到 H{n}',
  'ol.filter': '筛选标题',
  'ol.clear': '清空筛选',
  'ol.empty': '本文还没有标题',
  'ol.noMatch': '没有匹配的标题',
  'ol.expand': '展开',
  'ol.collapse': '折叠',
  'ol.words': '本节 {n} 词',
  'ol.copyAnchor': '复制本节锚点',
  'ol.newSibling': '在此后新建同级标题',
  'ol.promote': '升一级',
  'ol.demote': '降一级',

  // ---------- 格式栏（format-bar.ts）----------
  'fb.bold': '粗体  ⌘B',
  'fb.italic': '斜体  ⌘I',
  'fb.underline': '下划线  ⌘U',
  'fb.strike': '删除线  ⇧⌘X',
  'fb.code': '行内代码  ⌃⌘C',
  'fb.link': '链接  ⌘K',
  'fb.quote': '引用  ⇧⌘Q',
  'fb.ulist': '无序列表  ⇧⌘[',
  'fb.olist': '有序列表  ⇧⌘]',
  'fb.task': '任务项  ⇧⌘C',
  'fb.codeBlock': '代码块  ⇧⌘K',
  'fb.p': '正文',
  'fb.h': '标题 {n}',
  'fb.pick': '块类型',
  'fb.pickTitle': '块类型（正文 / 标题 1–6）',
  'fb.toolbar': '格式',
  // ---- P2-9 命令表补齐 ----
  'fb.highlight': '高亮  ⇧⌘H',
  'fb.sup': '上标  ⌃⌘=',
  'fb.sub': '下标  ⌃⌘-',
  'fb.mathInline': '行内公式  ⌃⌘M',
  'fb.insert': '插入',
  'fb.insertTitle': '插入表格 / 图片 / 分隔线 / 公式块…',
  'fb.table': '表格',
  'fb.image': '图片',
  'fb.hr': '分隔线',
  'fb.mathBlock': '公式块',
  'fb.callout': '告示块',
  'fb.mermaid': '流程图',
  'fb.footnote': '脚注',
  'fb.toc': '目录',

  // ---------- 设置面板（prefs.ts）----------
  'pf.title': '设置',
  'pf.close': '关闭设置',
  'pf.theme': '主题',
  'pf.theme.system': '跟随系统',
  'pf.theme.light': '浅色',
  'pf.theme.dark': '深色',
  'pf.theme.sepia': '护眼',
  'pf.font': '正文字体',
  'pf.font.serif': '衬线',
  'pf.font.sans': '无衬线',
  'pf.size': '字号',
  'pf.leading': '行距',
  'pf.column': '栏宽',
  'pf.lang': '语言',
  'pf.custom': '自定义样式',
  'pf.customHint': '把 .css 放进 {dir} 后重开',
  'pf.none': '无',
  'pf.hint': '改动即时生效并自动记住',
  'pf.reset': '恢复默认',

  // ---------- 统计（stats.ts）----------
  'st.cursor': '行 {line} · 列 {col}',
  'st.title': '文档统计',
  'st.close': '关闭统计',
  'st.all': '全文',
  'st.sel': '选中',
  'st.words': '词',
  'st.chars': '字符',
  'st.charsNoSpace': '不含空格',
  'st.cjk': '中日韩字',
  'st.latin': '拉丁词',
  'st.paragraphs': '段落',
  'st.lines': '行',
  'st.readTime': '阅读时间',

  // ---------- 阅读时长（shared/wordcount.ts）----------
  'wc.lessThan1m': '不到 1 分钟',
  'wc.minutes': '约 {n} 分钟',

  // ---------- 文档内查找替换（search-panel.ts）----------
  'sp.title': '在本文查找',
  'sp.showReplace': '显示替换',
  'sp.hideReplace': '隐藏替换',
  'sp.replaceTitle': '替换  ⌥⌘R',
  'sp.find': '查找',
  'sp.findOpts': '查找选项',
  'sp.prev': '上一个',
  'sp.prevTitle': '上一个  ⇧⌘G',
  'sp.next': '下一个',
  'sp.nextTitle': '下一个  ⌘G',
  'sp.selectAll': '全选',
  'sp.selectAllTitle': '选中全部匹配',
  'sp.close': '关闭',
  'sp.closeTitle': '关闭  Esc',
  'sp.replace': '替换为',
  'sp.replaceBtn': '替换',
  'sp.replaceAll': '全部替换',

  // ---------- CodeMirror 查找的读屏播报（setup.ts 的 phrases 门面）----------
  // `$` 是 CodeMirror 自己的占位符（`state.phrase(key, n)`），不是我们的 `{name}`
  'cm.currentMatch': '当前匹配',
  'cm.onLine': '，第',
  'cm.replacedMatches': '已替换 $ 处',
  'cm.replacedOnLine': '已替换第 $ 行的匹配',

  // ---------- 标题取数（headings.ts）----------
  'hd.empty': '（空标题）',
  'hd.new': '新标题',

  // ---------- 块级 widget（live-preview/widgets.ts）----------
  'w.toc': '目录',
  'w.imgBroken': '图片加载失败',
  'w.calloutExpand': '展开告示块',
  'w.calloutCollapse': '折叠告示块',

  // ---------- 代码块语言条（live-preview/code.ts）----------
  'cd.plain': '纯文本',
  'cd.mermaid': 'Mermaid 图表',
  'cd.copy': '复制',
  'cd.copied': '已复制',
  'cd.copyCode': '复制代码',
  'cd.langAria': '代码语言：{name}',
  'cd.change': '点击换语言',
  'cd.changeHint': '{spec} —— 点击换语言',
  'cd.changeHintFull': '点击换语言（也可以把光标挪到围栏行上直接改）',
  'cd.filter': '筛选语言',
  'cd.noMatch': '没有匹配的语言',

  // ---------- 表格就地编辑（live-preview/table.ts）----------
  // 对齐三条写成**整句**而不是「整列{方向}」拼接：英文里拼出来是 "Align column: Align left"，
  // 而语序本来就因语言而异 —— 句子级的 key 是唯一能翻对的粒度
  'tbl.colAlignLeft': '整列左对齐',
  'tbl.colAlignCenter': '整列居中',
  'tbl.colAlignRight': '整列右对齐',
  'tbl.rowUp': '上插行',
  'tbl.rowUpTitle': '在上方插入一行',
  'tbl.rowDown': '下插行',
  'tbl.rowDownTitle': '在下方插入一行',
  'tbl.rowDel': '删除行',
  'tbl.rowDelTitle': '删除本行（表头不可删）',
  'tbl.colLeft': '左插列',
  'tbl.colLeftTitle': '在左侧插入一列',
  'tbl.colRight': '右插列',
  'tbl.colRightTitle': '在右侧插入一列',
  'tbl.colDel': '删除列',
  'tbl.colDelTitle': '删除本列',
  'tbl.tidy': '整理',
  'tbl.tidyTitle': '整理对齐：把源码里的列宽补齐（只动空格，不改内容）',
  'tbl.delete': '删除表格',
  'tbl.deleteTitle': '删除整张表格'
}

export type Key = keyof typeof zh
export { zh }
