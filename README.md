# typmd

一个 Typora 风格的 Markdown 编辑器：单窗格、无分屏、打字即渲染。

## 当前进度

**已经是所见即所得了。** 打字即渲染，markdown 标记默认隐藏，光标移进某一行才回显源码。侧边栏可以打开文件夹树。

| 能力 | 状态 |
|---|:--|
| 实时预览装饰器引擎（标记按光标显隐） | ✅ |
| 打开/保存/另存、脏标记、关闭拦截、原生菜单、查找 | ✅ |
| 多标签（每标签独立 EditorState） | ✅ |
| 文件树 · 大纲（滚动跟随） | ✅ |
| GFM 表格真渲染 | ✅ 只读，光标进入回落源码 |
| 导出 PDF | ✅ 单页长条，未分页 |
| 最近文件 | ⬜ Swift 壳里尚未接回 |
| KaTeX 数学 · mermaid · 脚注 | ⬜ |
| 格式化快捷键 · 输入规则 · 智能粘贴 · 图片落盘 | ⬜ |
| 自动保存 · 外部变更监听 · 全局搜索 | ⬜ |
| 专注/打字机模式 · 主题切换 · 排版偏好 | ⬜ |
| 导出 HTML / pandoc | ⬜ |

**当前已渲染**：标题、粗体/斜体/删除线、行内代码、链接、图片、引用、分隔线、
无序/有序列表、任务复选框（可点击）、代码块（嵌套语言高亮）、YAML front matter、
表格（等宽对齐）。数学公式和 mermaid 还是源码。

## 快捷键

| | |
|---|---|
| ⌘O / ⌘⇧O | 打开文件 / 打开文件夹 |
| ⌘S / ⌘⇧S | 保存 / 另存为 |
| ⌘\ | 显示/隐藏侧边栏 |
| ⌘/ | 源代码模式 |
| ⌘F | 查找 |
| ⌘ + 点击链接 | 用浏览器打开 |

命令行：`typmd 文件.md` 打开文件，`typmd 目录/` 在侧边栏打开文件夹。

**接下来做什么见 [`ROADMAP.md`](ROADMAP.md)**（现状盘点 + 对标 Typora/MarkText + P0–P4 清单）；
开发上下文与踩坑记录见 [`CONTEXT.md`](CONTEXT.md)。最初的完整方案在 `~/.claude/plans/spicy-questing-rivest.md`。

## 运行

```bash
npm install
npm run dev        # 开发模式（HMR）
npm run build      # 构建到 out/
npm start          # 跑构建产物
npm test           # 往返保真测试
npm run typecheck  # 主进程 + 渲染进程分别类型检查
npm run pack       # 打成 .app（无签名，本地自用）
```

> 若 `npm install` 后启动报 `Error: Electron uninstall`，说明 Electron 二进制没下下来，
> 手动补一次：`node node_modules/electron/install.js`

## 架构

```
src/
├─ main/          Electron 主进程：窗口、菜单、文件 IO、对话框
├─ preload/       contextBridge → window.api（渲染进程唯一的对外通道）
├─ renderer/      CodeMirror 6 编辑器 + 应用界面
└─ shared/        两端共用：类型、换行/BOM 指纹、分词计数
```

### 核心约定：源码即真相

编辑器缓冲区里始终是**未经修改的 markdown 文本**。渲染效果全部由 CodeMirror 装饰器
（Decoration）叠加上去，不改动文本本身。因此：

- **保存零损耗** —— 没编辑过的地方，字节完全不变
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
   一个看起来毫不相干的 `Cannot destructure property 'tile'`）。分隔线改成覆盖整行
   文字的行内替换 + CSS `display:block`。
2. **输入法** —— `view.composing` 为真时绝不重算装饰器，否则中文连打会吞字。
   合成结束后靠 `wasComposing` 标志补一次。
3. **widget 必须实现 `eq()`** —— 否则每次按键都会把所有图片、图表重建一遍。

方言在 `markdown-lang.ts`：CommonMark + GFM + YAML front matter。刻意**不用**
`markdownLanguage`，因为它自带上下标扩展，会把 `$e^{-x^2}$ ` 里的 `^` 解析成
Superscript。`scripts/dump-tree.mjs` 可以打印任意文档的节点名，改装饰器前先跑一次。

## 组装成 .app

```bash
npm run icon    # 生成 build/icon.icns（只在想换图标时跑）
npm run pack    # → dist/mac-arm64/typmd.app，拖进「应用程序」即可
npm run dist    # → dist/typmd-0.1.0-arm64.dmg，给别人用才需要
```

打包配置在 `electron-builder.config.cjs`。三处不走默认值，都有原因：

**ad-hoc 签名（`afterPack` 钩子）** —— `identity: null` 会让 electron-builder
**完全跳过**签名，包里只剩 Electron 二进制自带的 linker 签名：`Identifier=Electron`、
`Sealed Resources=none`，`codesign --verify` 过不去。Apple Silicon 上二进制必须有有效
签名才能执行，所以钩子里补一次 `codesign --force --deep --sign -`。签完是
`Identifier=dev.lawrence.typmd`、`Sealed Resources version=2`，校验通过。

自用到此为止就够了 —— 本机构建的包没有 quarantine 属性，Gatekeeper 不拦。要发给别人
才需要 Apple Developer 证书 + 公证（notarization）。

**只留两份语言包** —— Electron 自带 220 份 `.lproj`，占 60MB+。
`electronLanguages: ['en-US', 'zh-CN']` 把 307MB 压到 243MB。

**文件关联** —— `fileAssociations` 注册 `.md/.markdown/.mdown/.mkd`，主进程的
`open-file` 事件靠它才会触发（否则 Finder 双击不会唤起 typmd）。`rank: 'Alternate'`
表示只出现在「打开方式」里、不抢默认；想设为默认改成 `'Owner'`。

图标是 `scripts/make-icon.mjs` 用 Electron 自己离屏渲染的（`scripts/icon.html` →
capturePage → `sips` 切尺寸 → `iconutil` 打 `.icns`），没引入图形库。想换图标就改
`scripts/icon.html` 再 `npm run icon`。

## 冒烟检查

没法手动点界面时（CI、沙箱），用这个确认渲染进程真的起来了：

```bash
TYPMD_SMOKE=/tmp/shot.png npx electron . test/fixtures/kitchen-sink.md
# SMOKE probe: {"editors":1,"lines":38,"status":"kitchen-sink.md","mode":"预览"}
# SMOKE problems: none
```

会截图、转发渲染进程的 console 报错，有问题就以非零码退出。

## 已知限制

- 数学公式（`$...$`）和 mermaid 还显示为源码，排在 M2
- 表格只做了等宽对齐，还不能像 Typora 那样直接编辑单元格，排在 M2
- 代码块的 ``` 围栏保留可见（藏掉会剩一个空行，更难看）
- 尚无大纲、专注/打字机模式、导出
- GPU 沙箱环境下需加 `--disable-gpu --no-sandbox` 才能启动（正常桌面环境不需要）
