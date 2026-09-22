import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { newSaveStatus, SAVING_AFTER, saveLabel, type SaveStatus } from '../src/renderer/ui/save-state'

/**
 * 状态栏那一格保存状态（第八节 1）。
 *
 * 要守的就一句话：**未落盘的内容不许显示成「已保存」**。四个状态的优先级是产品判断，
 * 一条一条钉在这儿 —— 失败不自己消失、慢过门槛才说「正在保存」、脏压过「已保存」。
 */

const st = (over: Partial<SaveStatus> = {}): SaveStatus => ({ ...newSaveStatus(), ...over })

describe('保存状态 → 状态栏', () => {
  it('没落过盘、也不脏 → 什么都不说（新开的空白文档）', () => {
    expect(saveLabel(st(), false, 1000)).toEqual({ kind: 'none' })
  })

  it('落过盘、不脏 → 已保存 + 那个时刻', () => {
    expect(saveLabel(st({ savedAt: 700 }), false, 1000)).toEqual({ kind: 'saved', at: 700 })
  })

  it('脏 → 有修改，**哪怕刚刚才存成过**', () => {
    // 这一条是整条规矩的要害：写盘那几毫秒里继续打字、或者存完接着打，
    // `savedAt` 都是新的，可新的是上一次那些字节
    expect(saveLabel(st({ savedAt: 999 }), true, 1000)).toEqual({ kind: 'dirty' })
  })

  it('正在写但还没到门槛 → 仍然是「有修改」，不是「正在保存」', () => {
    const s = st({ savingSince: 1000, savedAt: 500 })
    expect(saveLabel(s, true, 1000 + SAVING_AFTER - 1)).toEqual({ kind: 'dirty' })
  })

  it('慢过门槛才说「正在保存…」', () => {
    const s = st({ savingSince: 1000, savedAt: 500 })
    expect(saveLabel(s, true, 1000 + SAVING_AFTER)).toEqual({ kind: 'saving' })
  })

  it('正在写、而文档此刻不脏（存的就是手上这份）→ 也报「正在保存…」', () => {
    const s = st({ savingSince: 1000 })
    expect(saveLabel(s, false, 1000 + SAVING_AFTER)).toEqual({ kind: 'saving' })
  })

  it('失败压倒一切：正在重试、脏不脏都不遮它', () => {
    const s = st({ failure: '磁盘已满', savingSince: 1000, savedAt: 500 })
    expect(saveLabel(s, false, 9_999_999)).toEqual({ kind: 'failed', reason: '磁盘已满' })
    expect(saveLabel({ ...s, savingSince: null }, true, 1000)).toEqual({
      kind: 'failed',
      reason: '磁盘已满'
    })
  })

  it('失败**不会自己过期**：多久之后问都还是它', () => {
    const s = st({ failure: '外接盘拔了', savedAt: 100 })
    expect(saveLabel(s, false, 100 + 60 * 60 * 1000)).toEqual({
      kind: 'failed',
      reason: '外接盘拔了'
    })
  })

  it('一次成功写盘把失败顶掉（调用方清 failure，这里验清了之后的样子）', () => {
    const s = st({ failure: null, savedAt: 2000 })
    expect(saveLabel(s, false, 2001)).toEqual({ kind: 'saved', at: 2000 })
  })

  it('写不得的两种理由排在最前面：冲突 / 文件已不在', () => {
    // 两种挂着的时候这个文件一个字节都没往下写，「为什么没在保存」的答案就是它们
    const s = st({ failure: '磁盘已满', savedAt: 500 })
    expect(saveLabel(s, true, 1000, 'conflict')).toEqual({ kind: 'conflict' })
    expect(saveLabel(s, true, 1000, 'missing')).toEqual({ kind: 'missing' })
    // 不给理由时照旧
    expect(saveLabel(s, true, 1000)).toEqual({ kind: 'failed', reason: '磁盘已满' })
  })

  it('新的状态是干净的三个 null', () => {
    expect(newSaveStatus()).toEqual({ savedAt: null, savingSince: null, failure: null })
  })
})

/**
 * 接线在 `main.ts` 里（要 DOM、要 `window.api`、要一个真 EditorView），所以照
 * `closing.test.ts` 那条路子扫源码 —— 钉的都是「异步边界」那一类：**await 之后
 * 世界已经不是原来那个了**，而这几处从前正是在 await 之后才去问「当前是谁」。
 */
describe('main.ts 里的落盘接线', () => {
  const main = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8')
  const fn = (name: string): string => {
    const at = main.indexOf(`async function ${name}(`)
    expect(at, `${name} 不见了`).toBeGreaterThan(0)
    return main.slice(at, main.indexOf('\n}\n', at))
  }

  it('写下去的是**发出去的那一份**，不是 await 回来之后视图里那份', () => {
    const body = fn('writeOnce')
    const capture = body.indexOf('const doc = t.state.doc')
    // 发出去那一句现在是个三元（契约 v36：只有非另存为、非 force 的那一支带 expect）
    const send = body.indexOf('res = opts.as')
    expect(capture, '这一份必须在 await 之前就拿在手上').toBeGreaterThan(0)
    expect(capture).toBeLessThan(send)
    expect(body, '认 view.state.doc 等于把 await 期间敲的字说成已保存').toContain(
      't.savedDoc = doc'
    )
    expect(body).not.toContain('savedDoc = view.state.doc')
  })

  it('写盘前先让壳比一次盘上那份（契约 v36 的 compare-and-swap）', () => {
    const body = fn('writeOnce')
    // 光靠文件监听挡不住覆盖：监听 300ms 合并窗 vs 自动保存停手 2 秒 —— 外面在这
    // 300ms 里写一笔，我们会先盖上去，事件到的时候读到的已经是自己那份
    expect(body).toContain("opts.force ? null : (t.lastWritten ?? null)")
    // 另存为不比（目标是人现挑的）
    expect(body).toContain('window.api.saveAs(t.path, content, t.fp)')
    // 比出来不一样时**一个字节都没写**，走和外部变更同一条路
    expect(body).toContain('isStaleWrite(e)')
    expect(body).toContain('await handleExternalChange(t.path)')
  })

  it('另存为点了取消，上一次那个失败要原样挂回去', () => {
    const body = fn('writeOnce')
    expect(body).toContain('const hadFailure = t.save.failure')
    // 取消那一支必须还原，否则「保存失败 · 重试 · 另存为…」会在人改主意的那一下整条消失
    const cancel = body.slice(body.indexOf('if (!res) {'))
    expect(cancel.slice(0, 200)).toContain('t.save.failure = hadFailure')
  })

  it('盘上那个文件没了的时候，自动保存不许把它原地复活', () => {
    const body = fn('writeOnce')
    expect(body).toContain('if (t.missing && opts.auto) return false')
    // 人自己按的 ⌘S 照做，写成了就把这个状态摘掉
    expect(body).toContain('delete t.missing')
  })

  it('认领路径之前现问一次 activeId —— 面板开着的时候人可能已经切走了', () => {
    expect(fn('writeOnce')).toContain('if (t.id === activeId) docPath = t.path')
  })

  it('⌘S / 另存为都先把标签拿在手上，再 await', () => {
    const at = main.indexOf("case 'file:save': {")
    const block = main.slice(at, main.indexOf("case 'file:close-tab'", at))
    expect(at).toBeGreaterThan(0)
    // 两条分支各一次 activeTab()，而且都排在那句 await 前面
    expect(block.match(/const cur = activeTab\(\)/g)?.length).toBe(2)
    for (const head of ["case 'file:save': {", "case 'file:save-as': {"]) {
      const b = block.slice(block.indexOf(head))
      expect(b.indexOf('activeTab()'), head).toBeLessThan(b.indexOf('await writeTab'))
    }
  })

  it('自动保存在失败之后停下 —— 每两秒重试一次只会把那句「保存失败」不停重置', () => {
    const body = fn('writeOnce')
    const auto = body.slice(body.indexOf('if (opts.auto)'))
    expect(auto).toContain('t.save.failure !== null')
  })

  it('同一个标签的写盘是排队的，队列不传播异常', () => {
    const at = main.indexOf('function writeTab(')
    const body = main.slice(at, main.indexOf('\n}\n', at))
    expect(at).toBeGreaterThan(0)
    expect(body).toContain('writeQueue.get(t.id)')
    // 一次失败不许毒死这个标签后面每一次保存
    expect(body).toContain('() => undefined')
  })

  it('「保存失败」那一格不会自己消失，而且带着重试与另存为两颗按钮', () => {
    const at = main.indexOf('function renderSave(')
    const body = main.slice(at, main.indexOf('\n}\n', at))
    const failed = body.slice(body.indexOf("case 'failed'"))
    expect(failed).toContain('status.saveFailed')
    expect(failed).toContain('status.retry')
    expect(failed).toContain('cmd.saveAs')
    // 4 秒自散的 note() 配不上「文件没写进去」
    expect(failed).not.toContain('setTimeout')
    expect(failed).not.toContain('note(')
  })

  it('状态栏读的是**活动标签自己**那份状态，不是一个全局时刻', () => {
    const at = main.indexOf('function renderSave(')
    const body = main.slice(at, main.indexOf('\n}\n', at))
    expect(body).toContain('const cur = activeTab()')
    expect(body).toContain('cur?.save')
    // 全局那份已经没了
    expect(main).not.toContain('let savedAt')
    expect(main).not.toContain('markSaved()')
  })
})
