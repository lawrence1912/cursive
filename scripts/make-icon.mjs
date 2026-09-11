// 用 Electron 自己离屏渲染图标，避免为了画一张图引入 canvas / 图形库。
// 用法：npx electron scripts/make-icon.mjs
import { app, BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const iconset = join(root, 'build', 'typmd.iconset')

// .icns 需要的全套尺寸
const SIZES = [16, 32, 32, 64, 128, 256, 256, 512, 512, 1024]
const NAMES = [
  'icon_16x16', 'icon_16x16@2x', 'icon_32x32', 'icon_32x32@2x',
  'icon_128x128', 'icon_128x128@2x', 'icon_256x256', 'icon_256x256@2x',
  'icon_512x512', 'icon_512x512@2x'
]

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false }
  })
  await win.loadFile(join(root, 'scripts', 'icon.html'))
  await new Promise((r) => setTimeout(r, 400))

  const png = (await win.capturePage()).toPNG()
  await mkdir(join(root, 'build'), { recursive: true })
  const master = join(root, 'build', 'icon.png')
  await writeFile(master, png)

  await rm(iconset, { recursive: true, force: true })
  await mkdir(iconset, { recursive: true })
  for (let i = 0; i < SIZES.length; i++) {
    await run('/usr/bin/sips', [
      '-z', String(SIZES[i]), String(SIZES[i]),
      master, '--out', join(iconset, `${NAMES[i]}.png`)
    ])
  }
  await run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(root, 'build', 'icon.icns')])
  await rm(iconset, { recursive: true, force: true })

  console.log('icon: build/icon.icns + build/icon.png')
  app.exit(0)
})
