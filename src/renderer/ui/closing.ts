import type { FileFingerprint } from '../../shared/textfile'

/**
 * 关窗那一下的批量落盘（0.4.1 修）。
 *
 * 壳侧 `windowShouldClose` 看见 `dirty` 就不放行，改发一条 `file:save-and-close`
 * 过来（`main.swift` 的「关闭拦截」）；渲染层把所有脏标签一个个存掉，全成功才回
 * `confirmClose()`。**任何一个被取消就整批停下** —— 同标签右键菜单那几条批量命令
 * （继续存下去等于「用户说了这个不要存，那就把别的都存了吧」）。
 *
 * **提成一层是为了能测**：这条路上会错的三件事全是时序，而它们一个都不需要 DOM ——
 *
 * ① **取消之后要把「还有脏东西」重新告诉壳**：壳侧那个 `dirty` 是**一个全局位**，
 *    每次写盘成功就清零（`main.swift` 的 save 分支）。两个脏标签先存成一个、再取消
 *    一个，壳这边已经是「干净」了 —— 不重新同步的话，下一次关窗 `windowShouldClose`
 *    直接放行，剩下那几个标签的改动一声不响地没了。这是整条路上唯一会真丢东西的分支。
 * ② **无标题标签要接管保存面板给的路径**：不接管的话它还顶着「未命名」，
 *    下一次自动保存又往 scratch 里写一份，关掉重开就多出一个假草稿。
 * ③ **接管了就得把 scratch 那份清掉**（同 `save()` 里那三件事）。
 *
 * 这一层不认识 `EditorState`，也不碰状态栏：字节由调用方给，存成功之后的
 * `savedDoc` / `docPath` / 快照由 `onSaved` 回去做。
 */

/** 批量落盘只认标签的这几样。`main.ts` 的 `Tab` 结构上满足它 */
export interface SavableTab {
  id: number
  path: string | null
  fp: FileFingerprint
  /** 无路径标签在崩溃恢复目录里那份的 id（存成真文件之后要清掉） */
  scratchId?: string
}

export interface SaveIO {
  save(
    path: string | null,
    content: string,
    fingerprint: FileFingerprint
  ): Promise<{ path: string } | null>
  scratchClear(id: string): void
}

/**
 * 逐个存。回 `true` = 全存下了（调用方接着 `confirmClose()`）；
 * 回 `false` = 有人点了取消，**这一批到此为止，窗口留着**。
 *
 * `text(tab)` 取这个标签此刻的字节 —— 活动标签的内容在视图里而不在 `tab.state` 上，
 * 那件事归调用方判断（见 `viewTabId`）。
 */
export async function saveDirtyTabs<T extends SavableTab>(
  dirty: readonly T[],
  io: SaveIO,
  text: (tab: T) => string,
  onSaved: (tab: T, path: string) => void
): Promise<boolean> {
  for (const tab of dirty) {
    const res = await io.save(tab.path, text(tab), tab.fp)
    if (!res) return false
    tab.path = res.path
    if (tab.scratchId) {
      io.scratchClear(tab.scratchId)
      tab.scratchId = undefined
    }
    onSaved(tab, res.path)
  }
  return true
}
