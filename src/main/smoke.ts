import { app, type BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/**
 * 开发用冒烟检查：TYPMD_SMOKE=<png 路径> 时，等窗口加载完就截图、
 * 打印渲染进程的报错，然后退出。用来在没法手动点界面的环境里确认
 * 渲染进程真的起来了（CSP 没拦、模块没挂）。
 *
 * 另外两个可选环境变量，用来验证实时预览：
 *   TYPMD_SMOKE_CURSOR=<文档偏移>  把光标放到指定位置（验证标记回显）
 *   TYPMD_SMOKE_SCROLL=<像素>      截图前先滚动
 *   TYPMD_SMOKE_EVAL=<JS>          截图前在渲染进程里跑一段代码（可 await）
 */
export function attachSmokeTest(win: BrowserWindow): void {
  const out = process.env['TYPMD_SMOKE']
  if (!out) return

  const problems: string[] = []

  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') {
      problems.push(`[${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`)
    }
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    problems.push(`did-fail-load ${code} ${desc} ${url}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    problems.push(`render-process-gone ${details.reason}`)
  })

  win.webContents.once('did-finish-load', () => {
    // 给 CodeMirror 时间把 DOM 铺开（打开文件还要多走一趟 IPC）
    setTimeout(() => {
      void (async () => {
        const evalJs = process.env['TYPMD_SMOKE_EVAL']
        if (evalJs) {
          await win.webContents.executeJavaScript(`(async () => { ${evalJs} })()`, true)
          await new Promise((r) => setTimeout(r, 500))
        }

        const cursor = process.env['TYPMD_SMOKE_CURSOR']
        const scroll = process.env['TYPMD_SMOKE_SCROLL']
        if (cursor || scroll) {
          await win.webContents.executeJavaScript(`(() => {
            const v = window.__typmd?.view
            if (!v) return
            ${cursor ? `v.dispatch({ selection: { anchor: Math.min(${cursor}, v.state.doc.length) } }); v.focus();` : ''}
            ${scroll ? `v.scrollDOM.scrollTop = ${scroll};` : ''}
          })()`)
          await new Promise((r) => setTimeout(r, 350))
        }

        const probe = await win.webContents.executeJavaScript(`(() => ({
          editors: document.querySelectorAll('.cm-editor').length,
          lines: document.querySelectorAll('.cm-line').length,
          hidden: document.querySelectorAll('.cm-editor [class*="cm-widgetBuffer"]').length,
          bullets: document.querySelectorAll('.cm-lp-bullet').length,
          checkboxes: document.querySelectorAll('.cm-lp-checkbox').length,
          images: document.querySelectorAll('.cm-lp-image img').length,
          rows: document.querySelectorAll('.sb-row').length,
          activeRow: document.querySelector('.sb-row.is-active .sb-name')?.textContent ?? null,
          emptyShown: !document.querySelector('.sb-empty')?.hasAttribute('hidden'),
          status: document.getElementById('status-file')?.textContent ?? '',
          mode: document.getElementById('status-mode')?.textContent ?? ''
        }))()`)

        const png = await win.capturePage()
        const target = resolve(out)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, png.toPNG())

        console.log('SMOKE probe:', JSON.stringify(probe))
        console.log('SMOKE shot:', target)
        console.log(
          problems.length ? `SMOKE problems:\n${problems.join('\n')}` : 'SMOKE problems: none'
        )
        app.exit(problems.length ? 1 : 0)
      })()
    }, 1200)
  })
}
