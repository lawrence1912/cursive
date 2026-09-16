import type TurndownService from 'turndown'

/**
 * 智能粘贴的 turndown 规则表（0.2.0）。
 *
 * 单独成文件的原因有两个：`paste.ts` 里那一大半是 CodeMirror 的事件接线，
 * 而这里全是纯字符串变换 —— 分开之后 `test/paste-rules.test.ts` 只需要
 * turndown 本身（node 下它自带 domino），不用把整个编辑器拖进单测。
 *
 * **规则覆盖的是「编辑器认得、但 turndown 默认会丢掉」的那一批**。
 * turndown 只保证 CommonMark；Cursive 的方言（`==高亮==` / `^上标^` / `~下标~`）
 * 和 GFM 的表格、任务项它一概不认，于是从网页复制一段富文本进来，
 * 恰恰是这几样在渲染层已经做得最好的东西在入口处被抹平。
 *
 * 行内三条的写法与 `fmt.ts` 的格式化命令同源（那边 `fmt:highlight` 开合也是 `==`），
 * 所以「粘进来的」和「自己敲的」落在同一种源码上。
 */

/** DOM 侧只用到这几样，写成窄接口 —— node 单测里 turndown 给的是 domino 的节点，
 *  `closest` / `:scope` 这类较晚的 API 不保证有，一律自己走父链与兄弟链 */
type El = TurndownService.Node & {
  nodeName: string
  parentNode: El | null
  childNodes: ArrayLike<El>
  nextSibling: El | null
  getAttribute?(name: string): string | null
  textContent?: string | null
}

/** 子元素（跳过文本节点）。`children` 在 domino 上不是每种节点都有，自己筛更稳 */
function childElements(node: El | null): El[] {
  if (!node) return []
  const out: El[] = []
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i]!
    // 元素节点的 nodeName 是大写标签名；文本节点是 '#text'
    if (!child.nodeName.startsWith('#')) out.push(child)
  }
  return out
}

/** 往上找最近的某种祖先 */
function ancestor(node: El, name: string): El | null {
  let cur: El | null = node.parentNode
  while (cur) {
    if (cur.nodeName === name) return cur
    cur = cur.parentNode
  }
  return null
}

// ---------------------------------------------------------------- 表格

/**
 * 表格里所有的 `<tr>`，按文档顺序摊平（thead / tbody / tfoot 三层一起）。
 *
 * **只认属于这张表自己的行**：单元格里嵌套的表格有自己的 `<tr>`，
 * 混进来的话「第一行」会认错，分隔行就画到里层去了。
 */
function rowsOf(table: El): El[] {
  const out: El[] = []
  for (const child of childElements(table)) {
    if (child.nodeName === 'TR') out.push(child)
    else if (['THEAD', 'TBODY', 'TFOOT'].includes(child.nodeName)) {
      for (const row of childElements(child)) {
        if (row.nodeName === 'TR') out.push(row)
      }
    }
  }
  return out
}

function cellsOf(row: El): El[] {
  return childElements(row).filter((c) => c.nodeName === 'TH' || c.nodeName === 'TD')
}

/** 这一格横跨几列。跨列没法在 GFM 里表达，退化成「补几个空格子」，至少列数还对得上 */
function colSpan(cell: El): number {
  const raw = Number(cell.getAttribute?.('colspan') ?? '1')
  return Number.isFinite(raw) && raw > 1 ? Math.min(Math.floor(raw), 32) : 1
}

/** 对齐：`align` 属性与内联 `text-align` 都认（前者是老网页，后者是 Excel / Numbers 那一路） */
function alignOf(cell: El): 'left' | 'center' | 'right' | null {
  const attr = cell.getAttribute?.('align')?.toLowerCase()
  const style = cell.getAttribute?.('style')?.toLowerCase() ?? ''
  const fromStyle = /text-align\s*:\s*(left|center|right)/.exec(style)?.[1]
  const v = attr || fromStyle
  return v === 'left' || v === 'center' || v === 'right' ? v : null
}

/**
 * 单元格内容压成一行。GFM 的一格就是一行 —— 里面的段落、列表、甚至嵌套表格
 * 换行之后会把整张表冲散，所以换行一律并成空格；`|` 必须转义，否则多出一列。
 */
function flattenCell(content: string): string {
  return content
    .replace(/\\?\|/g, '\\|')
    .replace(/\s*\n+\s*/g, ' ')
    .trim()
}

const ALIGN_MARK = { left: ':---', center: ':---:', right: '---:' }

/** 表头下面那条分隔行。列数以**表头那一行**为准（GFM 按它定列数） */
function separatorRow(row: El): string {
  const marks: string[] = []
  for (const cell of cellsOf(row)) {
    const align = alignOf(cell)
    const mark = align ? ALIGN_MARK[align] : '---'
    for (let i = 0; i < colSpan(cell); i++) marks.push(mark)
  }
  return marks.length ? `| ${marks.join(' | ')} |` : ''
}

export function configureTurndown(td: TurndownService): void {
  // 从 Word / Excel / Outlook 复制来的 HTML 带着整段 `<style>`，而 turndown 对不认识的
  // 元素是「保留内容」—— 于是 CSS 正文被当成正文吐进文档（实测
  // `<style>.a{color:red}</style><p>hi</p>` → `.a{color:red}\n\nhi`）。整枝丢掉
  td.remove(['style', 'script', 'head', 'meta', 'link', 'noscript'])

  td.addRule('strikethrough', {
    filter: (node) => ['DEL', 'S', 'STRIKE'].includes(node.nodeName),
    replacement: (content) => (content.trim() ? `~~${content}~~` : content)
  })

  // 方言三条：编辑器渲染它们、格式菜单生成它们、导出认得它们，只有粘贴这条路上
  // 一直在丢。空内容不要包 —— `====` 是个假标记，会在文档里留一处怪东西
  td.addRule('highlight', {
    filter: (node) => node.nodeName === 'MARK',
    replacement: (content) => (content.trim() ? `==${content}==` : content)
  })
  td.addRule('superscript', {
    filter: (node) => node.nodeName === 'SUP',
    replacement: (content) => (content.trim() ? `^${content}^` : content)
  })
  td.addRule('subscript', {
    filter: (node) => node.nodeName === 'SUB',
    replacement: (content) => (content.trim() ? `~${content}~` : content)
  })

  // ---- GFM 任务项 ----
  // GitHub / 飞书的清单是 `<li><input type=checkbox checked> 文字</li>`。
  // turndown 默认把 input 当空元素丢掉，只剩 `-   文字`，勾选状态没了。
  //
  // **不能只给 input 加规则**再让 turndown 自己的 listItem 规则去包：它的项目符号是
  // `-` + 三个空格，出来是 `-   [x] 文字`，而 `fmt.ts` 认任务项的正则是 `^[-*+]\s\[[ xX]\]`
  // （恰好一个空白）—— 粘进来的清单点不动、格式栏也不认。所以整条 li 自己接管
  td.addRule('taskListItem', {
    filter: (node) => node.nodeName === 'LI' && checkboxOf(node as El) !== null,
    replacement: (content, node) => {
      const box = checkboxOf(node as El)!
      // `<input checked>` 的属性值是空串，`!= null` 才认得出来（`=== ''` 会漏掉 `checked="checked"`）
      const done = box.getAttribute?.('checked') != null
      // 续行缩进两格，和 `- [ ] ` 的正文起点对齐
      const body = content.replace(/^\s+/, '').replace(/\n/g, '\n  ').trim()
      return `- [${done ? 'x' : ' '}] ${body}${(node as El).nextSibling ? '\n' : ''}`
    }
  })

  // ---- GFM 表格 ----
  // 一张表由四条规则拼出来：格 → 行 → 分组（thead/tbody/tfoot 透传）→ 表。
  // 不写成「一条 table 规则里自己递归」是因为格里的行内标记（粗体、链接、公式）
  // 得由 turndown 自己那一套处理，重新发明一遍必然和上面三条方言规则对不齐。
  td.addRule('tableCell', {
    filter: ['th', 'td'],
    replacement: (content, node) => {
      const cell = node as El
      const first = cellsOf(cell.parentNode!)[0] === cell
      const extra = ' |'.repeat(colSpan(cell) - 1)
      return `${first ? '| ' : ' '}${flattenCell(content)} |${extra}`
    }
  })

  td.addRule('tableRow', {
    filter: (node) => node.nodeName === 'TR',
    replacement: (content, node) => {
      const row = node as El
      const table = ancestor(row, 'TABLE')
      const body = content.trim()
      if (!body) return ''
      // 第一行当表头 —— GFM 没有「无表头的表」这种东西，全是 `<td>` 的表
      // （Excel 复制出来的就是）也只能把第一行提上去，这是通行的退化方式
      const isHead = table !== null && rowsOf(table)[0] === row
      const sep = isHead ? separatorRow(row) : ''
      return `\n${body}${sep ? `\n${sep}` : ''}`
    }
  })

  td.addRule('tableSection', {
    filter: ['thead', 'tbody', 'tfoot'],
    replacement: (content) => content
  })

  // 列宽声明在 Markdown 里没有对应物，留着只会变成一串空行
  td.addRule('tableColgroup', {
    filter: ['colgroup', 'col'],
    replacement: () => ''
  })

  // 表名摆在表**前面**单独一行：塞进表格内部会多出一个对不上列数的行
  td.addRule('tableCaption', {
    filter: (node) => node.nodeName === 'CAPTION',
    replacement: (content) => (content.trim() ? `${content.trim()}\n` : '')
  })

  td.addRule('table', {
    filter: (node) => node.nodeName === 'TABLE',
    replacement: (content) => {
      const body = content.replace(/\n{2,}/g, '\n').trim()
      return body ? `\n\n${body}\n\n` : ''
    }
  })
}

/**
 * 这个 `<li>` 自己的复选框（不是嵌套子列表里那个）。
 * 只往下找到**下一层 li 为止**，否则 `- [ ] 外层` 会把内层的勾当成自己的。
 */
function checkboxOf(li: El): El | null {
  const stack = [...childElements(li)]
  while (stack.length) {
    const node = stack.shift()!
    if (node.nodeName === 'LI' || node.nodeName === 'UL' || node.nodeName === 'OL') continue
    if (
      node.nodeName === 'INPUT' &&
      (node.getAttribute?.('type') ?? '').toLowerCase() === 'checkbox'
    ) {
      return node
    }
    stack.push(...childElements(node))
  }
  return null
}
