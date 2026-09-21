/**
 * 正文缩放（0.4.1）。⌘+ / ⌘− / ⌥⌘0 与触控板捏合共用这一份。
 *
 * **只缩正文，不动窗口。** 0.2.x–0.4.0 走的是 WKWebView 的 `pageZoom`：整张网页
 * 一起放大 —— 侧栏、标签、状态栏、按钮、图标全跟着变粗，窗口里装得下的东西越来越少，
 * 而人按 ⌘+ 想要的只有一件事：**字大一点**。现在这一层归渲染层，`--zoom` 只乘在
 * 两处（`editor/theme.ts`：正文字号 + 正文栏宽），chrome 一个像素都不动。
 * 壳那边因此不再碰 `pageZoom`，它恒为 1。
 *
 * **栏宽跟着一起乘，不是漏了。** `--column` 是按「一行 38 个汉字」定的
 * （`themes/base.css`）。只放大字号的话，一行能放的字数随缩放缩水 —— 150% 时只剩
 * 二十来个字，而版心宽度是这个应用的排版决定，不该被缩放顺手改掉。两个一起乘，
 * 看到的就是「同一版正文，离眼睛近了一点」，与从前 `pageZoom` 的手感一致。
 *
 * **档位是一张表，不是连乘。** 从前是 ×1.1 / ÷1.1，按三下得到 133.1%。现在这个数
 * 要摆到状态栏上给人读，那它就得是个能读的数 —— 与浏览器的缩放档位同一个道理。
 *
 * **真相在渲染层**（localStorage `cursive.zoom`），与主题/字号/栏宽同一条路。
 * 不广播给别的窗口：缩放是「这一个窗口此刻凑近看」，不是一份偏好 —— 各窗口各缩各的，
 * 最后写下的那份是下次启动的起点。
 */

const KEY = 'cursive.zoom'

/**
 * 档位表。上下界沿用壳里那对数（0.5 / 3.0）：再小正文认不出字，再大一行放不下几个字。
 * 从前那条「缩到点不中任何按钮」的理由现在不成立了 —— 按钮不再跟着缩。
 */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
export const ZOOM_MIN = ZOOM_STEPS[0]!
export const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1]!

/** 浮点比较的容差：档位表里都是两位小数，比它小一个数量级就够 */
const EPS = 1e-4

/** 外面来的一份缩放（localStorage 里那份，可能是上个版本写的、也可能被人手改过） */
export function normalizeZoom(z: number): number {
  if (!Number.isFinite(z)) return 1
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))
}

/** 下一档 / 上一档。当前值不在表上（老数据）也成立：取严格大于 / 小于它的第一档 */
export function stepZoom(current: number, dir: 1 | -1): number {
  const z = normalizeZoom(current)
  if (dir > 0) return ZOOM_STEPS.find((s) => s > z + EPS) ?? ZOOM_MAX
  return [...ZOOM_STEPS].reverse().find((s) => s < z - EPS) ?? ZOOM_MIN
}

/** 状态栏上那个数。整数百分比 —— 档位表保证了它不会出现 133% 这种读数 */
export function zoomLabel(z: number): string {
  return `${Math.round(normalizeZoom(z) * 100)}%`
}

export class Zoom {
  private z: number

  /**
   * `onChange` 里要做两件事：让 CodeMirror 重量一次（字号变了），刷状态栏。
   *
   * `restore` = 要不要把上次记着的那份接回来。**自检下传 false**（契约 v24）——
   * 探针里有一批按像素来的断言，带着上次留下的 125% 跑就全飘了。这条与壳侧
   * `lastFolder`、会话恢复短路是同一条理由，也正是从前 `pageZoom` 在自检下一律 1.0 的
   * 那条规矩搬过来的。**只是不读，照样能改**：缩放那条路本身还得测得到。
   */
  constructor(
    private readonly onChange: () => void,
    restore = true
  ) {
    this.z = restore ? normalizeZoom(load()) : 1
  }

  get value(): number {
    return this.z
  }

  get label(): string {
    return zoomLabel(this.z)
  }

  /** 100% 以外才算「缩着」—— 状态栏据此决定那一格露不露面 */
  get zoomed(): boolean {
    return Math.abs(this.z - 1) > EPS
  }

  step(dir: 1 | -1): void {
    this.set(stepZoom(this.z, dir))
  }

  reset(): void {
    this.set(1)
  }

  /** 把当前值贴到 `:root` 上并通知外面。启动时由 main.ts 调一次（同 `prefs.apply()`） */
  apply(): void {
    document.documentElement.style.setProperty('--zoom', String(this.z))
    this.onChange()
  }

  private set(z: number): void {
    // 顶到头再按一下：不落盘、也不让 CM 白重量一次
    if (Math.abs(z - this.z) < EPS) return
    this.z = z
    try {
      localStorage.setItem(KEY, String(z))
    } catch {
      /* 隐私模式 / 存储被禁：这一次照样缩，只是记不住 */
    }
    this.apply()
  }
}

function load(): number {
  try {
    return Number(localStorage.getItem(KEY) ?? 1)
  } catch {
    return 1
  }
}
