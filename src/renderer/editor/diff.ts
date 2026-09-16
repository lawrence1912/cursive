/**
 * 行级差异（0.2.0 版本历史用）。
 *
 * 不引库：要的只是「把两份文本并排看出哪儿变了」，而 diff 库的大半篇幅在处理
 * 词级高亮、补丁格式、三方合并 —— 这里一样都用不上，还要往首屏多背几十 KB。
 *
 * 算法是教科书 LCS，但**先掐头去尾**：同一份文档的两个版本绝大部分是相同的，
 * 把公共前缀与公共后缀摘掉之后，真正进 DP 的往往只剩几十行。
 * 剩下的部分超过 `MAX_DP` 行时不硬算 —— 退化成「这一整段被换掉了」，
 * 看上去粗，但比让界面卡住好（而且那种规模的改动本来也看不出逐行对应）。
 */

export type DiffKind = 'same' | 'add' | 'del'

export interface DiffRow {
  kind: DiffKind
  text: string
  /** 旧版里的行号（1 起）；新增行没有 */
  oldLine?: number
  /** 新版里的行号（1 起）；删除行没有 */
  newLine?: number
}

/**
 * DP 表的边长上限。1200×1200 的 Int32Array 约 5.8 MB，算一次几十毫秒 ——
 * 再大就不值得了：那已经不是「改了几处」，而是「换了一篇」。
 */
const MAX_DP = 1200

export interface DiffStat {
  added: number
  removed: number
}

export function diffStat(rows: DiffRow[]): DiffStat {
  let added = 0
  let removed = 0
  for (const r of rows) {
    if (r.kind === 'add') added++
    else if (r.kind === 'del') removed++
  }
  return { added, removed }
}

/** 按行切。末尾那个换行不该变成一条空行 —— 它是行结束符，不是一行 */
export function splitLines(text: string): string[] {
  // 空文档是**零行**，不是「一条空行」——`''.split('\n')` 给的是 `['']`，
  // 照单全收的话「从空文档写起」会多出一条并不存在的删除行
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function diffLines(oldText: string, newText: string): DiffRow[] {
  const a = splitLines(oldText)
  const b = splitLines(newText)

  // 公共前缀
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  // 公共后缀（不和前缀重叠）
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }

  const rows: DiffRow[] = []
  for (let i = 0; i < head; i++) {
    rows.push({ kind: 'same', text: a[i]!, oldLine: i + 1, newLine: i + 1 })
  }

  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  rows.push(...diffMiddle(midA, midB, head))

  for (let i = 0; i < tail; i++) {
    const oldIdx = a.length - tail + i
    const newIdx = b.length - tail + i
    rows.push({ kind: 'same', text: a[oldIdx]!, oldLine: oldIdx + 1, newLine: newIdx + 1 })
  }
  return rows
}

/** 掐头去尾之后剩下的那一段。偏移量用来把行号还原成整份文档里的 */
function diffMiddle(a: string[], b: string[], offset: number): DiffRow[] {
  if (a.length === 0 && b.length === 0) return []
  const out: DiffRow[] = []
  // 一边空 = 纯删或纯增，不必进 DP
  if (a.length === 0 || b.length === 0 || a.length > MAX_DP || b.length > MAX_DP) {
    for (let i = 0; i < a.length; i++) out.push({ kind: 'del', text: a[i]!, oldLine: offset + i + 1 })
    for (let i = 0; i < b.length; i++) out.push({ kind: 'add', text: b[i]!, newLine: offset + i + 1 })
    return out
  }

  // LCS 长度表。`(a.length + 1) × (b.length + 1)`，回溯时从左上角往右下走
  const w = b.length + 1
  const dp = new Int32Array((a.length + 1) * w)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + j + 1]! + 1
          : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!)
    }
  }

  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]!, oldLine: offset + i + 1, newLine: offset + j + 1 })
      i++
      j++
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) {
      // 删在增前面：同一处改动读起来是「原来这样 → 现在那样」
      out.push({ kind: 'del', text: a[i]!, oldLine: offset + i + 1 })
      i++
    } else {
      out.push({ kind: 'add', text: b[j]!, newLine: offset + j + 1 })
      j++
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i]!, oldLine: offset + i++ + 1 })
  while (j < b.length) out.push({ kind: 'add', text: b[j]!, newLine: offset + j++ + 1 })
  return out
}

/**
 * 只留改动处及其上下文，中间大段相同的折成一条「跳过 N 行」。
 * 一份几百行的文档改了两个字，全列出来等于让人自己找。
 */
export interface DiffChunk {
  /** 折叠掉的相同行数；> 0 时这一条是个折叠标记，`rows` 为空 */
  skipped: number
  rows: DiffRow[]
}

export function collapse(rows: DiffRow[], context = 3): DiffChunk[] {
  const keep = new Array<boolean>(rows.length).fill(false)
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.kind === 'same') continue
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) {
      keep[k] = true
    }
  }
  const out: DiffChunk[] = []
  let run: DiffRow[] = []
  let skipped = 0
  const flushRun = (): void => {
    if (run.length) {
      out.push({ skipped: 0, rows: run })
      run = []
    }
  }
  const flushSkip = (): void => {
    if (skipped) {
      out.push({ skipped, rows: [] })
      skipped = 0
    }
  }
  for (let i = 0; i < rows.length; i++) {
    if (keep[i]) {
      flushSkip()
      run.push(rows[i]!)
    } else {
      flushRun()
      skipped++
    }
  }
  flushRun()
  flushSkip()
  return out
}
