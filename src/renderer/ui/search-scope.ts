/**
 * 跨文件搜索的包含 / 排除条件（第八节 11，契约 v41）。
 *
 * 人写的是路径模式（逗号分隔）：`*.md`、`drafts`、`docs/**`、`src/*.md`。这里把它们编译成
 * **按相对路径匹配的正则**（相对搜索范围的那个文件夹，`/` 分隔、不带前导斜杠），壳侧遍历文件时
 * 原样套用 —— 规则只在这一处写，单测钉着；壳那边只会「排除命中一条就跳过、包含有的话至少命中一条」。
 *
 * 规则（与 VS Code 的「包含 / 排除的文件」同一种直觉）：
 *   · `*` 只在一节路径里通配，`**` 跨节，`?` 一个字符；
 *   · **不带 `/` 的模式认任何一节**：`drafts` 排掉哪一层的 `drafts/` 都行，`*.md` 认哪一层的文件名都行；
 *   · **中间带 `/` 的模式从范围的根算起**：`docs/**` 只认根下那个 `docs/`；前面加上两个星号与一个斜杠才认任何一层；
 *   · 末尾的 `/` 只是说「这是个文件夹」，不算带斜杠：`docs/` 与 `docs` 一样认任何一层；
 *   · 认到一个文件夹，它底下的东西一并算进去（`docs` 与 `docs/**` 后半截的意思一样）。
 * 一个文件夹被排除，壳就不往里走（它里面的文件不占「最多扫 6000 个文件」的预算）。
 */

export interface SearchScope {
  /** 正则源码。有的话，文件的相对路径至少得命中一条 */
  include: string[]
  /** 正则源码。命中任何一条的文件（或文件夹）跳过 */
  exclude: string[]
}

/** 「`*.md, drafts，docs/**`」→ 一条条模式。中英文逗号、换行都认 */
export function parsePatterns(text: string): string[] {
  return text
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 一条路径模式 → 正则源码。写坏了（只剩斜杠之类）回 null，当没写 */
export function globToRegex(glob: string): string | null {
  let g = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
  // 中间带斜杠的才从范围的根算起：`docs/**` 是根下那个 docs，`docs/` 与 `docs` 是任何一层的 docs
  const anchored = g.includes('/')
  // 末尾的 `/**`、`/`：认到这个文件夹，底下的一并算 —— 正则末尾的 `(?:/|$)` 本来就是这个意思
  for (;;) {
    const next = g.replace(/\/\*\*$/, '').replace(/\/+$/, '')
    if (next === g) break
    g = next
  }
  if (!g || g === '**') return null
  let body = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` = 零到多节目录；单独的 `**`（夹在别的字符中间）= 任意多个字符
        if (g[i + 2] === '/') {
          body += '(?:.*/)?'
          i += 2
        } else {
          body += '.*'
          i += 1
        }
      } else {
        body += '[^/]*'
      }
    } else if (c === '?') {
      body += '[^/]'
    } else {
      body += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return (anchored ? '^' : '(?:^|/)') + body + '(?:/|$)'
}

/** 两个输入框里的字 → 交给壳的那份条件 */
export function compileScope(include: string, exclude: string): SearchScope {
  const compile = (text: string): string[] =>
    parsePatterns(text)
      .map(globToRegex)
      .filter((r): r is string => r !== null)
  return { include: compile(include), exclude: compile(exclude) }
}

/**
 * 这条相对路径在不在范围里 —— **与壳侧 `SearchOperation` 逐条一致的那套规则**
 * （壳那边是同样的几行 Swift）。单测与渲染层自己要判断时用它
 */
export function inScope(rel: string, scope: SearchScope): boolean {
  if (scope.exclude.some((re) => new RegExp(re).test(rel))) return false
  return !scope.include.length || scope.include.some((re) => new RegExp(re).test(rel))
}
