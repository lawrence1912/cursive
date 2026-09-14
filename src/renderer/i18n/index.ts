import type { UiLang } from '../../shared/types'
import { en } from './en'
import { zh, type Key } from './zh'

/**
 * 极简 i18n：两份字典 + 一个 `t()`，没有框架、没有加载器。
 *
 * 职责划分：
 * - **持久化归 `ui/prefs.ts`**（`cursive.prefs` 里的 `lang` 字段），这里只持有内存态。
 *   启动时 main.ts 先 `setLang(detectLang())` 再建任何组件，chrome 一出生就是对的。
 * - **静态 chrome**（innerHTML 一次构建的面板/工具栏）用 `data-i18n*` 属性声明文案，
 *   `applyI18n()` 翻译一遍；语言切换时全局重跑。属性有四种：
 *   `data-i18n`（textContent）/ `data-i18n-title` / `data-i18n-ph`（placeholder）/
 *   `data-i18n-aria`（aria-label），可选 `data-i18n-args`（JSON，占位符参数）。
 *   **一律走 textContent / setAttribute，没有 innerHTML 这一路** —— 字典里现在全是纯文本，
 *   留一个用不上的 HTML 出口只是替将来某次「顺手拿它插点动态内容」备好了坑。
 * - **动态字符串**（状态栏消息、右键菜单、widget）在构建点上直接 `t()`，语言切换后
 *   由 main.ts 的 langchange 订阅者重刷各处 chrome / 重建装饰。
 *
 * 翻译边界（刻意不翻）：callout 类型名（笔记/提示…）是 Markdown 方言的渲染内容；
 * 代码语言显示名（TypeScript 等专有名词）；产品名 Cursive。
 */

/** 与契约层同一个联合（`shared/types` 的 `UiLang`）—— 加第三种语言时只改那一处 */
export type Lang = UiLang
export type { Key } from './zh'

const DICTS = { zh, en }
/** 偏好键与 ui/prefs.ts 的 KEY 同源 —— 两处字面量保持一致（i18n 不能反过来 import 它） */
const PREFS_KEY = 'cursive.prefs'

let lang: Lang = 'zh'
const subs = new Set<() => void>()

export function getLang(): Lang {
  return lang
}

/** `toLocaleTimeString` 等要用的 locale 标签 */
export function localeOf(l: Lang = lang): string {
  return l === 'zh' ? 'zh-CN' : 'en'
}

/**
 * 系统语言，**不看偏好**。「恢复默认」要的就是这一份 —— 拿 `detectLang()` 当默认值的话，
 * 它会先读到偏好里存着的语言，于是「默认」其实等于「本次启动时的语言」，恢复默认恢复了个寂寞。
 *
 * 非浏览器环境（node 单测）→ 中文。注意 Node ≥21 也有 `navigator.language`，
 * 所以这里不能靠 `typeof navigator` 来判断「是不是在浏览器里」。
 */
export function systemLang(): Lang {
  if (typeof localStorage === 'undefined') return 'zh'
  const sys = typeof navigator !== 'undefined' ? navigator.language : 'zh'
  return typeof sys === 'string' && sys.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/**
 * 初始语言：偏好里记过 `lang` 就听它的；有偏好但没记过（老用户，一直是中文）→ 保持中文；
 * 全新安装 → 跟随系统语言。非浏览器环境（node 单测，无 localStorage）→ 中文。
 */
export function detectLang(): Lang {
  if (typeof localStorage === 'undefined') return 'zh'
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { lang?: Lang }
      return parsed.lang === 'en' ? 'en' : 'zh'
    }
  } catch {
    /* 坏 JSON / 隐私模式拒绝读取：落到系统语言 */
  }
  return systemLang()
}

export function setLang(l: Lang): void {
  if (l === lang) return
  lang = l
  if (typeof document !== 'undefined') document.documentElement.lang = localeOf()
  for (const fn of [...subs]) fn()
  // 订阅者重刷动态 chrome 之后，把全部静态 chrome 的 data-i18n 属性重翻一遍
  applyI18n()
}

/** 语言切换订阅。返回解绑函数 */
export function onLangChange(fn: () => void): () => void {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}

/** 取文案；`{name}` 占位符用 args 替换。key 不存在时原样返回（别让界面挂掉） */
export function t(key: Key, args?: Record<string, string | number>): string {
  const dict: Record<Key, string> = DICTS[lang]
  let s: string = dict[key] ?? key
  if (args) {
    for (const [k, v] of Object.entries(args)) s = s.split(`{${k}}`).join(String(v))
  }
  return s
}

interface I18nArgs {
  text?: string
  title?: string
  ph?: string
  aria?: string
  args?: Record<string, string>
}

/**
 * 把静态 chrome 上的 `data-i18n*` 属性翻译一遍。幂等 —— 构建后跑一次、
 * 语言切换时全局再跑一次都行。只认我们自己的属性，绝不会碰 CodeMirror 的正文 DOM。
 */
export function applyI18n(root?: ParentNode): void {
  // ⚠️ root 不能写成默认参数 `= document`：node 单测里那个标识符压根不存在，
  // 求值默认值直接 ReferenceError（早于函数体里的守卫）
  if (typeof document === 'undefined') return
  const els = (root ?? document).querySelectorAll<HTMLElement>(
    '[data-i18n],[data-i18n-title],[data-i18n-ph],[data-i18n-aria]'
  )
  for (const el of els) {
    const d = el.dataset
    const spec: I18nArgs = {
      text: d['i18n'],
      title: d['i18nTitle'],
      ph: d['i18nPh'],
      aria: d['i18nAria']
    }
    let args: Record<string, string> | undefined
    if (d['i18nArgs']) {
      try {
        args = JSON.parse(d['i18nArgs']) as Record<string, string>
      } catch {
        /* 坏 JSON 就当没有参数 */
      }
    }
    const x = (key: string): string => t(key as Key, args)
    if (spec.text !== undefined) el.textContent = x(spec.text)
    if (spec.title !== undefined) el.title = x(spec.title)
    if (spec.ph !== undefined) el.setAttribute('placeholder', x(spec.ph))
    if (spec.aria !== undefined) el.setAttribute('aria-label', x(spec.aria))
  }
}
