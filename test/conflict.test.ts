import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { diffView } from '../src/renderer/ui/diff-view'

/**
 * 外部修改冲突（第八节 2）。
 *
 * 面板本身要 DOM，所以这里分两头：差异那块版面是纯函数，直接跑；
 * 「什么时候不许覆盖、什么时候才算解决」全在 `main.ts` 的接线上，扫源码钉住 ——
 * 那几条正是会**真丢东西**的那一类。
 */

describe('差异版面（版本历史与冲突面板共用同一份）', () => {
  it('两份一样 → 空串，让调用方自己摆空态', () => {
    const d = diffView('a\nb\n', 'a\nb\n')
    expect(d.html).toBe('')
    expect(d.added + d.removed).toBe(0)
  })

  it('− 是老的那份（冲突里 = 磁盘），+ 是新的那份（冲突里 = 我手上这份）', () => {
    const d = diffView('第一行\n磁盘改的\n', '第一行\n我改的\n')
    expect(d.added).toBe(1)
    expect(d.removed).toBe(1)
    expect(d.html).toContain('is-del')
    expect(d.html).toContain('is-add')
    expect(d.html).toContain('我改的')
    expect(d.html).toContain('磁盘改的')
  })

  it('正文里的尖括号一个都不许原样进 innerHTML', () => {
    const d = diffView('safe\n', '<img src=x onerror=alert(1)>\n')
    expect(d.html).not.toContain('<img')
    expect(d.html).toContain('&lt;img')
  })
})

describe('main.ts：冲突未决时不许覆盖', () => {
  const main = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8')
  const fn = (name: string): string => {
    const at = main.indexOf(name)
    expect(at, `${name} 不见了`).toBeGreaterThan(0)
    return main.slice(at, main.indexOf('\n}\n', at))
  }

  it('写盘那道闸认的是 `conflict`，自动保存直接停、人按的 ⌘S 摆差异', () => {
    const body = fn('async function writeOnce(')
    const gate = body.slice(body.indexOf('if (t.conflict'))
    expect(body.indexOf('if (t.conflict'), '闸要排在真正发出去之前').toBeLessThan(
      body.indexOf('await (opts.as')
    )
    expect(gate).toContain('openConflict(t)')
    expect(gate.slice(0, gate.indexOf('\n  }'))).toContain('return false')
  })

  it('外部变更 + 脏 = 记下磁盘那份，而不是只挂一个 ⚠', () => {
    const body = fn('async function handleExternalChange(')
    expect(body).toContain('t.conflict = { content: disk.content, fingerprint: disk.fingerprint }')
    // 非活动标签从前就是「只标 ⚠ 就完了」，两秒后的自动保存照样盖掉外部改动 ——
    // 现在两条路合一：脏就是冲突，与活动不活动无关
    expect(body).not.toContain('if (t.id === activeId) {')
    expect(body, '正看着的那一份当场把差异摆出来').toContain('await openConflict(t)')
  })

  it('「保留我的」覆盖之前，先把磁盘那份存进版本历史', () => {
    const body = fn('async function resolveConflict(')
    const keep = body.slice(body.indexOf("if (choice === 'keep')"))
    const snap = keep.indexOf('keepSnapshot(tab.path, c.content)')
    const write = keep.indexOf('writeTab(tab, { force: true })')
    expect(snap, '磁盘那份是这条路上唯一一份会凭空消失的内容').toBeGreaterThan(0)
    expect(snap).toBeLessThan(write)
  })

  it('**写成了才算解决**：取消或写坏了，冲突原样挂回去', () => {
    const body = fn('async function resolveConflict(')
    // 摘掉 conflict 的那一句必须排在两条 `return` 之后（两条都是「没写成」）
    const drop = body.indexOf('delete tab.conflict')
    expect(drop).toBeGreaterThan(0)
    const before = body.slice(0, drop)
    expect(before.match(/return\b/g)?.length, '没写成的每一条都得先走掉').toBeGreaterThanOrEqual(3)
    expect(before).toContain('force: true')
  })

  it('三条出路都带 force —— 人刚在面板上做过决定，别再拦一次', () => {
    const body = fn('async function resolveConflict(')
    expect(body).toContain('{ force: true }')
    expect(body).toContain('{ as: true, force: true }')
  })

  it('状态栏那一格把冲突排在最前面，且那颗「查看差异」不自散', () => {
    const at = main.indexOf('function renderSave(')
    const body = main.slice(at, main.indexOf('\n}\n', at))
    const c = body.slice(body.indexOf("case 'conflict'"))
    expect(c).toContain('status.viewDiff')
    expect(c).toContain('openConflict(tab)')
    expect(c).not.toContain('setTimeout')
  })
})

describe('不再走原生弹窗（契约 v34）', () => {
  const root = new URL('../', import.meta.url)
  const read = (p: string): string => readFileSync(new URL(p, root), 'utf8')

  it('三处都没有 confirmReload 了：渲染层、契约、壳', () => {
    expect(read('src/renderer/main.ts')).not.toContain('confirmReload')
    expect(read('shell-swift/main.swift')).not.toContain('confirmReload')
    // 契约文件里只剩一条「为什么撤掉」的记录，不再有方法签名
    const types = read('src/shared/types.ts')
    expect(types).not.toMatch(/^\s*confirmReload\(/m)
    expect(types).toContain('契约 v34')
  })

  it('壳里那四条弹窗文案也跟着撤了（留着就是一份没人用的文案）', () => {
    expect(read('shell-swift/main.swift')).not.toContain('dlg.reload')
  })

  it('面板给的是三条出路，一条都不能少', () => {
    const cf = read('src/renderer/ui/conflict.ts')
    for (const k of ['cf.reload', 'cf.keep', 'cf.saveAs']) expect(cf).toContain(k)
    // 点背景不等于关掉：关掉之后冲突还在，而人会以为已经处理过了
    expect(cf).not.toContain(".hi-backdrop')!.addEventListener")
  })
})
