/**
 * 一个标签此刻的保存状态（ROADMAP 第八节 1）。
 *
 * 从前这件事只有**一个全局变量** `savedAt`：任何一个标签存成了就把它刷成此刻，
 * 状态栏那句「已保存 10:23」于是与「当前打开的是哪一份」无关 —— 后台标签的自动保存
 * 会给正在编辑的这一份挂上一句它自己从来没发生过的回执，切到一份**从来没存过**的
 * 文档上，那句话照样亮着。状态归到标签上，这类假话就不可能说出口。
 *
 * **四个状态不是四个字段，是「两件事实 + 一次判断」**：落过盘没有（`savedAt`）、
 * 此刻在不在写（`savingSince`）、上一次写坏了没有（`failure`）—— 而「有修改」这件事
 * 的真相在文档自己身上（`doc.eq(savedDoc)`），绝不另存一份，否则两处迟早说不到一块去。
 * `saveLabel` 把这三样加上「脏不脏」合成状态栏要显示的那一个。
 */

/** 一个标签的保存事实。三样都是「发生过什么」，不含任何显示决策 */
export interface SaveStatus {
  /** 上一次**成功写进真实路径**的时刻（`Date.now()`）。null = 这个标签还没落过盘 */
  savedAt: number | null
  /** 这一次写盘是什么时候开始的。null = 此刻没有写在飞 */
  savingSince: number | null
  /** 上一次写盘失败的原因（壳侧回的那句）。null = 没有待处理的失败 */
  failure: string | null
}

/** 状态栏那一格该显示什么。`none` = 什么都不显示（整格让出去，见 `#status-saved:empty`） */
export type SaveLabel =
  | { kind: 'none' }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'failed'; reason: string }

/**
 * 「正在保存…」**等到这么久才说**。
 *
 * 一次本地写盘通常几毫秒就回来了，照直渲染的话那句话只是在角落里闪一下 —— 闪烁比
 * 沉默更吵，而且什么信息都没传达（它结束得比人读完还快）。超过这个门槛才说，于是
 * 「正在保存…」真的出现时就意味着一件事：**这一次慢得不正常**（网络盘、磁盘忙）。
 * 门槛之内显示的是它本来的样子 —— 「未保存」，因为那时字节确实还没落地。
 */
export const SAVING_AFTER = 200

export function newSaveStatus(): SaveStatus {
  return { savedAt: null, savingSince: null, failure: null }
}

/**
 * 三样事实 + 脏不脏 → 状态栏那一格。**顺序本身就是产品判断**：
 *
 * ① **失败压倒一切**。它一直挂着直到人处理（重试 / 另存为 / 或者下一次成功写盘把它
 *    顶掉）—— 「保存失败」是这条状态栏上唯一一句不该自己消失的话。
 * ② **正在写**（且慢过门槛）。
 * ③ **有修改**排在「已保存」前面，这是**整条规矩的要害**：只要文档与盘上那份不一样，
 *    就不许显示「已保存 HH:MM」。人在写盘那几毫秒里继续打字、或者写完之后接着打，
 *    `savedAt` 都是新的 —— 可新的是**上一次**那些字节，手上这些还没落地。
 * ④ 剩下的才是「已保存 HH:MM」，没落过盘就什么都不说（新开一份空白文档的常态，
 *    没必要在角落里挂一句「未保存」吓人 —— 那时 ③ 也不成立，空文档不脏）。
 */
export function saveLabel(st: SaveStatus, dirty: boolean, now: number): SaveLabel {
  if (st.failure !== null) return { kind: 'failed', reason: st.failure }
  if (st.savingSince !== null && now - st.savingSince >= SAVING_AFTER) return { kind: 'saving' }
  if (dirty) return { kind: 'dirty' }
  if (st.savedAt !== null) return { kind: 'saved', at: st.savedAt }
  return { kind: 'none' }
}
