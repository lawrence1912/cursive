# Cursive 开发指南

怎么把 Cursive 编出来、怎么测、怎么调试，以及提交改动前要守的规矩。
系统怎么分层见[架构说明](architecture.md)；每个实现决策与踩过的坑在 [`CONTEXT.md`](../CONTEXT.md)，改哪一块之前先去那里搜一遍。

## 环境要求

| 依赖 | 说明 |
|---|---|
| macOS | 原生壳只能在 macOS 上编译和运行；E2E 与原生专项要开真窗口 |
| Node.js | 22.12 或更新（Vite 7 与 mermaid 12 的 engines 要求），CI 用 Node 24 |
| Xcode Command Line Tools | `xcode-select --install`。**不需要装 Xcode.app**，编译只用 `swiftc` |
| Python 3 | 原生专项与人工走查脚本使用，Command Line Tools 自带的 `python3` 即可 |

## 编译与运行

```bash
git clone https://github.com/lawrence1912/cursive.git
cd cursive
npm install
npm run build                         # 渲染层 → out/renderer
./shell-swift/build.sh                # 原生壳，只编本机架构 → shell-swift/cursive-shell
./shell-swift/cursive-shell EXAMPLE.md
```

- `cursive-shell` 按「应用包内 → 当前目录下的 `out/renderer` → 按可执行文件位置推算的仓库目录」的顺序找渲染层资源，在仓库根目录运行最省事。
- 只改了渲染层：`npm run build` 之后重开 `cursive-shell`；改了壳：重跑 `./shell-swift/build.sh`。
- 命令行参数可以是文件，也可以是文件夹（开成一个工作区窗口）。
- 不带 `CURSIVE_SMOKE` 时它就是正常的交互应用，不会自己退出。

## 常用命令

| 命令 | 做什么 |
|---|---|
| `npm run dev` | 在浏览器里开发渲染层（Vite 热更新）；没有 `window.api`，原生功能不可用 |
| `npm run build` | 构建渲染层到 `out/renderer` |
| `npm test` | vitest 单测（文件之间顺序执行，见 `vitest.config.ts`） |
| `npm run typecheck` | 渲染层与共享层的类型检查 |
| `npm run icon` | 从 `brand/app-icon.svg` 重新生成 `build/icon.png` 与 `build/icon.icns`，只用系统自带的 `sips` 与 `iconutil` |
| `./shell-swift/build.sh` | 编译原生壳，只出本机架构（约 10 秒） |
| `CURSIVE_UNIVERSAL=1 ./shell-swift/build.sh` | arm64 与 x86_64 都编（CI 跑的就是这条，挡住 x86_64 悄悄编不过） |
| `./shell-swift/make-app.sh` | 只打包 `dist/Cursive.app`（永远是 universal），不跑测试；`CURSIVE_DMG=1` 顺带出 dmg |
| `./shell-swift/release.sh` | 完整发布检查，全部通过才出包，见下文 |
| `npx vite-node scripts/dump-tree.mjs [文件] [--full]` | 打印一份 Markdown 的语法树节点名，写装饰器前用来核对节点名 |

架构、部署目标和链接参数只在 `shell-swift/compile.sh` 一处定义，`build.sh` 与 `make-app.sh` 都调用它。部署目标固定为 macOS 12，必须与 `Info.plist` 的 `LSMinimumSystemVersion` 和 README 写的「需要 macOS 12 或更新」一致：
不显式指定时它会跟着工具链默认值走，系统升级后可能高过正在运行的系统，表现是命令行能跑、双击 `.app` 却被 LaunchServices 以 `-10825` 拒绝。

## 测试分层

| 层 | 怎么跑 | 覆盖什么 | 在哪儿跑 |
|---|---|---|---|
| 单测 | `npm test` | 纯函数与编辑器状态、方言解析、导出与实时预览对账、保存零损耗、性能断言，以及几项一致性检查：菜单快捷键与渲染层、命令面板、用户指南对账，契约与桥对账 | 本地、`release.sh`、CI |
| 类型检查 | `npm run typecheck` | 渲染层与共享层；中文字典加了 key 而英文没跟上也会报错 | 本地、`release.sh`、CI |
| 原生专项 | `python3 shell-swift/check-focus.py`、`check-flow.py`、`check-pdf.py` | 真窗口里的键盘焦点流转；只读、后退前进、重新打开标签；PDF 宽表格与标题分页 | `release.sh` 第 2 步 |
| E2E | `release.sh` 第 3 步 | 11 份夹具各起一个真窗口跑页面探针：逐字节读写往返、装饰计数、表格编辑、查找、文件树、导出 HTML 与 PDF……另有崩溃恢复竞态、长文档分页与全选等独立用例 | `release.sh` |
| 打包后检查 | `release.sh` 第 4 步之后 | 包体上限与 `Info.plist` 声明；另一个架构的二进制在 Rosetta 下冒烟 | `release.sh` |
| 人工走查 | `python3 shell-swift/check-ime.py`、`python3 shell-swift/measure.py` | 真实中文输入法组合 20 项；真实窗口的输入延迟、滚动、冷启动、内存与回归预算 | 只在本地人工发起 |
| CI | GitHub Actions（`.github/workflows/ci.yml`） | ubuntu：类型检查、单测、构建；macOS：编译 universal 原生壳 | 每次推送与 PR |

E2E 有意不放进 CI：它要开真窗口、跑 WKWebView、走打印流程，托管 runner 上又慢又不稳定，红了也分不清是代码坏了还是 runner 的问题。CI 只保证「编得过、单测绿」。

计时类的测量（`measure.py`）也不进 `release.sh`：在有人使用的机器上会随机变红。改动碰到编辑器热路径、装饰、查找或表格时，手动跑一次，结果与[性能基线](perf-baseline-2026-10-09.md)对照；基线是 M1 Pro、macOS 27 上的实测，预算写在 `measure.py` 的 `BUDGETS` 里。

## release.sh：唯一的绿灯

```bash
./shell-swift/release.sh                 # → dist/Cursive.app
CURSIVE_DMG=1 ./shell-swift/release.sh   # 另出 dist/Cursive-<版本>.dmg
```

| 步骤 | 内容 |
|---|---|
| 1/4 | 类型检查、单测、构建渲染层 |
| 2/4 | 编译原生壳（本机架构），跑三组原生专项 |
| 3/4 | E2E：11 份夹具逐个跑页面探针，另有崩溃恢复竞态、长文档 PDF 分页与全选等用例 |
| 4/4 | 打包 universal 的 `dist/Cursive.app` 并做打包后检查 |
| 4+ | 用包里的二进制在 Rosetta 下给另一个架构冒烟 |

- 一轮约 8 分钟，会反复打开测试窗口并抢到前台。自检期间壳会吞掉真实按键，免得夹具被改坏，但最好别碰键盘鼠标。
- 夹具先拷到 `/tmp/cursive-e2e/` 再跑；应用支持目录换成 `/tmp/cursive-e2e-support`，结束时（不论成败）清理，不碰你自己的草稿、版本历史与皮肤。
- 每个用例的日志和探针结果留在 `/tmp/cursive-e2e-results.XXXXXX/`，失败时先看这里。
- 版本号取自 `package.json`。
- 约定：每一轮改动收尾都跑一次，让 `dist/` 里随时有一个全绿的包。

## 自检探针与调试

### 自检模式

```bash
CURSIVE_SMOKE=1 ./shell-swift/cursive-shell /tmp/cursive-e2e/kitchen-sink.md
# 约 3 秒后写 /tmp/cursive-shell-check.json（DOM 状态）
# 约 4 秒后写 /tmp/cursive-shell-e2e.json（读写往返、装饰计数、图片加载），然后退出
```

> [!CAUTION]
> 自检会改文档：往文末追加标记并自动保存，表格、格式、粘贴几条用例还会就地改内容；文件树探针会在树根目录里真的新建、改名、移动、删除文件。
> 永远只拿夹具的副本跑，别指向自己在乎的文件；手动跑时也给 `CURSIVE_SMOKE_SUPPORT` 一个临时目录，免得用到真实的草稿与版本历史目录。

常用的环境变量：

| 变量 | 作用 |
|---|---|
| `CURSIVE_SMOKE_SHOT=<png>` | 截取 web 视图 |
| `CURSIVE_SMOKE_SHOT_CLEAN=1` | 只截图、不跑探针，文档一个字不动。给文档拍配图用这个 |
| `CURSIVE_SMOKE_THEME=dark\|light\|sepia\|system` | 截图前切换主题（会写进偏好，走查完用 `system` 复位） |
| `CURSIVE_SMOKE_SUPPORT=<目录>` | 把应用支持目录换成指定目录，只在自检下生效 |
| `CURSIVE_SMOKE_QUIET=1` | 不抢前台。窗口不是 key 时 WebKit 不派帧、`:focus` 不匹配，只适合读状态类的探针 |
| `CURSIVE_SMOKE_PDF=<路径>`、`CURSIVE_SMOKE_HTML=<路径>` | 探针跑完后顺带导出 PDF 或 HTML，绕过保存面板 |
| `CURSIVE_TIMING=1` | 打印启动各阶段的耗时，不需要 `CURSIVE_SMOKE` |

完整清单（主题走查、模拟原生对话框的答案、崩溃恢复竞态、PDF 走查、真实按键放行……）在 `CONTEXT.md` 的「自检探针 / E2E」一节。

### 调试提示

- 改了壳或启动序列，**一定用普通模式真的启动一次**并看终端输出：自检下有些路径是短路的，探针全绿不等于应用能正常打开。
- 每次启动测试窗口都会抢前台；要看的东西尽量攒在一次启动里看完。
- 量启动速度用 `CURSIVE_TIMING=1`，比较最小值或 p25，不比平均数；量之前清掉崩溃恢复草稿，否则会先恢复出一个草稿标签。
- 验证 PDF 不要用 PDFKit 抽取中文（会失真），看页面尺寸、页数，或用 `qlmanage -t` 转成图片看。
- 「改了代码却不生效」：壳给自定义协议的响应都带 `Cache-Control: no-store`，启动时也会清一次 WebKit 缓存；先确认 `out/renderer` 是重新构建过的。

## 提交改动之前

1. **先读约束**：`CONTEXT.md` 里与改动相关的「功能要点」和「已踩坑」，以及 ROADMAP 第二到四节。新功能先对照 [ROADMAP 第三节](../ROADMAP.md#三有意不做总表)，确认它不在「有意不做」的表上。
2. **守住红线**：没有用户的明确要求，任何功能都不得改写源码（`test/pipeline.test.ts`）；输入法组字期间不重算装饰；新 widget 必须实现 `eq()`；块级装饰只能来自 StateField。
3. **契约三处同步**：改 `window.api` 时 `src/shared/types.ts`、`shell-swift/main.swift`、`CONTEXT.md` 一起改并递增契约版本；新调用登记进桥的白名单，新推送事件登记进监听表。`test/bridge.test.ts` 会核对契约里的每个方法桥上都有、桥上的每个调用壳侧都有实现。
4. **键盘入口走菜单**：新快捷键先加原生菜单项；`src/renderer/ui/shortcuts.ts` 与[用户指南的快捷键表](user-guide.md#快捷键)跟着改，`test/shortcuts.test.ts` 会对账。
5. **界面文案双语**：加进 `src/renderer/i18n/zh.ts` 与 `en.ts`；壳侧的菜单与对话框文案在 `main.swift` 的文案表里。
6. **测试跟进**：每个新功能在 `release.sh` 里加一个用例或一条断言；提交前跑 `npm run typecheck`、`npm test`，涉及编辑器行为或原生壳时跑一轮 `release.sh`。
7. **壳代码**放在 `shell-swift/`，单文件渐进，优先 AppKit，不用 SwiftUI。

## 文档维护

| 文档 | 写什么 | 什么时候改 |
|---|---|---|
| `README.md` | 产品首页：定位、核心功能概要、安装、上手、架构一段、文档导航 | 定位、安装方式或核心能力变化时 |
| `docs/user-guide.md` | 全部功能的用法、设置、快捷键表、已知限制 | 每个用户能感知的改动 |
| `EXAMPLE.md` | Markdown 效果全览与渲染验收稿 | 方言或渲染行为变化时 |
| `docs/architecture.md` | 分层、通信、管线与原则的概述 | 架构层面的变化 |
| `docs/development.md` | 构建、测试、调试、提交约定 | 脚本或流程变化时 |
| `CONTEXT.md` | 实现决策、契约逐条记录、踩过的坑 | 每次改代码都可能要追加 |
| `ROADMAP.md` | 当前计划、准入条件、版本记录与历史验收 | 排期变化与每次发布 |
| `docs/*-<日期>.md` | 某一轮的验收与测量记录 | 写完即存档，后续进展只追加注记 |

几条容易踩的规矩：

- 功能细节只在用户指南里维护，README 只写概要，避免两份清单各自过时。
- README 里指向 GitHub 页面（Releases、Issues、Actions）的链接写绝对 URL：GitHub 的相对写法在 Cursive 自己的预览里会被解析成本地路径。
- 文档里不写裸 HTML：Cursive 会把它按原文显示，README 在它自己的编辑器里会露出标签。
- 要被链接的标题里避免「 / 」「 —— 」这类两侧带空格的符号：GitHub 与 Cursive 的锚点算法只在连续空格的处理上不同。
- 菜单快捷键写紧凑形式（如 ⇧⌘P）；菜单之外的按键写成带空格的形式（如「⌥ + ↑」「⌘ + 点击」），否则快捷键对账测试会把它当成菜单里不存在的键。
- 代码注释里引用了 README 的几处说法：「需要 macOS 12 或更新」、「不需要装 Xcode.app」、「不联网的人用这个 app，应该一个字节都不多背」，改 README 时保留它们。
- `docs/shots/` 里的截图与演示是真实窗口的录制：带原生标题栏，2 倍分辨率，截图窗口 1280×800、演示窗口 900×560，偏好为全新安装的默认值，色彩转成 sRGB。重拍时保持这些条件，前后的图才对得上。只需要网页内容时，可以用 `CURSIVE_SMOKE_SHOT_CLEAN=1` 拍 `EXAMPLE.md` 的副本。
- 历史验收记录不改写事实，后来的进展以带日期的注记追加。

## 发布新版本

参考步骤：

1. 改 `package.json` 的 `version`（`make-app.sh` 从这里读版本号）。
2. `CURSIVE_DMG=1 ./shell-swift/release.sh`，得到 `dist/Cursive.app` 与 `dist/Cursive-<版本>.dmg`。
3. 打 `v<版本>` 标签，在 GitHub 上建 Release 并上传 dmg。应用的「检查更新」读的是 `releases/latest`，只打标签、不发 Release 的话，它会回答「还没有发布版本」。
4. 更新 ROADMAP 开头的发布基准与第五节的版本记录。
