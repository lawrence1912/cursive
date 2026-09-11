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
import { expandOnEnter } from './input-rules'
import { changeListIndent } from './list-ops'
import { smartPaste } from './paste'
import { docDir, livePreview, revealScope, type RevealScope } from './live-preview'
import { cursiveMarkdown } from './markdown-lang'
import { cursiveTheme } from './theme'

/** 源代码模式 = 把实时预览插件从这个 compartment 里撤掉 */
export const livePreviewConf = new Compartment()

export interface EditorOptions {
  /** 当前文档所在目录，用于解析图片相对路径 */
  dir?: string | null
  /** 光标回显粒度，默认按行 */
  reveal?: RevealScope
  /** 初始是否源代码模式 */
  sourceMode?: boolean
}

export function createState(
  doc: string,
  extras: Extension = [],
  options: EditorOptions = {}
): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      history(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      crosshairCursor(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightSelectionMatches(),
      search({ top: false }),
      // P2-7：查找面板中文化（@codemirror/search 的 UI 文案走 phrases facet）
      EditorState.phrases.of({
        Find: '查找',
        Replace: '替换',
        next: '下一个',
        previous: '上一个',
        all: '全部',
        'match case': '区分大小写',
        'by word': '整词',
        regexp: '正则',
        replace: '替换',
        'replace all': '全部替换',
        close: '关闭'
      }),
      EditorState.allowMultipleSelections.of(true),
      EditorView.lineWrapping,
      cursiveMarkdown(),
      smartPaste(),
      docDir.of(options.dir ?? null),
      revealScope.of(options.reveal ?? 'line'),
      cursiveTheme,
      livePreviewConf.of(options.sourceMode ? [] : livePreview()),
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
}
