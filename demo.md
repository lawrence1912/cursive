# Cursive 演示

用 Cursive 打开这一份，就能看到它把 Markdown **渲染成什么样子**。
把光标移进任意一行，**那一行**才回显源码 —— 所见即所得的全部秘密就这一句。

> [!tip] 三个可以立刻试的
> `⌘/` 切源代码模式对照着看 · `⌥⌘F` 只点亮当前段落 · `⌘⇧T` 开关右边的大纲。

## 表格是可以直接改的

点进任意一格就能打字，不会回落成源码；底部浮起工具栏管增删行列与对齐。

| 能力 | 靠什么实现 | 状态 |
| :--- | :--- | :--: |
| 实时预览引擎 | CodeMirror 6 装饰器 | ✅ |
| 原生外壳 | Swift + WKWebView | ✅ |
| 数学公式 | KaTeX（按需加载） | ✅ |
| 导出 docx / epub | pandoc 桥接 | ⬜ |

## 数学

行内的 $E = mc^2$ 混在文字里，整块的独占一行：

$$
\int_{-\infty}^{\infty} e^{-x^2}\,\mathrm{d}x = \sqrt{\pi}
$$

## 排版一览

粗体 **像这样**、斜体 *像这样*、行内代码 `npm run build`、
==高亮==、删除线 ~~不要了~~、上标 x^2^ 与下标 H~2~O、emoji :tada:，
以及一条脚注[^1]。

- [x] 标记默认隐藏，光标进入才回显
- [x] 图片粘贴/拖拽自动落盘到 `assets/`
- [ ] 双链 `[[wiki]]` 与反向链接

## 代码块带语言条

右上角是语言名和复制按钮，光标移到围栏那一行才会看见 ``` 源码。

```ts
/** katex 没到手时返回 null：调用方先摆源码占位，加载完再换掉 */
export function renderMath(tex: string, display: boolean): string | null {
  if (!katexMod) {
    void loadKatex()
    return null
  }
  return katexMod.renderToString(tex, { displayMode: display, throwOnError: false })
}
```

## 图表

```mermaid
flowchart LR
  A[Markdown 源码] --> B[语法树]
  B --> C[装饰器]
  C --> D[所见即所得]
```

## 告示块有 13 种

> [!warning] 会拦下来的
> 从 Releases 下载的包第一次打开会被 Gatekeeper 拦 —— 不签名的代价，README 里写了放行办法。

> [!note]- 这一条是折叠的
> 类型名后面加一个 `-` 就默认收起来，点标题展开。

[^1]: 脚注定义平时折叠成一行，光标移进去才摊开成源码。
