/**
 * 子序列模糊匹配（0.2.0，快速打开与命令面板共用）。
 *
 * 不引库：需要的只是「按名字跳」这一种场景，而通用打分器（fzf / fuse）的
 * 大半篇幅在处理多字段权重与 tokenize，这里一样都用不上。
 *
 * 规则就三条，按重要性排：
 *   1. **必须是子序列**，顺序不能乱 —— `mdl` 能匹配 `markdown-lang`，`lmd` 不能。
 *      模糊到能换顺序，列表就会开始给出「看不出为什么会在这儿」的结果；
 *   2. **连着的比散开的好**（连击加分），所以 `read` 排在 `r-e-a-d` 前面；
 *   3. **词首比词中好**（`/`、`-`、`_`、`.`、空格之后，以及小写转大写那一下），
 *      于是 `ml` 优先命中 `markdown-lang` 而不是 `normal`。
 *
 * 中文照样能用：CJK 一个字就是一个「词」，逐字匹配天然就是词首匹配。
 */

export interface FuzzyHit {
  score: number
  /** 命中的字符下标（在 text 上），面板拿它把匹配的字加粗 */
  positions: number[]
}

/** 词首：串首，或者前一个字符是分隔符 */
const BOUNDARY = /[/\\\-_. ]/

function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true
  const prev = text[i - 1]!
  if (BOUNDARY.test(prev)) return true
  // camelCase 的驼峰处也算词首（`langOptions` 里的 O）
  const cur = text[i]!
  return prev === prev.toLowerCase() && cur !== cur.toLowerCase() && prev !== cur
}

/**
 * 打分。不匹配返回 null。
 *
 * 分值只用来**排序**，绝对值没有意义 —— 别在调用处拿它跟一个阈值比。
 */
export function fuzzy(query: string, text: string): FuzzyHit | null {
  if (query === '') return { score: 0, positions: [] }
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (q.length > t.length) return null

  const positions: number[] = []
  let score = 0
  let ti = 0
  let run = 0
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!
    // 空格在查询里当「分段符」用（`fmt 表`），不参与匹配
    if (ch === ' ') {
      run = 0
      continue
    }
    const found = t.indexOf(ch, ti)
    if (found < 0) return null
    positions.push(found)
    // 连击：接着上一个命中 → 加分，且连得越长加得越多。
    // **每一击的加成必须压过一次词首加成**（10 比 12 小，10+10 才大）——
    // 否则 `abc` 查 `a-b-c-x` 会赢过 `abcx`：三个词首 +36，而连击只补了 +18，
    // 排出来的第一条是「三个首字母碰巧对上」的那个，不是真正连着的那个
    run = found === ti && qi > 0 ? run + 1 : 0
    score += 10 + run * 10
    if (isBoundary(text, found)) score += 12
    if (found === 0) score += 8
    // 跳过的距离要扣分，但**有下限** —— 否则长路径里靠后的命中一律被判死刑，
    // 而「在很长的路径末尾精确命中文件名」恰恰是快速打开最常见的一次查询
    score -= Math.min(found - ti, 6)
    ti = found + 1
  }
  // 越短的目标越可能是用户想要的那一个（`api.md` 优于 `api-reference-v2.md`）
  score -= Math.min(text.length, 60) / 10
  return { score, positions }
}

/**
 * 路径专用：**文件名比目录重要得多**。
 *
 * 只拿整条路径打分的话，`test/fixtures/callout.md` 里的 `t-e-s-t` 会让一个
 * 查 `test` 的人先看到一堆碰巧路过 test 目录的文件，而不是真的叫 test 的那份。
 * 所以两边各打一次，取文件名那次并给一份加成 —— 除非它压根匹配不上。
 */
export function fuzzyPath(query: string, path: string): FuzzyHit | null {
  const slash = path.lastIndexOf('/')
  const base = slash < 0 ? path : path.slice(slash + 1)
  const whole = fuzzy(query, path)
  const hit = fuzzy(query, base)
  if (!hit) return whole
  // 文件名那次的下标是相对 base 的，挪回整条路径的坐标系
  const offset = slash + 1
  const onBase: FuzzyHit = {
    score: hit.score + 40,
    positions: hit.positions.map((i) => i + offset)
  }
  return whole && whole.score > onBase.score ? whole : onBase
}
