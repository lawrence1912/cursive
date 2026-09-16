import type { ChangeDesc, Text } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'

/**
 * 「这一轮不重算装饰」时，把手里那份按文档变更**映射**过去。
 *
 * ViewPlugin 交出来的装饰，CM 是直接拿去画**当前**这份文档的 —— 它不替你映射
 * （`StateField` 那边才有 `value.map(tr.changes)` 这一步）。所以任何一条
 * 「这次先不重算、回头补」的捷径，返回之前都必须先过这里。
 *
 * 不映射的代价不是「画得旧一点」：中文连打时每敲一个拼音字母文档就长一个字，
 * 光标之后的每一条装饰都偏一位。轻则藏错字符、行样式落到别的行上（行高一变，
 * 视口就跟着往下跳）；重则某条替换装饰跨到下一行头上，CM 当场抛
 * `Decorations that replace line breaks may not be specified via plugins`，
 * **整个事务被中断** —— 视图与状态从此对不上。实测：高度图一瞬间差出三千多像素，
 * 之后每移动一次光标就在 CM 内部再炸一次（`Cannot destructure property 'tile'`）。
 *
 * 删除那一侧不用自己管：`Decoration.line` 的 mapMode 是 `TrackBefore`、行内替换是
 * `TrackDel`，被删掉的那几条 `map()` 自己就丢了。要补的只有**插进换行符**这一种 ——
 * 它会把一条本来在行内的替换装饰撑到下一行，正是上面那条 RangeError。
 */
export function carryDecorations(
  deco: DecorationSet,
  changes: ChangeDesc,
  doc: Text
): DecorationSet {
  const mapped = deco.map(changes)
  // 变更落在新文档里的哪一段（多处变更取外包络，宁可多查一点）
  let from = -1
  let to = -1
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    if (from < 0) from = fromB
    to = toB
  })
  // 这次变更没跨行 = 一条装饰都不可能因此跨行，整趟过滤省掉
  if (from < 0 || doc.lineAt(from).number === doc.lineAt(to).number) return mapped
  return mapped.update({
    filterFrom: from,
    filterTo: to,
    filter: (a, b) => a === b || doc.lineAt(a).number === doc.lineAt(b).number
  })
}
