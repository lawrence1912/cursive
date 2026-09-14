---
title: 语料文档
tags: [markdown, 测试]
---

# 一级标题

这是一段带 **粗体**、*斜体*、~~删除线~~ 和 `行内代码` 的中文段落。还有一个[链接](https://codemirror.net)。

## 列表

- 无序项一
- 无序项二
  - 嵌套项
- [ ] 待办未完成
- [x] 待办已完成

1. 有序项一
2. 有序项二

## 引用与分隔

> 引用块的第一行
> 引用块的第二行

---

带 **粗体** 和 `码` 的 setext 标题
--------------------------------

上面那行是 setext 二级标题：大纲与 `[TOC]` 里都必须显示成纯文字，
既不能拖着下划线，也不能露出星号和反引号（P3-6 修的两个既有缺陷）。

## 代码块

```ts
const greet = (name: string): string => `你好，${name}`
```

## 表格

| 左对齐 | 居中 | 右对齐 |
|:-------|:----:|-------:|
| a      |  b   |      c |
| 中文   | 内容 |   1234 |

## 数学

行内公式 $E = mc^2$，以及块级公式：

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

## 图片与脚注

![占位图](assets/placeholder.png)

正文里的脚注引用[^1]。

[^1]: 脚注内容。
external-append-marker

autosave-check-markerexternal-append-marker

autosave-check-markerexternal-append-marker
external-append-marker

autosave-check-markerexternal-append-marker

autosave-check-marker