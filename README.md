# Cursive

**macOS 上的 Markdown 编辑器：单窗格、无分屏、打字即渲染。**
标记默认隐藏，光标移进哪一行，哪一行才回显源码。

[![CI](https://github.com/lawrence1912/cursive/actions/workflows/ci.yml/badge.svg)](https://github.com/lawrence1912/cursive/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/lawrence1912/cursive)](https://github.com/lawrence1912/cursive/releases/latest)
![macOS 12+](https://img.shields.io/badge/macOS-12%2B-111111)
![Electron-free](https://img.shields.io/badge/Electron--free-2f6fd0)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![linux.do](https://img.shields.io/badge/%E7%A4%BE%E5%8C%BA-linux.do-ffb003)](https://linux.do/)

**[下载 Cursive](https://github.com/lawrence1912/cursive/releases/latest)** · 需要 macOS 12 或更新 · Apple Silicon 与 Intel 通用 · 开源免费（MIT）

![Cursive 浅色界面](docs/shots/light.png)

> 截图里打开的是仓库根目录的 [`EXAMPLE.md`](EXAMPLE.md)。装好之后打开它，表格、公式、告示块、mermaid 图表都能当场点着试。

## 为什么是 Cursive

- **不用在编辑和预览之间来回看。** 只有一个窗格，写的时候看到的就是排好版的样子；要改哪里，把光标移过去，那一行就露出 Markdown 源码。
- **不改写你的源码。** 编辑器里始终是原始的 Markdown 文本，排版只是叠在上面的显示层。没改过的内容保存后逐字节不变，换行符风格和 BOM 也原样保留。
- **原生 macOS 应用。** 外壳用 Swift + AppKit 编写，编辑器运行在系统自带的 WKWebView 里，不打包 Electron；v0.5.1 的安装包约 5 MB。
- **普通文件，本地优先。** 打开文件夹就能用，不建库、不建索引，折叠这类编辑状态不写进文件。应用自身只在你点「检查更新」时联网。

![光标移进哪一行，哪一行露出 Markdown 源码；新打的标题、高亮、上标和公式在换行后排好版](docs/shots/demo-live-preview.gif)

## 核心功能

### 沉浸式写作

- 空行开头输入 `/` 调出块菜单，插入标题、列表、表格、公式、告示块、流程图等 19 种块，中英文关键词都能搜。
- 格式命令在菜单、底部格式栏、快捷键、命令面板和斜杠菜单里是同一套，再按一次即取消，⌘Z 一步撤回。
- 从网页、飞书、Notion 粘贴时自动转成 Markdown，表格与任务列表不丢；另有自动补全、多光标、专注模式、打字机模式和源代码模式。

### 表格、公式与丰富内容

- 表格以真表格显示，点进格子直接改字；底部工具栏增删行列、设置对齐，还能把 Excel / Numbers 里的几行几列直接粘进去。
- KaTeX 公式与 LaTeX 源码格式化；mermaid 图表随主题配色。
- 13 种告示块（兼容 GitHub 的 `> [!NOTE]` 写法，可折叠）、带语言条的代码块、脚注、高亮、上下标、emoji、`[TOC]` 目录，YAML front matter 显示为属性表。
- 截图直接粘贴、图片从 Finder 拖入，自动存进 `assets/`；拖动右下角改尺寸，点击放大。

### 文件与工作区

- 一个窗口就是一个工作区：文件树、多标签、大纲、⌘T 快速打开、⇧⌘F 跨文件搜索与替换（可缩小到某个文件夹）。
- ⌘ + 点击链接跟过去，本地 `.md` 在新标签打开、`#锚点` 就地跳转；⌥⌘← / ⌥⌘→ 后退与前进。
- ⌘ + 点击 front matter 里的一颗标签（`tags:` 之外的数组也算），就拿它搜索整个工作区：不建索引，搜索式留在搜索框里，可以接着改。
- 只读阅读模式、单击预览标签、重新打开关闭的标签，以及检查文档里失效的本地链接与图片。

### 数据安全

- 停手 2 秒自动保存；未命名草稿在意外退出后可以恢复。
- 每次保存留一份版本快照，可以看差异、一键回滚，回滚之后还能撤销。
- 文件被别的程序改了：没有未保存修改就自动重新载入；有的话把差异摆出来让你选，处理完之前不会覆盖任何一边。
- 打不开文件时说清楚原因：编码不是 UTF-8、文件不在，还是没有权限。

### 导出与分享

- 单文件 HTML（样式、图片、图表都在一个文件里）、真分页 PDF（A4 / Letter、页码、书签目录）和长图 PNG。
- ⌥⇧⌘C 复制为富文本，直接粘进邮件或在线文档。
- 导出前先检查缺失的图片和画不出来的图表；长图超出上限时可以分成几张。

### 原生、轻量、可定制

- 浅色、深色、跟随系统、护眼四套主题，也可以加载自己的 CSS 皮肤；字体、字号、行距、栏宽可调，⌘+ / ⌘- 只缩放正文。
- 界面在简体中文与 English 之间随时切换；系统拼写检查可选。

![Cursive 深色界面](docs/shots/dark.png)

每个功能的完整用法见 [用户指南](docs/user-guide.md)。

## 安装

| 项目 | 说明 |
|---|---|
| 下载 | [Releases](https://github.com/lawrence1912/cursive/releases/latest) 里的 `Cursive-<版本>.dmg` |
| 系统 | 需要 macOS 12 或更新。安装包按 macOS 12 编译；开发与验收在 macOS 27 上进行，更早的系统版本没有逐一实测 |
| 芯片 | 同一个安装包同时包含 Apple Silicon 与 Intel 两份代码。Intel 那份是交叉编译的，只在 Rosetta 下做过冒烟测试，还没有在真 Intel Mac 上运行过，遇到问题请[提 issue](https://github.com/lawrence1912/cursive/issues) |

1. 打开 dmg，把 Cursive 拖进「应用程序」。
2. 第一次打开按下面的方法放行一次。
3. 想让双击 `.md` 都用 Cursive 打开：在 Finder 里选中任意 `.md` →「文件 → 显示简介」→「打开方式」选 Cursive →「全部更改…」。

### 第一次打开

Cursive 没有经过 Apple 公证（项目有意不付 Apple Developer 的年费，见 [ROADMAP 第三节](ROADMAP.md#三有意不做总表)），下载版第一次打开会被 macOS 的 Gatekeeper 拦下。放行一次即可：

1. 双击 Cursive，被拦后关掉提示。
2. 打开「系统设置 → 隐私与安全性」，在「安全性」一栏点「仍要打开」，按提示确认。macOS 14 及更早也可以在 Finder 里按住 Control 点按 Cursive，选「打开」。

如果提示「已损坏，无法打开」，而系统设置里没有出现「仍要打开」，可以在终端里去掉下载时附带的隔离标记：

```bash
xattr -dr com.apple.quarantine /Applications/Cursive.app
```

> [!WARNING]
> 这条命令让 Gatekeeper 不再检查这一份 Cursive，它是否可信只能由你自己判断。只对从本仓库 Releases 页面下载的安装包这样做，也不要为此关闭整个 Gatekeeper。

各系统版本的具体步骤见[用户指南](docs/user-guide.md#第一次打开放行没有公证的应用)。也可以[从源码编译](#从源码编译)：本机编译出来的包不带隔离标记，不会被拦。

### 更新

应用菜单里的「检查更新」只在你点它时联网，查到新版本就把 Releases 页面交给浏览器；它不在后台检查，不自动下载安装，也不带任何标识。不联网的人用这个 app，应该一个字节都不多背。

## 上手

| 想做什么 | 怎么做 |
|---|---|
| 看某一行的 Markdown 源码 | 把光标移进那一行；⌘/ 切换整篇的源代码模式 |
| 插入标题、表格、公式、告示块 | 在空行开头输入 `/`，继续输入筛选，回车插入 |
| 改表格 | 点进格子直接输入；Tab、回车换格，底部工具栏增删行列 |
| 找一条命令 | ⇧⌘P 打开命令面板，菜单里的命令都在这里 |
| 打开文件或文件夹 | ⌘T 按名字快速打开；⇧⌘O 把文件夹开成一个工作区窗口 |
| 在整个文件夹里搜索 | ⇧⌘F，可以替换，也可以缩小到某个子文件夹 |
| 导出 | 「文件」菜单：HTML（⇧⌘E）、PDF（⌥⌘P）、长图；⌥⇧⌘C 复制为富文本 |

斜杠菜单的几个例子：

| 输入 | 结果 |
|---|---|
| `/h2` ⏎ | `## `，光标落在标记后面 |
| `/table` ⏎ | 三列两行的空表，光标在表头第一格 |
| `/callout` 或 `/告示` ⏎ | `> [!NOTE]` 加一行正文 |
| `/code` ⏎ | 一对代码围栏，光标在中间 |

在空行输入 `/`，再输入「表」筛到表格，插入后直接在格子里输入，Tab 换到下一格：

![斜杠菜单插入表格，然后就地编辑每一格](docs/shots/demo-slash-table.gif)

全部快捷键与操作细节见[用户指南](docs/user-guide.md#快捷键)。

## 技术架构

| 层 | 技术 | 负责 |
|---|---|---|
| 原生壳 `shell-swift/` | Swift、AppKit、WKWebView | 窗口与菜单、文件读写与监听、跨文件搜索、导出与打印、剪贴板 |
| 渲染层 `src/renderer/` | TypeScript、CodeMirror 6 | 编辑器、实时预览与全部界面 |
| 共享 `src/shared/` | TypeScript | IPC 契约类型、换行符与 BOM 指纹、字数统计 |

几条贯穿全局的设计原则：

- **源码即真相**：编辑器缓冲区里始终是未经修改的 Markdown，渲染效果全部由 CodeMirror 装饰叠加；源代码模式只是把装饰关掉。
- **渲染层只认 `window.api`**：原生能力全部经过一份 IPC 契约（`src/shared/types.ts`），渲染层不直接碰任何原生能力。
- **键盘入口走原生菜单，大数据不过 IPC 桥，编辑状态不写回文档。**
- **导出与实时预览共用同一棵语法树**，同一段 Markdown 不会有两种理解。

详见[架构说明](docs/architecture.md)；每个决定的来由和踩过的坑记在 [`CONTEXT.md`](CONTEXT.md)。

## 从源码编译

需要 Node.js 22.12 或更新，以及 Xcode Command Line Tools（`xcode-select --install`），不需要装 Xcode.app。

```bash
npm install
npm run build                        # 构建渲染层 → out/renderer
./shell-swift/build.sh               # 编译原生壳（本机架构）→ shell-swift/cursive-shell
./shell-swift/cursive-shell EXAMPLE.md
```

打一个可以分发的包：

```bash
./shell-swift/release.sh                 # 测试与 E2E 全部通过才出包 → dist/Cursive.app
CURSIVE_DMG=1 ./shell-swift/release.sh   # 顺带出 dist/Cursive-<版本>.dmg
```

`release.sh` 一轮约 8 分钟，会反复打开测试窗口，运行期间不要碰键盘鼠标。

## 参与开发

- 报告问题或提建议：[Issues](https://github.com/lawrence1912/cursive/issues)。
- 改代码之前先读 [`CONTEXT.md`](CONTEXT.md)（架构契约与踩过的坑），以及 [ROADMAP](ROADMAP.md) 第二到四节：结构性判断、有意不做的事、非功能红线。
- 提交前跑 `npm run typecheck` 与 `npm test`；改动涉及编辑器行为或原生壳时，跑一轮 `./shell-swift/release.sh`，它是这个项目唯一的「绿灯」。
- 测试分层、自检探针与调试方法见[开发指南](docs/development.md)。

## 已知限制

- 没有签名公证，也没有自动更新：下载版第一次打开要手动放行，新版本要自己下载替换。
- 不导出 docx / epub；交给别人有 HTML、PDF、长图三种方式。
- 导出的 HTML、PDF 只有浅色一套：导出物会进别人的浏览器、会被打印。
- 跨文件搜索只看 `.md`、`.markdown`、`.mdown`、`.mkd`、`.txt`，最多 800 处命中、6000 个文件。
- 不做双链、反向链接、标签面板和插件：Cursive 是 Markdown 编辑器，不是笔记库。

完整列表与原因见[用户指南](docs/user-guide.md#已知限制)，有意不做的事见 [ROADMAP 第三节](ROADMAP.md#三有意不做总表)。

## 文档

| 文档 | 内容 |
|---|---|
| [用户指南](docs/user-guide.md) | 安装、全部功能的用法、设置、快捷键、已知限制 |
| [`EXAMPLE.md`](EXAMPLE.md) | Markdown 效果全览，也是走查渲染的验收稿 |
| [架构说明](docs/architecture.md) | 分层、IPC 契约、实时预览与导出管线、设计原则 |
| [开发指南](docs/development.md) | 构建、测试、自检探针、调试与提交约定 |
| [`CONTEXT.md`](CONTEXT.md) | 工程知识库：实现决策与踩过的坑，改代码前先读 |
| [`ROADMAP.md`](ROADMAP.md) | 当前计划、准入条件、版本记录与历史验收 |
| [`docs/`](docs/README.md) | 表格编辑设计、性能基线、输入法与 PDF 验收记录 |
| [`brand/README.md`](brand/README.md) | 品牌资产：标志、配色、用法、重出图标 |

## 许可

[MIT](LICENSE) © 2026 Lawrence。

依赖同为宽松许可：CodeMirror 6、@lezer/\*、KaTeX、mermaid、turndown 均为 MIT。
