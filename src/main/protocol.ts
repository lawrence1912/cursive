import { net, protocol } from 'electron'
import { normalize } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 渲染进程里 `<img src="assets/a.png">` 是加载不到本地文件的 —— file:// 会被
 * CSP 和 webSecurity 挡住，而关掉 webSecurity 是不能接受的。所以注册一个
 * 自定义协议，由主进程读盘：safe-file://local/<绝对路径>
 */
const SCHEME = 'safe-file'

/** 必须在 app ready 之前调用 */
export function registerSafeFileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

/** 必须在 app ready 之后调用 */
export function registerSafeFileProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    try {
      const path = normalize(decodeURIComponent(new URL(request.url).pathname))
      return await net.fetch(pathToFileURL(path).toString())
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}
