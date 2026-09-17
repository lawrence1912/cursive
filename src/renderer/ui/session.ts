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
      tabs.push({ path, scroll: safeNum((t as SessionTab).scroll), cursor: safeNum((t as SessionTab).cursor) })
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
