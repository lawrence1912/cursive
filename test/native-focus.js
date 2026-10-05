// 在真实 WKWebView 中运行；组合事件只守键盘处理，不替代真实输入法验收。
void (async () => {
  const view = window.__cursive.view
  const results = {}
  const key = (target, name, init = {}) => {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(event)
    return event
  }
  const menu = () => document.querySelector('.ctx-menu')
  const open = () => {
    view.focus()
    document.querySelector('.tab-item.is-active').dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, clientX: 300, clientY: 30
    }))
  }
  open()
  const enabled = [...menu().querySelectorAll('button:not(:disabled)')]
  results.menuFocus = document.activeElement === enabled[0]
  key(document.activeElement, 'ArrowDown')
  results.menuNext = document.activeElement === enabled[1]
  key(document.activeElement, 'End')
  results.menuEnd = document.activeElement === enabled.at(-1)
  key(document.activeElement, 'Home')
  results.menuHome = document.activeElement === enabled[0]
  key(document.activeElement, 'Escape', { isComposing: true })
  results.menuComposition = !!menu()
  key(document.activeElement, 'Escape')
  results.menuReturn = !menu() && document.activeElement === view.contentDOM
  open()
  key(document.activeElement, 'Tab')
  results.menuTabExit = !menu() && document.activeElement === view.contentDOM
  if (menu()) key(document.activeElement, 'Escape')

  const cell = document.querySelector('.cm-lp-tableview td')
  if (cell) {
    cell.focus()
    const before = view.state.doc
    cell.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    const event = key(cell, 'Enter', { isComposing: true })
    results.tableComposition = !event.defaultPrevented && document.activeElement === cell
      && view.state.doc.eq(before)
    cell.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  }
  const header = document.querySelector('.cm-lp-tableview th')
  header.focus()
  key(header, 'Tab', { shiftKey: true })
  const toolbar = document.querySelector('.cm-lp-tbl-bar')
  const buttons = [...toolbar.querySelectorAll('button:not(:disabled)')]
  results.tableToolbarEntry = document.activeElement === buttons[0]
  key(document.activeElement, 'End')
  results.tableToolbarEnd = document.activeElement === buttons.at(-1)
  key(document.activeElement, 'Home')
  key(document.activeElement, 'ArrowRight')
  results.tableToolbarNext = document.activeElement === buttons[1]
  key(document.activeElement, 'Escape')
  results.tableToolbarReturn = document.activeElement === header
  window.__shellEmit('menu', 'view:command-palette')
  const paletteInput = document.querySelector('.pl-input')
  results.tablePaletteEntry = document.activeElement === paletteInput
  key(paletteInput, 'Escape')
  results.tablePaletteReturn = document.activeElement === header

  key(header, 'Tab', { shiftKey: true })
  const beforeTool = view.state.doc
  toolbar.querySelector('[data-tool="row-down"]').click()
  results.tableToolAction = !view.state.doc.eq(beforeTool)
    && document.activeElement?.matches('.cm-lp-tableview th, .cm-lp-tableview td')
  window.__shellEmit('menu', 'edit:undo')
  results.tableToolUndo = view.state.doc.eq(beforeTool)

  const sidebar = window.__cursive.sidebar
  sidebar.openSearch()
  const input = document.querySelector('.fs-input')
  input.value = '中文'
  results.searchCompositionEnter = !key(input, 'Enter', { isComposing: true }).defaultPrevented
  key(input, 'Escape', { isComposing: true })
  results.searchCompositionEscape = input.value === '中文' && document.activeElement === input
  const replacement = document.querySelector('.fs-replace')
  replacement.focus()
  results.replaceCompositionEnter = !key(replacement, 'Enter', { isComposing: true }).defaultPrevented
  key(replacement, 'Escape', { isComposing: true })
  results.replaceCompositionEscape = document.activeElement === replacement
    && !document.querySelector('.sb-search').hidden

  await sidebar.open(window.__focusResult.slice(0, window.__focusResult.lastIndexOf('/')))
  sidebar.searchFor('中文')
  for (let i = 0; i < 50 && document.querySelectorAll('.fs-hit').length < 2; i++) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  input.focus()
  key(input, 'ArrowDown')
  const hits = [...document.querySelectorAll('.fs-open')]
  results.searchEntry = hits.length >= 2 && document.activeElement === hits[0]
  key(document.activeElement, 'ArrowDown')
  results.searchNext = hits.length >= 2 && document.activeElement === hits[1]
  key(document.activeElement, 'Home')
  results.searchHome = hits.length >= 2 && document.activeElement === hits[0]
  key(document.activeElement, 'Escape')
  results.searchReturn = document.activeElement === input
  hits.at(-1)?.click()
  for (let i = 0; i < 50 && document.activeElement !== view.contentDOM; i++) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  results.searchOpen = document.activeElement === view.contentDOM
    && view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) === '中文'

  const zoom = document.querySelector('.cm-lp-image .cm-lp-zoom')
  zoom.focus()
  zoom.click()
  const close = document.querySelector('.img-viewer-close')
  results.imageFocus = document.activeElement === close
  key(close, 'Tab', { shiftKey: true })
  results.imageTrap = document.activeElement === close
  key(close, 'Escape')
  results.imageReturn = !document.querySelector('#image-viewer') && document.activeElement === zoom

  window.__shellEmit('menu', 'view:command-palette')
  const query = document.querySelector('.pl-input')
  query.value = 'LaTeX'
  query.dispatchEvent(new Event('input', { bubbles: true }))
  results.latexPaletteEntry = [...document.querySelectorAll('.pl-row')]
    .some(row => row.textContent.includes('格式化 LaTeX'))
  key(query, 'Escape')
  const original = view.state.doc.toString()
  const position = original.indexOf('\\begin{aligned}')
  view.dispatch({ selection: { anchor: position + 2 } })
  window.__shellEmit('menu', 'fmt:latex-format')
  for (let i = 0; i < 50 && view.state.doc.toString() === original; i++) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const formatted = view.state.doc.toString()
  results.latexBlock = formatted.includes('$$\n\\begin{aligned}\n  a &= b + c \\\\\n  d &= 2\n\\end{aligned}\n$$')
    && document.activeElement === view.contentDOM
  view.dispatch({ selection: { anchor: position + 4 } })
  window.__shellEmit('menu', 'fmt:latex-format')
  for (let i = 0; i < 50 && !document.querySelector('#status-note').textContent.includes('源码已格式化'); i++) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  results.latexIdempotent = view.state.doc.toString() === formatted
    && document.querySelector('#status-note').textContent.includes('源码已格式化')
  window.__shellEmit('menu', 'edit:undo')
  results.latexUndo = view.state.doc.toString() === original
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
  window.__shellEmit('menu', 'fmt:latex-format')
  for (let i = 0; i < 50 && !view.state.doc.toString().includes('$x = 1 + 2$'); i++) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  results.latexBatch = view.state.doc.toString().includes('$x = 1 + 2$')
    && view.state.doc.toString().includes('a &= b + c')
  window.__shellEmit('menu', 'edit:undo')
  results.latexBatchUndo = view.state.doc.toString() === original
  view.dispatch({ selection: { anchor: 0 } })
  window.__shellEmit('menu', 'fmt:latex-format')
  for (let i = 0; i < 50 && !document.querySelector('#status-note').textContent.includes('请将光标'); i++) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  results.latexNoFormula = view.state.doc.toString() === original
    && document.querySelector('#status-note').textContent.includes('请将光标')
  await window.api.save(window.__focusResult, JSON.stringify(results), { eol: '\n', bom: false })
})()
