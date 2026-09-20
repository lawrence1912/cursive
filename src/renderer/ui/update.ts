import type { UpdateInfo } from '../../shared/types'
import { t } from '../i18n'
import { note } from './note'

/**
 * 检查更新（0.3.0 T2）。
 *
 * 整件事只有三步：**问壳要一眼**（契约 v27，联网的是壳 —— 页面的 CSP 出不去）→
 * **比两个版本号** → **在状态栏说一句**。不下载、不安装、不后台轮询：
 * 这个应用不引 Sparkle 的理由写在 ROADMAP 第八节，而「只在点的时候联网」是条红线。
 *
 * 比版本那一半是纯函数、能被测；说话那一半碰 DOM 与桥、进不了 node 测试 ——
 * 按 `ui/goto.ts` 的老办法拆成两截，会错的东西全留在上半截。
 */

/** 解析出来的版本。`nums` 永远三段（缺的补 0），`pre` 是 `-` 后面那一截（没有就空串） */
interface Parsed {
  nums: [number, number, number]
  pre: string
}

/**
 * `v0.3.0` / `V0.3` / `1.2.3-rc.1` / `0.3.0+build.7` 都收，认不出来回 null。
 * （前缀大小写都认：tag 怎么打是发版那天手上的事，不该由它决定能不能比）
 *
 * **认不出就不猜**：一个解析不了的 tag 宁可报「没问着」，也不能拿字符串比一下就说
 * 有新版本 —— `'0.10.0' < '0.9.0'` 正是字符串比会比反的那一对，而这个项目迟早走到 0.10。
 */
function parse(v: string): Parsed | null {
  const m = /^[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim())
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], pre: m[4] ?? '' }
}

/**
 * 预发布段比大小（semver 11.4）：按 `.` 拆开逐段比，纯数字段按数值比且**排在**
 * 带字母的段前面；前缀相同时段数少的在前（`1.0.0-rc` < `1.0.0-rc.1`）。
 *
 * 为什么不省掉这一段：`0.3.0-rc.1` 与 `0.3.0` 的先后**必须**是对的 —— 比反了的后果是
 * 「已经在正式版上了，还被告知有新版本」，而那正是 rc 存在的那几天里最容易发生的事。
 */
function comparePre(a: string, b: string): number {
  const xs = a.split('.')
  const ys = b.split('.')
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const x = xs[i]
    const y = ys[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1
    if (xn !== yn) return xn ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

/**
 * `a` 比 `b` 新回正数、旧回负数、一样回 0；**任何一边认不出来回 `null`**
 * （调用方据此走「没问着」那条路，而不是默默当成「已是最新」）。
 */
export function compareVersions(a: string, b: string): number | null {
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i]! < y.nums[i]! ? -1 : 1
  }
  if (x.pre === y.pre) return 0
  // 预发布排在正式版**前面**：0.3.0-rc.1 < 0.3.0（semver 11.3）
  if (!x.pre) return 1
  if (!y.pre) return -1
  return comparePre(x.pre, y.pre)
}

/**
 * 状态栏该说哪一句。四档，其中两档长得像但不是一回事：
 * `none` = 问着了、那边还没发过 release；`unknown` = 没问着（断网 / 限流 / tag 认不出来）。
 */
export type Verdict =
  | { kind: 'newer'; latest: string; current: string; url: string }
  | { kind: 'current'; version: string }
  | { kind: 'none' }
  | { kind: 'unknown' }

/** 显示用：tag 上的 `v` 前缀剥掉，好与 `current`（Info.plist 里从来不带 v）摆在同一句话里 */
function display(v: string): string {
  return v.replace(/^[vV]/, '')
}

/**
 * 壳交回来的那一眼 → 该说的那一句。**纯函数**，这一层是 `test/update.test.ts` 的全部靶子。
 */
export function verdict(info: UpdateInfo | null): Verdict {
  if (!info) return { kind: 'unknown' }
  if (info.latest === null) return { kind: 'none' }
  const cmp = compareVersions(info.latest, info.current)
  if (cmp === null) return { kind: 'unknown' }
  // 比当前**旧**的也算「已是最新」：本机跑着一个还没发布的构建时就是这一种，
  // 而「你比最新的还新」对用户不是一条有用的消息
  if (cmp <= 0) return { kind: 'current', version: display(info.current) }
  return {
    kind: 'newer',
    latest: display(info.latest),
    current: display(info.current),
    url: info.url
  }
}

/**
 * 同一时刻只问一次。一次往返要过网络（壳侧超时 10s），这中间再点一下菜单
 * 不该变成第二发请求 —— 状态栏上那句「正在检查更新…」已经在说这件事了。
 */
let inFlight = false

/** 菜单「检查更新」那一下。走完必定在状态栏留一句话 —— 点了没反应是最糟的失败方式 */
export async function checkForUpdate(): Promise<void> {
  if (inFlight) return
  inFlight = true
  // 先说「正在检查」：慢的时候要好几秒，中间静默就是「点了没反应」
  note(t('up.checking'))
  let info: UpdateInfo | null = null
  try {
    info = await window.api.checkUpdate()
  } catch {
    // 壳侧一切失败都回 null，这里接的是「桥自己出了岔子」那一种
    info = null
  } finally {
    inFlight = false
  }
  const v = verdict(info)
  if (v.kind === 'unknown') {
    note(t('up.failed'), { warn: true })
    return
  }
  // 「那边还没发过版本」不是失败，别用黄色：这一下什么都没出错
  if (v.kind === 'none') {
    note(t('up.none'))
    return
  }
  if (v.kind === 'current') {
    note(t('up.latest', { version: v.version }))
    return
  }
  // 有新版本**不自作主张把浏览器唤起来**：给一颗按钮（契约 v25 那条回执通道，
  // 有按钮时停留 8 秒）。点菜单的人想知道的是「有没有」，去不去看是下一个决定
  note(t('up.found', { version: v.latest, current: v.current }), {
    action: {
      label: t('up.view'),
      run: () => {
        void window.api.openExternal(v.url).then((opened) => {
          if (!opened) note(t('link.failed', { target: v.url }), { warn: true })
        })
      }
    }
  })
}
