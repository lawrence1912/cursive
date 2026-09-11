// 从 build/icon.png（提交在仓库里的母版）生成 macOS 的 build/icon.icns。
// 用法：npm run icon
//
// 母版 icon.png 的设计源是 scripts/icon.html —— 用浏览器打开它截图/导出即可更新母版。
// 这里只用系统自带的 sips + iconutil，不依赖 Electron 或任何图形库。
import { execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const master = join(root, 'build', 'icon.png')
const iconset = join(root, 'build', 'typmd.iconset')

// .icns 需要的全套尺寸
const SIZES = [16, 32, 32, 64, 128, 256, 256, 512, 512, 1024]
const NAMES = [
  'icon_16x16', 'icon_16x16@2x', 'icon_32x32', 'icon_32x32@2x',
  'icon_128x128', 'icon_128x128@2x', 'icon_256x256', 'icon_256x256@2x',
  'icon_512x512', 'icon_512x512@2x'
]

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

console.log('icon: build/icon.icns')
