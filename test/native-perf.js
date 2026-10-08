// 第八节 15：真实窗口里的交互基线（shell-swift/measure.py 驱动）。
//
// 按键是 ime-driver 从系统事件流打进来的真键，这里只量：
//   · frame —— keydown 的 `timeStamp`（WebKit 取的是平台事件的时刻）到「下一帧交出去」：
//     rAF 回调里再挂一个 setTimeout(0)，它在这一帧的布局、绘制都做完之后才轮到；
//   · sync  —— 这一下引起的 `view.dispatch` 同步耗时之和（状态 + 装饰 + DOM 写入）。
// 两个口径分开记，不互相代替（ROADMAP 第八节 15 的要求）。切标签走菜单（⌃⇥ 是原生菜单项，
// 页面收不到 keydown），起点改成壳把菜单动作转进页面的那一刻，另外交回墙钟时刻
// （`timeOrigin + now`）给驱动那一侧算端到端。
void (async () => {
  const view = window.__cursive.view
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const tick = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
  let rec = null
  let current = null

  document.addEventListener('keydown', (e) => {
    if (!rec) return
    const s = { t0: e.timeStamp, sync: 0, frame: null }
    rec.push(s)
    current = s
    requestAnimationFrame(() => setTimeout(() => {
      s.frame = performance.now() - s.t0
      s.wall = performance.timeOrigin + performance.now()
    }, 0))
  }, true)

  const realDispatch = view.dispatch
  view.dispatch = (...args) => {
    const at = performance.now()
    try {
      return realDispatch(...args)
    } finally {
      if (current) current.sync += performance.now() - at
    }
  }

  // 切标签：起点是菜单动作进页面那一刻（`__shellEmit` 是壳往页面推事件的唯一入口）
  const realEmit = window.__shellEmit
  window.__shellEmit = (event, payload) => {
    if (rec && event === 'menu' && /tab$/.test(String(payload))) {
      const s = { t0: performance.now(), sync: 0, frame: null, menu: payload }
      rec.push(s)
      current = s
      requestAnimationFrame(() => setTimeout(() => {
        s.frame = performance.now() - s.t0
        s.wall = performance.timeOrigin + performance.now()
      }, 0))
    }
    return realEmit(event, payload)
  }

  const lineOf = (marker) => {
    const at = view.state.doc.toString().indexOf(marker)
    return at < 0 ? -1 : view.state.doc.lineAt(at).to
  }

  const run = async (cmd) => {
    switch (cmd.op) {
      case 'place': {
        if (cmd.where === 'table') {
          view.dispatch({ selection: { anchor: lineOf('【格测量】') - 4 }, scrollIntoView: true })
          await tick()
          const td = [...document.querySelectorAll('.cm-lp-tableview td')].find((c) => c.textContent.includes('【格测量】'))
          td.focus()
          const range = document.createRange()
          range.selectNodeContents(td)
          range.collapse(false)
          getSelection().removeAllRanges()
          getSelection().addRange(range)
        } else {
          if (cmd.where === 'find') {
            window.__shellEmit('menu', 'edit:find')
            await sleep(150)
            const input = document.querySelector('.cm-panels input[name="search"]')
            input.value = '正文'   // 每一段都有：几千处命中，查找开着时最重的那一种
            input.dispatchEvent(new Event('input', { bubbles: true }))
            await sleep(300)
          }
          view.focus()
          view.dispatch({ selection: { anchor: lineOf('【测量点】') }, scrollIntoView: true })
        }
        await sleep(300)
        await tick()
        return { active: document.activeElement === view.contentDOM ? 'editor' : document.activeElement?.tagName }
      }
      case 'unfind': {
        const input = document.querySelector('.cm-panels input[name="search"]')
        input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        await sleep(200)
        return { open: !!document.querySelector('.cm-panels input[name="search"]') }
      }
      case 'arm':
        rec = []
        current = null
        return {}
      case 'collect': {
        await sleep(cmd.settle ?? 400)
        const out = (rec ?? []).filter((s) => s.frame !== null)
        rec = null
        current = null
        return { samples: out.map((s) => ({ frame: s.frame, sync: s.sync, wall: s.wall, menu: s.menu })) }
      }
      case 'scroll': {
        const s = view.scrollDOM
        s.scrollTop = 0
        await tick()
        const stamps = []
        const work = []
        await new Promise((resolve) => {
          let n = 0
          const frame = (t) => {
            stamps.push(t)
            const a = performance.now()
            s.scrollTop += cmd.step ?? 40
            work.push(performance.now() - a)
            if (++n < (cmd.frames ?? 300) && s.scrollTop + s.clientHeight < s.scrollHeight) requestAnimationFrame(frame)
            else resolve()
          }
          requestAnimationFrame(frame)
        })
        const intervals = stamps.slice(1).map((t, i) => t - stamps[i])
        return { intervals, frames: stamps.length }
      }
      case 'export': {
        const times = []
        let bytes = 0
        for (let i = 0; i < (cmd.runs ?? 3); i++) {
          const a = performance.now()
          bytes = (await window.__cursive.exportHtmlSource()).length
          times.push(performance.now() - a)
          await sleep(200)
        }
        return { times, bytes }
      }
      case 'open': {
        const row = [...document.querySelectorAll('.sb-row')].find((r) => r.dataset.path?.endsWith('/' + cmd.name))
        row?.click()
        const title = cmd.name.replace(/\.md$/, '')
        for (let i = 0; i < 100 && document.querySelector('.tab-item.is-active')?.title !== title; i++) await sleep(50)
        await sleep(400)
        return { ok: document.querySelector('.tab-item.is-active')?.title === title, tabs: document.querySelectorAll('.tab-item').length }
      }
      case 'info': {
        // 屏幕刷新率：空转 60 帧量一下 rAF 的间隔（ProMotion 屏上 WKWebView 未必跑 120）
        const stamps = []
        await new Promise((resolve) => {
          const f = (t) => {
            stamps.push(t)
            if (stamps.length < 61) requestAnimationFrame(f)
            else resolve()
          }
          requestAnimationFrame(f)
        })
        const gaps = stamps.slice(1).map((t, i) => t - stamps[i]).sort((a, b) => a - b)
        return {
          lines: view.state.doc.lines,
          chars: view.state.doc.length,
          rafMedian: gaps[Math.floor(gaps.length / 2)],
          hasFocus: document.hasFocus(),
          dpr: window.devicePixelRatio,
          viewport: [window.innerWidth, window.innerHeight]
        }
      }
      default:
        return {}
    }
  }

  const save = (payload) => window.api.scratchSave(window.__probeOut, JSON.stringify(payload), { eol: '\n', bom: false })
  await save({ id: 'ready' })
  let last = 'ready'
  for (;;) {
    let cmd = null
    try {
      cmd = JSON.parse((await window.api.read(window.__probeCmd)).content)
    } catch {
      cmd = null
    }
    if (cmd && cmd.id !== last) {
      last = cmd.id
      let out
      try {
        out = await run(cmd)
      } catch (e) {
        out = { error: String(e && e.stack || e) }
      }
      await save({ id: cmd.id, ...out })
      if (cmd.op === 'quit') break
    }
    await sleep(40)
  }
})()
