const { execFile } = require('node:child_process')
const { join } = require('node:path')
const { promisify } = require('node:util')

const run = promisify(execFile)

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.lawrence.typmd',
  productName: 'typmd',
  copyright: 'Copyright © 2026 Lawrence',
  // 渲染/主进程都已经由 electron-vite 打进 out/，源码不需要进包
  files: ['out/**/*', '!**/*.map'],
  directories: { buildResources: 'build', output: 'dist' },

  mac: {
    icon: 'build/icon.icns',
    category: 'public.app-category.productivity',
    target: ['dmg'],
    darkModeSupport: true,
    // Electron 自带 220 份语言包，占了 60MB+，自用只留这两份
    electronLanguages: ['en-US', 'zh-CN'],
    // 自用不做公证签名；下面 afterPack 会补一个 ad-hoc 签名让包能正常执行
    identity: null,
    extendInfo: {
      NSHumanReadableCopyright: 'Copyright © 2026 Lawrence'
    }
  },

  // 让 Finder 双击 .md 能唤起 typmd（主进程的 open-file 事件靠这个才生效）。
  // rank: Alternate = 出现在「打开方式」里但不抢默认；想设为默认改成 Owner。
  fileAssociations: [
    {
      ext: ['md', 'markdown', 'mdown', 'mkd'],
      name: 'Markdown 文档',
      description: 'Markdown 文档',
      role: 'Editor',
      rank: 'Alternate'
    }
  ],

  dmg: {
    title: 'typmd',
    contents: [
      { x: 140, y: 200, type: 'file' },
      { x: 400, y: 200, type: 'link', path: '/Applications' }
    ]
  },

  /**
   * electron-builder 在 identity:null 时会完全跳过签名，留下 Electron 二进制自带的
   * linker 签名 —— bundle 层面是坏的（Identifier=Electron、Sealed Resources=none），
   * `codesign --verify` 过不去。Apple Silicon 上二进制必须有有效签名才能执行，
   * 所以这里补一个 ad-hoc 签名（自用足够，不做公证）。
   */
  afterPack: async (context) => {
    if (context.electronPlatformName !== 'darwin') return
    const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
    await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath])
    await run('/usr/bin/codesign', ['--verify', '--strict', appPath])
    console.log(`  • ad-hoc signed  path=${appPath}`)
  }
}
