/**
 * 往表格格子里粘贴时，剪贴板里的东西是不是「一块矩形数据」（第八节 9）。
 *
 * Excel / Numbers 复制几格时，纯文本那一份是 **TSV**：格与格之间一个制表符、行与行之间一个换行，
 * 格子里自己带换行 / 制表符 / 引号时整格用双引号包起来、里面的引号写两遍。HTML 那一份是一张 `<table>`。
 * 认的口径：
 *   · 纯文本里有制表符 —— 那就是一块表；
 *   · 没有制表符、但 HTML 是**一张表、别无他物** —— 只复制了一列（纯文本里只剩换行）；
 *   · 其余（普通的多行文字、网页上图文表混排的一段）一律不是：照旧走格内粘贴原来那条路。
 * 1×1 也算「表来的」：只复制了一格，取那一格的字就好 —— 不必拿 turndown 去转那张一格的表。
 */

/** TSV → 一行一行的格子。带引号的格子里可以有换行、制表符，`""` 是一个引号 */
export function parseTsv(text: string): string[][] {
  const s = text.replace(/\r\n?/g, '\n')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (quoted) {
      if (c !== '"') cell += c
      else if (s[i + 1] === '"') {
        cell += '"'
        i++
      } else quoted = false
      continue
    }
    if (c === '"' && cell === '') quoted = true
    else if (c === '\t') {
      row.push(cell)
      cell = ''
    } else if (c === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  // 结尾那个换行（Excel 每次都带）不再多出一行空的
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

/** HTML 是不是「一张表、别无他物」：去掉表之后只剩样式、注释、外壳标签和空白 */
function onlyTable(html: string): boolean {
  const at = html.search(/<table[\s>]/i)
  const end = html.toLowerCase().lastIndexOf('</table>')
  if (at < 0 || end < at) return false
  const rest = (html.slice(0, at) + html.slice(end + 8))
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
  return !rest.trim()
}

/**
 * 剪贴板里那块矩形数据；不是就回 null（照旧走格内粘贴原来那条路）。
 * 每一行补齐到一样宽（短的那几行后面补空格子），一格都没有的回 null
 */
export function clipboardGrid(plain: string, html: string | null): string[][] | null {
  const fromSheet = !!html && onlyTable(html)
  if (!plain.includes('\t') && !fromSheet) return null
  const rows = parseTsv(plain)
  const width = Math.max(0, ...rows.map((r) => r.length))
  if (!rows.length || !width) return null
  return rows.map((r) => [...r, ...Array<string>(width - r.length).fill('')])
}
