/**
 * 块级 widget 的高度记忆 —— 落盘那一半（落盘之外的部分在 `widgets.ts` 的 `heightMemo`）。
 *
 * 为什么要落盘：CM 只渲染视口附近那一段，视口之外的块按 `WidgetType.estimatedHeight` 估高。
 * 估不出来（应用刚打开、这张图/这条公式还没量过）就按默认值算，等真渲染到那一块、
 * 高度一换上，后面的内容就跳一下。高度是**量**出来的，而「同一张图在同样排版条件下有多高」
 * 跨进程是稳定的 —— 所以把手里的这份记到 localStorage：第一次见到某个块的那一下位移消不掉
 * （那时确实没人量过），能消掉的是「每次开应用、每次滚动都要重新跳一遍」。
 *
 * 为什么 key 里带排版条件：栏宽、字体、字号、行距、窗口高都会改变像素高度
 * （图片的 CSS 有 `max-height: 60vh`，窗口一变高度就变）。对不上就整份丢掉 ——
 * 宁可多跳一次，也不要按错误的高度排版。
 */

/** 存进去的形状。`v` 是格式版本：将来字段变了直接弃旧，不做迁移 */
export interface HeightStore {
  v: number
  layout: string
  entries: Record<string, number>
}

export const HEIGHT_STORE_KEY = 'cursive.widgetHeights'
/**
 * 2：块级 widget 的上下留白从 margin 改成 padding（`themes/live-preview.css` 开头那段），
 * 同一个 key 量到的高度整体变高了十几 px —— 旧值不是「旧格式」而是**错的**，直接弃掉
 */
export const HEIGHT_STORE_VERSION = 2
/** 与内存里那份同一个上限，避免编辑久了存储无限长大 */
export const HEIGHT_STORE_MAX = 256

/** 只用到这两个方法的存储。给单测传桩用，浏览器里传 localStorage */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** localStorage 在某些环境（隐私模式、被策略禁掉）读一下就抛，拿不到就当没有 */
export function browserStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

/** 解析落盘的那串 JSON。换过版本、被人手改过、根本不是对象 —— 一律当没有 */
export function parseHeightStore(raw: string | null): HeightStore | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<HeightStore> | null
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.v !== HEIGHT_STORE_VERSION) return null
    if (typeof parsed.layout !== 'string' || !parsed.layout) return null
    const entries = parsed.entries
    if (!entries || typeof entries !== 'object') return null
    const clean: Record<string, number> = {}
    for (const [key, value] of Object.entries(entries)) {
      // 手改过的文件里可能是字符串/NaN，收进来会让 CM 拿到非法高度
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) clean[key] = value
    }
    return { v: HEIGHT_STORE_VERSION, layout: parsed.layout, entries: clean }
  } catch {
    return null
  }
}

/** 排版条件对得上才认那份高度；对不上返回空 —— 旧条件下的像素高度就是错的 */
export function heightsForLayout(
  store: HeightStore | null,
  layout: string
): Record<string, number> {
  return store && store.layout === layout ? store.entries : {}
}

/** 打包一份准备落盘。Map 是插入序，超上限时丢最旧的（≈ LRU） */
export function packHeightStore(
  layout: string,
  entries: Map<string, number>,
  max = HEIGHT_STORE_MAX
): HeightStore {
  const keys = [...entries.keys()]
  const keep = keys.length > max ? keys.slice(keys.length - max) : keys
  const out: Record<string, number> = {}
  for (const key of keep) out[key] = entries.get(key)!
  return { v: HEIGHT_STORE_VERSION, layout, entries: out }
}

export function loadHeightStore(storage: StorageLike | undefined): HeightStore | null {
  if (!storage) return null
  try {
    return parseHeightStore(storage.getItem(HEIGHT_STORE_KEY))
  } catch {
    return null
  }
}

export function saveHeightStore(storage: StorageLike | undefined, store: HeightStore): void {
  if (!storage) return
  try {
    storage.setItem(HEIGHT_STORE_KEY, JSON.stringify(store))
  } catch {
    // 存不下（配额满 / 隐私模式）就只靠内存那一份，不影响渲染
  }
}
