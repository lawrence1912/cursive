export interface MenuItem {
  label: string
  run: () => void | Promise<void>
  /** 危险动作（删除）用告警色 */
  danger?: boolean
  /** 置灰：条目留着但点不动（一级标题不能再升级这类） */
  disabled?: boolean
  /** 与上一条之间画一条分隔线 */
  separated?: boolean
}

/**
 * 右键菜单。**挂在 body 上**（面板自己是 `overflow:auto`，挂里面会被裁掉），
 * 全局同时只存在一个 —— 文件树（P3-1）与大纲（P3-6）共用这一份，
 * 两边各写一遍的话弹出/收起/边界回折这些细节迟早会走样。
 */
let current: HTMLElement | null = null
let cleanup: (() => void) | null = null

export function closeMenu(): void {
  current?.remove()
  current = null
  cleanup?.()
  cleanup = null
}

export function openMenu(
  x: number,
  y: number,
  items: MenuItem[],
  opts: { onClose?: () => void; scrollHost?: HTMLElement } = {}
): void {
  closeMenu()
  const menu = document.createElement('div')
  menu.className = 'ctx-menu'
  menu.setAttribute('role', 'menu')
  for (const item of items) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.setAttribute('role', 'menuitem')
    btn.className = 'ctx-item'
    btn.classList.toggle('is-danger', item.danger === true)
    btn.classList.toggle('is-sep', item.separated === true)
    btn.disabled = item.disabled === true
    btn.textContent = item.label
    btn.addEventListener('click', () => {
      closeMenu()
      void item.run()
    })
    menu.appendChild(btn)
  }
  document.body.appendChild(menu)
  // 贴着窗口右下角弹出时要回折，否则菜单会被切掉一半
  const box = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - box.width - 8))}px`
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - box.height - 8))}px`
  current = menu

  const dismiss = (ev?: Event): void => {
    if (ev && menu.contains(ev.target as HTMLElement)) return
    closeMenu()
  }
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') closeMenu()
  }
  // 捕获阶段：编辑器自己也吃 mousedown，等冒泡就晚了
  window.addEventListener('mousedown', dismiss, true)
  window.addEventListener('blur', dismiss)
  window.addEventListener('keydown', onKey, true)
  opts.scrollHost?.addEventListener('scroll', dismiss)
  cleanup = () => {
    window.removeEventListener('mousedown', dismiss, true)
    window.removeEventListener('blur', dismiss)
    window.removeEventListener('keydown', onKey, true)
    opts.scrollHost?.removeEventListener('scroll', dismiss)
    opts.onClose?.()
  }
}
