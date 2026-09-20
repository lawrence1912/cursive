/** 渲染进程里用的纯函数版 basename，避免为了显示文件名走一趟 IPC */
export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i === -1 ? path : path.slice(i + 1)
}

/** 同上，纯函数版 dirname；没有目录部分时返回 null */
export function dirname(path: string): string | null {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i <= 0 ? null : path.slice(0, i)
}

/**
 * `dir` + 相对路径 → 绝对路径，顺手把 `.` 和 `..` 消掉。
 * `rel` 本身就是绝对路径时忽略 `dir`（只做消解）；`..` 退到根就停住 ——
 * 文件系统本来也没有「根的上一级」。`dir` 必须是绝对路径，调用方先挡。
 */
export function resolvePath(dir: string, rel: string): string {
  const out: string[] = []
  for (const part of (rel.startsWith('/') ? rel : `${dir}/${rel}`).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

/**
 * `from` 目录 → `to` 文件的相对写法（0.4.0 F3 链接补全用）。
 *
 * 与 `resolvePath` 互为逆：`resolvePath(from, relativeLink(from, to)) === to`。
 * 不在同一棵子树下就退到 `../`，共同前缀一段都没有（不同卷）时原样回绝对路径 ——
 * 一个写满 `../../..` 的链接不如一条绝对路径诚实。
 *
 * **不做百分号编码**：带空格的目的地由调用方写成 `<…>`（与拖图 / 粘贴截图那条路一致）。
 */
export function relativeLink(from: string, to: string): string {
  if (!from.startsWith('/') || !to.startsWith('/')) return to
  // macOS 上 `/tmp`、`/var` 都是 `/private` 下的软链，两边很可能一边带一边不带
  // （工作区根来自壳的 `workspaceRoot`，文件表来自 FileManager 的标准化路径）。
  // 不先抹平的话，同一棵树上的两条路径会「一段前缀都不共享」，补出来的全是绝对路径。
  // 与 `ui/file-search.ts` 的 `unprivate` 同一条规矩
  const strip = (p: string): string => (p.startsWith('/private/') ? p.slice(8) : p)
  const a = strip(from).split('/').filter(Boolean)
  const b = strip(to).split('/').filter(Boolean)
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  if (i === 0) return to
  const up = a.length - i
  // 同一个目录里的文件写成裸文件名（`./` 是多余的，CommonMark 两种都认）
  return [...Array<string>(up).fill('..'), ...b.slice(i)].join('/')
}
