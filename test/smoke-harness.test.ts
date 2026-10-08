import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const swift = readFileSync(new URL('../shell-swift/main.swift', import.meta.url), 'utf8')
const release = readFileSync(new URL('../shell-swift/release.sh', import.meta.url), 'utf8')

/**
 * 自检的「安静模式」（0.4.1，`CURSIVE_SMOKE_QUIET=1`）。
 *
 * 自检窗口默认 `NSApp.activate(ignoringOtherApps: true)` 抢到最前面 —— 那是为了挡住
 * 「人在旁边打字把夹具改花」，可代价是**手跑一次探针就把人踢到后台一次**。
 * 安静模式不调 activate：窗口开在后面，人的按键落在人自己的 app 里，夹具反而更安全。
 *
 * **代价必须留在测试侧**：窗口不是 key 时 WebKit 一帧都不派（2026-09-21 实测
 * `raf: 0`，而定时器照跑）、`:focus` 压根不匹配。所以这个模式只给**状态类**探针用
 * （读 state、读文档、量同步耗时），而 `release.sh` 里有一批按帧取样的断言 ——
 * 它一旦带上这个变量，那批断言会变成假绿假红，比直接红更难查。这两条就是这里扫的。
 */
describe('自检安静模式', () => {
  it('只在自检下成立（正式启动走不到这条分支）', () => {
    expect(swift).toContain(
      'let smokeQuiet = smokeAuto && ProcessInfo.processInfo.environment["CURSIVE_SMOKE_QUIET"] != nil'
    )
  })

  it('抢前台那一句被它挡住了，而且全文只有这一处', () => {
    // 注释里也写着这个调用（吞键那段在讲它），所以按「不是注释行」筛
    const calls = swift
      .split('\n')
      .filter((l) => l.includes('NSApp.activate(') && !/^\s*(\/\/|\*|\/\*)/.test(l))
    expect(calls, '别处不许再有一句裸的 activate 把它绕过去').toHaveLength(1)
    expect(calls[0]).toContain('if !smokeQuiet')
  })

  it('release.sh 不许设它（那条流水线里有按帧取样的断言）', () => {
    expect(release).not.toContain('CURSIVE_SMOKE_QUIET')
  })
})

/**
 * 探针取值的层级（0.4.1 修）。
 *
 * 壳侧把网页那次 `callAsyncJavaScript` 的整个返回值塞进 `out["result"]`，顶层只剩
 * 它自己补的那几个键（窗口数、最近文件、草稿计数…）。于是「读错一层」在 Python 里
 * **一声不吭**：`e.get('selectAllProbe')` 拿到 `None`，`or {}` 兜成空字典，断言恒假 ——
 * 红的是业务，错的是取值，排查方向整个反了（实测 `release.sh` 因此必然停在那一条）。
 *
 * 所以这里对账：`release.sh` 里每一处从 `e` 顶层取的键，都必须真的是壳写在顶层的。
 * 键名从 `main.swift` 现扫，新增一个顶层键不用回来改这份测试。
 */
describe('E2E 探针取值不许读错一层', () => {
  const topLevelKeys = (): Set<string> => {
    const keys = new Set<string>()
    // ① `var out: [String: Any] = [ "source": …, "roundtrip": … ]` 那个字面量
    const lit = swift.match(/var out: \[String: Any\] = \[([\s\S]*?)\n\s*\]/)
    for (const m of (lit?.[1] ?? '').matchAll(/"([^"]+)":/g)) keys.add(m[1]!)
    // ② 之后逐条补上去的 `out["…"] = …`
    for (const m of swift.matchAll(/\bout\["([^"]+)"\]\s*=/g)) keys.add(m[1]!)
    return keys
  }

  it('壳确实分了两层（顶层有 result，探针在它底下）', () => {
    const top = topLevelKeys()
    expect(top.has('result')).toBe(true)
    expect(top.has('selectAllProbe'), '探针不该出现在顶层').toBe(false)
    // 扫岔了的话下面那条会变成一句废话，这里先把「扫到了东西」钉住
    expect(top.size).toBeGreaterThan(5)
  })

  it('release.sh 从顶层取的每一个键都真的在顶层', () => {
    const top = topLevelKeys()
    // `te.get(` / `re[` 这类别的变量不能算进来，所以 `e` 前面要求不是标识符字符
    const read = [...release.matchAll(/(?<![A-Za-z0-9_])e(?:\.get\(|\[)['"]([^'"]+)['"]/g)]
    expect(read.length, '一条都没扫到就说明这条断言自己坏了').toBeGreaterThan(5)
    const strays = [...new Set(read.map((m) => m[1]!))].filter((k) => !top.has(k))
    expect(strays, '这些键住在 result 里，不在顶层').toEqual([])
  })
})

/**
 * 自检的应用支持目录必须是临时的（0.4.1 修，这条早于 0.4.1 就在）。
 *
 * `release.sh` 从前拿开发机上**真实**的 `~/Library/Application Support/cursive/` 当
 * 试验田：整轮开始前 `rm -rf history/`（那是用户自己的版本历史）、每个用例
 * `rm -f scratch/*.json`（那是崩溃恢复草稿）、往 `themes/` 丢一张探针皮肤 ——
 * 而收走那张皮肤的 `rm` 挂在脚本末尾，`set -e` 下任何一条断言红了都走不到。
 * 实测这台开发机的 themes/ 里就躺着一张 9-21 留下的 e2e-skin.css。
 *
 * 真机那半（跑一次自检，真实目录一个字节都不动）只有 `release.sh` 自己证得了；
 * 这里守住形状：脚本不许再指向真实目录，壳侧那个出口不许在正式启动下打开。
 */
describe('自检不许碰真实的应用支持目录', () => {
  it('release.sh 里没有一处指向 ~/Library/Application Support', () => {
    // 上面那段注释里也写着这个路径（在讲它为什么不能再出现），所以按「不是注释行」筛
    const live = release
      .split('\n')
      .filter((l) => !/^\s*#/.test(l) && l.includes('Library/Application Support'))
    expect(live, '自检只许用临时目录').toEqual([])
  })

  it('支持目录换成临时的，而且成功失败两条路都收得干净', () => {
    expect(release).toContain('export CURSIVE_SMOKE_SUPPORT=')
    // 收尾只认 trap：挂在末尾的 rm 在 `set -e` 下失败时走不到（这就是原来的病灶）
    expect(release).toMatch(/trap 'rm -rf "\$SUPPORT"' EXIT/)
    // 三个目录都得从 $SUPPORT 长出来，漏一个就又回去动真实的那份了
    for (const dir of ['scratch', 'history', 'themes']) {
      expect(release, `${dir} 还指着别处`).toContain(`$SUPPORT/cursive/${dir}`)
    }
  })

  it('壳侧只有一处解析应用支持目录，出口只在自检下开', () => {
    const lines = swift.split('\n')
    const hits = lines.filter((l) => l.includes('.applicationSupportDirectory'))
    expect(hits, '换根只该有一处（supportBaseURL），别处再解析一次就绕开了隔离').toHaveLength(1)
    const at = lines.findIndex((l) => l.includes('func supportBaseURL()'))
    expect(at).toBeGreaterThan(0)
    const body = lines.slice(at, at + 10).join('\n')
    expect(body).toContain('CURSIVE_SMOKE_SUPPORT')
    // 平时能把数据目录换掉的口子，迟早有人在真实文档上误触一次
    expect(body, '这个出口必须被 smokeAuto 挡着').toMatch(/if smokeAuto,[\s\S]*CURSIVE_SMOKE_SUPPORT/)
  })
})

/**
 * 第八节 3 的**固定走查项**：五组组合操作，每一组都有一条 E2E 探针 + 一条断言。
 *
 * 这份清单的意义在于**它不许悄悄变短**。五组里每一组都对应一层已经存在、而且
 * 只有真跑起来才看得见的保护（拖选期间冻结回显布局、文末翻面的底部留白、表格
 * 进出编辑态的条件、reconfigure 之后的滚动锚、合成期间不重算装饰器）——
 * 这些保护从前全靠手点走查，谁都不知道哪一次改动把哪一层碰掉了。
 */
describe('第八节 3：源码显隐与选区稳定性的固定走查项', () => {
  const items = [
    // [探针名, release.sh 里读它的那一行的一部分]
    ['dragProbe', "dp.get('steady')"],
    ['mathTailProbe', "mt.get('inBlock')"],
    ['tableHopProbe', "th.get('stillRendered')"],
    ['modeProbe', "mp.get('drift')"],
    ['imeProbe', "ip.get('heldRendered')"]
  ] as const

  it('五组都在探针里，也都在断言里 —— 少一组就是少走查一层保护', () => {
    for (const [probe, assertion] of items) {
      expect(swift, `${probe} 的探针没了`).toContain(`${probe} = {`)
      expect(swift, `${probe} 没报回去`).toContain(`          ${probe},`)
      expect(release, `${probe} 没人验`).toContain(assertion)
    }
  })

  it('每一组都带着「这条用例还证明得了东西」的证人', () => {
    // 走查最容易烂掉的方式不是变红，是**变成一句空话**：图没渲染出来、公式没翻、
    // 表只有一张、模式没切过去、那一行本来就翻不动 —— 每一条都另钉一个前提
    expect(release).toContain("dp.get('covers')") // 选区真跨过了那张图
    expect(release).toContain("mt.get('revealed')") // 公式真翻成源码了
    expect(release).toContain("th.get('views0') == 2") // 真有两张表
    expect(release).toContain("mp.get('inSource')") // 真切到源码模式了
    expect(release).toContain("ip.get('revealedAfter')") // 合成收工之后它翻得动
  })

  it('文末翻面那条是**量出来的预算**，不是拍的', () => {
    // 2026-09-22 实测 29px（正文一行 ≈ 29px）。这个数一旦涨到几百，
    // 就是 `pointer-selection.ts` 末尾那笔底部留白又没了（0.2.x 实测跳 377px）
    expect(release).toContain("mt.get('jumped', 999) <= 40")
  })

  it('标签数按「多出来一个」算，不写死 —— 所有用例共用一个工作区根', () => {
    // 上一条用例留在会话里的标签会在这一条启动时被恢复出来，写死 2 会随用例顺序
    // 随机变红（2026-09-22 真踩过：单跑绿，接在 tables.md 后面跑红）
    expect(release).toContain("sp.get('tabsOpen') == sp.get('tabsBefore', -9) + 1")
  })
})

/**
 * 第八节 5–7（只读 / 后退前进 / 重新打开关闭的标签）的原生专项（第四节红线 5：每个新功能
 * 在 release.sh 里有一条断言）。它是一个独立的窗口（`check-flow.py`），这里钉两件事：
 * 流水线真的跑它；每一条「挡住了」都带着「可编辑时真的会改」的证人 —— 少了证人，
 * 「事件压根没生效」也会被读成「只读挡住了」。
 */
describe('第八节 5–7 的原生专项', () => {
  const flow = readFileSync(new URL('../test/native-flow.js', import.meta.url), 'utf8')
  const harness = readFileSync(new URL('../shell-swift/check-flow.py', import.meta.url), 'utf8')

  it('release.sh 跑它，而且排在打包之前（红了就不出包）', () => {
    const at = release.indexOf('python3 shell-swift/check-flow.py')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(release.indexOf('[4/4] 打包'))
  })

  it('挡住的那几条各有证人', () => {
    for (const name of ['roFormat', 'roPaste', 'roTask']) {
      expect(flow).toContain(`results.${name} =`)
      expect(flow).toContain(`results.${name}Witness =`)
    }
    expect(flow).toContain('results.roOff =') // 打字那条的证人：退出只读后同样的 insertText 改得动
  })

  it('检查条数对得上（少写一条断言不会悄悄混过去）', () => {
    const n = [...flow.matchAll(/^\s*results\.(?!error)\w+ = /gm)].length
    expect(harness).toContain(`CHECKS = ${n}`)
  })
})
