import { describe, expect, it } from 'vitest'
import { adoptEntries, sameEntries, watchPaths } from '../src/renderer/ui/sidebar'
import type { DirEntry } from '../src/shared/types'

/**
 * 文件树自动刷新（契约 v32）的三个判断。
 *
 * 整条路是「壳报某一级变了 → 重读那一级 → 比对 → 该动才动」，真正会错的全在这三处：
 * 比对放过了不该放的（树停在旧的一层）、比对拦住了该过的（每次自动保存都重建整棵树）、
 * 换层时把懒加载的子树丢了（展开着的一片当场空掉）、监听单子跟着 `expanded` 走
 * （收起来的那几级在背后过期）。DOM 那半在 node 环境里跑不了，所以判断都提成了纯函数。
 */

const f = (name: string): DirEntry => ({ name, path: `/w/${name}`, isDir: false })
const d = (name: string): DirEntry => ({ name, path: `/w/${name}`, isDir: true })

describe('sameEntries：该不该重画', () => {
  it('一模一样 = 不动', () => {
    expect(sameEntries([d('assets'), f('a.md')], [d('assets'), f('a.md')])).toBe(true)
  })

  it('自动保存那一下：原子写改了 mtime，但条目没变 —— 必须当成没变', () => {
    // 壳侧 readDir 只回 name/path/isDir，原子写的临时文件是点开头的（已被滤掉）。
    // 这条钉的是「每两秒一次的自噬事件到此为止」
    const before = [f('a.md'), f('b.md')]
    const after = [f('a.md'), f('b.md')]
    expect(sameEntries(before, after)).toBe(true)
  })

  it('多一个 / 少一个 / 改了名 = 要重画', () => {
    expect(sameEntries([f('a.md')], [f('a.md'), f('b.md')])).toBe(false)
    expect(sameEntries([f('a.md'), f('b.md')], [f('a.md')])).toBe(false)
    expect(sameEntries([f('a.md')], [f('b.md')])).toBe(false)
  })

  it('名字没变但文件变成了目录 = 要重画（图标与能不能展开都跟着它）', () => {
    expect(sameEntries([f('notes')], [d('notes')])).toBe(false)
  })

  it('空目录之间也认', () => {
    expect(sameEntries([], [])).toBe(true)
    expect(sameEntries([], [f('a.md')])).toBe(false)
  })
})

describe('adoptEntries：换一层，别把子树丢了', () => {
  const loaded = { entry: d('sub'), children: [{ entry: f('deep.md'), children: null }] }

  it('还在的目录连它读好的 children 一起留住 —— 否则展开着的子树当场空掉', () => {
    const next = adoptEntries([loaded, { entry: f('a.md'), children: null }], [d('sub'), f('a.md'), f('new.md')])
    expect(next.map((n) => n.entry.name)).toEqual(['sub', 'a.md', 'new.md'])
    expect(next[0]!.children).toBe(loaded.children)
  })

  it('新来的还没读过（children = null，展开时才走 IPC）', () => {
    const next = adoptEntries([], [d('fresh')])
    expect(next[0]!.children).toBeNull()
  })

  it('消失的就此丢掉，顺序按新读到的来', () => {
    const next = adoptEntries([loaded, { entry: f('gone.md'), children: null }], [f('a.md'), d('sub')])
    expect(next.map((n) => n.entry.name)).toEqual(['a.md', 'sub'])
  })

  it('名字还在但换了身份（目录 → 文件）：缓存不能留，那已经不是同一个东西', () => {
    const next = adoptEntries([loaded], [f('sub')])
    expect(next[0]!.children).toBeNull()
  })
})

describe('watchPaths：盯着谁', () => {
  const tree = [
    { entry: d('sub'), children: [{ entry: d('deep'), children: [] }, { entry: f('x.md'), children: null }] },
    { entry: d('cold'), children: null },
    { entry: f('a.md'), children: null }
  ]

  it('树根 + 每一级读进来的目录（含嵌套），排过序', () => {
    expect(watchPaths('/w', tree)).toEqual(['/w', '/w/deep', '/w/sub'])
  })

  it('没读过的目录不盯（没缓存就不会过期），文件也不盯', () => {
    expect(watchPaths('/w', tree)).not.toContain('/w/cold')
    expect(watchPaths('/w', tree)).not.toContain('/w/a.md')
  })

  it('读进来的空目录照盯 —— 空不等于没读过（往里丢一个文件得看得见）', () => {
    expect(watchPaths('/w', [{ entry: d('empty'), children: [] }])).toEqual(['/w', '/w/empty'])
  })

  it('没有工作区就一个都不盯', () => {
    expect(watchPaths(null, tree)).toEqual([])
  })
})
