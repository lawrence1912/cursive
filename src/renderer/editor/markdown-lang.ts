import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown'
import { yamlFrontmatter } from '@codemirror/lang-yaml'
import type { LanguageSupport } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { GFM } from '@lezer/markdown'

/**
 * typmd 的 markdown 方言：CommonMark + GFM + YAML front matter。
 *
 * 刻意不用 `markdownLanguage` —— 它在 GFM 之外还塞了上下标和 emoji 扩展，
 * 会把数学公式里的 `^` 当成 Superscript 解析（$e^{-x^2}$ 就废了）。
 * 这里用 commonmarkLanguage 打底、显式只加 GFM，方言范围跟计划一致。
 */
export function typmdMarkdown(): LanguageSupport {
  return yamlFrontmatter({
    content: markdown({
      base: commonmarkLanguage,
      extensions: [...GFM],
      codeLanguages: languages
    })
  })
}
