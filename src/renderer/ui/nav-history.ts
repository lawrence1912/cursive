import type { ChangeDesc } from '@codemirror/state'

/**
 * 第八节 6：后退 / 前进。
 *
 * **只记明确的跳转**：大纲、`[TOC]`、链接与锚点、跨文件搜索的命中、快速打开、文件树、
 * 跳到行。普通滚动与切标签不记 —— 那是「我在看」，不是「我去了别处」；记进来的话，
 * 后退一步就是倒带式地重放刚才的每一次滚动。
 *
 * 形状照浏览器：一串位置 + 一个「现在在第几格」。跳一次 = 砍掉往后那一截、接上新的一格；
 * 后退 / 前进只挪那根指针。离开一格之前先把它**刷新成离开那一刻的样子**（人可能在落点
 * 之后又往下读了一段）—— 前进回来时回到的是「刚才读到哪儿」，不是「当初落在哪儿」。
 *
 * 一个位置存的是**文档位置**而不是像素：光标，加上视口顶上那一行的起点。图片、公式晚到
 * 会把像素推走，文档位置不会；人接着编辑时由 `map` 跟着改动一起挪。
 *
 * 纯逻辑，不碰 DOM 与编辑器（`test/nav-history.test.ts`）；跳过去那一下在 main.ts。
 */
export interface NavSpot {
  /** 认标签用：标签还开着就回到它。无路径的草稿只能靠它认 */
  tabId: number
  /** 标签关掉之后靠它重新打开；无路径的草稿是 null —— 关掉就再也回不去了 */
  path: string | null
  /** 光标 */
  pos: number
  /** 视口顶上那一行的起点 —— 回来时把它摆回视口顶上，「刚才读到哪儿」靠的是它 */
  top: number
}

/** 认文档的那一半（不看位置）。按钮亮不亮只需要知道「人此刻在哪份文档里」 */
export type NavDoc = Pick<NavSpot, 'tabId' | 'path'>

/** 最多记这么多格。再往前的谁也不会一路按回去，而这串东西每次改文档都要映射一遍 */
export const NAV_MAX = 50

/** 同一份文档：同一个标签，或者同一个路径（标签关了又开，id 换了，路径还是那个） */
export function sameDoc(a: NavDoc, b: NavDoc): boolean {
  return a.tabId === b.tabId || (a.path !== null && a.path === b.path)
}

export class NavHistory {
  private spots: NavSpot[] = []
  private at = -1

  /** 一次明确的跳转：从 `from` 到 `to`。原地不动（同一份文档、同一个光标）不算 */
  record(from: NavSpot, to: NavSpot): void {
    if (sameDoc(from, to) && from.pos === to.pos) return
    this.settle(from)
    this.spots.length = this.at + 1 // 往后那一截作废（同浏览器）
    this.spots.push({ ...to })
    if (this.spots.length > NAV_MAX) this.spots.splice(0, this.spots.length - NAV_MAX)
    this.at = this.spots.length - 1
  }

  /** 后退一格，返回要去的位置；没有可退的就是 null（指针不动） */
  back(here: NavSpot): NavSpot | null {
    if (!this.spots.length) return null
    this.settle(here)
    if (this.at <= 0) return null
    this.at -= 1
    return { ...this.spots[this.at]! }
  }

  /** 前进一格。人在后退之后自己去了别处（`settle` 把那一截砍了）就没有可进的了 */
  forward(here: NavSpot): NavSpot | null {
    if (!this.spots.length) return null
    this.settle(here)
    if (this.at >= this.spots.length - 1) return null
    this.at += 1
    return { ...this.spots[this.at]! }
  }

  /**
   * 「后退」此刻有没有事可做。人不在当前这一格那份文档里（自己切了标签）时，
   * 后退回到的是当前这一格本身 —— 所以只要有记录就可以退
   */
  canBack(here: NavDoc): boolean {
    const cur = this.spots[this.at]
    if (!cur) return false
    return this.at > 0 || !sameDoc(cur, here)
  }

  /** 「前进」此刻有没有事可做。人离开了当前这一格那份文档，往后那一截就要作废了 */
  canForward(here: NavDoc): boolean {
    const cur = this.spots[this.at]
    if (!cur || !sameDoc(cur, here)) return false
    return this.at < this.spots.length - 1
  }

  /** 这个标签里的文档改了：记在它名下的位置跟着改动挪（同 CM 的 `mapPos`） */
  map(tabId: number, changes: ChangeDesc): void {
    for (const s of this.spots) {
      if (s.tabId !== tabId) continue
      s.pos = changes.mapPos(s.pos, 1)
      s.top = changes.mapPos(s.top, -1)
    }
  }

  /** 标签关了又开（id 换了）：按路径找回来的那一格认新 id，之后的 `map` 才跟得上 */
  rebind(path: string, tabId: number): void {
    for (const s of this.spots) if (s.path === path) s.tabId = tabId
  }

  /** 改名 / 搬走（同 main.ts 的 `retargetTabs`）：目录也要认，按前缀整体重写 */
  retarget(from: string, to: string): void {
    for (const s of this.spots) {
      if (s.path === from) s.path = to
      else if (s.path?.startsWith(`${from}/`)) s.path = to + s.path.slice(from.length)
    }
  }

  /**
   * 一个**无路径**的标签关了：记在它名下的位置再也回不去，整格删掉
   * （留着的话后退一步就停在一个打不开的地方，人得多按一次）。
   * 删完相邻的两格可能成了同一份文档的同一个位置，并成一格
   */
  forgetTab(tabId: number): void {
    const kept: NavSpot[] = []
    let at = -1
    this.spots.forEach((s, i) => {
      if (s.tabId === tabId && s.path === null) return
      const last = kept[kept.length - 1]
      if (!(last && sameDoc(last, s) && last.pos === s.pos)) kept.push(s)
      if (i <= this.at) at = kept.length - 1
    })
    this.spots = kept
    this.at = kept.length ? Math.max(0, at) : -1
  }

  /**
   * 「此刻在哪儿」落到当前这一格：还在那份文档里就刷新它（光标、读到哪儿）；
   * 不在（人自己切了标签、开了文件，那些不记）就把此刻记成新的一格 ——
   * 后退时才回得到「我刚才在的那个地方」，而不是跳过它。
   */
  private settle(here: NavSpot): void {
    const cur = this.spots[this.at]
    if (cur && sameDoc(cur, here)) {
      this.spots[this.at] = { ...here }
      return
    }
    this.spots.length = this.at + 1
    this.spots.push({ ...here })
    this.at = this.spots.length - 1
  }
}
