// 在真实 WKWebView 中运行（shell-swift/check-flow.py）：第八节 5–7 的核心流程 ——
// 只读阅读模式、后退 / 前进、重新打开关闭的标签。菜单动作走 `__shellEmit('menu', …)`，
// 与原生菜单、命令面板是同一条路；打字走 `execCommand('insertText')`，与按键同一条编辑管线。
void (async () => {
  const view = window.__cursive.view
  const results = {}
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (cond, ms = 2500) => {
    for (let i = 0; i < ms / 50 && !cond(); i++) await sleep(50)
    return !!cond()
  }
  const menu = (action) => window.__shellEmit('menu', action)
  const diag = () => window.__cursive.diagnostics()
  const dir = window.__flowResult.slice(0, window.__flowResult.lastIndexOf('/'))
  const A = dir + '/a.md'
  const B = dir + '/b.md'
  const text = () => view.state.doc.toString()
  const head = () => view.state.selection.main.head
  const note = () => document.querySelector('#status-note').textContent
  const activePath = () => {
    const d = diag()
    return d.tabs.find((tab) => tab.id === d.activeId)?.path
  }
  const tabCount = () => document.querySelectorAll('.tab-item').length

  try {
    // ---------------- 第八节 5：只读阅读模式 ----------------
    view.focus()
    const original = text()
    view.dispatch({ selection: { anchor: original.indexOf('开头一段') } })
    menu('view:toggle-read-only')
    await sleep(80)
    results.roOn = view.state.readOnly === true
      && !!document.querySelector('.tab-item.is-active .tab-ro')
      && document.querySelector('#status-ro').textContent.includes('只读')
      && view.dom.classList.contains('cm-ro')

    // 真的打字：浏览器的编辑管线（beforeinput → DOM），与按键同一条路
    view.focus()
    document.execCommand('insertText', false, '字')
    await sleep(80)
    results.roTyping = text() === original
    results.roBlockedNote = await until(() => note().includes('只读模式下不能修改'))

    // 格式命令（菜单那条路）
    const at = original.indexOf('开头一段')
    view.dispatch({ selection: { anchor: at, head: at + 2 } })
    menu('fmt:bold')
    await sleep(80)
    results.roFormat = text() === original

    // 粘贴：剪贴板里一段 HTML（smartPaste 那条会先转 Markdown 再插）
    const data = new DataTransfer()
    data.setData('text/plain', '粘贴进来')
    data.setData('text/html', '<b>粘贴进来</b>')
    view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    await sleep(300)
    results.roPaste = text() === original

    // 任务勾选：复选框灰着，按下去文档不动
    const box = document.querySelector('.cm-lp-checkbox')
    box?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    box?.click()
    await sleep(80)
    results.roTask = !!box && box.disabled && text() === original

    // 表格：光标进表也不翻回源码；格子不是可编辑的孤岛，没有工具栏
    view.dispatch({ selection: { anchor: original.indexOf('| 1 ') + 2 } })
    await sleep(80)
    const cells = [...document.querySelectorAll('.cm-lp-tableview th, .cm-lp-tableview td')]
    results.roTable = cells.length === 4 && cells.every((cell) => !cell.isContentEditable)
      && !document.querySelector('.cm-lp-tbl-bar')

    // 图片：改尺寸的拖角收起来
    const handle = document.querySelector('.cm-lp-img-handle')
    results.roImageHandle = !!document.querySelector('.cm-lp-image')
      && (!handle || getComputedStyle(handle).display === 'none')

    // 查找照常，替换那一行收起来
    menu('edit:find')
    await sleep(120)
    const replaceRow = document.querySelector('.cm-panels .cs-replace')
    results.roFind = !!document.querySelector('.cm-panels input[name="search"]')
      && !!replaceRow && getComputedStyle(replaceRow).display === 'none'
    menu('edit:find')

    // 撤销也改不了（CM 自己的命令认只读）
    menu('edit:undo')
    await sleep(80)
    results.roUndo = text() === original

    // 退出只读：恢复正常编辑，锁和状态栏那一格一起撤掉
    menu('view:toggle-read-only')
    await sleep(80)
    view.focus()
    view.dispatch({ selection: { anchor: original.indexOf('开头一段') } })
    document.execCommand('insertText', false, '字')
    await sleep(80)
    results.roOff = view.state.readOnly === false && text() !== original
      && !document.querySelector('.tab-item.is-active .tab-ro')
      && document.querySelector('#status-ro').textContent === ''
    menu('edit:undo')
    await sleep(80)
    results.roOffUndo = text() === original

    // 证人：同样的格式命令 / 粘贴 / 勾选，在可编辑时**真的会**改文档 —— 否则上面那几条
    // 「只读时文档没动」证明不了任何事（事件压根没生效也是「没动」）
    view.dispatch({ selection: { anchor: at, head: at + 2 } })
    menu('fmt:bold')
    await sleep(80)
    results.roFormatWitness = text().includes('**开头**')
    menu('edit:undo')
    await sleep(80)
    const again = new DataTransfer()
    again.setData('text/plain', '粘贴进来')
    again.setData('text/html', '<b>粘贴进来</b>')
    view.dispatch({ selection: { anchor: at } })
    view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: again, bubbles: true, cancelable: true }))
    results.roPasteWitness = await until(() => text().includes('粘贴进来'))
    menu('edit:undo')
    await sleep(80)
    const live = document.querySelector('.cm-lp-checkbox')
    live?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    await sleep(80)
    results.roTaskWitness = !!live && !live.disabled && text().includes('- [x] 待办一项')
    menu('edit:undo')
    await sleep(80)
    results.roWitnessUndo = text() === original

    // ---------------- 第八节 6：后退 / 前进 ----------------
    // 同文档：大纲点「最后一节」，后退回到原位置（光标与读到哪儿），再前进
    view.dispatch({ selection: { anchor: 0 } })
    view.scrollDOM.scrollTop = 0
    await sleep(150)
    const last = text().indexOf('## 最后一节')
    const row = [...document.querySelectorAll('.ol-row')].find((r) => r.textContent.includes('最后一节'))
    row?.click()
    await sleep(250)
    results.navJump = !!row && head() === last && view.scrollDOM.scrollTop > 200
    results.navFlagsAfterJump = diag().navFlags.canBack === true && diag().navFlags.canForward === false
    menu('go:back')
    await sleep(350)
    results.navBack = head() === 0 && view.scrollDOM.scrollTop < 60
    results.navFlagsAfterBack = diag().navFlags.canForward === true
    menu('go:forward')
    await sleep(350)
    results.navForward = head() === last && view.scrollDOM.scrollTop > 200
    menu('go:back')
    await sleep(350)

    // 跨文档：⌘+点击 [去 B 的第二节]，落在 B 的那一节；后退回到 A 的原处，再前进
    const linkAt = text().indexOf('去 B 的第二节')
    const rest = text().indexOf('开头一段')
    view.dispatch({ selection: { anchor: rest } })
    await sleep(80)
    const c = view.coordsAtPos(linkAt + 2)
    view.contentDOM.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, metaKey: true, button: 0,
      clientX: c.left + 2, clientY: (c.top + c.bottom) / 2
    }))
    await until(() => activePath() === B, 3000)
    await sleep(150)
    results.navCrossOpen = activePath() === B
      && view.state.doc.lineAt(head()).text === '## 第二节'
    menu('go:back')
    await until(() => activePath() === A)
    await sleep(150)
    results.navCrossBack = activePath() === A && head() === rest
    menu('go:forward')
    await until(() => activePath() === B)
    await sleep(150)
    results.navCrossForward = activePath() === B && view.state.doc.lineAt(head()).text === '## 第二节'

    // 关掉 B 之后后退：先回到 B（按路径重新打开），再退回 A
    menu('file:close-tab')
    await until(() => activePath() === A)
    menu('go:back')
    await until(() => activePath() === B, 3000)
    await sleep(150)
    results.navReopensClosed = activePath() === B && view.state.doc.lineAt(head()).text === '## 第二节'

    // ---------------- 第八节 7：重新打开关闭的标签 ----------------
    // B 设为只读、光标放在第一节，关掉；重新打开回来时位置与只读都在，标签数复原
    menu('view:toggle-read-only')
    await sleep(80)
    const first = text().indexOf('## 第一节')
    view.dispatch({ selection: { anchor: first } })
    const count = tabCount()
    menu('file:close-tab')
    await until(() => activePath() !== B)
    results.reopenAvailable = diag().closedTabs >= 1 && diag().navFlags.canReopen === true
    menu('file:reopen-closed-tab')
    await until(() => activePath() === B, 3000)
    await sleep(150)
    results.reopenRestores = activePath() === B && head() === first && view.state.readOnly === true
      && tabCount() === count
    // 只读这一位跟着回来：锁也在标签上
    results.reopenLock = !!document.querySelector('.tab-item.is-active .tab-ro')

    // 已经又开着了的不出第二份：关掉 B → 从文件树再开 B → 按「重新打开」不会多一个标签
    menu('file:close-tab')
    await until(() => activePath() !== B)
    const treeRow = [...document.querySelectorAll('.sb-row')].find((r) => r.dataset.path === B)
    treeRow?.click()
    await until(() => activePath() === B, 3000)
    const tabsNow = tabCount()
    menu('file:reopen-closed-tab')
    await sleep(400)
    results.reopenNoDuplicate = !!treeRow && tabCount() === tabsNow
      && diag().tabs.filter((tab) => tab.path === B).length === 1
      && note().includes('没有可以重新打开的标签')

    // 无路径的草稿关了不进栈（首版不救明确丢弃的草稿）
    const stacked = diag().closedTabs
    menu('file:new')
    await sleep(80)
    menu('file:close-tab')
    await sleep(150)
    results.reopenSkipsUntitled = diag().closedTabs === stacked
  } catch (e) {
    results.error = false
    results.errorText = String(e && e.stack || e)
  }
  await window.api.save(window.__flowResult, JSON.stringify(results), { eol: '\n', bom: false })
})()
