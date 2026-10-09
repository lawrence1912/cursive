// 第八节 17：真实中文输入法走查的页面这一半（shell-swift/check-ime.py 驱动）。
//
// 按键不是这里发的 —— 是 `ime-driver` 用 CGEvent 投给这个进程、由系统当前的中文输入法
// 真的接手组字。这里只做三件事：按指令把光标 / 焦点摆到位；**记下输入法自己的提交**
// （`compositionend` 的 data —— 判据不依赖候选词是什么）；把此刻的文档、选区、焦点交回去。
// 指令走文件：`__probeCmd` 里一份 JSON（`window.api.read` 轮询），结果写进隔离支持目录的
// scratch（`scratchSave`，不碰「最近文件」）。
void (async () => {
  const view = window.__cursive.view
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const log = []
  const describe = (el) => {
    if (!el) return 'none'
    if (el === view.contentDOM) return 'editor'
    if (el.matches?.('.cm-lp-tableview td, .cm-lp-tableview th')) return 'cell'
    if (el.matches?.('.cm-panels input[name="search"]')) return 'find'
    if (el.matches?.('.pl-input')) return 'palette'
    return el.tagName || 'other'
  }
  for (const type of ['compositionstart', 'compositionend']) {
    document.addEventListener(type, (e) => {
      log.push({ type, data: e.data ?? '', target: describe(e.target) })
    }, true)
  }
  // 不把拼音嵌进输入框的输入法（候选全在它自己的窗里）不派 composition 事件，提交只是一次
  // insertText —— 那时的判据是 beforeinput 的 data。按键到没到也记一笔，排查「键根本没进来」
  document.addEventListener('beforeinput', (e) => {
    log.push({ type: 'beforeinput', inputType: e.inputType, data: e.data ?? '', target: describe(e.target) })
  }, true)
  document.addEventListener('keydown', (e) => {
    log.push({ type: 'keydown', key: e.key, composing: e.isComposing || e.keyCode === 229, target: describe(e.target) })
  }, true)
  const lineFrom = (marker) => {
    const at = view.state.doc.toString().indexOf(marker)
    return at < 0 ? -1 : view.state.doc.lineAt(at).to
  }
  const cell = () => [...document.querySelectorAll('.cm-lp-tableview td')]
    .find((td) => td.textContent.includes('在格子里输入')) ?? null
  const state = () => {
    const sel = view.state.selection.main
    const active = document.activeElement
    const activeCell = active?.matches?.('.cm-lp-tableview td, .cm-lp-tableview th') ? active : null
    return {
      text: view.state.doc.toString(),
      sel: [sel.anchor, sel.head],
      active: describe(active),
      composing: view.composing || view.compositionStarted,
      tab: document.querySelector('.tab-item.is-active')?.title ?? '',
      find: document.querySelector('.cm-panels input[name="search"]')?.value ?? null,
      palette: document.querySelector('.pl-input')?.value ?? null,
      paletteOpen: !!document.querySelector('.pl-input') && document.querySelector('.pl-input').offsetParent !== null,
      cell: activeCell ? { text: activeCell.textContent, row: activeCell.parentElement.rowIndex, col: activeCell.cellIndex } : null,
      lines: view.state.doc.lines,
      hasFocus: document.hasFocus(),
      log: log.splice(0)
    }
  }
  const caretAtEnd = (el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const s = window.getSelection()
    s.removeAllRanges()
    s.addRange(range)
  }

  const run = async (cmd) => {
    switch (cmd.op) {
      case 'prepare': {
        if (cmd.where === 'paragraph' || cmd.where === 'paragraph2') {
          const marker = cmd.where === 'paragraph' ? '在这里输入：' : '第二段：点到这里。'
          view.focus()
          view.dispatch({ selection: { anchor: lineFrom(marker) }, scrollIntoView: true })
        } else if (cmd.where === 'cell') {
          const td = cell()
          td.focus()
          caretAtEnd(td)
        } else if (cmd.where === 'find') {
          window.__shellEmit('menu', 'edit:find')
          await sleep(120)
          const input = document.querySelector('.cm-panels input[name="search"]')
          input.value = ''
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.focus()
        }
        await sleep(150)
        log.length = 0
        return state()
      }
      case 'menu':
        window.__shellEmit('menu', cmd.action)
        await sleep(cmd.wait ?? 200)
        return state()
      case 'point': {
        // 「第二段」那一行里某个字的**页面坐标**。换成屏幕坐标要加窗口在屏幕上的原点，那个数由驱动
        // 从窗口服务器读（`ime-driver bounds`）—— 全尺寸内容视图下网页从窗口顶边就开始了，
        // 拿 outerHeight - innerHeight 当标题栏去推会整整偏一截（2026-10-08 点进了下面的表格）
        const at = lineFrom('第二段：点到这里。') - 3
        const c = view.coordsAtPos(at)
        return { cx: c.left + 2, cy: (c.top + c.bottom) / 2, pos: at }
      }
      case 'open-b': {
        const row = [...document.querySelectorAll('.sb-row')].find((r) => r.dataset.path?.endsWith('/b.md'))
        row?.click()
        const active = () => document.querySelector('.tab-item.is-active')?.title
        for (let i = 0; i < 60 && active() !== 'b'; i++) await sleep(50)
        const bText = view.state.doc.toString()
        window.__shellEmit('menu', 'file:prev-tab')
        await sleep(300)
        return { ...state(), bText }
      }
      case 'escape-find': {
        const input = document.querySelector('.cm-panels input[name="search"]')
        input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        await sleep(100)
        return state()
      }
      default:
        return state()
    }
  }

  const save = (payload) => window.api.scratchSave(window.__probeOut, JSON.stringify(payload), { eol: '\n', bom: false })
  await save({ id: 'ready', ...state() })
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
    await sleep(50)
  }
})()
