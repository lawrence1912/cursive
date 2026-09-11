import { BrowserWindow, dialog, ipcMain } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import type { DocPayload } from '../../shared/types.js'
import { decode, encode, type FileFingerprint } from '../../shared/textfile.js'
import { pushRecent } from '../store.js'

const MD_FILTERS = [
  { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] },
  { name: '所有文件', extensions: ['*'] }
]

export async function readDoc(path: string): Promise<DocPayload> {
  const { text, fingerprint } = decode(await readFile(path, 'utf8'))
  pushRecent(path)
  return { path, content: text, fingerprint }
}

async function writeDoc(path: string, text: string, fingerprint: FileFingerprint): Promise<void> {
  await writeFile(path, encode(text, fingerprint), 'utf8')
  pushRecent(path)
}

/** 打开对话框选文件；用户取消返回 null */
async function pickOpen(win: BrowserWindow | null): Promise<string | null> {
  const opts = { properties: ['openFile' as const], filters: MD_FILTERS }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return res.canceled ? null : (res.filePaths[0] ?? null)
}

/** 另存为对话框；用户取消返回 null */
async function pickSave(win: BrowserWindow | null, current: string | null): Promise<string | null> {
  const opts = { defaultPath: current ?? '未命名.md', filters: MD_FILTERS }
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  return res.canceled ? null : (res.filePath ?? null)
}

export function registerFileIpc(): void {
  ipcMain.handle('file:open-dialog', async (e): Promise<DocPayload | null> => {
    const path = await pickOpen(BrowserWindow.fromWebContents(e.sender))
    return path ? readDoc(path) : null
  })

  ipcMain.handle('file:read', async (_e, path: string): Promise<DocPayload> => readDoc(path))

  // path 为 null 时退化成另存为
  ipcMain.handle(
    'file:save',
    async (
      e,
      path: string | null,
      content: string,
      fingerprint: FileFingerprint
    ): Promise<{ path: string } | null> => {
      const target = path ?? (await pickSave(BrowserWindow.fromWebContents(e.sender), null))
      if (!target) return null
      await writeDoc(target, content, fingerprint)
      return { path: target }
    }
  )

  ipcMain.handle(
    'file:save-as',
    async (
      e,
      current: string | null,
      content: string,
      fingerprint: FileFingerprint
    ): Promise<{ path: string } | null> => {
      const target = await pickSave(BrowserWindow.fromWebContents(e.sender), current)
      if (!target) return null
      await writeDoc(target, content, fingerprint)
      return { path: target }
    }
  )
}
