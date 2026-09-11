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
import { docDir, livePreview, revealScope, type RevealScope } from './live-preview'
import { typmdMarkdown } from './markdown-lang'
import { typmdTheme } from './theme'

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
      EditorState.allowMultipleSelections.of(true),
      EditorView.lineWrapping,
      typmdMarkdown(),
      docDir.of(options.dir ?? null),
      revealScope.of(options.reveal ?? 'line'),
      typmdTheme,
      livePreviewConf.of(options.sourceMode ? [] : livePreview()),
      keymap.of([
        ...closeBracketsKeymap,
        ...searchKeymap,
        ...historyKeymap,
        // 必须排在 defaultKeymap 之前：回车续列表、退格删标记
        ...markdownKeymap,
        ...defaultKeymap,
        indentWithTab
      ]),
      extras
    ]
  })
}
