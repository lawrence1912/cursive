/**
 * 标题栏的「放行区段」（契约 v26）。
 *
 * 原生拖拽条整条盖在 webview 上（`shell-swift` 的 `DragStripView`）—— 窗口拖拽和
 * 「点得到页面上的东西」是同一块地方上互斥的两件事，条子不挖洞，落在它下面的按钮
 * 和标签一个点击都收不到。壳里原来写死两段（两颗面板开关，左 72–110 / 右末尾 96–6），
 * 于是 base.css 的内边距、按钮尺寸与 Swift 里那几个数字**必须手动对齐**，三处注释
 * 各喊了一遍「改这里记得同步壳」。
 *
 * 正文的标签顶到最上面之后那套彻底不够用了：要放行的段数与位置跟着**标签数、窗口
 * 宽度、两侧面板的显隐、页面缩放**一起变。所以改成「渲染层量、壳照做」——
 * 这里按真实 rect 算出这一条上哪几段不归拖拽，其余照旧归原生（空白处仍然拖得动窗口、
 * 双击照旧缩放）。
 *
 * **为什么不让壳自己去问页面**：`hitTest` 是同步的，`evaluateJavaScript` 是异步的，
 * 鼠标按下那一刻问不出答案。只能由渲染层在布局变了之后推一次。
 */

/** 一段不归拖拽的横向区间，`[左, 右]`，CSS px（壳侧按 pageZoom 换成点） */
export type Hole = [left: number, right: number]

/** `getBoundingClientRect()` 的结构子集 —— 测试里直接喂字面量，不必有 DOM */
export interface RectLike {
  left: number
  right: number
  top: number
  bottom: number
}

/**
 * 两边各撑开这么多：边缘 1px 打偏的话，按钮那一格就会时灵时不灵。
 * 壳里原来写死的区间也留了这个余量（按钮 78–104，洞开到 72–110）。
 */
const PAD = 6

/**
 * 算出要挖的洞。
 *
 * 三条规矩：
 * ① **只认与条子上下相交的**元素 —— 条子只有 38 高，落在它下面的东西（编辑区、
 *    面板里的行）本来就点得到，挖了反而把能拖的地方越挖越少；
 * ② **横向裁到条子里** —— 标签栏是横向滚动的，滚出视口的那半截不能算；
 * ③ **相邻/重叠的合并** —— 一排标签本来就是连着的，不合并的话壳侧每次点击都要
 *    在几十段里线性找。
 */
export function holesFrom(rects: readonly RectLike[], strip: { width: number; height: number }): Hole[] {
  const raw: Hole[] = []
  for (const r of rects) {
    if (r.top >= strip.height || r.bottom <= 0) continue
    const left = Math.max(0, r.left - PAD)
    const right = Math.min(strip.width, r.right + PAD)
    if (right > left) raw.push([left, right])
  }
  raw.sort((a, b) => a[0] - b[0])

  const merged: Hole[] = []
  for (const h of raw) {
    const last = merged[merged.length - 1]
    if (last && h[0] <= last[1]) last[1] = Math.max(last[1], h[1])
    else merged.push([h[0], h[1]])
  }
  return merged
}

export interface HoleReporter {
  /** 布局可能变了（标签重画、面板开关、窗口 resize、缩放、标签栏横向滚动）*/
  schedule(): void
}

/**
 * 合帧 + 去重的上报器。
 *
 * **合帧**：`syncStatus()` 每次文档变化都会重画标签栏（自动保存落盘也算一次），
 * 一帧里量几十个 rect 再发一趟桥调用是白费的。
 * **去重**：绝大多数重画之后这几段一个像素都没动（改的是脏点、是标题），
 * 值没变就一个字节都不发 —— 与 `applyPageZoom` 那条「值没变就别写」同一个道理。
 */
export function createHoleReporter(opts: {
  collect: () => readonly RectLike[]
  strip: () => { width: number; height: number }
  send: (holes: Hole[]) => void
}): HoleReporter {
  let last = ''
  let queued = false

  const flush = (): void => {
    queued = false
    const holes = holesFrom(opts.collect(), opts.strip())
    // 取整再比：缩放/等分让 rect 带一串小数，肉眼看不出的抖动不值得发一趟桥调用
    const key = holes.map(([a, b]) => `${Math.round(a)},${Math.round(b)}`).join(' ')
    if (key === last) return
    last = key
    opts.send(holes)
  }

  return {
    schedule(): void {
      if (queued) return
      queued = true
      requestAnimationFrame(flush)
    }
  }
}
