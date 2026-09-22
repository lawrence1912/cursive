import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  SESSION_MAX,
  SESSION_VERSION,
  loadSession,
  packSession,
  parseSession,
  planRestore,
  restoreFocus,
  saveSession,
  sessionKey,
  type SessionTab,
  type StorageLike
} from '../src/renderer/ui/session'

/**
 * 会话恢复的纯函数（`ui/session.ts`）。
 *
 * 这一层要经得起**手改过的、上个版本写的、根本不是 JSON 的**那串东西 —— 它在
 * localStorage 里，谁都能动。原则与 `height-store` 那份一样：**认不出就当没有**，
 * 宁可回到「只开双击的那份文档」，也不要拿半截数据摆出一排空壳标签。
 */
function memory(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v)
  }
}

const tab = (path: string, scroll = 0, cursor = 0): SessionTab => ({ path, scroll, cursor })

describe('会话的读写', () => {
  it('存进去能原样读回来', () => {
    const store = memory()
    const s = packSession([tab('/a.md', 120, 30), tab('/b.md')], 1)
    saveSession(store, '/root', s)
    expect(loadSession(store, '/root')).toEqual(s)
  })

  it('按工作区根分组 —— 换个根就读不到', () => {
    const store = memory()
    saveSession(store, '/root', packSession([tab('/a.md')], 0))
    expect(loadSession(store, '/other')).toBeNull()
    expect([...store.map.keys()]).toEqual([sessionKey('/root')])
  })

  it('一个标签都不剩 = 没有会话', () => {
    const store = memory()
    saveSession(store, '/root', packSession([tab('/a.md')], 0))
    saveSession(store, '/root', packSession([], 0))
    expect(loadSession(store, '/root')).toBeNull()
  })

  it('没有存储（隐私模式 / 被策略禁掉）不炸', () => {
    expect(loadSession(undefined, '/root')).toBeNull()
    expect(() => saveSession(undefined, '/root', packSession([tab('/a.md')], 0))).not.toThrow()
  })
})

describe('认不出就当没有', () => {
  it.each([
    ['空', null],
    ['不是 JSON', '{{{'],
    ['不是对象', '42'],
    ['版本对不上', JSON.stringify({ v: SESSION_VERSION + 1, tabs: [tab('/a.md')], active: 0 })],
    ['tabs 不是数组', JSON.stringify({ v: SESSION_VERSION, tabs: '/a.md', active: 0 })],
    ['tabs 是空的', JSON.stringify({ v: SESSION_VERSION, tabs: [], active: 0 })],
    ['每一条都没有路径', JSON.stringify({ v: SESSION_VERSION, tabs: [{ scroll: 1 }], active: 0 })]
  ])('%s', (_name, raw) => {
    expect(parseSession(raw as string | null)).toBeNull()
  })

  it('坏掉的只是其中几条：留下好的那些', () => {
    const raw = JSON.stringify({
      v: SESSION_VERSION,
      tabs: [{ path: '/a.md', scroll: 10, cursor: 5 }, { path: 42 }, null, { path: '/b.md' }],
      active: 3
    })
    const s = parseSession(raw)!
    expect(s.tabs.map((t) => t.path)).toEqual(['/a.md', '/b.md'])
    // active 指向的是原来那份清单的下标，越界就退回第一个 —— 恢复出来总得有个活动标签
    expect(s.active).toBe(0)
  })

  it('坐标是 NaN / 负数 / 字符串一律当 0（别拿它去 scrollTop）', () => {
    const raw = JSON.stringify({
      v: SESSION_VERSION,
      tabs: [{ path: '/a.md', scroll: -5, cursor: 'x' }],
      active: 0
    })
    expect(parseSession(raw)!.tabs[0]).toEqual({ path: '/a.md', scroll: 0, cursor: 0 })
  })
})

describe('上限', () => {
  it('超了留最后那些，活动标签的下标跟着搬', () => {
    const many = Array.from({ length: SESSION_MAX + 5 }, (_, i) => tab(`/f${i}.md`))
    const s = packSession(many, many.length - 1)
    expect(s.tabs).toHaveLength(SESSION_MAX)
    expect(s.tabs[0]!.path).toBe('/f5.md')
    expect(s.active).toBe(SESSION_MAX - 1)
  })

  it('活动标签正好被截掉就退回第一个', () => {
    const many = Array.from({ length: SESSION_MAX + 5 }, (_, i) => tab(`/f${i}.md`))
    expect(packSession(many, 0).active).toBe(0)
  })
})

/**
 * 恢复计划（`planRestore`）。两条最要紧的规矩在这儿被钉住：
 * **已经开着的不再开一遍**、**双击进来的那份文档不会被挤下去**。
 * 后一条要是破了，症状是「从 Finder 双击一个文件，打开之后停在上次那个文件上」。
 */
describe('恢复计划', () => {
  const saved = packSession([tab('/a.md'), tab('/b.md'), tab('/c.md')], 1)

  it('全都没开过：按会话的顺序开，落在会话的活动标签上', () => {
    expect(planRestore(saved, [], false)).toEqual({
      open: ['/a.md', '/b.md', '/c.md'],
      focus: '/b.md'
    })
  })

  it('已经开着的那份不再开一遍', () => {
    expect(planRestore(saved, ['/b.md'], false).open).toEqual(['/a.md', '/c.md'])
  })

  it('带着文件启动（双击 / argv）：落点交回给那份文档，会话不抢', () => {
    expect(planRestore(saved, ['/b.md'], true)).toEqual({
      open: ['/a.md', '/c.md'],
      focus: null
    })
  })

  it('活动标签下标越界时退回第一个（`parseSession` 夹过一次，这儿再兜一次）', () => {
    const broken = { v: SESSION_VERSION, tabs: [tab('/a.md')], active: 7 }
    expect(planRestore(broken, [], false).focus).toBe('/a.md')
  })
})

/**
 * 会话恢复把文件写成 0 字节那次（2026-09-22，真丢了文件）。
 *
 * 现场：`restoreSession` 用 `spawnTab(…, focus=false)` 接管启动时那个空白标签 ——
 * 标签的 `state`/`path`/`savedDoc` 都换成了会话里第一份文件，**而视图还停在
 * 那份空白文档上**，`activeId` 又一直指着这个标签。于是紧接着的
 * `activate(会话里的活动标签)` 执行 `cur.state = view.state`，把空白文档当成了
 * 这份文件的内容，`flushTabAutosave` 静默落盘 —— 文件被写成 0 字节，
 * 版本历史里跟着留下一份 0 字节的快照（那是当时唯一的痕迹）。
 *
 * 触发条件是「会话里排第一的那份文件**不是**活动标签」，所以它既随机又反复：
 * 每次这样启动，都正好杀掉排第一的那一份。
 *
 * 真正的修法是**别再从 `activeId` 推断视图里装着谁**（`viewTabId`）。这几条扫源码，
 * 因为这条路要真跑起来得有活的 EditorView + 一次真启动 —— 那是 `release.sh` 的事，
 * 而这个不变量本身是「看得见」的：凡是拿视图当某个标签的内容，都必须先问 viewTabId。
 */
describe('视图与标签的归属（别再把空白文档写进别人的文件）', () => {
  const main = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8')
  const lines = main.split('\n')

  it('每一处「拿视图当某个标签的内容」都问过 viewTabId', () => {
    // 注释里也引着这句（上面那段就在讲它），所以按「不是注释行」筛
    const code = lines.filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    const syncs = code.filter((l) => /\.state = view\.state/.test(l))
    expect(syncs.length, '至少还有那几处同步').toBeGreaterThanOrEqual(3)
    for (const l of syncs) {
      expect(l, `这一行没问 viewTabId 就拿了视图：${l.trim()}`).toContain('viewTabId')
    }
  })

  it('每一处 view.setState 都当场记下归属（漏一处，后面全是错的）', () => {
    const at = lines.flatMap((l, i) =>
      l.includes('view.setState(') && !/^\s*(\/\/|\*|\/\*)/.test(l) ? [i] : []
    )
    expect(at.length).toBeGreaterThanOrEqual(3)
    for (const i of at) {
      expect(lines.slice(i, i + 3).join('\n'), `第 ${i + 1} 行之后没有 viewTabId =`).toMatch(
        /viewTabId = /
      )
    }
  })

  it('脏不脏也按 viewTabId 判（判错就等于拿错内容去存）', () => {
    expect(main).toContain('const doc = t.id === viewTabId ? view.state.doc : t.state.doc')
  })

  it('空白标签被背景接管时会把视图带上', () => {
    expect(main).toContain('if (focus || pristine.id === activeId) activate(pristine.id)')
  })
})

/**
 * 恢复跑完那一下的落点（0.4.1 修）。
 *
 * 恢复是异步的 —— 每读一个文件让出一次事件循环，而第一份文件在第一轮就接管了
 * 启动那个空白标签、进了视图。人在这段时间里敲的字只活在 `view` 里，`tab.state`
 * 还是读盘时那份；末尾要是再对**同一个 id** activate 一次，那些字连同光标、
 * 滚动位置一起被读盘时那份盖掉（`activate` 里的「先存下来」被 `cur.id !== id` 挡着）。
 */
describe('恢复跑完要不要切标签', () => {
  const at = (o: Partial<Parameters<typeof restoreFocus>[0]>) =>
    restoreFocus({ focus: 7, active: 3, typed: false, moved: false, ...o })

  it('落点是别人、人也没动过：正常切过去', () => {
    expect(at({})).toBe(7)
  })

  it('落点就是当前这个：一个都别动（再 activate 一次等于拿旧 state 盖掉实时输入）', () => {
    expect(at({ focus: 3 })).toBeNull()
  })

  it('人在恢复期间打字了：连切走都不切 —— 恢复是背景行为', () => {
    expect(at({ typed: true })).toBeNull()
  })

  it('人自己切过标签了：同上，他已经表过态了', () => {
    expect(at({ moved: true })).toBeNull()
  })

  it('没有落点（文件全没了）：别动', () => {
    expect(at({ focus: null })).toBeNull()
  })
})

/**
 * 那两个信号**必须是抹不平的**（0.4.1 修的第二版）。
 *
 * 第一版拿「`tab.state.doc` 与视图里那份一不一样」当「人打过字」的证据 —— 可
 * `flushTabAutosave` 与 `activate` 都会把 `tab.state` 重新同步成视图那份（停手 2s
 * 自动保存一次就够），一比又相等了，人打过的字于是不算数，恢复照样把他拽走。
 * 现在一个是**只增不减的计数**、一个是**身份比对**，两者都不随时间复原。
 */
describe('恢复期间「人动过手没有」的两个信号', () => {
  const main = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8')
  const at = main.indexOf('async function restoreSession()')
  const body = main.slice(at, main.indexOf('\n}', at))

  it('打过字：用计数器，不用「两份 doc 相不相等」', () => {
    expect(body).toContain('const editsBefore = docEdits')
    expect(body).toContain('typed: docEdits !== editsBefore')
    expect(body, 'doc.eq 会被自动保存抹平').not.toContain('.doc.eq(')
  })

  it('计数器挂在 updateListener 的 docChanged 上，而且只增不减', () => {
    const lines = main.split('\n').filter((l) => /docEdits\s*(\+?=)/.test(l))
    // 声明一处 + 自增一处，别处不许再动它
    expect(lines.map((l) => l.trim())).toEqual(['let docEdits = 0', 'docEdits += 1'])
    const lis = main.slice(main.indexOf('const listener = EditorView.updateListener'))
    expect(lis.slice(0, 200)).toContain('docEdits += 1')
  })

  /**
   * **换过标签也得用计数，不能比身份**：切走再切回来（A → B → A）身份一模一样，
   * 而人明明动过手。恢复自己只会激活一次（接管启动空白页那一下），总数减掉它，
   * 多出来的每一次都是人自己点的。
   */
  it('换过标签：用激活计数减掉恢复自己那次', () => {
    expect(body).toContain('let selfActs = 0')
    expect(body).toContain('if (tab.id === activeId) selfActs += 1')
    expect(body).toContain('moved: activations - actsBefore > selfActs')
    expect(body, '比身份的话，切走再切回来就看不见了').not.toContain('activeId !== (')
  })

  it('激活计数只在 activate() 里加一次', () => {
    const lines = main.split('\n').filter((l) => /activations\s*(\+?=)/.test(l))
    expect(lines.map((l) => l.trim())).toEqual(['let activations = 0', 'activations += 1'])
    const fn = main.slice(main.indexOf('function activate(id: number)'))
    expect(fn.slice(0, fn.indexOf('\n}'))).toContain('activations += 1')
  })

  /**
   * **两条基线必须记在第一个 `await` 之前**：问工作区根是一趟 IPC 往返、读会话是一次
   * localStorage —— 那会儿编辑器已经装着文档、也已经有焦点了。记晚一步，人在这段时间
   * 敲的字就被算进基线，`typed` 永远是 false，末尾照样把他拽走。
   */
  it('基线记在第一个 await 之前', () => {
    // 按**行号**来，而且跳过注释行 —— 上面那段注释里就写着「第一个 await 之前」，
    // 按字符位置找 'await ' 会抓到它自己（这条断言第一版就栽在这儿）
    const lines = body.split('\n')
    const at = (re: RegExp) => lines.findIndex((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && re.test(l))
    const edits = at(/const editsBefore = docEdits/)
    const acts = at(/const actsBefore = activations/)
    const firstAwait = at(/\bawait\b/)
    expect(edits).toBeGreaterThan(0)
    expect(acts).toBeGreaterThan(0)
    expect(firstAwait).toBeGreaterThan(0)
    expect(edits, '记在 await 之后就等于把人的输入算进了基线').toBeLessThan(firstAwait)
    expect(acts).toBeLessThan(firstAwait)
  })
})

/**
 * 滚动位置必须在 `spawnTab` **里面**就位。第一份文件会就地接管启动那个空白标签，
 * 而那次 `activate` 就在 spawnTab 内部 —— 调用方拿到返回值再写 `tab.scroll` 晚一步，
 * 视图已经滚到 0 了，而末尾那次 activate 现在又（正确地）不再发生。
 */
describe('恢复出来的滚动位置', () => {
  const main = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8')
  const at = main.indexOf('async function restoreSession()')
  // 结尾从函数头往后找：`view.scrollDOM.addEventListener` 在别处也有，
  // 从头找会拿到一个比开头还小的下标，切出来是空串（这条断言会静悄悄变成废话）
  const body = main.slice(at, main.indexOf('\n}', at))

  it('作为参数交给 spawnTab，而不是返回之后再写', () => {
    expect(body.length).toBeGreaterThan(100)
    expect(body).toContain('st?.scroll ?? 0')
    expect(body, '返回之后再写就晚了一步').not.toMatch(/\.scroll = /)
  })

  it('spawnTab 收得下它，而且在 activate 之前就摆上', () => {
    const at = main.indexOf('function spawnTab(')
    const fn = main.slice(at, main.indexOf('\n}', at))
    expect(fn).toMatch(/scroll = 0\s*\n\s*\): Tab \{/)
    expect(fn.indexOf('pristine.scroll = scroll')).toBeLessThan(
      fn.indexOf('activate(pristine.id)')
    )
  })
})
