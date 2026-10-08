/**
 * 第八节 7：重新打开关闭的标签。
 *
 * 一个栈：关一个有路径的标签就压一格，「重新打开」弹最近那一格。三条边界：
 * - **只认有路径的**：路径就是它回来的路（内容按路径重新读盘）。无路径的草稿首版不救 ——
 *   人在「是否保存」里点了「不保存」，那就是他明确不要了；救回来是另一件事（scratch 管的是崩溃，
 *   不是反悔）；
 * - **已经开着的不出第二份**：一个路径只要重新开着了（不管是从这里、文件树还是链接开的），
 *   就从栈里摘掉（`forget`）—— 栈里永远只有「此刻真的关着」的那些；
 * - **带着位置回来**：光标、滚动、只读这一位，与会话恢复同一套口径（`ui/session.ts`）。
 *
 * 只在内存里（同导航记录）：关掉窗口再开，那是会话恢复的地盘。纯逻辑，`test/closed-tabs.test.ts`。
 */
export interface ClosedTab {
  path: string
  /** 光标偏移 */
  cursor: number
  /** 滚动位置（像素），同会话恢复：排版条件变了会不准，但差一点也比回到文首强 */
  scroll: number
  /** 关掉时是不是只读（第八节 5）—— 误关一份参考文档，回来时还该是只读的 */
  readOnly: boolean
}

/** 记多少个。再多就是「我关过哪些文件」的历史了，那是最近文件菜单的事 */
export const CLOSED_MAX = 20

export class ClosedTabs {
  private stack: ClosedTab[] = []

  get size(): number {
    return this.stack.length
  }

  /** 关了一个有路径的标签。同一个路径只留最近那一次（关两遍不该回来两份） */
  push(tab: ClosedTab): void {
    this.forget(tab.path)
    this.stack.push({ ...tab })
    if (this.stack.length > CLOSED_MAX) this.stack.splice(0, this.stack.length - CLOSED_MAX)
  }

  /** 最近关掉的那一个（并从栈里拿走）；栈空就是 null */
  pop(): ClosedTab | null {
    return this.stack.pop() ?? null
  }

  /** 这个路径又开着了 / 进了废纸篓：不再算「关着的」 */
  forget(path: string): void {
    this.stack = this.stack.filter((x) => x.path !== path)
  }

  /** 改名 / 搬走（同 main.ts 的 `retargetTabs`）：目录也要认，按前缀整体重写 */
  retarget(from: string, to: string): void {
    for (const x of this.stack) {
      if (x.path === from) x.path = to
      else if (x.path.startsWith(`${from}/`)) x.path = to + x.path.slice(from.length)
    }
  }
}
