// 从矢量源 brand/app-icon.svg 生成 macOS 的 build/icon.icns（母版 build/icon.png 顺带产出）。
// 用法：npm run icon
//
// 只用系统自带的 sips + iconutil，不依赖浏览器、Electron 或任何图形库 ——
// sips 直接吃 SVG（渐变/柔和投影/透明都保真），所以**设计源只有 brand/app-icon.svg 一份**，
// 不再有「HTML 导出页与 SVG 各画一遍、迟早对不上」的问题。
import { execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'brand', 'app-icon.svg')
const master = join(root, 'build', 'icon.png')
const iconset = join(root, 'build', 'cursive.iconset')

// .icns 需要的全套尺寸
const SIZES = [16, 32, 32, 64, 128, 256, 256, 512, 512, 1024]
const NAMES = [
  'icon_16x16', 'icon_16x16@2x', 'icon_32x32', 'icon_32x32@2x',
  'icon_128x128', 'icon_128x128@2x', 'icon_256x256', 'icon_256x256@2x',
  'icon_512x512', 'icon_512x512@2x'
]

await mkdir(join(root, 'build'), { recursive: true })
// 1024 母版：矢量直出，不经中间尺寸（每一档都从 SVG 重新栅格，小尺寸才不糊）
await run('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '1024', source, '--out', master])

await rm(iconset, { recursive: true, force: true })
await mkdir(iconset, { recursive: true })
for (let i = 0; i < SIZES.length; i++) {
  await run('/usr/bin/sips', [
    '-s', 'format', 'png', '-Z', String(SIZES[i]),
    source, '--out', join(iconset, `${NAMES[i]}.png`)
  ])
}
await run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(root, 'build', 'icon.icns')])
await rm(iconset, { recursive: true, force: true })

console.log('icon: build/icon.png + build/icon.icns（源：brand/app-icon.svg）')
