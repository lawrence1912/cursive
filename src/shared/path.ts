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
