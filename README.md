# cursive

macOS 上的 Markdown 编辑器：单窗格、无分屏、打字即渲染。
标记默认隐藏，光标移进哪一行，哪一行才回显源码。

## 当前进度

**已经是所见即所得了。** 打字即渲染，markdown 标记默认隐藏，光标移进某一行才回显源码。
渲染层是纯 CodeMirror 6，原生能力由 `shell-swift/` 的 Swift + WKWebView 壳提供 ——
**仓库里没有 Electron**。

| 能力 | 状态 |
|---|:--|
| 实时预览装饰器引擎（标记按光标显隐） | ✅ |
| 打开/保存/另存、脏标记、关闭拦截、原生菜单、查找 | ✅ |
| 多标签（每标签独立 EditorState） | ✅ |
| 文件树 · 大纲（滚动跟随） | ✅ |
| GFM 表格真渲染 + 点单元格进源码改字 | ✅ 浮动工具栏待补 |
| 自动保存 + 崩溃恢复 · 外部变更监听 | ✅ |
| 最近文件 · Finder 双击 · Dock 菜单 | ✅ |
| 导出 PDF | ✅ 单页长条，未分页 |
| 主题切换（浅/深/系统）· 排版偏好（字号/行距/栏宽/衬线） | ✅ |
| KaTeX 数学公式（行内/块级）· mermaid 图表 | ✅ |
| 脚注 · `==高亮==` · 上下标 · emoji · `[TOC]` | ✅ |
| 代码块语言标签+复制 · 图片放大预览/尺寸语法 | ✅ |
| 格式化命令 +「格式」菜单（⌘B/⌘I/⌘1-6…） | ✅ |
| Markdown 输入规则（表格/代码块骨架）· 列表智能（Tab 升降级/重编号） | ✅ |
| 智能粘贴（HTML→MD · URL 包链接 · ⇧⌥⌘V 纯文本） | ✅ |
| 图片粘贴 / 拖拽落盘 | ⬜ |
| 跨文件全局搜索 · 专注/打字机模式 | ⬜ |
| 导出 HTML / pandoc | ⬜ |

**当前已渲染**：标题、粗体/斜体/删除线、行内代码、链接、图片、引用、分隔线、
无序/有序列表、任务复选框（可点击）、代码块（嵌套语言高亮）、YAML front matter、
GFM 表格、KaTeX 数学公式（`$…$` / `$$…$$`，货币符号不吃，错误红色源码）、
mermaid 图表（随主题配色，语法错误保留源码+报错）。

## 快捷键

| | |
|---|---|
| ⌘O / ⌘⇧O | 打开文件 / 打开文件夹 |
| ⌘S / ⌘⇧S | 保存 / 另存为 |
| ⌘P | 导出 PDF |
| ⌘, | 设置（主题 / 排版） |
| ⌘\ / ⌘⇧T | 显示/隐藏文件树 / 大纲 |
| ⌘/ | 源代码模式 |
| ⌘F | 查找 |
| ⌘B / ⌘I / ⌘U | 粗体 / 斜体 / 下划线 |
| ⇧⌘X / ⌃⌘C / ⌘K | 删除线 / 行内代码 / 链接 |
| ⌘1 – ⌘6 / ⌘0 | 标题 1–6 / 正文 |
| ⇧⌘K / ⇧⌘Q | 代码块 / 引用 |
| ⇧⌘[ / ⇧⌘] / ⇧⌘C | 无序列表 / 有序列表 / 任务项 |
| ⇧⌥⌘V | 粘贴为纯文本 |
| ⌘ + 点击链接 | 用浏览器打开 |

命令行：`cursive 文件.md` 打开文件，`cursive 目录/` 在侧边栏打开文件夹。

**接下来做什么见 [`ROADMAP.md`](ROADMAP.md)**（现状盘点 + 对标 Typora/MarkText + P0–P4 清单）；
开发上下文与踩坑记录见 [`CONTEXT.md`](CONTEXT.md)。

## 运行

```bash
npm install
npm run build                     # 构建 renderer 到 out/renderer
./shell-swift/build.sh            # 编译原生壳 → shell-swift/cursive-shell
./shell-swift/cursive-shell a.md    # 开发运行（资源查找 Bundle → cwd → exe 相对）
```

其他脚本：

```bash
npm run dev        # 浏览器里开发 renderer（HMR，但拿不到 window.api，原生功能不可用）
npm test           # 往返保真 + 方言 + 表格单测
npm run typecheck  # 渲染层 + 共享层类型检查
npm run icon       # 从 build/icon.png 重建 build/icon.icns（想换图标时跑）
```

## 架构

```
src/
├─ renderer/      CodeMirror 6 编辑器 + 应用界面（纯 Web，产物 out/renderer）
└─ shared/        两端共用：类型、换行/BOM 指纹、分词计数
shell-swift/      Swift + AppKit + WKWebView 原生壳（单文件渐进，优先 AppKit）
```

渲染层只认 `window.api`（签名见 `src/shared/types.ts` 的 `CursiveApi`），不碰任何原生能力 ——
这正是把 Electron 换成 Swift 壳时 renderer 零改动的原因。壳侧 1:1 实现该契约，
新增通道要三处同步：`types.ts` ↔ `main.swift` ↔ `CONTEXT.md`。

两个自定义协议缺一不可：`app://r/<路径>` 服务渲染资源（WKWebView 下 `file://` 的 ES module
因 opaque origin 会静默失败），`safe-file://local/<绝对路径>` 加载文档里的本地图片。

### 核心约定：源码即真相

编辑器缓冲区里始终是**未经修改的 markdown 文本**。渲染效果全部由 CodeMirror 装饰器
（Decoration）叠加上去，不改动文本本身。因此：

- **保存零损耗** —— 没编辑过的地方，字节完全不变（自动保存也必须走这条指纹路径）
- 源代码模式 = 把装饰器关掉，一次 `Compartment.reconfigure`
- 撤销、搜索、输入法、大文档性能都由 CM6 兜底

`src/shared/textfile.ts` 守住这条承诺的边界：CodeMirror 建 state 时会把 CRLF/CR 归一成
LF，BOM 若不剥掉会被当成正文第一个字符。读文件时把这两样摘成「指纹」，写回时原样还原。
`test/textfile.test.ts` 对着 `test/fixtures/` 里的语料断言字节级往返一致。

### 实时预览是怎么做的

`src/renderer/editor/live-preview/` 是全项目的核心。一个 `ViewPlugin` 遍历**可视区域内**
的语法树，产出装饰器改变显示方式，不碰文本本身：

| 目的 | 手段 |
|---|---|
| 藏掉 `**` `#` `>` 这些标记 | `Decoration.replace({})` |
| 圆点、复选框、分隔线、图片 | `Decoration.replace({ widget })` |
| 标题字号、引用边框、代码块底色 | `Decoration.line({ class })` |

`reveal.ts` 决定「光标碰到多大范围就露出源码」，三档可选，默认按行：

- `node` 只露出光标所在的行内元素。最贴近 Typora，但每动一次光标就重排一次。
- `line` **默认**。整行露出，抖动降到「每换一行一次」，稳得多。
- `block` 整段露出。最稳但离 Typora 最远。

写这部分时踩到的三个坑，都记在代码注释里：

1. **ViewPlugin 不能提供块级装饰** —— `Decoration.replace({ block: true })` 会抛
   `Block decorations may not be specified via plugins`，并且连带把行渲染搞崩（报
   一个看起来毫不相干的 `Cannot destructure property 'tile'`）。块级（表格、以后的
   数学块/mermaid）一律走 `StateField`，见 `tableField`。
2. **输入法** —— `view.composing` 为真时绝不重算装饰器，否则中文连打会吞字。
   合成结束后靠 `wasComposing` 标志补一次。
3. **widget 必须实现 `eq()`** —— 否则每次按键都会把所有图片、图表重建一遍。

方言在 `markdown-lang.ts`：CommonMark + GFM + YAML front matter。刻意**不用**
`markdownLanguage`，因为它自带上下标扩展，会把 `$e^{-x^2}$ ` 里的 `^` 解析成
Superscript。`scripts/dump-tree.mjs` 可以打印任意文档的节点名，改装饰器前先跑一次。

## 打包成 .app

```bash
./shell-swift/release.sh              # 标准工作流：测试 + E2E 全绿才打包 dist/cursive.app
CURSIVE_DMG=1 ./shell-swift/release.sh  # 同上，额外出 dist/cursive-<version>.dmg
```

`release.sh` 依次跑：类型检查 + 单测 → 构建 renderer → 编译壳 → 6 个 E2E 用例
（图片/表格/全家桶/CRLF/数学/mermaid）+ 崩溃恢复竞态 → `make-app.sh` 组装 bundle。
产物约 9.5 MB（app，含 KaTeX 与 mermaid）。

`make-app.sh` 把 `out/renderer` 塞进 `Contents/Resources/renderer`，写入 `Info.plist`
（`.md` 关联 rank=Alternate，不抢默认打开方式），再做 ad-hoc 签名
（`codesign --force --deep --sign -`）。自用到此为止 —— 本机构建的包没有 quarantine
属性，Gatekeeper 不拦。要发给别人才需要 Apple Developer 证书 + 公证。

图标母版是 `build/icon.png`（设计源 `scripts/icon.html`），`npm run icon` 用系统
`sips` + `iconutil` 打出 `build/icon.icns`，不依赖任何图形库。

## 冒烟 / E2E

没法手动点界面时（沙箱、自动化），壳内置探针：

```bash
CURSIVE_SMOKE=1 ./shell-swift/cursive-shell test/fixtures/kitchen-sink.md
# +3s 写 /tmp/cursive-shell-check.json  （DOM：api/cm/侧栏/状态栏/标题栏/拖拽条）
# +4s 写 /tmp/cursive-shell-e2e.json    （read→save 逐字节往返 + 装饰计数 + 图片加载），然后退出
```

`CURSIVE_SMOKE` 之外启动就是正常交互应用，绝不自动退出。可选：
`CURSIVE_SMOKE_SHOT=<png>` 截图、`CURSIVE_SMOKE_THEME=dark|light|system` 切主题后截图、
`CURSIVE_SMOKE_PDF=<路径>` 顺带导出 PDF、`CURSIVE_SMOKE_SCRATCH_DELAY=<ms>` 逼出崩溃恢复竞态。

细节见 `CONTEXT.md` 的「自检探针 / E2E」一节。

## 已知限制

- 表格能点进单元格改字，但还没有增删行列的浮动工具栏，排在 P2-6
- 代码块可复制、图片可放大、格式化快捷键已就位，但表格工具栏 / 输入规则 / 智能粘贴仍在 P2
- 代码块的 ``` 围栏保留可见（藏掉会剩一个空行，更难看）
- 导出 PDF 是单页长条，不是真分页
- 尚无脚注/高亮/上下标/TOC、跨文件搜索、专注/打字机模式、导出 HTML
