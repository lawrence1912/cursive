import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DocState } from '../shared/types.js'
import { readDoc, registerFileIpc } from './ipc/file.js'
import { registerDialogIpc } from './ipc/dialog.js'
import { registerFolderIpc } from './ipc/folder.js'
import { buildMenu } from './menu.js'
import { registerSafeFileProtocol, registerSafeFileScheme } from './protocol.js'
import { attachSmokeTest } from './smoke.js'
import { store } from './store.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface WinCtx {
  doc: DocState
  /** 关闭确认已走完，下一次 close 直接放行 */
  forceClose: boolean
}

const contexts = new Map<number, WinCtx>()

function ctxOf(win: BrowserWindow): WinCtx {
  let c = contexts.get(win.id)
  if (!c) {
    c = { doc: { path: null, dirty: false }, forceClose: false }
    contexts.set(win.id, c)
  }
  return c
}

function titleFor(doc: DocState): string {
  const name = doc.path ? basename(doc.path) : '未命名'
  return `${doc.dirty ? '• ' : ''}${name} — typmd`
}

/** preload 产物在 ESM 工程下是 .mjs，兼容两种扩展名 */
function preloadPath(): string {
  const mjs = join(__dirname, '../preload/index.mjs')
  return existsSync(mjs) ? mjs : join(__dirname, '../preload/index.js')
}

function createWindow(target?: { path: string; isDir: boolean }): BrowserWindow {
  const bounds = store.get('windowBounds')

  const win = new BrowserWindow({
    ...bounds,
    minWidth: 480,
    minHeight: 360,
    show: false,
    title: 'typmd',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: preloadPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  attachSmokeTest(win)
  win.once('ready-to-show', () => win.show())

  win.on('close', (e) => {
    const c = ctxOf(win)
    if (c.forceClose || !c.doc.dirty) {
      store.set('windowBounds', win.getBounds())
      return
    }
    e.preventDefault()
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['保存', '不保存', '取消'],
      defaultId: 0,
      cancelId: 2,
      message: '是否保存更改？',
      detail: `${c.doc.path ? basename(c.doc.path) : '未命名文档'} 有未保存的修改。`
    })
    if (choice === 2) return
    if (choice === 1) {
      c.forceClose = true
      win.close()
      return
    }
    // 让渲染进程存盘，存完它会回调 win:confirm-close
    win.webContents.send('menu', 'file:save-and-close')
  })

  win.on('closed', () => contexts.delete(win.id))

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  if (target) {
    win.webContents.once('did-finish-load', () => {
      if (target.isDir) {
        store.set('lastFolder', target.path)
        win.webContents.send('folder:opened', target.path)
        return
      }
      readDoc(target.path)
        .then((doc) => win.webContents.send('file:opened', doc))
        .catch(() => {})
    })
  }

  return win
}

function openInFocusedWindow(path: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win) {
    createWindow({ path, isDir: false })
    return
  }
  readDoc(path)
    .then((doc) => win.webContents.send('file:opened', doc))
    .catch((err) => dialog.showErrorBox('打不开文件', String(err)))
}

/**
 * 从 argv 里挑出第一个存在的路径（跳过 electron 自身、'.' 和各种开关）。
 * 传文件就打开文件，传目录就在侧边栏里打开这个文件夹。
 */
function firstPathArg(argv: string[]): { path: string; isDir: boolean } | null {
  const start = app.isPackaged ? 1 : 2
  for (const arg of argv.slice(start)) {
    if (arg.startsWith('-')) continue
    if (arg === '.' && !app.isPackaged) continue // 开发模式下这是 electron 的应用目录
    if (!existsSync(arg)) continue
    // 必须转成绝对路径：文档目录要用来解析图片相对路径，相对目录拼不出合法 URL
    const path = resolve(arg)
    return { path, isDir: statSync(path).isDirectory() }
  }
  return null
}

// macOS 上从 Finder 双击 .md 打开
let pendingOpen: string | null = null
app.on('open-file', (e, path) => {
  e.preventDefault()
  if (app.isReady()) openInFocusedWindow(path)
  else pendingOpen = path
})

// 特权协议必须在 app ready 之前登记
registerSafeFileScheme()

app.whenReady().then(() => {
  registerSafeFileProtocol()
  registerFileIpc()
  registerDialogIpc()
  registerFolderIpc()

  ipcMain.on('doc:state', (e, state: DocState) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    const c = ctxOf(win)
    const pathChanged = c.doc.path !== state.path
    c.doc = state
    win.setTitle(titleFor(state))
    win.setDocumentEdited(state.dirty)
    if (state.path) win.setRepresentedFilename(state.path)
    if (pathChanged) buildMenu(openInFocusedWindow)
  })

  ipcMain.on('win:confirm-close', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    ctxOf(win).forceClose = true
    win.close()
  })

  buildMenu(openInFocusedWindow)
  createWindow(
    (pendingOpen ? { path: pendingOpen, isDir: false } : null) ??
      firstPathArg(process.argv) ??
      undefined
  )
  pendingOpen = null

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
