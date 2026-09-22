/**
 * 「这份文件为什么打不开」（ROADMAP 第八节 4，契约 v35）。
 *
 * 壳侧把读盘失败分成四类回过来，形状是 `<类别>|<路径>` —— **一个字的文案都不带**：
 * 话由这边说，因为只有这边知道此刻该给哪颗按钮，也只有这边有那两份字典。
 *
 * 从前四种失败在渲染层长得一模一样（都是一句「读不到文件：<路径>」），而且
 * **两条最常走的路压根没接住它**（文件树点一下、搜索结果点一下都没有 catch）——
 * 于是点开一个 GBK 编码的 .md，屏幕上什么都不会发生，控制台里多一条没人看的
 * unhandled rejection。「点了没反应」是这个应用最不该有的失败方式。
 */

/**
 * - `notUtf8`：读到了，但不是 UTF-8 文本（GBK / Big5 / 二进制冒充 .md）。**不会自己好**；
 * - `notFound`：那个路径上没有东西（树里那一行过期了 / 刚被别处删掉或改名）；
 * - `denied`：在，但读不动（权限）。**不会自己好**；
 * - `io`：其余（盘掉了、读到一半坏了…）。这一类值得给一颗「重试」。
 */
export type ReadFailKind = 'notUtf8' | 'notFound' | 'denied' | 'io'

/**
 * 那条竖线后面是**路径**。菜单「打开」那条路上渲染层手里没有路径（是人在原生面板里
 * 挑的），只能从这句话里拿（契约 v36）
 */
export function readFailPath(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const at = msg.indexOf('|')
  return at < 0 ? '' : msg.slice(at + 1)
}

/** 写盘那一刻发现盘上那份已经不是我们以为的那份了（契约 v36 的 compare-and-swap） */
export function isStaleWrite(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.startsWith('stale|')
}

const KINDS: readonly ReadFailKind[] = ['notUtf8', 'notFound', 'denied', 'io']

/**
 * 从壳侧那个 Error 里认出类别。**认不出来一律当 `io`** —— 这条通道将来多一类、
 * 或者哪天有人在别处 `throw new Error('boom')`，都不该让「打不开」这句话本身消失。
 */
export function readFailKind(e: unknown): ReadFailKind {
  const msg = e instanceof Error ? e.message : String(e)
  const head = msg.slice(0, msg.indexOf('|'))
  return (KINDS as readonly string[]).includes(head) ? (head as ReadFailKind) : 'io'
}

/** 这几类**不会自己好**，所以那条提示不许 4 秒自散（第八节 4 的「不只依赖短暂通知」） */
export function readFailSticky(kind: ReadFailKind): boolean {
  return kind === 'notUtf8' || kind === 'denied'
}
