import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdownKeymap } from '@codemirror/lang-markdown'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  keymap,
  rectangularSelection
} from '@codemirror/view'
import { moveBlock } from './block-move'
import { cursiveCompletion } from './complete'
import { landingFlash, stableNavigation } from './navigation'
import { expandOnEnter } from './input-rules'
import { t } from '../i18n'
import { changeListIndent } from './list-ops'
import { smartPaste } from './paste'
import { searchIndexField } from './search-index'
import { cursiveSearchPanel } from './search-panel'
import { scrollMarks } from './scroll-marks'
import { docDir, livePreview, revealScope, type RevealScope } from './live-preview'
import { adoptTableAtCursor } from './live-preview/table'
import { cursiveMarkdown } from './markdown-lang'
import { readOnlyConf, readOnlyExt } from './read-only'
import { cursiveTheme } from './theme'
import { writingModes, WRITING_DEFAULT, type WritingModes } from './writing-modes'

/** 源代码模式 = 把实时预览插件从这个 compartment 里撤掉 */
export const livePreviewConf = new Compartment()

/** P3-3 专注/打字机模式的挂载点：切换 = reconfigure（与源代码模式同一套） */
export const writingConf = new Compartment()

/**
 * 0.2.0 拼写检查的挂载点。
 *
 * CodeMirror 默认在 `.cm-content` 上写死 `spellcheck="false"`；把它翻成 true，
 * macOS 的 NSSpellChecker 就在 WKWebView 的可编辑区里自动接管 ——
 * 红波浪线、右键「改正为…」全是系统给的，这边一行检查逻辑都没有。
 *
 * **不能在建 state 时钉死**：偏好是可以随时改的，而每个标签一份 EditorState，
 * 钉死等于「改了设置只对新标签生效」。走 compartment，切换 = 一次 reconfigure。
 */
export const spellConf = new Compartment()

/** 拼写检查开关的扩展体。默认关 —— 中文写作用不上，而长文档上 WebKit 的扫描要花 CPU */
export function spellcheckExt(on: boolean): Extension {
  return EditorView.contentAttributes.of({ spellcheck: String(on) })
}

/**
 * 当前开没开。**全局的，不随标签走** —— 与 `writingNow` 同一个道理：
 * 新建的 state 拿它当种子（所以七处 `createState` 一处都不用改），
 * 切标签时 main.ts 的 `syncSpell()` 再把冻结的那份对齐。
 */
export const spellNow = { on: false }

/**
 * 当前写作模式。**全局的，不随标签走** —— 每个标签一份 EditorState，新建的
 * state 拿它当种子；切标签时 main.ts 的 `syncWriting()` 再把冻结的那份对齐
 * （和 `bottomOverlay` 一样，是「扩展要读、但不属于任何一个 state」的东西）。
 */
export const writingNow: WritingModes = { ...WRITING_DEFAULT }

/**
 * 盖在正文底部的悬浮物（P2-8 格式栏）要占多高。
 * 不给滚动留出这段，光标打到视口最下面就会躲到条子后面 —— CodeMirror 只认
 * `scrollMargins`，它不知道页面上还浮着别的东西。用可变对象而不是常量：
 * 格式栏可以随时显示/隐藏，facet 每次算边距都会重新读它。
 */
export const bottomOverlay = { height: 0 }

export interface EditorOptions {
  /** 当前文档所在目录，用于解析图片相对路径 */
  dir?: string | null
  /** 光标回显粒度，默认按行 */
  reveal?: RevealScope
  /** 初始是否源代码模式 */
  sourceMode?: boolean
  /** 初始光标位置（会话恢复用）；超出文档长度会夹回来 */
  cursor?: number
  /** 初始是否只读（第八节 5：会话恢复、重开关闭的标签把它原样带回来） */
  readOnly?: boolean
}

/**
 * CodeMirror 查找的读屏播报。**必须是取值器而不是 `{ 'current match': t(...) }`** ——
 * facet 的值是建 state 时钉进配置里的那一份，写成字面量就等于把「当时的语言」腌进每个
 * EditorState：切完语言，已经开着的标签（尤其是冻结的那些）还在用旧文案，而新开的标签
 * 用新的，同一个窗口里两套语言。`state.phrase()` 每次都 `map[key]` 现取，
 * getter 因此天然跟着 `t()` 走，连 reconfigure 都不用。
 */
const SEARCH_PHRASES = {
  get 'current match'(): string {
    return t('cm.currentMatch')
  },
  get 'on line'(): string {
    return t('cm.onLine')
  },
  get 'Replaced $ matches'(): string {
    return t('cm.replacedMatches')
  },
  get 'replaced match on line $'(): string {
    return t('cm.replacedOnLine')
  }
}

export function createState(
  doc: string,
  extras: Extension = [],
  options: EditorOptions = {}
): EditorState {
  const state = EditorState.create({
    doc,
    selection: options.cursor ? { anchor: Math.min(options.cursor, doc.length) } : undefined,
    extensions: [
      history(),
      stableNavigation,
      landingFlash,
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      crosshairCursor(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      // 0.2.0 自动补全（emoji / 告示块 / 脚注 / 锚点 / 围栏语言，见 complete.ts）。
      // 它自带的 keymap 是 Prec.highest，但每一条在「没有活动补全」时都返回 false，
      // 所以下面 Enter / Tab 那几条接管不受影响
      cursiveCompletion(),
      highlightSelectionMatches(),
      // 查找面板整个换成自己的那一版（editor/search-panel.ts）：右上角浮层、
      // 组字期间不提交、计数画在框里。默认那版的文案在 phrases facet 里，
      // 换掉之后只剩读屏播报还走它
      search({ top: true, createPanel: cursiveSearchPanel }),
      // 第八节 18：命中位置跟着事务增量更新（计数与滚动条刻度共用，见 editor/search-index.ts）
      searchIndexField,
      EditorState.phrases.of(SEARCH_PHRASES),
      EditorState.allowMultipleSelections.of(true),
      EditorView.lineWrapping,
      EditorView.scrollMargins.of(() =>
        bottomOverlay.height ? { bottom: bottomOverlay.height } : null
      ),
      cursiveMarkdown(),
      smartPaste(),
      docDir.of(options.dir ?? null),
      revealScope.of(options.reveal ?? 'line'),
      cursiveTheme,
      // 0.2.x：查找命中画在滚动条上（见 editor/scroll-marks.ts）
      scrollMarks,
      livePreviewConf.of(options.sourceMode ? [] : livePreview()),
      // 第八节 5：只读阅读模式。按标签 —— 态就在这份 state 里，切标签时跟着冻结
      readOnlyConf.of(readOnlyExt(options.readOnly === true)),
      writingConf.of(writingModes(writingNow)),
      spellConf.of(spellcheckExt(spellNow.on)),
      keymap.of([
        ...closeBracketsKeymap,
        ...searchKeymap,
        ...historyKeymap,
        // P2-2：表格/围栏骨架优先于 markdownKeymap 的续行
        {
          key: 'Enter',
          run: (view) => {
            const spec = expandOnEnter(view.state)
            if (!spec) return false
            view.dispatch(spec)
            return true
          }
        },
        // 必须排在 defaultKeymap 之前：回车续列表、退格删标记
        ...markdownKeymap,
        // 0.2.x：⌥↑/⌥↓ 搬**块**而不是搬行（见 editor/block-move.ts 的顶注）。
        // 同样必须排在 defaultKeymap 之前 —— 那边这两个键绑着 `moveLineUp/Down`。
        // 认不出块（多光标、选区跨出块外）时返回 false，照旧退回按行搬
        {
          key: 'Alt-ArrowUp',
          run: (view) => {
            const spec = moveBlock(view.state, -1)
            if (!spec) return false
            view.dispatch(spec)
            return true
          }
        },
        {
          key: 'Alt-ArrowDown',
          run: (view) => {
            const spec = moveBlock(view.state, 1)
            if (!spec) return false
            view.dispatch(spec)
            return true
          }
        },
        ...defaultKeymap,
        // P2-3：列表里 Tab/⇧Tab 升降级（先于 indentWithTab 接管）；不在列表则回退
        {
          key: 'Tab',
          run: (view) => {
            const spec = changeListIndent(view.state, 1)
            if (!spec) return false
            view.dispatch(spec)
            return true
          }
        },
        {
          key: 'Shift-Tab',
          run: (view) => {
            const spec = changeListIndent(view.state, -1)
            if (!spec) return false
            view.dispatch(spec)
            return true
          }
        },
        indentWithTab
      ]),
      extras
    ]
  })
  // 光标一开门就落在某张表里（文档以表格开头 / 会话把它放回表里）：直接进就地编辑，
  // 否则那张表会回落成管道符源码 —— 见 adoptTableAtCursor
  return adoptTableAtCursor(state)
}
