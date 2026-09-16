import { Facet } from '@codemirror/state'

/**
 * 当前文档所在目录（绝对路径；未命名文档是 null）。
 * 图片的 `assets/x.png` 和链接的 `./别的文档.md` 都按它算起点。
 *
 * **单开一个文件**而不是留在 `live-preview/decorate.ts` 里：格内链接要在
 * `live-preview/table.ts` 里读它，而 `decorate.ts` 已经在 import `table.ts`
 * （表格数据），反过来再 import 就成了一个环。facet 本来也不属于装饰层 ——
 * 它是「这份文档在磁盘上的哪儿」，装饰和链接都只是它的用户。
 */
export const docDir = Facet.define<string | null, string | null>({
  combine: (values) => values[0] ?? null
})
