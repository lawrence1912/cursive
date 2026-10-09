import { getSearchQuery, type SearchQuery } from '@codemirror/search'
import { StateField, type ChangeSet, type EditorState, type Text } from '@codemirror/state'

/**
 * 查找命中的位置表（第八节 18）。查找计数（`search-panel.ts` 的 `searchStat`，面板与状态栏
 * 共用）和滚动条刻度（`scroll-marks.ts`）读的都是这一份。
 *
 * 从前两边各扫一遍全文，正文一变就整份重扫。`SearchCursor` 逐字做 NFKD + 小写，一万行、
 * 四千处命中的文档扫一遍十几毫秒（node 里 25ms）：计数在 dispatch 里扫一遍、刻度在测量阶段
 * 再扫一遍，开着查找时每打一个字同步要 29ms（普通打字 14ms，见 docs/perf-baseline-2026-10-09.md）。
 *
 * 现在跟着事务走：**改动碰到哪几行就只重扫那几行**，其余命中按改动平移。前提是
 * 一处命中出不了它所在的那一行 —— 字符串查询里没有换行、正则不是 CM 判成跨行的那种；
 * 整词判定只看命中两侧各一个字符，行首行尾那一侧是换行，与别的行无关。
 * 前提不成立（跨行查询、自定义 test、上一份已经截在 CAP）就整份重扫。
 * 两条路的结果逐项相同，`test/search-index.test.ts` 拿随机编辑对拍。
 */

/** 扫描上限：别为一个 `.` 把整篇数一遍（计数显示「5000+」，刻度也只画到这儿） */
export const CAP = 5000

export interface SearchIndex {
  readonly query: SearchQuery
  /** 整词判定用的词字符，取自光标处的语言（CM 的 cursor 也是这么取的）；不是整词查询时为空串 */
  readonly wordChars: string
  /** 命中起点，升序、互不重叠，最多 CAP 个 */
  readonly starts: readonly number[]
  /** 扫到 CAP 就停了：后面还有没有、有几处，不知道 */
  readonly capped: boolean
}

function wordCharsOf(state: EditorState, q: SearchQuery): string {
  return q.wholeWord ? state.languageDataAt<string>('wordChars', state.selection.main.head)[0] ?? '' : ''
}

/** 两个查询找出来的东西是不是一样（替换串变了不算：只在替换那一行打字不该重扫全文） */
function sameMatcher(a: SearchQuery, b: SearchQuery): boolean {
  return a === b || (a.search === b.search && a.caseSensitive === b.caseSensitive && a.regexp === b.regexp &&
    a.wholeWord === b.wholeWord && a.literal === b.literal && a.test === b.test)
}

/** 与 SearchQuery 内部的 unquote 同一条规则：不是 literal 时，查询里的 `\n` 是一个真换行 */
function unquoted(q: SearchQuery): string {
  return q.literal ? q.search : q.search.replace(/\\([nrt\\])/g, (_, ch: string) =>
    ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : '\\')
}

/** 一处命中出不出得了它所在的那一行。出不了，才能只重扫改动所在的那几行 */
function lineLocal(q: SearchQuery): boolean {
  if (q.test) return false
  // 与 RegExpCursor 判跨行的那条正则逐字相同：命中了它，CM 就换 MultilineRegExpCursor 跨行去找
  if (q.regexp) return !/\\[sWDnr]|\n|\r|\[\^/.test(q.search)
  return !unquoted(q).includes('\n')
}

function scan(state: EditorState, q: SearchQuery, wordChars: string): SearchIndex | null {
  const starts: number[] = []
  try {
    const cursor = q.getCursor(state)
    for (let r = cursor.next(); !r.done; r = cursor.next()) {
      starts.push(r.value.from)
      if (starts.length >= CAP) break
    }
  } catch {
    // 正则在这一刻跑不起来（边打边搜时会路过各种半截正则）
    return null
  }
  return { query: q, wordChars, starts, capped: starts.length >= CAP }
}

/**
 * 按一次改动把位置表推到新文档上；推不了返回 null（交给整份重扫）。
 *
 * 改动所在的整行在改前、改后各有一段坐标：段外的命中原样平移，段里的作废、在新文档上重扫。
 * 同一行上的几处改动（多光标）、或者改动把两行连成一行，段会叠在一起，合成一段。
 */
function advance(prev: SearchIndex, before: Text, state: EditorState, changes: ChangeSet): SearchIndex | null {
  if (prev.capped || !lineLocal(prev.query)) return null
  const after = state.doc
  const spans: { aFrom: number; aTo: number; bFrom: number; bTo: number }[] = []
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    const span = {
      aFrom: before.lineAt(fromA).from,
      aTo: before.lineAt(toA).to,
      bFrom: after.lineAt(fromB).from,
      bTo: after.lineAt(toB).to
    }
    const last = spans[spans.length - 1]
    if (last && (span.aFrom <= last.aTo || span.bFrom <= last.bTo)) {
      last.aTo = span.aTo
      last.bTo = span.bTo
    } else spans.push(span)
  })
  const old = prev.starts
  const starts: number[] = []
  let i = 0
  // 段与段之间的正文没动过：那里的位置一律差同一个数（上一段末尾改前改后之差）
  let delta = 0
  try {
    for (const span of spans) {
      while (i < old.length && old[i]! < span.aFrom) starts.push(old[i++]! + delta)
      while (i < old.length && old[i]! <= span.aTo) i++
      const cursor = prev.query.getCursor(state, span.bFrom, span.bTo)
      for (let r = cursor.next(); !r.done; r = cursor.next()) starts.push(r.value.from)
      delta = span.bTo - span.aTo
    }
  } catch {
    return null
  }
  while (i < old.length) starts.push(old[i++]! + delta)
  // 原来那份是全的（没截断），所以截到前 CAP 个与整份重扫拿到的一样
  const capped = starts.length >= CAP
  if (capped) starts.length = CAP
  return { query: prev.query, wordChars: prev.wordChars, starts, capped }
}

/**
 * 读的时候整份扫出来的那一份，**按文档记**：只挪光标时文档还是同一个对象，用不着再扫；
 * 下一个改正文的事务也从这里接着推。没装 `searchIndexField` 的 state（单测里那些）靠它
 * 守住「光标移动不重扫」
 */
const scanned = new WeakMap<Text, SearchIndex>()

/** 这一份还能不能直接当 `q` 在这份 state 里的答案 */
function fits(found: SearchIndex | null | undefined, q: SearchQuery, wordChars: string): found is SearchIndex {
  return !!found && sameMatcher(found.query, q) && found.wordChars === wordChars
}

/** 每个事务把位置表往前推一步。没人读过（没开查找）就一直是 null，不花一分钱 */
export const searchIndexField = StateField.define<SearchIndex | null>({
  create: () => null,
  update(value, tr) {
    const cached = scanned.get(tr.startState.doc)
    if (!value && !cached) return null
    const q = getSearchQuery(tr.state)
    // 自定义 test 能读整个 state（选区之类），结果只对算它的那一个 state 成立
    if (q.test) return null
    // 整词规则跟着光标所在的语言走：换了语言，旧的那份就不能平移着用了
    const wordChars = wordCharsOf(tr.state, q)
    const prev = fits(value, q, wordChars) ? value : fits(cached, q, wordChars) ? cached : null
    if (!prev) return null
    if (!tr.docChanged) return prev
    return advance(prev, tr.startState.doc, tr.state, tr.changes)
  }
})

/**
 * 当前查询在这份 state 里的全部命中（升序，最多 CAP 个）。没有查询、正则不合法、
 * 或者正则跑的时候抛了，都是 null
 */
export function searchIndex(state: EditorState): SearchIndex | null {
  const q = getSearchQuery(state)
  if (!q.search || !q.valid) return null
  const wordChars = wordCharsOf(state, q)
  if (q.test) return scan(state, q, wordChars)
  const kept = state.field(searchIndexField, false)
  if (fits(kept, q, wordChars)) return kept
  const cached = scanned.get(state.doc)
  if (fits(cached, q, wordChars)) return cached
  const fresh = scan(state, q, wordChars)
  if (fresh) scanned.set(state.doc, fresh)
  return fresh
}
