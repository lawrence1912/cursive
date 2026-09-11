import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { DiscardChoice } from '../../shared/types.js'

export function registerDialogIpc(): void {
  // 只放行 http(s)，别把 file:// 之类的交给系统去开
  ipcMain.handle('shell:open-external', async (_e, url: string): Promise<void> => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })

  // 新建/打开时若当前文档为脏，先问一次，避免静默丢改动
  ipcMain.handle('dialog:confirm-discard', async (e, name: string): Promise<DiscardChoice> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      type: 'warning' as const,
      buttons: ['保存', '不保存', '取消'],
      defaultId: 0,
      cancelId: 2,
      message: '是否保存更改？',
      detail: `${name} 有未保存的修改。`
    }
    const { response } = win
      ? await dialog.showMessageBox(win, opts)
      : await dialog.showMessageBox(opts)
    return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel'
  })
}
