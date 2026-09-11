import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * 只构建渲染层（纯 CodeMirror 6），产物 out/renderer。
 * 原生能力全部由 Swift 壳通过 window.api 提供，构建链里没有 Electron。
 *
 * base: './' —— 壳经自定义协议 `app://r/` 加载 index.html，相对路径是唯一稳妥的写法。
 */
export default defineConfig({
  root: resolve('src/renderer'),
  base: './',
  resolve: {
    alias: {
      '@': resolve('src/renderer'),
      '@shared': resolve('src/shared')
    }
  },
  build: {
    outDir: resolve('out/renderer'),
    emptyOutDir: true,
    rollupOptions: { input: { index: resolve('src/renderer/index.html') } }
  }
})
