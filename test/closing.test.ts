import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { saveDirtyTabs, type SavableTab } from '../src/renderer/ui/closing'

/**
 * 关窗那一下的批量落盘（0.4.1 修）。
 *
 * 会错的那几件事全是时序，一件都不需要 DOM —— 所以循环从 `main.ts` 提了出来。
 * 最要紧的是**没存完**那两条分支：壳侧的 `dirty` 是一个全局位，写盘成功就清零，
 * 于是「先存成一个、再没存成一个」之后壳那边已经是干净的。渲染层不重新同步的话，
 * 下一次关窗 `windowShouldClose` 直接放行，剩下那几个标签的改动一声不响地没了。
 * **没存完有两条路**：点了取消（`save` 回 null）与写盘失败（壳侧 reject，直接抛）——
 * 第二条是 `if (!done)` 守不住的那一条，所以调用方那边挂的是 `finally`。
 */

const FP = { eol: '\n' as const, bom: false }

interface Tab extends SavableTab {
  text: string
  savedText?: string
}

const tab = (id: number, path: string | null, text: string, scratchId?: string): Tab => ({
  id,
  path,
  fp: FP,
  text,
  ...(scratchId === undefined ? {} : { scratchId })
})

/** `save` 按脚本作答：字符串 = 存成这个路径，null = 用户在保存面板里点了取消 */
function io(answers: (string | null)[]) {
  const scratchCleared: string[] = []
  const asked: (string | null)[] = []
  let i = 0
  return {
    scratchCleared,
    asked,
    save: vi.fn(async (path: string | null) => {
      asked.push(path)
      const a = answers[i++]
      return a === null || a === undefined ? null : { path: a }
    }),
    scratchClear: (id: string) => void scratchCleared.push(id)
  }
}

const run = (tabs: Tab[], x: ReturnType<typeof io>) =>
  saveDirtyTabs(
    tabs,
    x,
    (t) => t.text,
    (t) => {
      t.savedText = t.text
    }
  )

describe('关窗批量落盘', () => {
  it('全存下了才回 true（调用方据此 confirmClose）', async () => {
    const tabs = [tab(1, '/a.md', 'A'), tab(2, '/b.md', 'B')]
    const x = io(['/a.md', '/b.md'])
    await expect(run(tabs, x)).resolves.toBe(true)
    expect(x.asked).toEqual(['/a.md', '/b.md'])
    expect(tabs.map((t) => t.savedText)).toEqual(['A', 'B'])
  })

  it('任何一个被取消就整批停下 —— 后面那个碰都不碰', async () => {
    const tabs = [tab(1, '/a.md', 'A'), tab(2, '/b.md', 'B'), tab(3, '/c.md', 'C')]
    const x = io(['/a.md', null, '/c.md'])
    await expect(run(tabs, x)).resolves.toBe(false)
    // 第三个根本没问
    expect(x.asked).toEqual(['/a.md', '/b.md'])
    // 存成功的那个确实存了，被取消的和它后面的都还是脏的
    expect(tabs[0]!.savedText).toBe('A')
    expect(tabs[1]!.savedText).toBeUndefined()
    expect(tabs[2]!.savedText).toBeUndefined()
  })

  it('无标题标签接管保存面板给的路径，并把 scratch 那份清掉', async () => {
    const tabs = [tab(1, null, '草稿', 'tab-9-1')]
    const x = io(['/存到这儿.md'])
    await expect(run(tabs, x)).resolves.toBe(true)
    expect(x.asked).toEqual([null])
    expect(tabs[0]!.path).toBe('/存到这儿.md')
    // 不清的话，下一次自动保存又写一份，关掉重开就多出一个假草稿
    expect(x.scratchCleared).toEqual(['tab-9-1'])
    expect(tabs[0]!.scratchId).toBeUndefined()
  })

  it('取消的那个不接管路径，也不动它的 scratch', async () => {
    const tabs = [tab(1, null, '草稿', 'tab-9-1')]
    const x = io([null])
    await expect(run(tabs, x)).resolves.toBe(false)
    expect(tabs[0]!.path).toBeNull()
    expect(x.scratchCleared).toEqual([])
    expect(tabs[0]!.scratchId).toBe('tab-9-1')
  })

  it('一个脏标签都没有：不问任何人，直接回 true', async () => {
    const x = io([])
    await expect(run([], x)).resolves.toBe(true)
    expect(x.save).not.toHaveBeenCalled()
  })

  /**
   * **写盘失败与「点了取消」是两条路**：取消是 `save` 回 null，写坏了（磁盘满、
   * 外接盘拔了、权限没了）是壳侧 reject → 这里直接抛出去。抛出去也一样**不许**
   * 把剩下的存下去，更不许让调用方漏掉那次脏状态重同步（那一半由 `finally` 守，
   * 见下面那个 describe）。
   */
  it('写盘失败：就地抛，后面那个不碰', async () => {
    const tabs = [tab(1, '/a.md', 'A'), tab(2, '/b.md', 'B'), tab(3, '/c.md', 'C')]
    const x = io(['/a.md', '/b.md', '/c.md'])
    x.save.mockImplementationOnce(async (path: string | null) => {
      x.asked.push(path)
      return { path: '/a.md' }
    })
    x.save.mockImplementationOnce(async (path: string | null) => {
      x.asked.push(path)
      throw new Error('写入失败：No space left on device')
    })
    await expect(run(tabs, x)).rejects.toThrow('No space left')
    expect(x.asked).toEqual(['/a.md', '/b.md'])
    expect(tabs[0]!.savedText).toBe('A')
    expect(tabs[2]!.savedText).toBeUndefined()
  })
})

/**
 * 取消之后那一次**强制**同步只活在 `main.ts` 里（要 DOM 与 `window.api`），
 * 而它正是这条路上唯一会真丢东西的一步 —— 所以这里扫源码把它钉住：
 * `syncStatus()` 不带参数时只在 dirty **变了**才发 `setDocState`，而渲染层这边
 * 它一直是 true，不 force 就等于没发。
 */
describe('取消之后要把脏状态重新告诉壳', () => {
  const main = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8')

  const at = main.indexOf("case 'file:save-and-close'")
  const block = main.slice(at, main.indexOf("case 'file:open-folder'", at))

  it('没存完就重新同步一次，而且是 force 的', () => {
    expect(at).toBeGreaterThan(0)
    expect(block).toContain('if (!done)')
    const sync = block.slice(block.indexOf('if (!done)'))
    expect(sync, '不 force 的话这一句等于没发').toContain('syncStatus(true)')
  })

  it('那次同步挂在 finally 上 —— 写盘失败会直接抛，`if` 那一支执行不到', () => {
    const fin = block.indexOf('} finally {')
    expect(fin, '挂在 if 上只守得住「点取消」，守不住「写坏了」').toBeGreaterThan(0)
    expect(block.slice(fin)).toContain('syncStatus(true)')
    // 同步必须排在 confirmClose 之前，而且没存完就不许关窗
    expect(block.indexOf('syncStatus(true)')).toBeLessThan(block.indexOf('confirmClose'))
    expect(block).toContain('if (!done) return')
  })

  it('异常不许吞：finally 里没有 catch', () => {
    expect(block, '吞掉的话，磁盘满这种事就永远没人知道').not.toContain('catch')
  })
})
