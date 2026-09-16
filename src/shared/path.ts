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
