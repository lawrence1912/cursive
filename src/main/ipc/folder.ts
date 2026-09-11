import { BrowserWindow, dialog, ipcMain } from 'electron'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { DirEntry } from '../../shared/types.js'
import { store } from '../store.js'

/** 树里只显示目录和这些后缀，其余文件对一个 markdown 编辑器没意义 */
const VISIBLE = /\.(md|markdown|mdown|mkd|txt)$/i

export function registerFolderIpc(): void {
  ipcMain.handle('dir:open-dialog', async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = { properties: ['openDirectory' as const, 'createDirectory' as const] }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const dir = res.canceled ? null : (res.filePaths[0] ?? null)
    if (dir) store.set('lastFolder', dir)
    return dir
  })

  ipcMain.handle('dir:read', async (_e, path: string): Promise<DirEntry[]> => {
    let items
    try {
      items = await readdir(path, { withFileTypes: true })
    } catch {
      return []
    }
    const out: DirEntry[] = []
    for (const item of items) {
      if (item.name.startsWith('.')) continue
      const isDir = item.isDirectory()
      if (!isDir && !VISIBLE.test(item.name)) continue
      out.push({ name: item.name, path: join(path, item.name), isDir })
    }
    // 目录在前，同类按名字排；localeCompare 让中文按拼音而不是码位排
    out.sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh-CN') : a.isDir ? -1 : 1
    )
    return out
  })

  ipcMain.handle('dir:last', (): string | null => store.get('lastFolder') ?? null)
}
