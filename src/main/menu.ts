import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { basename } from 'node:path'
import type { MenuAction } from '../shared/types.js'
import { clearRecent, getRecent } from './store.js'

type OpenRecent = (path: string) => void

function send(action: MenuAction): void {
  BrowserWindow.getFocusedWindow()?.webContents.send('menu', action)
}

function recentSubmenu(onOpenRecent: OpenRecent): MenuItemConstructorOptions[] {
  const recents = getRecent()
  if (recents.length === 0) {
    return [{ label: '（暂无）', enabled: false }]
  }
  return [
    ...recents.map((p) => ({
      label: basename(p),
      sublabel: p,
      click: () => onOpenRecent(p)
    })),
    { type: 'separator' as const },
    {
      label: '清除最近文件',
      click: () => {
        clearRecent()
        buildMenu(onOpenRecent)
      }
    }
  ]
}

export function buildMenu(onOpenRecent: OpenRecent): void {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const, label: `关于 ${app.name}` },
              { type: 'separator' as const },
              { role: 'services' as const, label: '服务' },
              { type: 'separator' as const },
              { role: 'hide' as const, label: `隐藏 ${app.name}` },
              { role: 'hideOthers' as const, label: '隐藏其他' },
              { role: 'unhide' as const, label: '全部显示' },
              { type: 'separator' as const },
              { role: 'quit' as const, label: `退出 ${app.name}` }
            ]
          } satisfies MenuItemConstructorOptions
        ]
      : []),
    {
      label: '文件',
      submenu: [
        { label: '新建', accelerator: 'CmdOrCtrl+N', click: () => send('file:new') },
        { label: '打开…', accelerator: 'CmdOrCtrl+O', click: () => send('file:open') },
        {
          label: '打开文件夹…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => send('file:open-folder')
        },
        { label: '打开最近', submenu: recentSubmenu(onOpenRecent) },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => send('file:save') },
        { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('file:save-as') },
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        { label: '查找…', accelerator: 'CmdOrCtrl+F', click: () => send('edit:find') }
      ]
    },
    {
      label: '视图',
      submenu: [
        {
          label: '显示/隐藏侧边栏',
          accelerator: 'CmdOrCtrl+\\',
          click: () => send('view:toggle-sidebar')
        },
        { type: 'separator' },
        {
          label: '源代码模式',
          accelerator: 'CmdOrCtrl+/',
          click: () => send('view:toggle-source')
        },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'toggleDevTools', label: '开发者工具' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        ...(isMac
          ? [{ role: 'front' as const, label: '前置全部窗口' }]
          : [{ role: 'close' as const, label: '关闭' }])
      ]
    },
    {
      role: 'help',
      label: '帮助',
      submenu: [
        {
          label: 'CodeMirror 6 文档',
          click: () => shell.openExternal('https://codemirror.net/docs/')
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
