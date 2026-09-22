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
      body.indexOf('res = opts.as')
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

  it('我们自己写下去的那一份不算外部变更 —— 哪怕人在那之后又敲了几个字', () => {
    const body = fn('async function handleExternalChange(')
    // 光比「盘上那份与当前文档一不一样」不够：自动保存落盘到监听事件到达之间只隔
    // 300ms，人在这中间又敲两个字，那条就不成立了 —— 于是报出一次假冲突，
    // 而假冲突会把这个文件的自动保存整个停下来，比没有冲突更坏
    expect(body).toContain('disk.content === t.lastWritten')
    expect(main, '写成了才记得住').toContain('t.lastWritten = content')
  })

  it('文件监听是**尾部去抖**，不是头部节流（2026-09-22 跑 E2E 跑出来的）', () => {
    const swift = readFileSync(new URL('../shell-swift/main.swift', import.meta.url), 'utf8')
    const at = swift.indexOf('private func watch(_ path: String) {')
    const body = swift.slice(at, swift.indexOf('\n    }\n', at))
    // 头部节流是把那 0.8 秒里的变更**整个丢掉**，不是晚一点再报 —— 一次真的外部变更
    // 可以就此消失（自动保存刚吵醒过 kqueue，紧接着别人改了同一个文件）
    expect(body).not.toContain('lastNotify')
    expect(body).toContain('fileNotify[path]?.cancel()')
    expect(body).toContain('DispatchWorkItem')
    // 目录那一侧（契约 v32）当初就是因为同一个道理选的尾部去抖
    expect(swift).toContain('self.dirNotify[path]?.cancel()')
  })

  it('关窗那条批量路径同样过闸 —— 它不走 writeOnce', () => {
    const at = main.indexOf("case 'file:save-and-close'")
    const block = main.slice(at, main.indexOf("case 'file:open-folder'", at))
    // 复现过的路：本地改 → 外部改 → 冲突选「稍后」→ 关窗选保存 = 外面那份被静默覆盖
    expect(block).toContain('tabs.find((x) => x.conflict && isTabDirty(x))')
    expect(block, '先把它摆出来，这一次关窗到此为止').toContain('await openConflict(blocked)')
    // 而且这条路也要比一次盘（刚刚才发生、还没来得及变成 conflict 的那一种）
    expect(block).toContain('lastWritten ?? null')
  })

  it('新来的冲突不许被旧操作顺手删掉', () => {
    const body = fn('async function resolveConflict(')
    // 两句 await 之间外面可能又改了一次，handleExternalChange 会往这儿放一个更新的冲突
    expect(body).toContain('if (tab.conflict !== c)')
  })

  it('自写识别连指纹一起比 —— 只改换行/BOM 的外部修改不算我们自己写的', () => {
    const body = fn('async function handleExternalChange(')
    expect(body).toContain('sameFp')
    expect(body).toContain('disk.fingerprint.eol === t.writtenFp?.eol')
  })

  it('版本历史没写成就不许说「随时找得回来」', () => {
    const body = fn('async function resolveConflict(')
    expect(body).toContain('const kept =')
    expect(body).toContain('if (kept) note(')
    expect(body).toContain('cf.noBackup')
    // 壳那边也别再谎报成功
    const swift = readFileSync(new URL('../shell-swift/main.swift', import.meta.url), 'utf8')
    const snap = swift.slice(swift.indexOf('case "snapshotSave"'), swift.indexOf('case "snapshotList"'))
    expect(snap).not.toContain('try? fm.createDirectory')
    expect(snap).not.toContain('try? content.write')
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
