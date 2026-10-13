import { browserStorage, type StorageLike } from '../editor/live-preview/height-store'

/**
 * **会话恢复**（0.2.x）：关掉再开，回到上次那几个标签、那个位置。
 *
 * 在此之前，重开应用只剩「双击的那份文档」——`sidebar.restore()` 恢复的只是树根，
 * 标签、滚动位置、光标全都只活在内存里。崩溃恢复（scratch）管的是**没存过的草稿**，
 * 与这里是两回事：那边救的是内容，这边救的是**现场**。
 *
 * 三条边界：
 * - **按工作区根分组**：一个窗口 = 一个工作区（契约 v19），A 文件夹的标签不该在 B 窗口里冒出来。
 * - **只记有路径的标签**：无路径的草稿归 scratch 管，两边都记就会开出两份。
 * - **自检下整条关掉**（契约 v23）：探针要的是确定的起点。
 *
 * 存的是「哪几个文件 + 滚到哪儿 + 光标在哪儿」，不存内容 —— 内容在磁盘上，
 * 恢复时按路径读；文件没了就跳过那一条，绝不把一个空壳标签摆出来。
 */

export interface SessionTab {
  path: string
  /** 滚动位置（像素）。排版条件变了会不准，但差一点也比回到文首强 */
  scroll: number
  /** 光标偏移 */
  cursor: number
  /**
   * 只读阅读模式（第八节 5）。**只在为真时写**：老会话里没有这一项，读出来就是「可编辑」，
   * 版本号因此不用动（`SESSION_VERSION` 一变，所有人上次的标签就全丢了）
   */
  readOnly?: true
  /**
   * 预览标签（单击文件树开的那一格）。同 `readOnly`，只在为真时写、老会话读出来就是普通标签 ——
   * 不记的话，关掉再开那一格就成了普通标签，下一次单击另开一格，它却赖着不走
   */
  preview?: true
}

export interface Session {
  v: number
  tabs: SessionTab[]
  /** 活动标签在 `tabs` 里的下标 */
  active: number
}

export const SESSION_VERSION = 1
export const SESSION_PREFIX = 'cursive.session:'
/** 最多记这么多标签 —— 上限不设的话，一个开过三百个文件的窗口会把存储塞满 */
export const SESSION_MAX = 24

/** 按工作区根分组：`sessionKey(null)` 没有意义，调用方先确认拿到了根 */
export function sessionKey(root: string): string {
  return SESSION_PREFIX + root
}

/** 解析存下来的那串 JSON。换过版本、被人手改过、根本不是对象 —— 一律当没有 */
export function parseSession(raw: string | null): Session | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<Session> | null
    if (!parsed || typeof parsed !== 'object' || parsed.v !== SESSION_VERSION) return null
    if (!Array.isArray(parsed.tabs)) return null
    const tabs: SessionTab[] = []
    for (const t of parsed.tabs) {
      // 手改过的文件里什么都可能有：路径不是字符串、坐标是 NaN / 负数 / 字符串
      if (!t || typeof t !== 'object') continue
      const path = (t as SessionTab).path
      if (typeof path !== 'string' || !path) continue
      tabs.push({
        path,
        scroll: safeNum((t as SessionTab).scroll),
        cursor: safeNum((t as SessionTab).cursor),
        // 只认严格的 true：手改成 "yes"、1 之类的一律当可编辑 —— 认错了的代价是一份文档
        // 莫名其妙打不了字，而当成可编辑最坏也就是少了一把锁
        ...((t as SessionTab).readOnly === true ? { readOnly: true as const } : {}),
        // 认错了的代价反过来：当成普通标签最坏也就是多留一格，当成预览会被下一次单击顶掉
        ...((t as SessionTab).preview === true ? { preview: true as const } : {})
      })
    }
    if (!tabs.length) return null
    const active = typeof parsed.active === 'number' && parsed.active >= 0 && parsed.active < tabs.length
      ? Math.floor(parsed.active)
      : 0
    return { v: SESSION_VERSION, tabs, active }
  } catch {
    return null
  }
}

function safeNum(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/**
 * 打包一份准备落盘。超上限时**留最后那些**（≈ 最近用的），并把活动标签的下标跟着搬；
 * 活动标签要是正好被截掉，就退回 0 —— 恢复出来总得有个活动标签。
 */
export function packSession(tabs: SessionTab[], active: number, max = SESSION_MAX): Session {
  const from = Math.max(0, tabs.length - max)
  const kept = tabs.slice(from)
  const moved = active - from
  return {
    v: SESSION_VERSION,
    tabs: kept,
    active: moved >= 0 && moved < kept.length ? moved : 0
  }
}

export function loadSession(storage: StorageLike | undefined, root: string): Session | null {
  if (!storage) return null
  try {
    return parseSession(storage.getItem(sessionKey(root)))
  } catch {
    return null
  }
}

export function saveSession(storage: StorageLike | undefined, root: string, session: Session): void {
  if (!storage) return
  try {
    // 一个标签都不剩时照样写（`parseSession` 把空清单当成「没有会话」）——
    // 省掉一个 `removeItem`，也就省掉「StorageLike 要不要多一个方法」这件事
    storage.setItem(sessionKey(root), JSON.stringify(session))
  } catch {
    // 存不下（配额满 / 隐私模式）就这一次不记，下次再说
  }
}

export { browserStorage, type StorageLike }

/**
 * 恢复计划：给定「上次那份会话」与「这个窗口现在已经开着的路径」，回答两件事 ——
 * **还要开哪几个**、**开完该落在谁身上**。
 *
 * 规矩只有三条，但每一条都是踩过的：
 * ① **已经开着的不再开一遍**（argv/Finder 那份文档启动时就在了）；
 * ② **启动带进来的那份文档说了算**（`launched`）—— 恢复出来的是背景内容，
 *    把用户刚双击的那份挤到后面去是最难受的一种「聪明」；
 * ③ 没有启动文档时才听会话的活动标签；它要是读不出来（文件没了），
 *    调用方按实际开出来的那些自己兜底。
 */
export interface RestorePlan {
  /** 还要新开的路径，按会话里的先后 */
  open: string[]
  /** 开完之后该激活的那个路径；null = 听启动那份文档的 */
  focus: string | null
}

export function planRestore(saved: Session, openPaths: readonly string[], launched: boolean): RestorePlan {
  const already = new Set(openPaths)
  return {
    open: saved.tabs.map((t) => t.path).filter((p) => !already.has(p)),
    // 下标越界就退回第一个：`parseSession` 那层已经夹过一次，这儿再兜一次
    // —— 「恢复出来没有落点」比「落点不是最想要的那个」难受得多
    focus: launched ? null : ((saved.tabs[saved.active] ?? saved.tabs[0])?.path ?? null)
  }
}

/**
 * 恢复跑完了，到底要不要切标签（0.4.1 修）。回 `null` = **一个都别动**。
 *
 * 恢复是异步的：每读一个文件都让出一次事件循环，而第一份文件在第一轮就接管了启动
 * 那个空白标签、当场进了视图。这段时间人完全可能已经在打字了 —— 于是末尾那一次
 * `activate` 有两种错法，都是「聪明反被聪明误」：
 *
 * ① **落点就是当前这个标签**：`activate` 里「先拿视图当它的内容存下来」那句被
 *    `cur.id !== id` 挡着（同一个 id 走不到），紧接着 `view.setState(tab.state)`
 *    就用读盘时那份把人敲进去的字整个盖掉，光标与滚动位置一并回到会话里那个值。
 *    而这一步本来就没什么可切的 —— 那次接管的 activate 已经把落点摆好了。
 * ② **人动过文档，落点却是别的标签**：字不会丢（切走时会存下来），但人会被从
 *    正在打字的那个标签上拽开。会话恢复是**背景行为**，同「别把刚双击打开的那份
 *    挤下去」是一条规矩的两半。
 * ③ **人自己切过标签**：同上一条，只是他表达意图的方式是点了一下标签栏而不是打字。
 *
 * **两个信号都必须是「抹不平」的那种**：`typed` 从前是拿 `tab.state.doc` 与视图里
 * 那份一比 —— 可自动保存（停手 2s）与切标签都会把 `tab.state` 重新同步成视图那份，
 * 一比又相等了，人打过的字于是「不算数」。所以改成**计数**（编辑发生过就再也回不去）
 * 与**身份比对**（活动标签还是不是恢复自己摆上去的那个），两者都不随时间复原。
 */
export function restoreFocus(opts: {
  /** 会话算出来的落点；null = 没有落点（文件没了 / 一个都没开出来） */
  focus: number | null
  /** 此刻的活动标签 */
  active: number
  /** 这段时间里人往文档里敲过字吗 */
  typed: boolean
  /** 这段时间里人自己切过标签吗（活动标签已经不是恢复摆上去的那个了） */
  moved: boolean
}): number | null {
  if (opts.focus === null || opts.focus === opts.active) return null
  if (opts.typed || opts.moved) return null
  return opts.focus
}
