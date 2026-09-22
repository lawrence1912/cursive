/**
 * 状态栏左边那句**一次性反馈**（0.2.x 从 main.ts 挪出来，因为粘贴那条路也要用）。
 *
 * 为什么不弹原生对话框：点错一条链接、存下一张图，都是小事；拦下整个界面要人按一下
 * 「好」是大事。为什么也不能什么都不说：「点了没反应」是最糟的失败方式 —— 用户分不清
 * 是链接写错了、文件没了，还是这个编辑器压根不支持。
 *
 * 两类消息共用这一条：
 *   · **没能如愿**（`warn: true`）—— 黄色，4 秒；
 *   · **办成了**（默认）—— 常规色，同样 4 秒。成功的回执本来就只是「看一眼就好」。
 * 带动作按钮时停留 **8 秒**：一颗按不到的按钮等于没有，而「撤销」恰恰是最需要
 * 时间反应的那一种。
 */

import { t } from '../i18n'

export interface NoteAction {
  label: string
  run: () => void
}

export interface NoteOpts {
  /** 右边那颗动作按钮（撤销 / 在 Finder 中显示）。按下即收起这条消息 */
  action?: NoteAction
  /** 「刚才那一下没成」用黄色；办成了的回执用常规色 */
  warn?: boolean
  /**
   * **不自己消失**（第八节 4）：留到人自己收起为止，末尾多一颗「知道了」。
   *
   * 给的是那一类**不会自己好**的失败 —— 这份文件不是 UTF-8、没有读它的权限：
   * 人多半得离开这个窗口去处理（换个程序转码、改权限），回来时那句话还得在。
   * 「刚才那下没成」与「那件事还没解决」是两种消息，前者 4 秒足够，后者不该有计时器。
   */
  sticky?: boolean
}

/** 有动作按钮时停久一点 —— 4 秒够不着一颗要读一眼才敢按的按钮 */
const LINGER = { plain: 4000, action: 8000 }

let timer: number | undefined

/** 懒取而不是模块级常量：模块的求值顺序排在启动序列前面，那会儿 DOM 还不一定在 */
function host(): HTMLElement | null {
  return document.getElementById('status-note')
}

export function note(message: string, opts: NoteOpts = {}): void {
  const el = host()
  if (!el) return
  el.classList.toggle('is-warn', opts.warn === true)
  el.replaceChildren(document.createTextNode(message))
  if (opts.action) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'note-act'
    btn.textContent = opts.action.label
    const run = opts.action.run
    btn.addEventListener('click', () => {
      clearNote()
      run()
    })
    el.append(' ', btn)
  }
  if (opts.sticky) {
    // 一条不会自己走的消息必须给得出「让它走」的办法，否则状态栏上就多了一块赶不掉的疤
    const off = document.createElement('button')
    off.type = 'button'
    off.className = 'note-act'
    off.textContent = t('note.dismiss')
    off.addEventListener('click', clearNote)
    el.append(' ', off)
  }
  clearTimeout(timer)
  if (opts.sticky) return
  timer = window.setTimeout(clearNote, opts.action ? LINGER.action : LINGER.plain)
}

/** 立刻收起。动作按下之后要先收再跑 —— 跑出来的那条新消息不该被这次的计时器清掉 */
export function clearNote(): void {
  clearTimeout(timer)
  host()?.replaceChildren()
}
