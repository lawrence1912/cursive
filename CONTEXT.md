# Cursive 开发上下文（AI 助手必读）

## 一句话

所见即所得的 macOS Markdown 编辑器。**Swift 壳（AppKit + WKWebView）+ `src/renderer`（CodeMirror 6）**；Electron 版已彻底删除（P0-4），构建链只剩 Vite → `out/renderer`。
产品名写作 **Cursive**（菜单、窗口标题、`Cursive.app`）；**目录名 / 环境变量 / localStorage 键 / 可执行文件仍是小写 `cursive`** —— 那些是标识符，改了等于给自己造一次数据迁移。

## 功能要点（renderer）

- **文件树**：`sidebar.ts` 懒加载树。打开单个 .md 且未开过文件夹时，`setActive` 自动把文档目录挂为树根（sbRows E2E 断言把关）。**树里只放能打开的文档**：`readDir` 在壳侧按 `DocScan.exts` 过滤（与跨文件搜索、快速打开同一份白名单，一处说了算），目录原样回 —— 打不开的文件进了树，点了也只是白报一次错；侧栏行名跟着剥掉全部文档后缀（不只 .md）。**上方一条工具栏**（`.sb-head` 里，文件夹名在左、五颗按钮在右：新建文件 / 新建文件夹 / **完全折叠** / 搜索 / 打开其他文件夹）—— 与 Finder 侧栏、VS Code 资源管理器同一套摆法，标题与动作同一行，不为按钮再占一整条竖向空间；原来那颗「⋯」换成了 folder-open 图标。**完全折叠**（P2-9，工具栏 + 右键菜单两个入口）只清 `expanded`、不动懒加载好的 children（那是缓存，清了下次每一级都要重走 IPC），没得可折时按钮 `disabled` 灰掉；它不是持久状态 —— 下一次 `setActive` 会把活动文件沿途重新展开，「让当前文件看得见」比「保持折叠」要紧。**读写全套**：新建 / 重命名 / 拖拽移动 / 删除进废纸篓 / 在 Finder 中显示（右键菜单 + 工具栏两个入口，契约 v7 + v10）。**拖拽移动不走 HTML5 拖放**（同大纲重排：`DataTransfer` 在无头自检里造不出来，走 mousedown/mousemove/mouseup E2E 才跑得通），落点画在目标目录上、拖到空白处则整棵树描边 = 落到树根；拖进自己或自己的子孙目录直接不给落点（壳侧 `moveItem` 还有第二道闸）。**重命名/移动之后 `expanded` 集合要按前缀整体重写**（里面存的是绝对路径，改名一个目录会让它和全部子孙的键一起失效，不重写整棵子树会「啪」地收起来），开着的标签也要 `retargetTabs` 改指向，否则下一次保存会按旧路径写回去 = 凭空复活一个已经不在那儿的文件。**别处改了盘，树自己跟上**（契约 v32）：壳按目录挂 kqueue，哪一级的条目变了就重读**哪一级**（`refreshDir`，不是整棵 `reload()`），重读回来先与现有清单比对 —— 一样就连 render 都不做（我们自己的自动保存是原子写，在目录看来就是条目变了，每两秒一次）
- **跨文件搜索**（P3-2，`ui/file-search.ts`）：占**文件树那块地方**，与树二选一显示（`.sb-search` / `.sb-tree`，⌘⇧F 或工具栏那颗放大镜切换）。**搜索本身在壳里跑**（契约 v11，`SearchOperation`）—— 渲染层递归 `readDir` 会让 IPC 往返爆炸。结果**按文件成批**流式回推（一个文件的命中一起发，既是天然批次也正好是 UI 分组单位），`token` 每次查询递增，**对不上的整批丢掉** —— 边打字边搜时上一次的结果还在路上，不挡就会盖住当前这次。命中携带**两个列**：`col` 是文档里的列（跳转用）、`textCol` 是展示串里的列（画 `<mark>` 用）—— Markdown 一个段落常常就是一行几百字符，壳侧要围着命中点裁窗口，裁完偏移就变了，合成一个字段的话长段落的高亮会画到别处。点一处命中 = 开那个文件的标签 + **选中那一处**（只跳到行首不够：一行里可能有好几处）
- **打开文件夹 = 新窗口**：菜单 ⌘⇧O / 侧栏工具栏那颗 folder-open / Finder 里把文件夹拖到图标上，走的都是「开一个新窗口挂这个树根」（一个窗口 = 一个工作区，与 VS Code 同款）。**唯一例外**是当前窗口还干净得像刚开出来 —— 一个空白标签、没改过东西 —— 那就地挂上，否则「新建窗口 → 打开文件夹」会白留一个空窗口。判断在渲染层（`main.ts` 的 `openFolder()`，只有它知道标签脏不脏），壳侧 `application(_:openFile:)` 收到文件夹则一律开新窗口
- **多窗口**（P3-7）：一个窗口 = 一个 `WindowController`（窗口 + webView + 只属于它的脏标记 / 当前文档 / 树根 / 外部变更监听 / PDF 导出）。菜单、最近文件、Dock 菜单仍归 `AppDelegate` —— 它们本来就是应用级的，每个窗口各建一份会打架。菜单命令经 `AppDelegate.key`（当前 key 窗口，没有就取最后开的那个）转给某一个窗口
- **大纲视图**：`ui/outline.ts`（P3-6 全量）。**标题取数在 `editor/headings.ts`，与 `[TOC]` 组件共用同一份**（`collectHeadings`：ATX + setext 都认，`plainInline` 把 `#`、setext 的 `=====`、行内语法一并剥掉，`:smile:` 换成字符；`sections()` 再按「本节 = 到下一个同级或更高级标题」切片算字数），250ms 防抖重建；点击 `scrollIntoView(y:'start')` 跳转；滚动时按「视口顶部行之前最近的标题」跟随高亮（`headingBefore` 在数组上找，不再每次滚动都遍历语法树）。面板里六件事：**折叠**（三角，状态按「层级 + 标题文字」记 localStorage `cursive.outlineFold`，**按文档分桶、只留最近 20 篇** —— 记位置的话编辑一下就全乱）、**层级档位**（头部 1–6 六个小方块，「显示到第 N 级」，≤N 的都亮着像进度条；再点当前档位 = 回到全部，省一个「全部」按钮）、**过滤框**（输入即筛，命中片段套 `<mark>`；**过滤时不认折叠** —— 收起来的那节里有命中项也得看得见）、**每节字数**（行尾灰色小字，`shared/wordcount.ts` 的 CJK 分词按节切片）、**拖拽重排**（自己接 mousedown/mousemove/mouseup，不走 HTML5 拖放：阈值/落点线/取消都好控，而且 `DataTransfer` 在无头自检里造不出来，走鼠标事件 E2E 才跑得通整条路；落进自己名下那一段直接判无效）、**右键菜单**（复制本节锚点 / 在此后新建同级标题 / 升降级；与文件树共用 `ui/menu.ts`）。**空态**给「本文还没有标题」，筛不到给「没有匹配的标题」。会改文档的三个命令都是 `headings.ts` 里的**纯函数算出一次 dispatch**（一步撤销白拿），并且**改完立刻重建大纲、不等那 450ms 防抖** —— 行上带的 `pos` 是渲染那一刻的位置，连点两下就会搬错一段。显隐 = 菜单 `view:toggle-outline`（⌘⇧T），状态存 localStorage `cursive.outlineVisible`。**两个面板开关在标题栏两端**（`.tb-btn`，main.ts 插进 `#drag-strip`：左内边距 78 躲开红绿灯、右留 10，26×26；**顶部 3px 不是 align-items:center** —— 红绿灯是 14×14、圆心离窗口顶 16pt，按 38px 条高居中会落到 19，低 3px；两个数都由探针 `trafficEnd`/`trafficMidFromTop` 实测把关），面板藏了开关还在，亮=面板开着（`.is-on` + aria-pressed）。面板头部原来的隐藏按钮、以及更早的「唤回浮标」（#sb-show/#ol-show，absolute 钉在 #main 左右上角，正好压住第一个标签）**都已删**，开关只剩标题栏 + 菜单 ⌘\ / ⌘⇧T 两条路，且都走 main.ts 的 `toggleSidebar()`/`toggleOutline()`（localStorage 持久化和按钮状态各只有一份）。E2E 防回归：`tabHit`、`tbHoleLeft/tbHoleRight`、`tabNativeHole`/`tabUnderStrip`、`tbHitPage`、`tbToggle`、`trafficEnd ≤ 72`、`|tbMidY - trafficMidFromTop| ≤ 1`，以及 `outlineProbe`（字数/折叠/档位/过滤/菜单/拖拽/pos 新鲜度）。**布局总览（0.2.x 顶栏合并后）**：**main 从 y=0 起**（左 sidebar 通栏 | center=topbar+editor | 右 outline 通栏）→ status-bar；顶边那 38px 的底色由三块各自画 —— 中间列是 `#topbar`（标签栏），两侧是 sidebar/outline 的 `padding-top`。`#drag-strip` 还在，但退成一条**不占位**的按钮轨（`position: fixed` + `pointer-events: none`），只负责把两端那几颗按钮钉在红绿灯那条线上。标签栏仍只属于中间编辑器列（在文件树/大纲的右侧），不横贯全宽；DOM：index.html 静态 #main/#center/#topbar 骨架，sidebar/tabbar/outline 由 main.ts 插入对应槽位
- **标签页**：`main.ts` + `ui/tabbar.ts`。每标签持有完整 EditorState（切走冻结/切回 setState，装饰+撤销历史+光标随 tab 走）；`setDocState` 的 dirty 聚合为「任意标签脏」，`file:save-and-close` = 所有脏标签落盘（任一取消即中止关窗）；关闭最后标签自动开新空白标签；开新标签**不**触发 dirty 守卫（不会丢内容）。**布局（0.2.x 顶栏合并）**：标签栏就是顶栏（`#topbar`，`base.css`），坐在中间列最上面、与原生拖拽条同高同位（38px）—— 原来顶上是「通栏拖拽条 38 + 标签栏 40」两条，正文白白被压低 78px。标签因此坐在原生拖拽条底下，点击/中键/右键/拖拽重排全靠**挖洞**收事件（契约 v26，见下面那条坑）；两侧面板藏起来时顶栏要让开红绿灯（左 110）与右上三颗（右 96），两个 class 由 `syncTitlebar()` 挂
- **标签右键菜单**（0.2.0，`ui/tabbar.ts` + main.ts 的 `closeTabs`）：关闭 / 关闭左边 / 关闭其他 / 关闭右边 / 关闭所有，相对**右键点中的那个标签**（不是活动标签）。浮层复用 `ui/menu.ts`，与文件树、大纲同一份。四条决定各有理由：① **右键不激活**（同 Chrome / VS Code：右键只是「对这个标签发个命令」）；② **按标签栏里看到的顺序从左往右关**，脏标签的「是否保存」于是也按这个顺序一个个弹 —— 先关非活动的那种优化会让弹窗顺序显得随机；③ **任何一次取消就整批停下**（`closeTab` 为此从 `Promise<void>` 改成 `Promise<boolean>`）—— 继续关下去等于「用户说了不要关这个，那就把别的都关了吧」，这是唯一一条错了会真丢东西的分支；④ **留下来的那个先激活**（`all` 除外），于是被关的全是非活动标签，`closeTab` 里那条 `activate(邻居)` 一次都不走 —— 否则关五个标签要 `setState` + `focus` 五遍。高亮存 `contextId` **而不是直接往 DOM 上加 class**：`render()` 每次文档变化都会重建全部子元素（自动保存落盘也会触发一次），加在 DOM 上的标记会被悄悄冲掉。顺带补了壳侧一个隐患：`confirmDiscard` 在自检下**没有护栏**，探针一关脏标签 `runModal` 就会把无人值守的 E2E 卡死 —— 现在由 `CURSIVE_SMOKE_DISCARD=save|discard|cancel` 给替身答案（默认 discard），「取消要中止整批」这条也因此测得到

- **状态栏与统计**：`index.html` 的 `#status-bar`（左文件名 → 右 `#status-pos` 光标行列 / `#status-count` 字数 / `#status-match` 查找计数 / `#status-saved` / `#status-zoom` 缩放 / `#status-mode`）。P3-8 新增：**行列**（`ui/stats.ts` 的 `cursorLabel`，列按**码点**数 —— emoji 占一列）不防抖，方向键走到哪跟到哪；**字数**平时是「N 词 · N 字符 · 约 N 分钟」，一有选区就换成「已选 N 词 · N 字符」并染成 accent 色；**点它弹详细统计**（`#stats` 浮层：词/字符/不含空格/中日韩字/拉丁词/段落/行/阅读时间，有选区时多一列「选中」）。0.4.1 新增 **`#status-zoom`**（正文缩放的百分比，`ui/zoom.ts`）：**不是 100% 时才出现**（`:empty` 整格不占位 —— 状态栏这一排的规矩是「没话说就别占地方」，而「现在是 100%」正是没话说），点一下回到 100%，键盘可达同字数条。口径全在 `shared/wordcount.ts`（`count` 便宜的那几个标量 + `shape` 段落/行，后者只有面板要，别塞进 `count` 让大纲的每节字数白算一遍）；阅读时间**中文 300 字/分、英文 200 词/分各按各的算再相加**，混排文档才不会把汉字当词估成三倍。全文统计**缓存在 `docStat`**，只有文档变了才重算（200ms 防抖），挪光标只重数选中那一段（120ms）
- **chrome 视觉网格**（真相 = `base.css` 顶部那几个 token，别在组件里写死尺寸）：`--chrome-size:13px`（树行/大纲行/标签，macOS 的界面字号）、`--chrome-label:12px`（面板小标题 + 状态栏）、`--chrome-row:30px`、`--tabbar-h:40px`、`--status-h:30px`、图标 16px（`ui/icons.ts` 一处改全局）。拖拽条与侧栏/标签栏/大纲/状态栏同属 chrome 层 `--surface`，**只有正文那张纸是 `--bg`**。**标签栏**：活动标签 = 编辑区那张纸的顶边（`--bg` + 1px 描边 + 8px 上圆角，与正文连成一片），分隔线画成 `#tabbar` 的 `box-shadow: inset 0 -1px 0`（border-bottom 在盒子外沿，子元素盖不住它；inset 在背景层，活动标签的底色正好压住那一段）；所有标签等高（条高 40 − 顶部 6 = 34，用 `height:100%` 拿），**活动态不能比别人高**，否则文字基线会跳；非活动标签不画边框（一排描边盒子 = 格栅），关闭 × 平时 `opacity:0`、hover/活动/键盘聚焦才现身（用 opacity 不用 display，位置留着才不抖）。**标签还等宽**（`flex: 1 1 0`，92–200px）：宽度只跟数量走、不跟文件名长短走 —— 名字一长一短排出来的参差格栅是标签栏最吵的来源；窄到 92px 就不再挤，改为横向滚动。**关闭键固定在右端**：标题 `flex:1` 吃掉所有多余空间（`min-width:0` 不能省，否则 flex 子项里的 `text-overflow` 失效），× 于是永远贴着同一条竖线。**标题栏右上角是一块三连**（`.tb-group`：深色 / 栏宽 / 大纲，26×3 + 间隙 2×2 = 82px）—— 与壳侧 `DragStripView.hitTest` 的右侧挖洞区（末尾 96px）强耦合，改尺寸必须同步壳。原先那条「顶部 2px 蓝条」已删 —— 连成一片本身就是当前位置的信号。
- **表格就地编辑**：`live-preview/table.ts`（解析 + 编辑态 + widget 一整套，从 widgets.ts 拆出来）。块级（跨行）装饰**只能走 StateField**（`index.ts blockField`），ViewPlugin 的会直接报错。**点进单元格不再回落源码**：格子是 `contenteditable="plaintext-only"` 的编辑岛，打字经 `input` → `writeCell` 只替换那一格文字的源码区间，同行其余 padding 一个字节不动（保存零损耗的表格版；nomo 那种 AST 往返会把整张表重排）。三条地基（都在 @codemirror/view 6.43 里核过）：① widget 里的 DOM 变更 CM 一律不读（`readMutation` 命中 widget tile 直接 `return null`）；② 焦点在格子里（`activeElement != contentDOM`）时 CM 既不读选区也不写选区 —— reveal 判定自然失效，表格才留得住；③ **必须实现 `updateDOM` 并返回 true**，否则每次 dispatch 都重建 DOM，焦点和光标必丢（它开头那句 `!this.editing && dom.contains(activeElement)` 守的是「别把正在编辑的那份 DOM 抢走」）。**代价**：`ignoreEvent` 全忽略之后格子里的按键不进 CM keymap，Tab/回车/方向键/Esc 全自己接，**⌘Z/⌘⇧Z 必须显式转发给 history**（keydown 和 `beforeinput` 的 historyUndo 两条路都要拦）。`tableEditField` 取值一律 `state.field(f, false)`：源代码模式撤掉了整套扩展，单测也只装 markdown 语言包。**CM 选区 = 「在编辑哪一格」的唯一真相**，widget 只把它镜像成 DOM 焦点，于是点击/Tab/方向键进表三条路径统一成「移动选区」。Esc 是保留的逃生口（回管道符源码）。**下半场**：底部浮动工具栏（`absolute; top:100%`，只在编辑态露面；按钮 `mousedown` 一律 `preventDefault`，焦点离开格子编辑态就散）、悬停 +/− 手柄、格内行内语法（片段由 `cellTokens()` 从**文档的语法树**上采 —— 与正文同一套方言，不另写小解析器）、「整理对齐」（唯一重写整块的操作，**永不自动跑**、幂等、CJK 算两列）。增删行列/对齐/整理/删表**全是纯函数** `(state, tableFrom, …) -> TransactionSpec`，工具栏与手柄共用一份，撤销栈和保存零损耗自动成立。详细设计见 `docs/table-editing.md`。E2E `tableEdit`/`handles` 断言「点进去表格还在 + 焦点是 contenteditable 的 td + 改完那行其余列 padding 一字不变 + 工具栏露面 + 下插行/整列居中/整理对齐（各行显示宽度一致）生效 + `**粗体**` 渲染成 `<strong>` + 两颗手柄都在」

- **自动补全**（0.2.0，`editor/complete.ts`）：`@codemirror/autocomplete` 一直在依赖里但只用了 `closeBrackets`，补全本身一次都没挂。五个源的数据**全是现成的**，不新增任何一张表：`:` 走 `emoji.ts` 的 `EMOJI`、`> [!` 走 `callout.ts` 的 `calloutTypes()`（别名折叠成 13 个规范名）、`[^` 现扫文档里已有的脚注定义（形状走 `markdown-lang.ts` 那份 `FOOTNOTE_DEF` —— 解析器 / 补全 / 导出切分 / `footnoteLabels` 四处同一条正则，补全只列解析器认的东西）、`](#` 走 `headings.ts` 的 `collectHeadings`+`slugs`（与 `[TOC]`、大纲、导出 id 同一份算法，所以补出来的链接一定点得动）、围栏语言走语言条那份 `langOptions()`（只列真会上色的）。三个细节都是坑填出来的：① **`closeBrackets` 会先替你补上收尾括号** —— 想写 `[!note]` 的人打到 `[!` 时文档里其实是 `[!]`，所以 `applyWith` 要么吃掉右边那个（`[!note]`/`[^id]` 自带收尾）要么跳过去（`](#锚点` 的 `)` 不属于这次插入）；② **围栏语言的 `from` 要落在 ``` 之后** —— CM 拿 from 到光标那一段当过滤串，连围栏一起算的话打 `ty` 是拿 "```ty" 去比 "TypeScript"，一条都匹配不上；③ emoji 要求**冒号后至少一个字符**且冒号前不是字母数字，否则 `10:30:45`、`TODO:fix` 每写一个冒号都被面板打断。每个源开头都挡 `view.composing`（红线二）。面板皮**照抄 `.ctx-menu`**（毛玻璃 + 同款圆角投影 + `--accent-wash` 悬停），浮层就该长一个样。**第六个源是斜杠命令**，见下一条
- **斜杠命令**（`editor/slash.ts`，照 Notion 那套输入方式）：行首打 `/` 弹一份块菜单 —— `/callout`、`/table`、`/h2`、`/todo`…。两处都不自己造：**一条斜杠命令只是一个 `fmt:*` MenuAction**，落地走 `fmt.ts` 那台引擎（与原生「格式」菜单、格式栏、快捷键、命令面板同一条路，于是幂等、多光标、一次 ⌘Z 撤回全都白拿，「菜单能插的块斜杠插不了」这种漂移不可能发生）；面板就是 `complete.ts` 那套 `autocompletion()` 的第六个源（上下选 / 回车插 / Esc 关 / 组字期间不抢键一件都不用重写，长相也与 emoji、告示块那几个源一致）。它只回答三个问题：① **什么时候弹** —— 斜杠前面**只允许缩进**。Notion 里 `/` 在块内哪儿都弹，这儿不行：`2026/09/16`、`src/renderer`、`http://` 全是正文里的常客，见一个斜杠弹一次面板会让写路径变成一件需要躲闪的事。列表项 `- /`、引用行 `> /` 以及它们的**续行**一并不认 —— 缩进两格的续行前面确实只有空白，但人在写的是同一个块，在那儿插一张表，表会从列表里掉出来、原来那个块还剩个空壳（续行靠语法树认：`ListItem` / `Blockquote`）；代码块 / 公式 / front matter 里的 `/` 是内容，也不弹（节点名是实测出来的：front matter 上是 `Frontmatter` 而**不是** `FrontmatterContent`，里面那截由 YAML 解析器接管，链上先是它自己的 `Document`/`Stream`；`CodeBlock` 顺带管住了四空格/Tab 起头的缩进代码块 —— 那种行「前面只有空白」但已经不是正文了）。② **列哪些** —— 只收块级命令（行内开关在行首没有可套的文字，`/bold` 只会插出一对空 `**`，而它们各自都有快捷键）；显示名走格式栏那份 `fb.*`（同一件事在四个入口里必须同名），右边一列摆关键词 —— 与命令面板拿这一列摆快捷键是同一个位置、同一个意思，**斜杠词就是这条命令的快捷键**；**筛选和排序自己做**（`filter: false` + `ui/fuzzy.ts` 那个打分器，与命令面板 / 快速打开同一份，同一条查询在三处行为一致），因为要让 `/cal` 和 `/告示` 都找得到「告示块」—— 关键词、显示名、别名是三个串，而 CM 自带的匹配只比 `label` 一个。只打了一个 `/` 时**保持表序**（那一刻它是一份菜单不是搜索结果）。③ **光标落在哪** —— 插入类照用骨架自己定的落点（`skeletonOf` 一处定义：表头第一格 / 公式块中间那一空行 / 图片 url 的括号里），行级类**按行号数**：`makeFormatSpec` 给的落点是「把原选区映射过去」，而斜杠命令的原选区恰好压在行首、`# ` 也正是插在行首，映射出来的光标会停在 `#` **前面**（接着打字打出来的是 `文字# `）；代码块要 +1 行（开围栏另起一行插在前面，原来那一行顺延成围栏中间那一空行），**而这里靠 `mapPos` 是走不通的** —— 删掉 `/code` 再在同一点插入开闭两道围栏，composed 之后那是一次**替换**，`mapPos` 在替换的起点上不看 assoc、一律落回替换点。删关键词与插骨架**合成一个事务**（`ChangeSet.compose`），⌘Z 一下就回到打 `/` 之前，而不是先撤掉块、再撤掉那几个字。另外两处：缩进连着关键词一起删（留着的话 `fmt.ts` 会把标记插在缩进前面，`  /h1` 变成 `#   `），删除事务里的选区要**显式**摆到删除点上（`makeFormatSpec` 读的是 `state.selection`，靠「调用方恰好把光标放在那儿」的话，单测和编辑器插出来的不是同一个地方）。**面板长相**：行首一列图标走 `autocompletion({ addToOptions })`（位置 20，CM 的标签是 50、右列是 80），渲染器读不到 `ic` 字段就**返回 null** —— 另外五个源于是照旧是「文字 + 右列」，不会平白多出一列空白。图标名与格式栏那份 `FORMAT_ICONS`（由条子上的 `BLOCK` + 插入下拉的 `INSERT_META` 现算）**逐条对账**，十九条里只有标题六级是新画的。行的度量**照抄 `.fb-kind`**（28 高 / `0 8` 内边距 / 7 圆角 / 6 间距 / 16 图标列）—— 两处列的是同一批块，长相不该有第二种；右列的尺寸照抄命令面板的 `.pl-hint`（12px、最多 45% 宽、省略号收尾，**45% 是给脚注源兜底的**：它的 detail 是定义正文，不封顶面板会被一条脚注拉到 700px），但**颜色故意不抄** —— 那边是 `--mark-idle`（装饰档 2.6:1，「你早就会按的快捷键」），这里是**你要照着打的那个词**，用 `--muted`（5.1:1）。两个坑：① `.cm-completionLabel` 必须给 `min-width: 0`，flex 子项默认 `min-width:auto` 会顶着内容撑开，`text-overflow` 一辈子不生效（标签栏 `.tab-title` 踩过同一个），而 CM 画在 li 上的那份省略号对 flex 布局不起作用；② 行里有了 SVG 就不能再靠 `line-height` 定心，得换 `align-items:center`。**对齐是量出来的**（把 `theme.ts` 生成的那份 StyleModule 取出来 + 真图标 + 真候选拼成一页，headless Chrome 截图并回读 `getBoundingClientRect`）：行高 28、图标左沿 8、名字左沿 30、图标垂直偏心 0，三套主题与中英两种界面语言全部一致；关键词右沿 8，列表长到要滚时是 18 —— 那 10px 是滚动条，自定义滚动条**占位**（base.css 里那条注释写明了代价），所以是让开而不是压住。顺带修了 `footnote` 图标：原来墨迹落在 y 2.4–11、视觉重心 6.7，比同排别的图标高 1.3 格（量出来的，别的都压在 8.0），在格式栏的插入下拉里就偏上了，一列图标摞起来更明显；现在整体下移 1.3 成 3.7–12.3。标题六级的数字是**画**的不是拿字符当图标（`ui/icons.ts` 开头那条理由），外面一层 `<g>` 把数字绕**基线**放大 1.14 —— 数字与 H 同底但字面只有 H 的 0.73 高，不放大读出来是下标 `H₁` 而不是 `H1`（三版并排截过图）。`test/slash.test.ts` 32 条
- **命令面板 / 快速打开**（0.2.0，`ui/palette.ts` + `ui/commands.ts` + `ui/fuzzy.ts`）：**一个组件两种内容** —— 交互完全一样，差别只在条目从哪儿来。面板不认识任何命令，只认 `PaletteItem.run`：命令面板把它接到 `handleMenu(action)` 上，**与原生菜单同一条路**，于是「菜单里有、面板里没有」这种漂移不可能发生（`test/commands.test.ts` 直接读 `types.ts` 把 `MenuAction` 联合成员抠出来对账，豁免名单里每条都得写明理由）。快速打开的索引走契约 v21，**每次现要不缓存** —— 缓存要跟着新建/改名/拖动/删除/外部变更一起失效，那是五个订阅点，换来的只是省掉几十毫秒。模糊匹配是自写的子序列打分（`fuzzy.ts`）：必须是子序列（`mdl` 匹配 `markdown-lang`，`lmd` 不行）、连击加分**必须压过词首加分**（10+10 > 12，否则 `abc` 查 `a-b-c-x` 会赢过 `abcx`）、路径按文件名优先（`fuzzyPath`）。**Esc 走 window 捕获**而不是只挂输入框 —— 焦点一旦被别的东西收走就按不掉了（同 `ui/menu.ts` 的做法）；顺带这也是 E2E 唯一能测到它的路径：元素级的合成 `KeyboardEvent` 在 WKWebView 里送不到监听器（实测：同一元素上 `new Event('keydown')` 能触发、`new KeyboardEvent(...)` 不能）
- **链接跳转**（0.2.0，`editor/link.ts`）：⌘/⌃ + 点击跟着链接走。**一处回答「这个地址指的是什么」**，正文、表格格内、导出 HTML 三条路共用（`resolveLink` / `linkDest` / `safeUrl` / `autolinkUrl` / `collectRefs` 全在这一个文件里，`export/render.ts` 从这里 import —— 原来它自己那份 `safeUrl`/`collectRefs` 已经删掉）。四种去处按**目的地本身**分：外部地址交给系统（`openExternal`）、`#锚点` 在本文滚过去、本地 `.md/.markdown/.mdown/.mkd/.txt`（与壳侧 `DocScan.exts` 同一份名单）在**这个窗口**开标签、其余本地文件交给默认应用或 Finder。**锚点串走 `headings.ts` 的 `slugs()`** —— 与 `[TOC]`、大纲「复制本节锚点」、导出 id、补全里 `](#` 那个源同一份算法，于是「补出来的锚点一定点得动」这句话第一次真的成立（此前 ⌘+点击 `#标题` 是把它当外部地址交出去，什么都不会发生）。认的是**语法树而不是 `.cm-lp-link` 类**，所以引用式 `[文字][id]`、简写 `[id]`、裸链接、`<地址>`、连引用定义 `[id]: 地址` 那一行都跟得过去；不是链接就**必须返回 false**，⌘+点击在 CodeMirror 里本来是「加一个光标」。四个坑：① **先切 `#` 再百分号解码** —— 反过来的话文件名里写成 `%23` 的 `#` 会被当成锚点分隔符；② **裸链接才补协议**（`a@b.com` → `mailto:`、`www.x` → `https:`），引用定义里的地址是**目的地**，补了协议 `[doc]: ./别的.md` 就成了一条打不开的网址；③ **「已经是当前这份」要先挡住**（`main.ts` 的 `openDocLink`）—— `activate()` 只在切换时把 view 的 state 存回标签，对当前标签再调一次就是拿旧 state 盖掉正在编辑的内容（`openPath` 开头那句 return 挡的是同一件事）；④ 打不开时**必须说话**：状态栏 `#status-note`（4 秒自散）说「找不到文件 / 本文里没有这个锚点 / 打不开」，壳侧 `openExternal` 也改成回 Bool（契约 v23）—— 「点了没反应」是最糟的失败方式。**连「这压根不是链接」也要说**：目的地带空格**又看不出是哪个文件**时（`[文档](我的 笔记)`、`[官网](http://a b.com)`）方言仍然不认，`spacedDest()` 在点击落空**之后**才现扫一行源码（平时一次都不跑，行内代码里的同款文字不算），认出来就说「写成 `<…>` 或把空格换成 %20」，并吃掉这一下（点在那儿的人想的是「跟过去」，不是「加一个光标」）。**方言放宽一格（`markdown-lang.ts` 的 `SpacedLink`）**：CommonMark 的链接目的地不能带空格，于是 `[部署手册](我的 笔记.md)` 整段落进正文 —— 连 `Link` 节点都没有，不上色、点不动、导出也不是链接。而**带空格的文件名正是中文笔记的常态**（作者在自己的 vault 里连试六种写法，最后把文件改了名才算完，版本历史一条不落地记着）。放宽的边界钉死在「看得出是个文件」上：目的地里真有空格、不带协议、不是 `<…>` 写法、且 `#` 之前那半截以 `/` 或 `.后缀`（首字母是字母）结尾 —— 于是 `[备注](见 下文)`、`[版本](见 v1.2)`、`[官网](http://a b.com)` 都不会被误认（**误认比不认更糟**：正文里平白多出一条蓝线）。节点形状与内置完全一致，装饰/导出/大纲/表格四条路一条分支都不用加；`parseImage` 的裸目的地同步放宽（非贪婪 + 尾部 `\s*\)$`，尺寸段与标题不会被吃进去），否则解析器给了 Image 节点而装饰层读不出 src，屏幕上就是「alt + 一串源码」。**已知取舍**：这种链接的文字里行内语法不再解析（与 `SizedImage` 同款 —— 换来的是不去动 lezer 的分隔符栈）。**写出去的仍是标准形状**：`destLiteral()` 给 app 自己插入的路径（拖图、粘贴截图）带空白时括上 `<…>` —— 放宽的是「读」，而文档还要进 GitHub / Obsidian / pandoc。顺带补齐三处预览保真：裸链接与 `<地址>` 现在也按链接上色（`cm-lp-autolink` 单压一层 —— `t.url` 的灰嵌在链接标记里面，继承不过去）、引用式的 `[id]` 与链接标题 `"说明"` 在预览里藏掉（`LinkTitle` 本来就在 `INLINE_MARKS` 里，大纲和表格格内一直藏着，只有装饰层漏了这一条；`LinkLabel` 一并收进那张表）
- **启动首帧的深浅 + 正文缩放**（0.2.x 起在壳侧；**缩放那一半 0.4.1 整个搬到了渲染层**）：① **首帧不白闪** —— 页面那半本来就不闪（`base.css` 里那份 `@media (prefers-color-scheme: dark)` 专管「JS 起来之前的首帧」），漏的是它跟的是**系统**外观、而 WKWebView 的 `prefers-color-scheme` 跟的是 `NSApp.appearance`；于是 `setAppearance` 顺手把模式记进 UserDefaults，`applicationWillFinishLaunching`（**任何窗口出现之前**）按它摆好 `NSApp.appearance`，那份媒体查询自己就把首帧画对了。**护眼归到浅色**（`appearanceFor` 是全仓库唯一一份映射）—— 它是一张暖色的纸，配深色标题栏是「上半截深下半截浅」，原先它落在 else 里跟随系统。② **正文缩放**（0.4.1 重做，`ui/zoom.ts`）：⌘+ / ⌘− / ⌥⌘0 与触控板捏合缩的**只有正文** —— `--zoom` 乘在两处（`editor/theme.ts` 的正文字号与正文栏宽），侧栏 / 标签 / 状态栏 / 格式栏一个像素都不动。**换掉的是 `pageZoom`**：那是整张网页一起放大，界面越缩能装下的东西越少，而人按 ⌘+ 要的只是「字大一点」（壳因此不再碰 `pageZoom`，它恒为 1；老 UserDefaults 里那份启动时清掉）。三条决定：**栏宽跟着一起乘**（不乘的话一行能放的字数随缩放缩水，而 38 字是排版决定）；**档位是一张表**（0.5/0.67/…/3，不再 ×1.1 连乘 —— 这个数现在摆在状态栏上给人读，133.1% 不是个能读的数）；**捏合在壳侧攒够一档才发一条 `view:zoom-in/out`**（`PINCH_STEP`），与菜单共用同一张表，各算各的话状态栏迟早出现半档数。⌥⌘0 而不是 ⌘0：⌘0 在「格式」里是「正文」，而 AppKit 按菜单顺序取第一个匹配、格式排在视图前面 —— 视图里那条 ⌘0「实际大小」从加进来那天起就是死键。状态栏那一格**只在不是 100% 时出现**，点一下回到 100%。**两样自检下都不恢复**（同 `lastFolder`）：探针里有一批按像素来的断言，带着上次的缩放/外观跑就全飘了
- **会话恢复**（0.2.x，`ui/session.ts`）：关掉再开，回到上次那几个标签、那个位置。此前重开只剩「双击的那份文档」—— `sidebar.restore()` 恢复的只是树根，标签/滚动/光标全在内存里。与崩溃恢复（scratch）分工明确：**那边救内容（没存过的草稿），这边救现场（开着哪几个文件）**，所以这份清单**只记有路径的标签**，两边都记会开出两份。**按工作区根分组**（契约 v19，一个窗口 = 一个工作区），存 `cursive.session:<根>`；存的是路径 + 滚动 + 光标，不存内容 —— 恢复时按路径读盘，**文件没了就跳过那一条**（壳侧 `read` 只 reject 不弹框，静默跳过是安全的），绝不摆一个空壳标签。恢复的三条顺序规矩：① 排在**崩溃恢复之后**（那边会过滤启动空白页并校正 `activeId`）；② 每个标签都 `spawnTab(..., focus=false)` 开在背景里，**最后只激活一次**（一个个激活等于 `view.setState` + 大纲重建 + 一趟 IPC 各做 N 遍）；③ **启动带进来的那份文档说了算** —— 恢复出来的是背景内容，把用户刚双击的那份挤到后面去是最难受的一种「聪明」（`planRestore` 是纯函数，`test/session.test.ts` 把这条钉死了）。自检下整条关掉（契约 v24）
- **版本历史**（0.2.0，`ui/history.ts` + `editor/diff.ts`，契约 v22）：对抗的是「改崩了一段而撤销栈已经翻篇」——自动保存让这件事更常见。整窗浮层（左列版本、右侧差异），不是侧栏第三块面板：差异要并排读，侧栏撑不住；而它是「偶尔打开看完就走」的东西，不值得常驻。差异是自写的行级 LCS（`diff.ts`，不引库）：**先掐头去尾**，同一文档两版绝大部分相同，真进 DP 的往往只剩几十行；两边都超过 1200 行就退化成整段替换（那已经不是「改了几处」）。**恢复 = 一次普通编辑**（整份替换进 EditorView），⌘Z 撤得回，保存零损耗那条红线一点没碰。有意不做的三件：不做分支/命名版本、不比对两个历史版本（右侧永远是当前文档）、不做词级高亮
- **复制为富文本**（0.2.0，契约 v20）：⌥⇧⌘C。地基是 P4-1 那份单文件 HTML，壳只多一个 `NSPasteboard` case。**有选区就只复制选区** —— 把选中那段 Markdown 现造一个 EditorState 交给同一个渲染器，没有第二套局部渲染逻辑
- **PDF 书签**（0.2.0）：目录层级来自渲染层的 `collectHeadings`（与大纲同一份取数）。两处非做不可的迂回，都是实测摔出来的：① **PDFKit 写不出 outline** —— `doc.outlineRoot = root` 之后 `numberOfChildren` 是 1，`write(to:)` 返回 true，重新读回来却是 nil；`dataRepresentation()` 一样。所以自己往文件尾部**追加一次增量更新**（PDF 32000 §7.5.6，`PDFOutlineWriter`）：只追加、不改动原有字节，链接注记和页码因此一个不丢（换 `CGPDFContextSetOutline` + 逐页重绘的话链接全没了）。只支持经典 xref 表 + 明文 trailer，也就是 WebKit 印出来的那种；认不出就**一个字节都不写**。② **标题定位不能用 `findString`** —— WebKit 印出来的 PDF，中文抽出来是**康熙部首形**（`⽂` U+2F42 而不是 `文` U+6587），`findString("长文档")` 一条都找不到，而「真分页」三个字却好好的，症状是「有的标题有书签有的没有」。办法是两边都过一遍**逐字 NFKC**（逐字是因为整串 normalize 会把 `ﬁ`→`fi` 这类一变多的映射也做掉，UTF-16 下标当场错位，而后面要靠它回查 `selection(for:)`）。定位另有两条约束：单调推进（只在上一条落点之后找）、跳过落在**链接注记**上的命中（`[TOC]` 生成的目录项是链接、真标题不是 —— 这一条正好挡掉「书签全指向目录页」那个最常见的错法）
- **拼写检查**（0.2.0，默认关）：设置面板里一个分段开关。实现是 `EditorView.contentAttributes.of({ spellcheck: 'true' })` 一行 —— 可编辑区一旦声明要检查，macOS 的 NSSpellChecker 在 WKWebView 里自动接管，红波浪线和右键「改正为…」全是系统给的。走 compartment 而不是建 state 时钉死：每标签一份 EditorState，钉死等于「改了设置只对新标签生效」；`spellNow` 是新 state 的种子（与 `writingNow` 同一个做法，七处 `createState` 一处都不用改）

- **导出跟随当前排版**（0.2.x，`export/style.ts` 的 `typographyCss`）：设置面板里的字号/行距/字族/栏宽此前只写进编辑器的 `--body-*`，导出 HTML 与 PDF 一直用钉死的默认值 —— 屏幕上 18px 无衬线、导出物 16px 衬线，是「所见即所得」最后漏掉的一处。做法是 `EXPORT_CSS` 里那四个 token **与 `themes/base.css` 同名同默认值**，`exportHtmlDocument` 多收一个排版参数，在样式表后面追加一小段 `:root` 覆盖它们。**与默认值全等时返回空串** —— 没改过设置的人，导出物与从前逐字节相同（golden 快照因此不用重录，有断言守着）。两处分寸：**纸上的字号按比例缩而不是原样搬**（16px = 五号 10.5pt 是基准，px 原样写成 pt 一页少放三分之一的字）；**栏宽只管屏幕**（纸的宽度由 NSPrintInfo 的纸张 + 页边距说了算，`@media print` 里本来就是 `max-width:none`）。配色那条红线没碰，导出仍恒为浅色；**复制为富文本有意不跟** —— 粘贴目的地有它自己的正文样式，带一个 20px 过去只会在别人的邮件里显得突兀
- **标签栏：拖拽重排 + ⌃Tab 循环 + 活动标签滚进视口**（0.2.x，`ui/tabbar.ts`）：拖拽照抄大纲/文件树那套 mousedown/mousemove（**不走 HTML5 拖放**，同一个理由：`DataTransfer` 在无头自检里造不出来）；落点线是绝对定位的出流元素，不参与标签等分。**顺序的真相是 `main.ts` 的 `tabs` 数组**，标签栏只是照着重画 —— 会话按它记、「关闭左边/右边」按它算、⌃Tab 按它走，只挪 DOM 的话那三处立刻与眼睛看到的对不上；顺序语义单独抽成纯函数 `reorderIds`（`test/tabbar.test.ts`）。⌃Tab / ⌃⇧Tab **走原生菜单项**（窗口菜单，判断 1 的同一条理由：菜单的 `performKeyEquivalent` 排在所有键盘处理之前），到头折回。`#tabbar` 是 `overflow-x:auto`，开到七八个就横着滚，于是 `render()` 末尾把活动标签滚进视口 —— **自己算而不是 `scrollIntoView`**，后者会顺带滚祖先、整页跟着跳一下
- **状态栏回执与撤销删除**（0.2.x，`ui/note.ts` + 契约 v25）：`note()` 从 main.ts 搬出来（粘贴那条路也要用），多了两样：**动作按钮**（撤销 / 在 Finder 中显示，有它时停留 8 秒 —— 一颗按不到的按钮等于没有）和**中性色**（此前整条通道是黄的，因为它只用来说「没成」；现在也说「办成了」，一条黄色的「已复制」会让人以为出了事）。新接上的四处都是「看不见任何变化」的动作：复制为富文本、截图/拖图落盘到 `assets/`、导出 HTML 完成、删除进废纸篓（带撤销）。版本回滚顺带说一句「⌘Z 可撤回」—— 整份文档刚被换掉，不说的话它看起来像一条单行道
- **文件树键盘可达**（0.2.x，`ui/sidebar.ts`）：↑↓ 走行、←→ 收展（收着的目录/文件按 ← 退到父目录）、Enter/双击 打开、**首字母跳**（连按算一个词，停手 800ms 从头算，绕圈找 —— `typeaheadIndex` 是纯函数，`test/sidebar-keys.test.ts` 钉住绕圈那一下）、F2 重命名、**⌘⌫** 进废纸篓（裸 ⌫ 有意不接：删除是这棵树上唯一「按错一个键就没了」的动作）。焦点模型走 **aria-activedescendant**：焦点始终在 `.sb-tree` 这一个元素上，「光标在哪一行」只是它的一个属性 —— 换成「每行一个 tabindex、焦点跟着行走」的话，每次 `render()`（自动保存、外部变更、展开一级）都会把带焦点的元素整个换掉，焦点当场掉回 body，而这棵树重建得非常勤。键盘光标复用 `selected`（它本来就是「新建落到哪个目录」「右键作用在谁身上」的依据，两套光标会立刻打架），**只在树有焦点时画**
- **跳到行**（0.2.x，`ui/goto.ts`）：⌘T 里打 `:120` 跳当前文档第 120 行，`readme:120` 跳那个文件的第 120 行。面板为此多了一个**查询预处理**钩子（`PaletteQuery`）：`:120` 这截不参与模糊匹配（没有哪个文件名里有它，一打冒号整排结果就空），只写行号时**只列这一条**（底下再跟一整排文件只会碍事）；`PaletteItem.run` 现在收得到「选中那一刻输入框里的原串」，行号在那儿兑现。跳转走现成的 `jumpTo`，落点闪一下白拿。解析是纯函数：末尾必须是纯数字（`a:b`、`http://x`、`C:\x` 都不是跳行），`:0` 夹到第 1 行，前导零照收
- **⌥↑/⌥↓ 搬块**（0.2.x，`editor/block-move.ts`）：此前这两个键是 `defaultKeymap` 的 `moveLineUp/Down`，按**源码行**搬 —— 在所见即所得里，「行」几乎从来不是屏幕上那个单位：搬走围栏里的一行等于把图弄碎，搬走分隔行等于把表格拆了。改成「光标在哪个块里就搬哪个块」：列表项里搬那一项（连子项与续行）、其余搬顶层块。**换位按整行来，两块之间的空行原样留在中间**（那一个空行是 Markdown 的语法，跟着某一块走的话搬两次就把两段粘成一段）；**有序列表换完把编号摆回原位**（不重编整份 —— 那会把「从 3 开始」这种写法悄悄改掉）。`resolveInner` 在边界上只朝一个方向看，而光标最常停的行尾/行首恰恰都是边界，所以**两侧各问一遍、谁占着光标那一行谁算数**；多光标与跨块选区一律让开，退回按行搬
- **图片拖角改尺寸**（0.2.x，`widgets.ts` 的 `sizeHandle` + `markdown-lang.ts` 的 `withImageSize`）：尺寸语法 `![图](a.png =600x400)` 在 P1 就通了，但此前只能手写数字 —— 这是最后一件还得回源码去做的常见操作。右下角的手柄与右上角那颗放大镜对称，hover 才露面。**松手才写文档**（拖的过程只改 DOM 的宽高，不碰文档 = 不进撤销栈），于是整段拖拽在历史里是一步，⌘Z 一下回原样；**锁纵横比**，比例取 `naturalWidth/Height`；量的是渲染后的盒子（`max-width:100%` / `max-height:60vh` 压过之后的那个数，写回去的正是屏幕上看到的）。**带标题的图不写**（`![图](a.png "说明")`）：尺寸 + 标题两边解析器都不认，硬写等于把一张好好的图写成裸源码
- **查找命中画在滚动条上**（0.2.x，`editor/scroll-marks.ts`）：长文里「还有几处、都在哪儿」此前只有查找框里一个计数。刻度压在那条 10px 的滚动条槽上（槽本来就是透明的，滑块只有 6px 宽），`pointer-events:none` 才不会把滑块拖不动。三个分寸：**只在查找面板开着时画**（查询串会留在 state 里，面板一关就不该再有刻度）、**内容没超过一屏就不画**、**按高度不按行号**（一张图一张表占的高度远不止一行，按行号折算会和滚动条上的实际位置差出半屏）。读几何与写 DOM 分两段走 `requestMeasure`
- **导出 HTML**（P4-1，`renderer/export/`）：`render.ts` 把**全文**渲染成语义 HTML（纯函数，可单测），`index.ts` 负责两件必须有浏览器的事 —— 先 `loadCodeLangs()` 把文档里用到的围栏语言加载完（language-data 是按需 import 的，不等它代码块整块没颜色），再把 mermaid 烘成**静态 SVG** 灌回占位处；`style.ts` 是内联样式表。**与实时预览共用同一棵语法树和同一批解析函数**（`parseImage` / `calloutAt` / `matchCallout` / `tableDataAt` / `cellTokens` / `fenceParts` / `langLabel` / `INLINE_MARKS` / `collectHeadings` / `slugs`）—— 编辑器只渲染视口而导出渲染全文，两条路径对同一段 markdown 必须是同一种理解，所以这里**一处小解析器都不另写**；`test/export.test.ts` 拿 `buildBlocks()` 的块级装饰逐类对账（表格/公式/mermaid/目录/脚注/告示块数目必须相等）+ 行内拿 `plainInline()` 对账 + 一份 golden 快照（`UPDATE_GOLDEN=1` 重录）。三处**有意与编辑器不同**：① 公式走 **MathML**（KaTeX 的 HTML 输出要额外背 1 MB 字体，单文件导出划不来）；② 裸 HTML **一律转义**（编辑器就是这么显示的，所见即所得；顺带也就没有「导出的文件被文档里的脚本接管」这回事）；③ 折叠态一律摊开。样式**只有浅色一套且钉死**（导出物会进别人的浏览器、会被打印、还要给 P4-2 的真分页当地基，跟着阅读者的系统外观走 = 同一份文档两个样子；现在的 PDF 导出钉浅色是同一个道理）。`javascript:` / 非图片 `data:` 链接只留文字。**连着摞的脚注定义并进同一个 `.footnotes` 区**（它自带 2em 上边距和一道上边框，一条一个容器就在文末摞出好几道分隔线）—— 合并在 `blocks()` 里，按相邻的 `FootnoteDefinition` 兄弟节点攒一串。**已知**：脚注定义里的行内语法不渲染 —— 解析器把 `FootnoteDefinition` 整块当叶子节点（没有行内子节点），编辑器里也一样，要改得先改解析器

- **导出 PDF**（P4-2，`main.swift` 的 `PDFPrinter`）：**PDF = 打印 P4-1 的那份导出 HTML**（壳向渲染层要 `window.__cursive.exportHtmlSource()`，把本地图片嵌成 data: URI，装进离屏 webView 打印），不再自己渲染一遍编辑器 —— 两条导出路径长相永远一致，老那段 printCSS（里面抄了一份 base.css 浅色 token）连同 `WKPDFConfiguration` 一起删了。纸张 / 页边距 / 分页归**壳侧 `NSPrintInfo` 一处管**，导出 CSS 刻意不写 `@page { size }`（两处各说一套时 WebKit 行为没有定义）；保存面板上一块附件选 A4/Letter、三档页边距、要不要页码（选择记 UserDefaults）。页码走 PDFKit 的 **freeText 注记**盖在下页边距里，不重绘整页（重绘会把链接注记一起丢掉）。**四条铁律**（每一条都能让结果「时好时坏」，全写在 `PDFPrinter` 的注释里）：① **绝不用 `op.run()`** —— 它堵死主线程，而 WKWebView 的分页是 web 进程异步回报的，回报进不来就无穷无尽地要下一页，实测 20 秒写出 1.8 GB 的 PDF；正解是 `runModal(for:delegate:didRun:)`；② web view **必须挂在真窗口上**（`runModal(for:)` 要宿主窗口），摆到屏幕外 + `orderBack` 就看不见；③ **开印前一个字都别问打印视图** —— 为打日志调一次 `knowsPageRange` 就会把这次打印搅坏（随机空白页，三次错两次），这条最阴，它让前两条看着全是偶发；④ 等版面稳定用 `setTimeout` **不能用 rAF**（离屏窗口 `visibilityState: 'hidden'`，rAF 一次都不回调 —— 同 P3-8 打字机那个坑）

## 决策记录（2026-09-11）

- 只做 macOS，不做跨平台
- 不引入 Rust/Tauri
- 壳 = Swift + AppKit + WKWebView；原型在 `shell-swift/main.swift`，已探针验证渲染进程完整启动
- **P0-4 已完成**：删除 `src/main` / `src/preload` / electron 系依赖与配置，构建只走根目录 `vite.config.ts`（root=`src/renderer`，base=`./`，output=`out/renderer`）；`electron-vite.config.ts`、`electron-builder.config.cjs`、electron/electron-store/electron-vite/electron-builder 均已移除。`package.json` 无 `main` 字段，`npm run build` = `vite build`

## 架构与契约

- 渲染进程：`src/renderer`，产物 `out/renderer`，纯 CodeMirror 6 —— **构建链里没有 Electron/Node 依赖**，原生能力一律经 `window.api`
- IPC 契约 = `window.api`（签名见 `src/shared/types.ts` 的 `CursiveApi`），壳侧 1:1 实现：
  - 契约 v32（0.4.1 文件树自动刷新）：`watchDirs(paths)` + `onDirChanged(path)`。渲染层报上来「树里**缓存着**哪几级目录」（树根 + 每一个已经读进来的目录，`ui/sidebar.ts` 的 `watchPaths`），壳给每一级挂一个 kqueue（`watchDir`，与「打开着的文档」那张 `watchers` **分两张表**放：两边的集合各自更新、报的也是两个事件）；哪一级的**条目**变了就报哪一级的路径回来，渲染层**只重读那一级**（`refreshDir`）—— 不走 `reload()`，那是「根 + 每个展开目录各一次 IPC 还串着等」，接在一条每两秒就可能来一次的事件上太重。四处分寸：① **按「缓存着的」而不是「展开着的」挂监听** —— 懒加载读过的 children 不会再读第二遍，而「完全折叠」有意留着那份缓存，跟着 `expanded` 盯的话，收起来的那几级会在背后悄悄过期，下次展开给人看的是旧的一层；② **300ms 尾部去抖在壳侧**（从 Finder 拷一批文件是一条条到的；用头部节流会把最后几条丢掉 = 树停在半路）；③ **「是不是我们自己写的」不猜** —— 保存走 `atomically: true` = 临时文件 + rename，在目录看来就是条目变了，边打字边自动保存会让当前文档那一级每两秒报一次；挡法是渲染层比对**条目清单**（`sameEntries`，只看名字与是不是目录），一样就连 render 都不做，而**不是**在壳里开一扇「刚写过就不报」的时间窗 —— 那种窗猜错一次就是丢一次真的外部变更；④ 换层走 `adoptEntries`，**留住还在的节点连同它们读好的 children** —— 整层重建会让展开着的子树因为 children 回到 null 而当场空掉一片。kqueue 在目录上**不递归**（子目录的动静只有子目录自己那份收得到，所以报的是一整张单子而不是树根一个点），**也不看文件内容**（原地改写一个已经在的文件不吵醒它）。拖拽期间收到的先攒着（树在手底下重建 = 落点行被换掉、拖着的那行还可能消失），松手补刷
  - 契约 v31（0.4.0 图片落脚）：`setImageDir(mode)` —— 图片落到「文档同级 assets/」还是「工作区根 assets/」。真相在渲染层的偏好（`PrefValues.imageDir`），壳只记在内存里（同主题 / 语言）。**为什么壳非知道不可**：粘贴走 `pasteImage`（渲染层发起），而 Finder 拖入是壳自己接的（`onImageDropped`）——后者压根不经过渲染层。两边各判一次迟早一边落文档同级、一边落工作区根，所以落脚与「回给渲染层的相对路径」都收在壳侧 `assetsBaseDir` / `assetRelPath` 一处（落在工作区根时回的就是 `../assets/x.png`）
  - 契约 v30（0.4.0 F2 跨文件替换）：`replaceInFiles(targets, replacement)` + `undoReplaceInFiles(token)`。**全应用改动面最大的一个动作**（一次改几十个没打开过的文件），四条约束全在壳侧：① **只改清单里这些处**，每一处带着搜到时的原文，逐字比对过才动，有一处对不上就**整份跳过**（文件在搜完之后被改过时，按行列硬改会改到别处去 —— 那是最坏的一种损坏，因为它看起来成功了）；② 指纹原样（走 `decodeDoc`/`encodeDoc`，与保存同一条路）；③ 改之前每个文件先留一份版本历史快照（契约 v22 的 `saveSnapshot`，与 `snapshotSave` 通道共用一份实现）；④ 壳侧留着改前那几份，`undoReplaceInFiles` 原样写回 —— 状态栏那颗 8 秒撤销。行列坐标与 `SearchHit` 同一套（行 1 起、列按 UTF-16 码元），**同一行多处从右往左改**，否则左边改完右边的列号就失效了
  - 契约 v29（0.3.0 T4 停用自定义皮肤）：`ViewFlags` 多一个 `customOff`（勾上 = 皮肤停着），配套菜单动作 `view:disable-custom-theme` 与偏好字段 `PrefValues.customOff`。**安全出口**：皮肤是叠在内置主题后面的一整张 CSS，一条 `.cm-content{display:none}` 就能把编辑器变成一片空白，而设置面板 / 命令面板 / 状态栏全在同一张 CSS 底下 —— 能按到的入口一起没了。原生菜单不受页面 CSS 影响（判断 1 的直接受益），所以这条开关只能摆在那儿。**状态进偏好而不是会话级**（花了一次就别让它下次重开再花一遍），而且**不置空 `custom`** —— 那会忘掉选的是哪一张，改好 CSS 之后回不去。顺带补了两句此前彻底静默的话：皮肤读不到、以及挂上去之后 `cssRules.length === 0`（CSS 写坏了）
  - 契约 v28（0.3.0 T3 导出为长图）：`exportPng(html, name, width)` —— 与导出 HTML **同一份** HTML 进壳（三条导出的长相必须永远一致），壳侧走离屏 WKWebView + `takeSnapshot`，形状照抄 `PDFPrinter`（挂一个摆到屏幕外的窗口，等 `document.fonts.ready` 与图片 `decode()` 再按快门）。三处要记住：① **视图要撑到整篇那么高**（WebKit 按视图 bounds 排版绘制，不撑开就只截到第一屏，而那张图看起来是「完整」的）；② 导出 CSS 的 `padding-bottom: 30vh` 是为滚动留的余量，在整篇高的视口里会变成一条几百像素的白边 —— 快门前注一句 `.cursive-doc{padding-bottom:48px}` 盖掉；③ **2 倍图要除回 backing scale**：`snapshotWidth` 的单位是点，出来的位图还要再乘一次屏幕缩放，不除的话 Retina 上是 4 倍。高度上限 32768 px 是量出来的取舍（WebKit 再高就截，截了还不报错），超了只出前面那些并明说
  - 契约 v27（0.3.0 T2 检查更新）：`checkUpdate()` —— **只在用户点那一下联网**，壳拉一次 `api.github.com/repos/lawrence1912/cursive/releases/latest`，回 `{ current, latest, url }`。三处有意收窄：① **响应里只取 `tag_name`**，`url` 是壳自己拼的常量（`releases/latest` 那一页）——响应里的 `html_url` 一个字节都不进来，于是「网络说去哪儿就去哪儿」这条路根本不存在；② 不带 token / cookie / 任何标识，也不吃缓存（`reloadIgnoringLocalCacheData`，否则第二次点击原地复读）；③ **404 与「连不上」分开**：404 = 问着了、那边一个 release 都没有（打了 tag 不等于发了 release，这个仓库在第一次发版之前一直是这一种），壳回 `latest: null`，渲染层说「还没有发布版本」且**不用黄色** —— 说成「连不上」就是在冤枉网络。**联网的必须是壳**：页面的 CSP 是 `default-src 'self'`，`fetch` 根本出不去，而为一颗按钮把整张网页的出网口开开，代价远大于这条通道。比版本（`ui/update.ts` 的 `compareVersions`，纯函数 + `test/update.test.ts`）与措辞都在渲染层；壳侧走 `URLSession.dataTask` 而**不是** `await URLSession.data(for:)` —— x86_64 那一片是 `-runtime-compatibility-version none` 编的，`compile.sh` 那道并发 guard 会当场拦下
  - 契约 v26（0.2.x 顶栏合并）：`setTitlebarHoles(holes)` —— 渲染层把「窗口顶边那一条上，哪几段不归原生拖拽条」量好报上来（CSS px 的 `[左, 右]`，壳按 `pageZoom` 换成点）。正文的标签顶到最上面之后，要放行的段数与位置跟着标签数 / 窗口宽度 / 面板显隐一起变，壳里再写死区间就对不上了。**方向只能是页面 → 壳**：`hitTest` 是同步的，`evaluateJavaScript` 是异步的，鼠标按下那一刻壳问不出答案。算法与合帧去重在 `ui/drag-holes.ts`（纯函数 + `test/drag-holes.test.ts`），上报挂在 `syncStatus()`（标签重画）、`syncTitlebar()`（面板显隐）、`resize`（含缩放）与标签栏横向滚动这四处
  - 契约 v25（0.2.x 撤销删除）：`trashItem(path)` 的返回值从 `boolean` 换成 **`{ trashed } | null`** —— `trashed` 是它在废纸篓里的落点（`trashItem(at:resultingItemURL:)` 给的那个 URL，同名冲突时系统会改名，**只有壳知道它最后叫什么**）；配套新增 `restoreItem(trashed, to)` 把它挪回原处。补的是「删除是这个应用里唯一点一下就没了的动作，而唯一的反悔路径是自己去废纸篓翻」这个洞：现在状态栏那条回执里有一颗**撤销**（8 秒）。壳侧两道闸方向相反：源头**必须真的在废纸篓里**（路径里有 `/.Trash/` 或 `/.Trashes/` 那一节 —— `safeTarget` 在这儿用不上，废纸篓本来就不在树根底下），落点照旧过 `safeTarget` 且**此刻必须不存在** —— 删掉之后又新建了同名文件时宁可撤不回来（回 false，渲染层明说），也不能悄悄盖掉那个新文件。`test/bridge.test.ts` 新增两条对账：契约里宣称的每个方法桥上都有、桥上每个 `call()` 壳侧都有对应的 `case`（后者漏一条的表现是「promise 永远不 resolve」，最难查）
  - 契约 v24（0.2.x 自检标记）：`window.__cursiveSelfCheck` —— 壳**只在 `CURSIVE_SMOKE` 下**于 `atDocumentStart` 注入（同 v18 那条注入路），平时这个属性根本不存在。渲染层据此关掉一切「把上次的样子恢复出来」的行为（当前是**会话恢复**）。理由与壳侧 `lastFolder` 在 smokeAuto 下短路是同一条：自检要的是一个**确定的**起点，恢复出来的标签会让「开了几个标签 / 大纲几行 / 快速打开列几个文件」这类断言跟着上一轮的残留飘，而探针改文档是常态 —— 恢复出来的那几份会被一并改写
  - 契约 v23（0.2.0 链接跳转）：`openExternal(url)` 从 `Promise<void>` 变成 **`Promise<boolean>`** —— 回的是 `NSWorkspace.open` 的返回值，也就是「系统真的接手了吗」。地址不合法、本地文件已经不在了都会是 false，渲染层据此在状态栏说一句「打不开」。不回这个的话，一次失败的点击与成功的长得一模一样。**自检下不真的唤起浏览器**：只把地址记进 `smokeExternal`（同契约 v20 不碰剪贴板的理由），E2E 靠它断言「外部地址与 `file://` 都交对了」。**但本地文件仍按「在不在」回话** —— 替身一律回 true 的话，「打不开」那条路在 E2E 里永远走不到，等于没测
  - 契约 v22（0.2.0 版本历史）：`snapshotSave(path, content)` / `snapshotList(path)` / `snapshotRead(path, id)` —— 每次**写进真实路径**之后留一份快照，落在 `~/Library/Application Support/cursive/history/<路径摘要>/<毫秒时间戳>.md`（摘要 = 路径的 SHA-256 前 16 个十六进制字符；**不能拿路径当目录名**，里面有 `/` 还可能超过文件名上限）。三条约束全在壳侧，渲染层只发一次请求：**去重**（与最新那份逐字节相同就不写 —— 自动保存每两秒就可能触发一次同样的内容）、**留存上限**（最近 50 条且 30 天内，但至少保住 10 条；两个条件是「或」不是「且」）、**只认带路径的文档**（未命名的归 scratch 管，那是崩溃恢复不是版本）。`snapshotRead` 的 id 直接拼进路径，所以**只允许纯数字**（时间戳）挡穿越。恢复由渲染层做成**一次普通编辑**（整份替换进 EditorView），于是 ⌘Z 撤得回、保存零损耗那条红线也不受影响
  - 契约 v21（0.2.0 文件索引）：`listFiles(root)` —— 快速打开（⌘T）要的那份清单。**遍历在壳侧做**（判断 3 同款理由：渲染层递归 `readDir` 是几百次桥调用），目录黑名单与后缀白名单与跨文件搜索**共用** `DocScan`（各写一份的话，搜得到却打不开是最难自查的那种不一致）。上限 4000 条；走 `DispatchQueue.global` 而**不占 `searchQueue`** —— 那条队列是串行的，索引挂上去会把用户正在打字的跨文件搜索顶掉
  - 契约 v20（0.2.0 复制为富文本）：`copyHtml(html, plain)` —— 正文仍由渲染层渲染（与 P4-1 导出、P4-2 打印**共用同一棵语法树**），壳只负责放上 `NSPasteboard`。**两种风味一起放**：`.html` 给邮件 / 飞书 / Notion，`.string` 放 Markdown 源码给终端 / 代码框（只放 html 的话纯文本目标收到的是一堆标签）。有选区就只导选区 —— 现造一个 EditorState 交给同一个渲染器，没有第二套局部渲染逻辑。**自检下不碰剪贴板**（E2E 是开发者在自己机器上跑的），只把两个长度记进 `smokeCopyHtml`
  - 契约 v17（跨窗口偏好同步）：`syncPrefs(values)` + `onPrefsChanged` —— **壳既不读内容也不持久化，只当一条总线**：收到就原样转给`除发起者以外`的窗口（`AppDelegate.broadcastPrefs(_:except:)`）。补的是 v13 那句「窗口之间除了 localStorage 全无共享状态」留下的洞 —— localStorage 是共享的**存储**、不是共享的**通知**，各窗口启动时各读一份进内存，之后谁改了只有谁自己知道。而原生那半偏偏是 **app 级**的：`setAppearance` 设的 `NSApp.appearance` 一次管所有窗口，于是 A 窗切深色，B 窗当场变成**「标题栏是深的、正文是浅的」**（B 恰好停在「跟随系统」时会歪打正着跟上 —— 这让它更难复现）。语言、字号、行距、栏宽、皮肤是同一个洞。收端 `Prefs.adopt()` 的三条「不做」是全部要害：**不落盘**（发起窗口已经写过，再写可能盖掉第三个窗口更新的那份）、**不回广播**（否则两窗互推转圈，所以它走 `paint()` 而不是任何会 `commit()` 的路）、**不重推 `setAppearance`**（那是 app 级的，发起窗口推过了）。发端收在 `Prefs.commit()` 一处 = 「落盘 + 广播」，所有改动都从那儿过，漏不掉。**没有启动竞态**：`commit()` 先写 localStorage 再广播，而新窗口的 `load()` 与 `onPrefsChanged` 注册同在 main.ts 那一次同步执行里 —— 广播要么早到（被丢掉，但随后的 `load()` 读到的已经是新值），要么晚到（监听已就位）
  - 契约 v16（界面语言）：`setLanguage(lang)` —— **真相在渲染层** localStorage `cursive.prefs.lang`，壳不持久化：启动时被推一次、用户切换时再推一次。壳收到后把 `uiLangIdx` 翻过去并整份重建菜单栏（`buildMenu()` 可重入），NSAlert/NSOpenPanel 的文案每次弹出现查（`L(key)`/`LF(key, args)` 查 `SHELL_TEXT` 表），天然跟随。**壳侧文案表与渲染层字典各自维护**（菜单措辞本来就是另一套），key 互不引用
  - 契约 v15（P4-1 导出 HTML）：`exportHtml(html, defaultName)` —— **正文由渲染层渲染**（`renderer/export/`，与实时预览同一棵语法树），壳只管保存面板（带一颗「嵌入图片（单文件）」复选框，默认勾上）和把 `<img src="…" data-abs="/绝对/路径">` 换成 data: URI。**图片字节不过 IPC 桥**（判断 3）：渲染层只在属性里写清楚去哪儿取，读盘与 base64 在壳侧。`data-abs` 里的路径是文档里原样的写法（可能带百分号编码），壳按 `FileSchemeHandler` 同款**逐级解码**去找文件；单张超 16 MB 不嵌。自检下（`CURSIVE_SMOKE`）绕过保存面板，落到 `CURSIVE_SMOKE_HTML` 指的路径
  - 契约 v14（打开文件夹 = 新窗口）：`newWindow(path?)` —— 带路径就让新窗口直接落在那个**文件或文件夹**上。文件夹那条会在窗口建好的当场把 `treeRoot` 钉上（防穿越守卫要用，不能等渲染层就绪），渲染层就绪后再收到 `folder:opened`
  - 契约 v13（P3-7 多窗口）：`newWindow()` —— 壳自己开窗口。菜单里的「新建窗口」走 `#selector`，**不绕菜单通道**（壳能直接开，没必要往返一趟渲染层）
  - 契约 v12（P3-4 自定义皮肤）：`userThemes()` —— 扫 `~/Library/Application Support/cursive/themes/*.css`，整份 CSS 一起回来（皮肤文件就几 KB，不值得再开一条读文件通道）。选中的那份以 `<style id="user-theme">` **叠在内置主题之后**，不是替换；页面 CSP 是 `style-src 'self' 'unsafe-inline'`，`<style>` 元素本身允许
  - 契约 v11（P3-2 跨文件搜索）：`searchFiles(token, root, query, opts)` 立刻返回，结果经 `search:hits` 分批 + `search:done` 收尾推回；`cancelSearch(token)`。壳侧 `OperationQueue`（串行），新搜索先 `cancelAllOperations`
  - 契约 v10（P3-1 收尾）：`renameItem(path)`（新名字同样由壳弹原生输入框问，预填旧名；自检下取 `CURSIVE_SMOKE_RENAME`，**不能与新建那个环境变量共用** —— 同名会被判成「没改」直接返回 null）、`moveItem(src, destDir)`、`revealInFinder(path)`。三者都过 `safeTarget`
  - 契约 v9（P3-6 复制本节锚点）：`writeClipboardText(text)` —— 与读那条同源，剪贴板归壳管。**`navigator.clipboard` 在 `app://r` 下不是安全上下文**，压根拿不到，别绕那条路
  - 契约 v8（P3-3 视图开关勾选态）：`setViewFlags({sidebar,outline,formatBar,source,focus,typewriter})` —— 开关状态全在渲染层 localStorage，壳的菜单自己不知道，每次切换推一次，菜单项才打得出勾
  - 契约 v7（P3-1 文件树读写）：`createFile(dir)` / `createFolder(dir)` —— 名字由壳弹原生输入框问，重名加 `-2`；`trashItem(path)` —— 进废纸篓（可找回），壳侧先弹确认。三者都过 `safeTarget` 防穿越
  - invoke：`openDialog` / `read` / `save` / `saveAs` / `confirmDiscard` / `openExternal` / `pickFolder` / `readDir` / `createFile` / `createFolder` / `trashItem` / `lastFolder` / `setAppearance`
  - send：`setDocState` / `confirmClose`
  - 壳→渲染推送：`menu` / `file:opened` / `folder:opened`
- 菜单动作字符串（真相在 `src/shared/types.ts` 的 `MenuAction`）：`file:new` `file:open` `file:save` `file:save-as` `file:save-and-close` `file:close-tab` `file:open-folder` `file:export-html` `edit:find` `edit:replace` `edit:find-in-files` `view:toggle-source` `view:toggle-sidebar` `view:toggle-outline` `view:toggle-format-bar` `view:toggle-focus` `view:toggle-typewriter` `view:theme-system` `view:theme-light` `view:theme-dark` `view:theme-sepia` `view:toggle-dark` `app:preferences`
- **主题与排版偏好**：真相在渲染层 localStorage `cursive.prefs`（`ui/prefs.ts`）。CSS 只认 `data-theme="light|dark|sepia"` 这几个确定值，`system` 由 matchMedia 解析后钉上去；`base.css` 里那份媒体查询只兜首帧（CSP 禁内联脚本，抢不到更早时机），**暗色 token 两份必须同步改**。护眼（`sepia`）是**第三套确定 token**，算在浅色一侧（`setAppearance` 给壳的是 `.aqua`），只覆写变量、组件样式一条不改 —— 这正是当初把颜色全收进变量的回报；媒体查询那份要写成 `:root:not([data-theme="light"]):not([data-theme="sepia"])`，否则系统暗色下选护眼会被它压回深色。切主题会调 `setAppearance` 让壳设 `NSApp.appearance` —— 不设的话标题栏/红绿灯/NSAlert/NSOpenPanel 还是系统色，切一半很违和。字号/行距改完必须 `view.requestMeasure()`，否则 CodeMirror 缓存的字符尺寸是过期的
- **界面语言**（中英双语，真相与主题同处）：`src/renderer/i18n/` —— `zh.ts` 是 **key 清单的真相源**，`en.ts` 类型为 `Record<Key, string>`，中文加了条目英文没跟上 typecheck 直接红。入口在设置面板「语言」分段控件（语言选项各自以自身语言显示）。**三层机制**：① 静态 chrome（innerHTML 一次构建的面板/工具栏）用 `data-i18n` 系属性声明文案（四种：`data-i18n` / `-title` / `-ph` / `-aria`，外加 `data-i18n-args`；**没有 innerHTML 那一路**，一律 textContent / setAttribute），`applyI18n()` 幂等重翻 —— 构建后跑一次、切语言时 `setLang()` 全局重跑；② 动态字符串（状态栏消息/右键菜单/widget）在构建点直接 `t()`，`main.ts` 的 langchange 订阅者重刷状态栏各行/光标行列/标签栏/格式栏/大纲/统计，`syncMode()` 顺手把活动标签的块级装饰整体重建（TOC 标题/表格工具栏/代码语言条），**冻结标签不用管** —— 重新激活时 `activate()` → `syncMode()` 自会重建；自己拿不到 main.ts 那份订阅的（侧栏、跨文件搜索面板、查找面板）各自 `onLangChange`；③ 快捷键后缀拼进 title 的（标题栏/侧栏工具栏按钮）走显式 relabel，data-i18n 表达不了 `标签 (⌘X)` 这种组合。**默认语言**：偏好记过 `lang` 听偏好；有偏好但没记过（老用户）保持中文；全新安装跟随系统语言 —— `detectLang()`（先看偏好）与 `systemLang()`（只看系统）是两个函数，**`ui/prefs.ts` 的 DEFAULTS.lang 必须用后者**，用前者的话「默认」等于「本次启动时的语言」，恢复默认改不动语言。**边界**：callout 类型名（笔记/提示…）是 Markdown 方言的渲染内容、代码语言显示名（TypeScript 等专有名词）、产品名 Cursive 都不随界面语言切。**代码侧的四个坑**：① `applyI18n(root?)` 的 root 不能写成默认参数 `= document` —— node 单测里那个标识符不存在，求值默认值直接 ReferenceError；而且它走的是 `querySelectorAll`，**选不中 root 本身**，根元素上的 `data-i18n-*` 只能靠切语言时那次全局 `applyI18n()` 生效。② Node ≥21 有 `navigator.language`，判「在不在浏览器里」只能看 `typeof localStorage === 'undefined'`。③ 语言名缓存（`langLabel` 的 labelCache）键里要带当前语言，否则切语言后条子还挂着旧名字。④ **凡是「由某个事件顺手刷出来」的文案都要在 langchange 里点名**：`syncCursor`/`syncFormatBar` 挂在 updateListener 的 `docChanged || selectionSet` 分支上，而 `syncMode()` 派的是一次 reconfigure（两者皆假），漏了就会一直留着旧语言直到用户碰一下光标；同理 `EditorState.phrases`（CodeMirror 查找的读屏播报）是**建 state 时钉进配置**的，写成 `{ k: t(...) }` 会让已开着的标签念旧文案 —— `setup.ts` 的 `SEARCH_PHRASES` 因此写成取值器（`state.phrase()` 每次 `map[key]` 现取，getter 天然跟着 `t()` 走，连 reconfigure 都不用）。跨文件搜索的状态行同理**存状态不存字符串**（`Status` 联合类型），否则切语言说不出「12 处 · 3 个文件」那句话
- **代码块语法高亮**：解析侧是 `markdown-lang.ts` 的 `codeLanguages: resolveCodeLang`（@codemirror/language-data 按需动态 import，`app://r` 服务得了这些 chunk；**名字匹配之上补了一条后缀兜底** —— `py`/`yml`/`rs`/`kt` 这些最常写的简称在 language-data 里只登记成扩展名、没进 alias，`matchLanguageName` 一概认不出来，```py 因此整块没颜色。条子上显示的语言名走的**就是这同一次解析**，两边各判各的迟早会出现「写着 Python 却没有颜色」）；上色侧是 `theme.ts` 的 `markdownHighlight`。两侧都通才有颜色，而**只有上色侧缺 tag 时不报错、只是「看起来很素」**——历史上就只配了 keyword/string/number/comment/function/typeName 六条，结果 yaml·json 的键（`propertyName`）、css 的属性/选择器（`propertyName`/`className`/`atom`）、diff 的增删（`inserted`/`deleted`）、bash 的参数（`propertyName`）全落空，这五种块整块是纯文本色。加语言前先确认它发的是什么 tag（`highlightTree(tree, classHighlighter, …)` 打一遍就知道）。颜色一律走 `--hl-*` 变量（base.css 三处同步），**不许写死 hex** —— `test/highlight.test.ts` 会检查生成的 CSS 里没有 hex。`labelName` 故意不涂：它在 markdown 层就是围栏行上的语言名（`` ```ts `` 里的 ts），那行要压到最轻
- **代码块的围栏与语言条**（`editor/live-preview/code.ts` + `decorate.ts` 的 `decorateFence`）：开围栏那一行**整行换成一条语言条**（左边语言名、右边复制），闭围栏那一行内容藏掉、行高压成 5px 当卡片的下边距。当年「藏了会剩个空行更难看」说的就是闭围栏那一行 —— 解法不是让 ``` 一直露着，是把那个空行变成边距。**回显粒度是每条围栏行各算各的**（不是整块 reveal）：光标在代码体里敲字时围栏保持藏着（卡片不会一边打字一边抽动），复制按钮也一直够得着；光标落在围栏行上才回显 ```` ```ts ```` 源码去改。语言名是**给人看的名字**（`ts` → TypeScript，没写 → 纯文本，认不出来 → 原样显示 = 「这块没有高亮」），点它弹**语言选择器**（筛选框 + language-data 全量候选，**只列真会上色的语言**）；选中 = 一次 dispatch 只改围栏行上那个词（`fenceLangSpec`，纯函数，一步撤销，围栏行后面的参数如 `title=a.js` 原样留着）。围栏拆解 `fenceParts` **走子节点不走行首正则** —— 引用块里的代码块行首那截 `> ` 是 QuoteMark 兄弟节点，正则匹配会漏掉闭围栏。widget **不存代码正文**（存了的话块里每敲一个字 `eq()` 就不成立、整条 DOM 重建、「已复制」被冲掉），要用时按 `posAtDOM` 现查语法树
- **文档内查找替换**（`editor/search-panel.ts`，替掉 @codemirror/search 的默认面板）：**右上角浮层**，不再贴底通栏 —— 底部那条格式栏于是不用再量着查找条的高度往上让（`syncFormatBarOffset` 整个删了），正文也不被顶走。输入框/选项键复用跨文件搜索那套 `.fs-box` / `.fs-opts`（放大镜 + Aa / ab| / .*），两个「查找」终于长得像一对兄弟；计数 `3/12` 画在框里，状态栏那条「第 3 处 / 共 12 处」还在（`searchStat` 一份算完两处用，按 EditorState 缓存，上限 5000 处）。**查询走 `input` 事件 + 组字期间不提交** —— 默认面板只认 change/keyup，中文边打边搜会拿拼音中间态去查。替换那行默认收着（**⌥⌘R** 或左边三角展开，状态记 localStorage；不是 macOS 标准的 ⌥⌘F —— 那个键位归专注模式，编辑菜单排在视图菜单前面，写了就等于把它抢走）。**`.cm-panels` 必须 `height:0 + overflow:visible`**：CM 的面板插件按容器实测高度报一份**通栏** `scrollMargins`，而这块浮层压根不盖正文那一栏 —— 不归零的话打字机模式的「光标行停在 42%」会被顶下去 12%（E2E 的 `writingProbe.ratio` 当场变 0.55）
- 文件读写必须走 `src/shared/textfile.ts` 的 BOM/EOL 指纹逻辑（Swift 侧已移植为 `decodeDoc`/`encodeDoc`），保证「保存零损耗」

## 自定义协议（两个，缺一不可）—— ✅ 已实现

1. **`app://r/<相对路径>`** → 服务 `out/renderer` 静态资源。原因：`<script type="module" crossorigin>` 在 WKWebView 的 `file://` 下因 opaque origin **静默失败**。壳已实现 `FileSchemeHandler`（含路径穿越防护）。
2. **`safe-file://local/<绝对路径>`** → Markdown 图片加载。渲染层由 `src/renderer/editor/live-preview/decorate.ts` 生成这种 URL。壳侧已实现，**E2E 验证中文/空格文件名图片可加载**。

## 契约 v2（P0 自动保存 / 崩溃恢复 / 外部变更）

- `CursiveApi` 新增：`scratchSave(id,content,fp)`（无路径文档静默写
  `~/Library/Application Support/cursive/scratch/<id>.json`）、`scratchList()`、
  `scratchClear(id)`、`confirmReload(name) → 'reload'|'keep'`、`openTabs(paths)`
  （壳据此注册外部变更监听）；推送通道新增 `file:changed-externally(path)`
- **崩溃恢复不许抢焦点**：`scratchList()` 是异步的，而 argv/Finder 那份文件是壳轮询 `__cursive` 就绪后推过来的 —— 谁先到都有可能。恢复前先记下「活动标签是否已有路径」，spawnTab 完再 `activate` 回去；另外过滤启动空白页之后必须校正 `activeId`，否则它悬空 → 后续 `activate()` 既不冻结旧 state 也不更新 `docPath`，状态栏会一直挂着一个已经不存在的文件名（真出现过：三个标签 + 状态栏显示另一个文件）
- 自动保存：停止输入 2s / 切标签 / 失焦时静默落盘，**必须走 encodeDoc 指纹路径**
  （E2E 验证字节级一致）；无路径文档进 scratch；真正保存/关闭时清 scratch
- 外部变更：壳侧 DispatchSource 监听 openTabs 的所有路径；
  **rename/delete 后必须重开重注册**（rename-replace 保存会让 fd 失效，事件只来一次）；
  0.8s 节流。渲染层收到后：与磁盘一致（自己的自动保存触发）→ 忽略；
  干净 → 静默重载保留滚动/光标；脏 → confirmReload 弹窗；非活动标签脏 → 标记 ⚠ 失效
- 已知坑：Swift 三引号字符串里的 `\n` 是真实换行 —— 拼进 JS 字符串字面量会变成
  跨行语法错误（callAsyncJavaScript 报 "A JavaScript exception occurred" 且
  try/catch 接不住，因为是 parse 错误）。要写 `\\n`

## 已踩坑（勿再踩）

- **sheet 挂在离屏窗口上 = 「点了卡住」**（0.4.0 真打印机）。`PDFPrinter` 为了让 WebKit
  肯渲染，把 web view 挂在一只 x = -30000 的离屏窗口上（铁律 2）。导出那条不弹面板，
  所以一直没事；**打印那条要弹系统打印面板，而 `runModal(for:)` 的面板是 sheet** ——
  挂到那只离屏窗口上，面板与进度条就都在屏幕外，模态会话却开着：症状是 ⌘P 之后整个 app
  不响应。改法：宿主传**看得见的主窗口**，并把 `showsProgressPanel` 关掉。
  （凡是 `runModal(for:)` / `beginSheet` 都得先问一句「这只窗口在屏幕上吗」。）

- **「编辑态一动就清」会让刚插进来的表格当场回落源码**（0.4.0 修）。`tableEditField`
  从前是「`tr.docChanged || tr.selection` 一律清」，而 `/table` 插出来的新表正是靠
  `setTableEdit` 才以渲染态出现、光标还在第一格里 —— 插完之后必然还有别的事务
  （滚动、聚焦、按一下键），编辑态于是活不过一帧，表格变回 `| --- |` 的源码。
  改法：**只在光标真的离开这张表时才退出**（`editStillLive`）。
  教训是「什么时候退出一个态」要按**语义**判（人还在不在这张表里），不是按「有没有事务」。

- **Foundation 读文件会把 BOM 吃掉**（0.4.0 修，红线一上的一个洞）。
  `String(contentsOfFile:encoding:.utf8)` 把开头那三个字节当编码标记**直接吞掉**，
  于是 `decodeDoc` 永远看不见 BOM、指纹里 `bom` 恒为 false —— **打开一个带 BOM 的文件再保存，
  那三个字节就没了**。`test/textfile.test.ts` 测的是 TS 那份实现，壳这边的读盘从来没被 E2E 盖过
  （`bom.md` 不在用例表里，而那份夹具自己都没有 BOM，只有一行不知哪轮 E2E 写进去的 marker）。
  - **改法**：壳侧读文档一律走 `readRawDoc`（自己读 Data、自己认 BOM），并把 `bom.md` 修成
    真带 BOM 的夹具、加进 `release.sh` 的用例表 —— 通用断言里的 `bytesEqual` 就够守住它。
  - **有意不动的那一处**：跨文件搜索仍用会吃掉 BOM 的那条读法。搜索报的是行列，
    而替换是在 `decodeDoc` **之后**（同样不含 BOM）的文本上按行列定位的，两边都不含才对得齐。

- **E2E 探针改文档超过一秒，就会撞上 2s 的自动保存**（0.4.0 F3 撞到）。
  补全那几发探测前后插了一秒多的临时文字，防抖正好落在中间时，临时文字被写进夹具，
  `bytesEqual` 于是偶发变红 —— 而失败点（「往返不相等」）离真因（「补全探针没收干净」）很远。
  **改法**：探完立刻 `await window.api.save(path, sampled, doc.fingerprint)` 再走下一步，
  与主探针那步「收干净」同一个办法。凡是会让文档离开取样态超过半秒的探针，都得自己收尾。

- **Swift 多行串里的 `\n` 与 `\a`**（0.4.0 F3 又踩了一次，这次是新形状）。
  上面那条「注入的 JS 要写 `\\n`」说的是字符串**值**；这次栽在两处新地方：
  ① JS 代码里的 `'\n'` 写成单反斜杠 → Swift 直接变成真换行 → **JS 字符串跨行 = 解析错误**，
  报出来是 `A JavaScript exception occurred`，try/catch 接不住（parse 错误）；
  ② **注释里**写 `\al` → Swift 编译期就报 `invalid escape sequence`（注释也在字符串里）。
  认它的线索：E2E 只跑了 7 秒就退出、`result` 整个不见、check.json 却一切正常（渲染层是活的）。

- **自检的窗口大小一直是「碰巧」确定的**（0.3.0 T5 撞出来）。E2E 里有一批断言是**视口敏感**的 ——
  块级装饰只给视口里的块建（0.2.x 增量化的设计），窗口一大一小，数出来的东西就不一样。
  而窗口大小从前来自 `setFrameAutosaveName("Main")` 恢复的那份**开发机上的记忆**（这台机器上恰好是
  700×500），代码里的默认值其实是 1080×720。T5 把键改成按工作区分之后，同一台机器上恢复到的
  变成了 1080×720，`mermaid.md` 当场变红：第一张流程图在更宽的窗口里画得更大，
  把第二个 mermaid 块挤出了视口，`.cm-lp-mermaid` 只数到 1 个。
  - **两件事一起改**：自检下**既不恢复也不记住**窗口位置（同 `applyStartupAppearance` 的规矩，
    起点必须确定；顺带也不再把开发机记住的位置改掉）；`mermaid` 那条探针**先把文末滚进视口再数**
    —— 它要的是「两个块都渲染了」，不是「它们恰好同屏」。
  - **教训**：换台机器就红的测试，在自己机器上是绿的。这条与 T1 那次「整条流水线本来就是红的」同源：
    自检里凡是依赖「上次留下的状态」的地方，迟早都会这样。

- **要送到壳里的东西别只押在 rAF 上**（0.3.0 修，`ui/drag-holes.ts`）。
  挖洞区（契约 v26）的上报走 `requestAnimationFrame` 合帧，而**窗口被盖住 / 还没上屏时
  rAF 会被降频甚至根本不回调** —— 与 `warmup.ts` 那条坑同源。后果比预热重得多：
  预热不跑只是慢一点，挖洞区不报，壳退回 `DragStripView.fallbackPasses` 那两段写死的区间，
  **顶栏上的标签一个点击都收不到**，而页面这一侧完全看不出来（rect 照量、元素照画、
  `elementFromPoint` 照样命中）。整条 E2E 停在第一条用例上就是它。
  - **认出它的线索**：`dragGapX` 恰好是 `(trafficEnd+4 + bounds.maxX)/2` ——
    那正是 `firstDraggableX` 在 `holes` 为空时算出来的值。
  - **改法**：rAF 与 `setTimeout` 一起下注，谁先到谁算、另一条当场撤掉
    （看得见时贴着帧走，看不见时 100ms 兜底）。晚报一帧没关系，永远不报是另一回事。
  - **为什么单测拦不住**：`test/drag-holes.test.ts` 只测了纯算法 `holesFrom`，
    `createHoleReporter` 那一半一条断言都没有 —— **算得对 ≠ 送得到**。现在两半都有。

- **`/bin/sh` 里 `$VAR` 紧跟全角 `）` 会被连着吃掉**（0.3.0，`release.sh` / `compile.sh`）。
  `echo "另一片（$OTHER）冒烟"` 打出来是「另一片（▒▒冒烟」，变量和括号一起没了。
  半角 `)` 不会，`${OTHER}` 也不会。中文注释/提示多的脚本里很容易中招，写 `${}` 最省事。

- **CLT 里 Swift 的回退兼容库没有 x86_64 片**（0.3.0 T1，`shell-swift/compile.sh`）。
  macOS 27 的 Command Line Tools 里六个 `libswiftCompatibility*.a` 全是 `arm64 arm64e`，
  交叉编 x86_64 于是在**链接阶段**失败：`Undefined symbols for architecture x86_64:
  __swift_FORCE_LOAD_$_swiftCompatibility56`。报错长得像代码问题，其实是工具链缺片，
  装 Xcode.app 可能有 —— 但「不需要装 Xcode.app」是 README 里的承诺，不为一个链接参数收回去。
  解法：只给 x86_64 那片加 `-runtime-compatibility-version none`。
  **它安全的理由是可验证的**：那批库回退的是 Swift 并发运行时与更老运行时的 bug 修复，
  而壳里一处 Swift 并发都没有（`func … async` / `actor` / `@MainActor` / `Task {` 全为零，
  满屏的 async 是 `DispatchQueue.*.async`，注入 webview 的 JS 字符串里那些 await 不算）。
  `compile.sh` 的 `SWIFT_CONCURRENCY_RE` 就是守这个前提的 —— **一旦往壳里写 Swift 并发，
  表现会极其隐蔽：arm64 一切正常，只有 Intel 机器上出问题，而这儿没有 Intel 机器。**
  - **那条正则第一版写错过**：写成 `async func`。Swift 的语序是 `func f() async`，
    于是 `func probeGuard() async { }` 从 guard 底下整个溜过去。现在认的是 JS 写不出来的形状
    （`\bfunc\b` 不匹配 `function`），13 种真并发写法全中、7 种像并发的写法全不误报。
  - **`lipo -create` 对着一份单架构输入也会「成功」**，所以合完必须当场 `lipo -archs` 断言两片都在：
    一个只有 arm64 的包在 Intel 上的表现是「双击没反应」，出包时一点都看不出来。
  - **`lipo` 里有那一片 ≠ 那一片跑得起来**。`release.sh` 末尾因此多一条：拿**包里那个二进制**
    在 Rosetta 下跑一遍冒烟。但它**代替不了真机** —— Rosetta 用的是本机 macOS 27 的 Swift 运行时，
    而 x86_64 的真实用户跑的是 macOS 12–15 上的老运行时。

- **mousedown 里不许做滚动补偿**（0.2.x，`editor/pointer-selection.ts`）。
  `start()` 开头那句 `this.release()` 是给「上一次手势没能正常收尾」兜底的，可 release
  不只是翻回跟随光标 —— 它还要把视口滚回落点。于是**按下去的那一刻正文先滚了一段**，
  而 `editor/link.ts` 是按坐标反查文档位置的：⌘+点击当场落到别的字上，
  表现为「第一下正常、之后每一下都没反应」。现在 `start()` 只把上一次作废
  （清计时器），滚动补偿留给真正的收尾（mouseup / keydown / blur / pointercancel）。
  E2E 的 links.md 整条红就是它。

- **探针点击要先把目标滚进视口**（0.2.x，`main.swift` 的 `modClick`）。同一条链：
  探针按元素的 `rect` 派事件，而链接处理器按坐标反查位置 —— 元素在视口外时坐标落在
  渲染范围之外，CM 只能把它夹到文末（实测解析到了 `external-append-marker` 那一行）。
  另外两条同源的坑：**取 `getClientRects()[0]` 而不是包围盒**（一行里摞着几条链接时，
  长的那条会折行，包围盒的中点落到第二行、甚至底部悬浮格式栏后面），以及
  **自检要一个确定的起点** —— 大纲的层级档位与状态栏那句回执都是会留下来的状态
  （`cursive.outlineLevel` 在 localStorage 里；回执 4 秒才散），探针中途抛一次异常，
  下一轮就会红在完全无关的地方。

- **PingFang 印出来的 PDF，抽出来的中文不是原来的码位**（0.2.x，`PDFPrinter.GLYPH_FIX`）。
  「长 / 页 / 见 / 车 / 门 / 马」这类字会落在「CJK 部首补充」区（U+2E80–U+2EF3），
  而**那个区没有兼容分解**，NFKC 折不回来 —— PDF 书签于是定位不到那些标题。
  导出跟随字体设置（0.2.x）之后才会走到这条路：衬线那套 Songti 没这毛病。
  表是量出来的（本仓库全部中文的 1340 个不同汉字排成一篇印出来逐字比对），
  重新生成照这个办法。**代价要说清楚**：这类 PDF 在任何阅读器里搜中文也搜不到，
  那是 WebKit 写 ToUnicode 的老毛病，不在这个应用能改的范围内。

- **导出不能吃 `parsedTree` 那条「超预算就退回快照」的路**（0.2.x，`editor/syntax.ts` 的 `primeTree`）。
  `parsedTree` 的最后一句是「`ensureSyntaxTree` 50ms 内没解析完就返回手上那棵半截树」——
  对屏幕上的消费者这是对的（有多少画多少，后台 parse 跟上就补全了），可**导出只有一次机会**：
  `render.ts` 的 `blocks()` 按 `topNode` 的范围走，树短一截，**交出去的那份 HTML/PDF 就少一截**，
  而产物看着完好（外壳齐全、标签闭合），只有翻到末尾才发现文档没了一半。
  真摔过：E2E 的 kitchen-sink 偶发地只导出到代码围栏之前（1005 字的文档只出 428 字节正文），
  同一份文档十次里中一两次 —— 机器越忙越容易。**导出前一律 `primeTree(state)`**（5 秒预算，
  确保到手之后记进同一份缓存，随后 renderBody 里的每次 `parsedTree` 直接命中）。
  `test/export.test.ts` 里有一条「拿不到全长的树画出来的正文真的会短」把这件事钉住。

- **ViewPlugin 的装饰「这轮不重算」时，必须先 `map` 过去**（2026-09-15，`editor/carry.ts`）。
  中文输入法连打时整页往下跳、跳完之后每动一次光标就再炸一次 —— 真因在
  `live-preview/index.ts` 与 `writing-modes.ts` 那两句「组字期间不重算装饰，直接 return」。
  **CM 不替 ViewPlugin 映射装饰**（`StateField` 那边才有 `value.map(tr.changes)`）：
  交出去的那份，它是直接拿去画**当前**这份文档的。而组字期间文档是一直在变的
  （每敲一个拼音字母 `applyDOMChange` 就 dispatch 一次，`view.composing` 同时为真），
  于是光标之后的每一条装饰都偏一位 —— 轻则藏错字符、行样式落到别的行上（行高一变
  视口就往下跳），重则某条替换装饰跨到下一行头上，CM 当场抛
  `Decorations that replace line breaks may not be specified via plugins`，**整个事务被中断**。
  中断之后视图与状态就此对不上：浏览器里实测高度图一瞬间差出 ±3376px，
  之后每移动一次光标都在 CM 内部再炸一次（`Cannot destructure property 'tile'`）。
  **判别口径**：ViewPlugin 里每一条不走重算的 `return`（组字中、鼠标拖选中、将来任何一条）
  都得先过 `carryDecorations()`。删除那一侧不用自己管（`Decoration.line` 的 mapMode 是
  `TrackBefore`、行内替换是 `TrackDel`，`map()` 自己会丢）；要补的只有**插进换行符**那一种。
  单测 `test/carry.test.ts` 把关：去掉 `map` 红 4 条，去掉跨行过滤红 1 条。

- **自检期间人碰键盘 = 夹具被改坏**（2026-09-15，抓到两次实证才定位）。自检的 app 会
  `NSApp.activate(ignoringOtherApps: true)` 抢到最前面，于是**跑 E2E 的那几十秒里，
  键盘上敲的每一下都落进编辑器**：光标在新开文档的 0 位，敲下的字就成了文档第一个字符，
  接着被自动保存写回夹具。症状是 `kitchen-sink.md` 变成 `u---`（front matter 不成立 →
  大纲探针整片崩）、`long.md` 变成 `ge# 长文档…`（标题数 0 → PDF 书签 0）。
  **最难查的地方**：不可复现，而且失败点离真因十万八千里 ——
  报出来的是「大纲降级没生效」「PDF 没有书签」，谁也想不到是有人敲了个字。
  现在 `MainWebView` 在 `smokeAuto` 下把 `keyDown` 与 `performKeyEquivalent` 一并吞掉
  （探针发的是合成事件，不走这条路，吞掉零影响）。
  验证办法：跑自检时用 `osascript -e 'tell application "System Events" to keystroke "ZZZ"'`
  往里灌几个字，夹具应当纹丝不动
- **`swiftc` 的部署目标必须显式写死**（2026-09-15，macOS 27 升级当天现形）。不写 `-target`
  就跟着工具链的默认值走，而那个值**会随系统升级而变**：升到 macOS 27 后，同一套 CLT
  给出的默认 `minos` 跳到了 **28.0**（`sdk` 却还是 26.5）—— 比正在跑的系统还高。
  症状很有迷惑性：**裸跑二进制一切正常**（`./cursive-shell`、`release.sh` 的八个 E2E 全绿，
  因为它们不经 LaunchServices），只有**双击 .app 打不开**，`open` 给的是
  `-10825` = `kLSIncompatibleSystemVersionErr`。
  `otool -l <二进制> | grep -A4 LC_BUILD_VERSION` 一眼看得出来。
  现在 `build.sh` 与 `make-app.sh` 共用 `TARGET=arm64-apple-macos12.0`，
  **必须与 Info.plist 的 `LSMinimumSystemVersion` 和 README 的「macOS 12+」三处一致**。
  顺带查出来一处旧账：`FileSchemeHandler` 用的 `URL.path(percentEncoded:)` 是 macOS 13 才有的，
  也就是说「12+」这个承诺**在此之前一直是假的**（默认部署目标够高，编译器从来没报过）。
  已换成语义相同、10.10 就有的 `URLComponents.percentEncodedPath`
- ⌘C/⌘V 在 WKWebView 不生效，除非应用菜单里有接线的「编辑」菜单（`Selector("cut:")` 等）
- `evaluateJavaScript` 与 `WKUserScript` **不受页面 CSP 限制**（页面 `script-src 'self'` 拦不住注入）
- **didFinish 可能早于渲染层模块执行完**：监听器没注册时 emit `file:opened` 会静默丢失。壳侧轮询 `window.__cursive`（main.js 末尾暴露的就绪标记）就绪后再发射，见 `flushPendingOpen()`
- **WebKit 会对自定义 scheme 的 URL 再做一次百分号编码（`%` → `%25`）**，而渲染层拼 safe-file URL 时已经 encodeURI 过了 → handler 逐级解码：解一次文件不存在就再解一次（对字面 `%` 文件名依然成立）
- 探测图片要用 `.cm-lp-image img`，`.cm-editor img` 会先匹配到 CodeMirror 自己的隐藏占位 `cm-widgetBuffer`（src=null）
- **live-preview 装饰只铺可视视口（设计如此）**：视口外的图片 widget 不存在，滚动到位才建，不是 bug
- **CM6 的 parse 是异步分块的**，且 `update()` 的 docChanged/selectionSet/viewportChanged 都不响应 parse 推进 → 首开长文档时深处节点拿不到树、装饰缺失。修复：`buildDecorations` 里用 `ensureSyntaxTree(state, visEnd + 1000)` 把可视范围强制同步解析到位（有限界，不伤大文档）。（当时 Electron 版也有同款潜在 bug，顺带修了）
- **同款坑的块级版更隐蔽**：`blockField`（表格/公式/mermaid 共用的 StateField）的重建只挂在 docChanged/selection/主题效应上，「打开文件 / 外部重载 / 切标签」这类**纯换 state 的路径**之后没人再推它一把 —— 字段初值是在空树上算的，装饰就永远缺失（tableField 时代就潜伏着，E2E 能过纯靠时序侥幸）。块级装饰本来就是全文范围的，只能 `ensureSyntaxTree(state, doc.length)` 全文强制同步解析。test/block.test.ts 不依赖 DOM 就能断言这些
- **`ensure` 完必须用它的返回值**（上面两条真正的收口，2026-09 才揪出来）：`ensureSyntaxTree` 推的是语言字段里那份**可变的 ParseContext**，而 `syntaxTree(state)` 读的是 `LanguageState` 构造时钉下的**快照**，快照要等下一个事务才刷新 —— 所以「ensure 完再 syntaxTree」拿到的还是 ensure 之前那棵半截树（上游 `forceParsing` 正因为这个，才要在两者不等时补发一个空事务）。而半截有多短是写死的：**打开文件那一刻只解析前 3000 字**（CM 的 `Work.InitViewport`）。症状：一份 5.6KB 文档里 100 行的表格**首开只画到第 44 行**（3000 字正好落在那一行），点一下格子（任何事务都会刷新快照）表格突然长全、视口跟着跳到末尾。修复：`editor/syntax.ts` 的 `parsedTree(state, upto?)` 一处收口，`buildBlocks` / `buildDecorations` / `collectHeadings` / `plainInline` / `cellTokens` / `tableNodeAt` 全走它；`blockField` 另加「树换了就重建」（`syntaxTree(startState) !== syntaxTree(state)`），文档大到一次 ensure 解析不完时，靠后台 parse 推进的空事务把剩下的补上。回归在 test/block.test.ts「首开长文档」那条（**不预先 ensure** 才测得到）
- **块级装饰的增量重建（`patchBlocks`，一台机器三条路）**：`blockField` 每次重建都是一遍**全文遍历**（1 万行 3.4ms、3 万行 10.9ms，一帧预算 16ms），所以挪光标 / 打字 / 后台 parse 推进这三条路都只重建脏区：① 脏区 = 「光标动前动后的露出区间」∪「改动的范围」∪「新解析出来的那一段」，每一段都**撑到与之相交的顶层块边界**（`blockSpan`：装饰的范围不一定等于它那个节点的范围 —— 折叠告示块从首行末尾画起，却由整块是否被碰到决定）；② **改动那一段要在新旧两棵树上各撑一次**：新树盖住「块长大了」、老树盖住「块缩短了」；③ 两条红线之外才允许增量 —— **围栏配对**（`pairingRisk`：改动碰到 ``` / ~~~ / `---` 行时，几百行外那条围栏会从「收尾」变成「开头」，把后面整篇吞进代码块，脏区那套推理没有上界）与 **`[TOC]` 的全文依赖**（`tocDocs`：目录烘的是整份标题表，改动碰到标题就得重算整份；标记由全量重建顺手记下，拿不到时**当有**）；④ 脏区撑到大半份文档（>80%）或超过 8 段就交回全量 —— 宁可慢一次，不能画错。实测一次按键 0.11ms vs 全量 2.2ms（16×），整条事务 1 万行 15.4 → 12.6ms、3 万行 16.1 → 7.4ms。断言在 `test/block.test.ts`（逐位置插字/删字/断行与全量逐条对账，**并断言命中率 > 70%** —— 退回全量永远是对的，命中率不守就会「全绿着退化」）与 `test/perf.test.ts`（增量/全量比值 > 5×）
- **每次按键不再全文 ensure（`parsedTree` 先看快照够不够长）**：装饰层降到 0.11ms 之后，一次按键剩下的成本全在 `parsedTree` 上，而**只要文档里有带语言的代码块**就会特别贵 —— 嵌套语言会在 ParseContext 上留下 skipped 区间，`ensureSyntaxTree` 每次翻视口都 cutFragments + reset，下一句 work() 真的重新解析一遍（1 万行掺 ```ts 实测 12.5ms/键；同一份文档去掉 ```ts 只要 2.2ms）。而 CM 在**每个事务里**就已经用 fragment 把改动那一段重新解析好了（`LanguageState.apply` 给 20ms 预算），实测快照覆盖率中位数 100% —— 那一发 ensure 绝大多数时候白付。判据是 `tree.length`：`takeTree()` 把树停在 `parsedPos` 上，所以「长度盖住了」就等于「这一段真解析过」；嵌套语言的内层挂载可能还没做，但本仓库没有一个 `parsedTree` 的消费者读它（导出的代码高亮是自己 `parser.parse(src)` 另起一棵树）。**快照不够长（首开只解析前 3000 字）照旧 ensure**，那条坑与它的断言都没变
- **截图探针拍的是「稳定之后」，验不了首帧**：`CURSIVE_SMOKE_SHOT` 在探针跑完才截图，那会儿渲染层早把自己的主题钉上了 —— 拿它去验「启动首帧是深是浅」，看到的永远是稳定态（真踩过：记着 dark 去截图，截出来是白的，差点以为改动没生效）。首帧这类问题要**看机械信号**：在建窗口那一刻打印 `NSApp.effectiveAppearance.name`，那才是媒体查询实际跟随的东西
- **模块级 `let` 与启动序列的先后**（0.2.x 会话恢复踩到）：`main.ts` 是一条从上往下跑的启动序列，**函数声明会提升、`const`/`let` 的绑定不会**。把会话那一段（`let sessionRoot` + `scheduleSession()`）放在文件末尾、而 `activate()` 里调了 `scheduleSession()`，启动时第一次 `spawnTab` 就 activate 一次 —— 那一下读到的是还没初始化的绑定，整条启动路径当场抛 `ReferenceError: Cannot access 'X' before initialization`，页面一片空白。**自检下反而看不出来**：`selfCheck || !sessionRoot` 在自检时短路，压根不读它 —— 单测全绿、探针全绿，只有普通启动会白屏。教训有两条：① 凡是被 `activate()` / `openTab()` 这类**启动就会跑**的函数引用到的模块级状态，一律排在启动序列之前；② **改完必须真的普通模式启动一次看 stderr**（`./shell-swift/cursive-shell 文件.md`），探针跑绿不等于 app 能开
- **块级 widget 必须给 `estimatedHeight`，而且要贴着真值、宁高勿低**：CM 的高度图在 widget 真被画出来之前只能拿它去估，默认 -1 = 按**一行**算 —— 一张 100 行的表在高度图里只有 28px。后果三层：① 滚动条长度不对；② 表格块被算在视口之外 → 不渲染 → 永远量不到真高度 → 永远出不来（死循环，整张表干脆不显示，`.cm-content` 里只剩一个 `cm-gap`）；③ 最隐蔽的一层：`heightRelevantDecoChanges` 对「点装饰不相等」一律判为高度变更，而**点一下格子、敲一个字都会换一个 widget 实例**（`eq()` 不成立）—— 于是**每次交互**高度图都先塌回估值、下一帧量到真值再涨回去；估矮了，那一帧文档就短一截，浏览器把超出的 `scrollTop` 夹回来、CM 随后判定「已经滚到底」，measure 末尾那条分支就把视口钉到文末。症状是**「点一下单元格，整页往下跳」**（实测跳 370–4324px）。`TableWidget` 的解法：按行数估，并把量到的真行高经 `view.requestMeasure` 回灌给模块级 `rowH`（向上取整，宁可估高：估高只是滚动条长一点，估矮会甩视口）。修完实测：滚到 900/2000/3500/5000 各点一格、再在格里敲字，滚动位移全是 0。**mermaid / 数学块 / 脚注定义同款隐患还在**（真高度更没法先验），暂时留着
- **块级 widget 的根节点不能有上下 `margin`**（2026-09-18，上一条的另一半）：`estimatedHeight` 只管「还没画出来」那一段，画出来之后高度图信的是 `dom.getBoundingClientRect().height`（`DocView.measureVisibleLineHeights`）—— 而 **margin 不在这个盒子里**。于是一张 `margin: 8px 0` 的表在高度图里比真实版面矮 16px，**它后面的每一行都往下偏这么多，还一路累加**（两张表 32px）。症状不是「看着不对」而是**点不准**：`posAtCoords` 先用高度图 `elementAtHeight(y)` 挑行、再在行内找列，偏移吃掉半个行盒就挑中下一行 —— 表格下方点一条链接、光标落到下一条上（行高 28px、偏 16px 实测必现；`pointer-selection.ts` 的滚动复位同样按高度图算，偏多少就还错多少）。当时五个块级 widget 全中（表格 8、数学/mermaid/目录 10、脚注定义 6）；`TableWidget` 那句 `TABLE_PAD = 16` 只补了估值那一半，量到真值就前功尽弃。**规矩**：留白一律写成根节点的 `padding`（根节点自己不画东西时），根节点有皮肤（底色/边框：目录、脚注定义）的就套一层只管留白的 `.cm-lp-blockgap`。代价是相邻两块之间**不再折叠**（连着摞的两条脚注定义 6 → 6+6），能折叠的那部分本来就是 CM 量不到的。说明写在 `themes/live-preview.css` 开头，`test/widget-height.test.ts` 的「块级 widget 的上下留白」按类名扫 CSS 把关
- **WKWebView 会持久缓存自定义 scheme 的响应**：`FileSchemeHandler` 裸 `URLResponse` 不带缓存指令 → `app://r/index.html`（固定文件名 = 永远同一个缓存键）被磁盘缓存，重新构建后浏览器还在跑旧 bundle，症状是「改了代码却永远不生效」。修复：响应用 `HTTPURLResponse` 显式带 `Cache-Control: no-store` + `Content-Type`（.js 不是 text/javascript 的话 ES module 被拒载），启动时再清一次 WebKit 数据库自愈老缓存。调试「改了没生效」先怀疑这个，别急着怀疑自己的代码
- **⌘Z 不许交给 WebKit 自己的编辑撤销**（2026-09-20）：「编辑」菜单里的撤销/重做原先挂 AppKit 的 `undo:`/`redo:`，沿响应链落进 WKWebView —— 撤的是 **WebKit 那套 DOM 编辑撤销栈**，而文档的真历史在 CodeMirror 里。从前只是**碰巧**能用：WebKit 撤一步 DOM，顺手派一发 `beforeinput/historyUndo`，正文那边被 CM 的 DOM 读回路当成一次新编辑、表格格子那边被 `wire()` 接住转发给 CM 的 `undo`。表格一改结构（回车加行、删行、增删列、整理）整张表的格子都会重建，WebKit 栈顶那条记录指着的元素当场没了 —— 它**既不派事件也不做事**，可 `document.queryCommandEnabled('undo')` 还是 `true`：菜单项照亮、照吃 ⌘Z（判断 1，带 ⌘ 的键全归菜单系统），一按下去一点反应都没有。症状是「在格子里打过字之后回车加一行，⌘Z 失灵」，**偶发**取决于 WebKit 栈里那一刻是不是恰好压着死记录（没在格子里打过字就是空栈 → 菜单项置灰 → 键落回页面，格子自己那条 keydown 反而管用）。修法：与 ⌘D 同款走菜单 → `MenuAction`（`edit:undo`/`edit:redo`）→ 渲染层直接调 CM 的 `undo`/`redo`；焦点在壳自己的 `<input>/<textarea>`（搜索框、重命名…）里时下放 `document.execCommand`，那儿该撤的是那一行字。**别把编辑语义交给浏览器的编辑器** —— 它的状态我们看不见、也清不掉。守着的：`test/commands.test.ts` 的「撤销这条键盘入口」扫 main.swift，E2E `tableEdit.undoRound` 复刻整个现场（先打字、再加行、再撤销/重做）
- **`border-collapse: collapse` 下的格子焦点环必须用 `outline`，不能用 `inset box-shadow`**（2026-09-20）：合并出来的那条横线归**表格**画，排在「格子背景 + 内阴影」之后 —— 于是环的上边被上一行那条边框整条盖掉，左/右/下都在，只有上边没有。同一帧两格对照、截图逐像素量过：内阴影写法上沿 0/58 个强调色像素，`outline: 1px solid var(--accent); outline-offset: -1px` 是 58/58。outline 排在更后面的绘制阶段，压得住那条线；offset −1px 让它落回内阴影原来占的位置，观感一个像素不挪。`test/table.test.ts` 的「单元格焦点环」扫 CSS 守着
- **量 `:focus` 样式之前先确认窗口是 key**：WebKit 在窗口不是 key 时 `:focus` **压根不匹配**（`document.activeElement` 照样指着那个元素，`el.matches(':focus')` 却是 false）。自检窗口没抢到最前时，焦点环那类截图断言会整片变绿或整片变红 —— 两个都不是真话。探针里先等 `document.hasFocus()`，或者干脆别靠 `:focus`：把同一批声明贴成一个类来量
- 编译固定 `swiftc -O -swift-version 5`（避开 Swift 6 严格并发检查）；CLT 即可，无需 Xcode.app
- 编译输出里那几个 `use '#selector' instead of Selector(...)` 警告是**刻意的**（`cut:`/`copy:`/`paste:`/`selectAll:`/`performClose:` 这些响应链派发必须用字符串选择器），忽略，不要"修"。**`undo:`/`redo:` 已经不在这份名单里**，它们被换成了走渲染层的 `edit:undo`/`edit:redo`（理由见上面那条「⌘Z 不许交给 WebKit 自己的编辑撤销」），别顺手加回来
- **`application(_:openFile:)` 排在 `didFinishLaunching` 之前**：Finder 双击 .md（以及带文件名直接跑二进制）时，窗口在 `openFile:` 里就开出来了；`didFinishLaunching` 要是再无条件开一个，用户看到的就是**打开一个 md 弹出两个窗口**（真出现过，修了两次才对：第一版只挡住了「没有 argv」那一路）。正确写法是 `guard windows.isEmpty else { return }`；菜单和 `appDelegate` 全局也得提前到 `applicationWillFinishLaunching`，否则 `openFile:` 那会儿它们还没就位。E2E 把窗口数写死成 2（启动 1 + 探针显式开 1）守这条
- **等渲染层就绪要用推送，别轮询**：`window.__cursive` 出现的那一刻壳才能推文档，而轮询期间 JS 线程正忙着跑一兆多的模块 —— 每一发 `evaluateJavaScript` 都排在它后面，实测白等 150–200ms，正好顶在「双击到看见字」的关键路径上。现在 `BRIDGE_JS` 给 `window.__cursive` 装了个 setter，赋值时 `postMessage({type:'ready'})` 回壳，壳收到就 flush（`flushPendingOpen` 的轮询留着兜底，头 30 次改成 16ms 一帧）。启动各阶段耗时用 `CURSIVE_TIMING=1 ./shell-swift/cursive-shell a.md` 自己量，数据与后续计划见 ROADMAP P4-6
- **启动那份文档不走 IPC，随页面注进去**（P4-6①，契约 v18）：壳在 `setup()` 里就知道要开哪个文件，同步 `readDoc` 完用一条 `WKUserScript`（`atDocumentStart`）注成 `window.__cursiveInitialDoc`，`pendingOpen` 当场清掉；渲染层 `main.ts` 启动**末尾**拿它 `openTab`。注入体走 `JSON.parse('…')` 而不是对象字面量 —— 几十上百 KB 的字面量要过完整语法分析，JSON.parse 有专用快路径。读盘失败就不注入，`pendingOpen` 还在、老路（就绪后 `file:opened`）照走，两条路不会同时发生。**顺序是有代价的**：`openTab` 必须排在 `syncMode()` / `syncStatus()` 那一串收尾**之后** —— `syncMode()` 派的是一次 reconfigure，会把活动标签的装饰整份重建，提到前面就等于拿着全文再跑一遍
- **量启动速度的规矩**（踩过的坑写在 ROADMAP P4-6 末尾）：渲染层有 `window.__cursiveMark(label)`，壳**只在 `CURSIVE_TIMING=1` 下注入**（`TIMING_JS`），平时页面上没有这个函数、调用处 `?.()` 直接短路，正常启动零开销。三条铁律：① 比 **min / p25**，不比平均数与中位数（同一个二进制跑 20 次噪声带 ±150ms）；② 只看**页面内** `performance.now()`，壳侧那 600ms AppKit + WKWebView 与改动无关；③ 量之前先清 `~/Library/Application Support/cursive/scratch` —— 留着草稿的话崩溃恢复会先开出一个小文档，打点打在那份草稿上，基线凭空快 70ms
- **`view.focus()` 会顺手把画面滚走**：WebKit 在 focus() 时把**当前 DOM 选区**滚进视口，而编辑器失焦期间 CM 压根不写 DOM 选区 —— 留在那儿的是上次焦点离开时的旧位置。于是「焦点在查找框/语言选择器里 → 菜单切专注模式」会跳到半篇之外（E2E 实测 scrollTop 228 → 1063）。CM 自己已经用了 `preventScroll`，挡不住这一路。解法是 `editor/focus.ts` 的 `keepScroll`：量一把 scrollTop，做完再放回去。**只给「不该移动视口」的动作用** —— 大纲跳转、查找下一个那几处是故意要滚的
- `NSWindow` 脏标记是 `isDocumentEdited` 属性（没有 `setDocumentEdited()`）
- `NSAlert.runModal()` 返回 `ModalResponse`，做数组下标要 `.rawValue` 运算
- 大字符串回传：`evaluateJavaScript("window.api._resolve(\(id), <json>)")`，JSON 用 `JSONSerialization` 生成，别手拼；异步通道用 `callAsyncJavaScript(body, arguments:, in: nil, in: .page)`（body 是第一个无标签参数）
- `#drag-strip` 拖拽（两代实现，现在是确定性方案）：WKWebView 不认 `-webkit-app-region`，且把 `mouseDownCanMoveWindow` 重写为 false。第一代「叠 NSView + isMovableByWindowBackground」**失败**——当时 contentView 就是 webView，`addSubview(_, positioned:, relativeTo: webView)` 相对自身属未定义用法。现在的做法：① 容器视图做 contentView，webView 与 `DragStripView` 平级兄弟；② 条的 `mouseDown` 直接 `window.performDrag(with: event)`（与系统标题栏同源，不依赖任何机制位）。**38px 高度与 base.css `--drag-strip` 强耦合，改 CSS 记得同步壳** —— 顶栏合并之后这条更要命：`#topbar` 的高度就是它，两边对不上会出现「标签上半截点不动、下半截点得动」；③ `clickCount == 2` 走 `performDoubleClickAction()` —— titleVisibility 藏了系统标题栏，双击缩放 AppKit 不会替你接，得自己读 NSGlobalDomain 的 `AppleActionOnDoubleClick`（Maximize 默认 / Minimize / None）再分派 `performZoom`/`performMiniaturize`。单击那条先进 performDrag 的拖拽循环，跑完才返回，第二击照常带 clickCount=2，两者不打架；④ 条子底下的东西要**挖洞**，`hitTest` 在那几段返回 nil，点击才落得到网页上（区间按 `webView.pageZoom` 缩放 —— 页面一缩放 CSS px 就不等于点了）。**0.2.x 起区间不再写死在壳里**（契约 v26）：顶栏合并之后要放行的段数与位置跟着标签数、窗口宽度、面板显隐一起变，只有页面知道 —— `ui/drag-holes.ts` 量真实 rect、合帧去重后报给 `DragStripView.holes`，壳照做；反过来（条子自己去问页面）做不到，`hitTest` 是同步的而 `evaluateJavaScript` 是异步的。壳里还留着老那两段当**兜底**（首帧/reload 那一瞬页面还没报上来，两颗开关也得能点）。**这一段算错页面那侧完全看不出来**：标签照旧画着、`elementFromPoint` 照旧命中，只是真鼠标点下去被窗口拖拽吃了 —— 所以 `release.sh` 守两条：`tabNativeHole`（壳真的放行了第一个标签）+ `tabUnderStrip`（标签确实落在条子那一带，否则上一条等于没测）。⑤ smoke 探针有 `dragStripHit`（原生 hitTest）与 `dblClickZoomed` 自动把关。后者**必须先把窗口设成确定的小 frame**（窗口若已在 standard state，zoom 只会试着回 user state，而新窗口没有 user state，frame 纹丝不动 → 假阴性）；前者的**取点不能是条子正中** —— 顶栏合并之后那儿多半是一个标签（本来就该漏给 webview），改成 `firstDraggableX`：从红绿灯右边起、在放行区段之外找第一处空当（灯本身是 frame view 上的原生按钮，在那儿 hitTest 命中的是灯不是条子），一处都找不到 = 整条被挖穿、窗口再也拖不动，那时它就该红
- **切主题之后马上截图会拍到旧配色**：WKWebView 的 `takeSnapshot` 会把切换前的合成层原样拍进去 —— 表现为整页已经是新主题，唯独活动标签、大纲当前行还留着上一套颜色（第一次见到还以为是 sepia 的 token 漏配）。**是截图假象，不是配色 bug**：同一主题连跑第二次就正常。走查配色时别接着上一次不同主题的运行跑
- **`themeItems` 与 `syncThemeMenu` 里的 `order` 必须等长**：加护眼那次只加了菜单项没加数组，`order[i]` 当场越界 —— 而且崩在 `setAppearance` 回调里，症状是**启动即 SIGTRAP、一个日志都没有**。现在那个循环加了 `where i < order.count` 兜底
- **`open(_:)` 会遮住 `Darwin.open`**：`WindowController` 上加一个叫 `open` 的实例方法，外部变更监听里的 `open(path, O_EVTONLY)` 会解析到它，报「use of 'open' refers to instance method」。取名避开即可（现在叫 `openFile`）
- renderer 行为用壳内探针 + vitest 验证（无头环境点不了界面，靠 `/tmp/cursive-shell-*.json` 断言）
- `WKPDFConfiguration.rect` 输出**单页** PDF（页尺寸 = rect），不是分页文档；要 A4 分页需走 `WKWebView.printOperation`（NSPrintOperation）或 print CSS @page，当前长条页方案对自用足够

> **`NSPrintOperation.runModal(for:delegate:didRun:)` 的 didRun 回调不在主线程上**（P4-2）：
> AppKit 的 `_continueModalOperationToTheEnd:` 起了自己的线程。在那儿关窗口 / 弹面板 /
> `NSApp.terminate` 会当场 EXC_BREAKPOINT，而 PDF 其实已经好好地写在盘上了 ——
> 于是它长得像「导完就闪退」。回调里第一件事就是 `DispatchQueue.main.async`。

- **`EditorView.theme()` 出的规则比 `live-preview.css` 高一档 —— 行级 padding 写在 `.cm-lp-*` 上一律落空**（0.4.1）。
  `editor/theme.ts` 那条 `.cm-line { padding: 0 }` 经主题生成后是 `.ͼ1 .cm-line`（0,2,0），
  而 `.cm-lp-callout`（0,1,0）低一档。于是告示块、引用、代码块、front matter 的内边距
  **从来没生效过**：实测 `getComputedStyle(.cm-lp-callout).paddingLeft` 是 `0px`，正文紧贴着色条。
  行级的内边距一律写成 `.cm-line.cm-lp-*` 凑成 0,2,0 —— style-mod 把主题插在 head 最前，
  同分时这份文件（排在后面）胜。**写完去量一遍计算样式**，这类落空不报错、看着也只是「有点挤」。
- **多行选区那条带子是按 `.cm-content` 的 padding box + 第一个 `.cm-line` 的 padding 画的**（0.4.1）。
  CM 的 `RectangleMarker.forRange` 读的就是这两个值，也就是说**横向留白它只认 `.cm-line` 上那一份**。
  这儿的 32px 全在 `.cm-content` 上，于是带子比每一行都宽 32px —— 平时看不出来，
  一旦行上有卡片（告示块 / 代码块有底色有圆角），选中时卡片两边就各露出一条高亮。
  解法是让卡片用负外边距铺到同一条边界上（`--lp-gutter`，base.css 与 theme.ts 共用一个值），
  内边距再把正文推回原处。**别改成「把留白搬到 `.cm-line` 上」** —— 表格、公式、mermaid
  那些块级 widget 是 `.cm-content` 的直接子元素、不在任何 `.cm-line` 里，搬完它们会整体外扩 32px。

- **合成的 `mousedown` 必须配一个 `mouseup`**（0.4.1 的 E2E 逼出来的）。
  `editor/pointer-selection.ts` 在 contentDOM 的 mousedown 上（**捕获阶段**）按下一个闸：
  手势期间固定回显依据、不让版面翻面；松手才放。探针只派 mousedown 的话那个闸一直合着，
  而 `writing-modes.ts` 的打字机归位看见 `pointerSelection` 非空会**直接不滚** ——
  表现是几百行之后一条毫不相干的断言挂掉（`writingProbe.ratio` 1.98，该是 0.42）。
  **widget 撞不上这个坑**（`start()` 对 `[contenteditable="false"]` / button 直接放行），
  mark（标签药丸、行内链接）会撞上：它就是一段真文本。
- **卡片上的选区：`drawSelection` 画在底下那一层，有底色的行把它整个盖住**（0.4.1）。
  代码块早就踩过（那条 `::selection` 的 `!important` 就是它），front matter 的属性表
  一上底色又踩了一遍 —— 拖选经过它时**一点反应都没有**。解法同款：在 `.cm-line.cm-lp-*`
  上恢复原生 `::selection`（特指度要压过 CM 那条 `Prec.highest` 的
  `.cm-line ::selection{transparent !important}`，`.cm-editor .cm-line.xxx` 的 0,3,0 够）。
  **但药丸（有 padding 的行内盒）救不回来**：WebKit 不给它画高亮，实测把
  `background` 换成 transparent、去掉 border、去掉 border-radius、改 inline-block
  都不行，只有 `padding: 0` 时才出现 —— 而那就不是药丸了。所以 front matter 选中时
  卡片、键名、值都高亮，**只有那几颗标签是白的**；松开鼠标那一下整块回落成 YAML 源码
  （回显按行判，与全应用同一条规矩），选区就完整了。
- **拖选期间装饰是冻着的**（0.4.1 顺带量到的，`live-preview/index.ts`）：
  `pointerSelection` 非空时 ViewPlugin 直接 `carry()` 返回、不重算装饰。
  所以「选中了就给它换个类」这种做法在鼠标拖选下**不成立** —— 换上去的类要等松手
  才画得出来，而那会儿回显已经把整块翻成源码了。选区的长相只能交给 CSS。
- **YAML 那棵树就在 `Frontmatter` 底下**（0.4.1）：`yamlFrontmatter` 把
  `Stream > Document > BlockMapping > Pair > Key/Literal/FlowSequence|BlockSequence > Item`
  整套挂了上来，front matter 的属性表**不必自己解析一行 YAML**（同表格「片段从文档
  自己的语法树上采」那条）。但**别让 `live-preview/decorate.ts` 的主 switch 往下走** ——
  那台 switch 认的是 Markdown 的节点名，放 YAML 进去，`Document`/`Item`/`Literal` 三个
  现成的同名候选迟早串味。单开一个 `decorateFrontmatter()`，与 `decorateFence()` 同款。

## 自检探针 / E2E（每次改壳必跑）

```sh
CURSIVE_SMOKE=1 ./shell-swift/cursive-shell <file.md>
# +3s 写 /tmp/cursive-shell-check.json   （DOM：hasApi/cm/sidebar/status）
# +4s 写 /tmp/cursive-shell-e2e.json    （read→save 逐字节往返 + 装饰计数 + 图片加载），然后自动退出
```

另加 `CURSIVE_SMOKE_SHOT=<png>`（截 webView）、`CURSIVE_SMOKE_THEME=dark|light|sepia|system`（截图前切主题，走查三套配色；**会写进 localStorage，走查完用 system 复位**）、`CURSIVE_SMOKE_MENU=<菜单动作>`（截图前派任意一个菜单动作，目检设置面板这类用；**与 THEME 互斥** —— THEME 那条先 return）、`CURSIVE_SMOKE_SHOT_SEARCH=1`（截图前把跨文件搜索面板留在开着的状态）、`CURSIVE_SMOKE_NAME` / `CURSIVE_SMOKE_RENAME`（新建 / 重命名时原生输入框的替身，两个**必须不同名**）、`CURSIVE_SMOKE_SCRATCH_DELAY=<ms>`（拖慢 scratchList 应答，逼出「文件先到、崩溃恢复后到」的竞态）。

⚠️ **自检会往你指给它的那份文档里写东西**：`external-append-marker` / `autosave-check-marker` / `fmtprobe alpha beta` 三段**追加到文末并自动保存**，表格/格式/粘贴那几条用例还会就地改内容（改格子、加行、整理对齐）。**只拿 `/tmp/cursive-e2e/` 里的夹具或副本跑，永远别指真文档** —— 真踩过：拿 obsidian 里的一篇笔记跑了三轮，尾巴上多出 12 行探针标记。

⚠️ **自检下不恢复 `lastFolder`**：`treeProbe` 会在树根里真的建文件、改名、搬走、删除（契约 v32 那三条另走一份 `e2e-外来.md`：`window.api.save` 直接写盘 = 一次真的外部变更，验完进废纸篓） —— 恢复用户上次那个文件夹等于拿人家的目录做实验。壳侧 `setup()` 与 `lastFolder` 通道都按 `smokeAuto` 短路。⚠️ `~/Library/Application Support/cursive/scratch/` 里的残留快照会被下一轮当成待恢复草稿开出来，把用例打开的文件挤成非活动标签 —— release.sh 每轮开头会清空它，手跑探针时也记得清。

另加 `CURSIVE_SMOKE_PDF=<路径>`：E2E 后顺带导出 PDF（绕过保存面板，默认 A4 / 标准页边距 / 带页码；另两档走 `CURSIVE_SMOKE_PDF_PAPER=a4|letter` 与 `CURSIVE_SMOKE_PDF_MARGIN=narrow|normal|wide`），结果写 `/tmp/cursive-shell-pdf.json`（bytes / pages / width / height / error）。**空串当没设**（`release.sh` 里这个变量只对 mermaid 那条用例非空）。**它导的是探针跑完时的活动标签** —— kitchen-sink 那条最后会被 `findProbe` 带到 table.md 去，所以 PDF 断言挂在 mermaid 用例上（它没有 findProbe）。mermaid 那条只守**页面尺寸 595×842**；**页数另起一条独立用例**：现造一份 200 段的长文档导一次，守页数 ≥ 3 —— 八个夹具都只有一两页，而探针会改文档，拿它们断言页数就是在赌这一轮有多长（真摔过：mermaid 在污染过的副本上 2 页，干净夹具上 1 页）。

另加 `CURSIVE_SMOKE_HTML=<路径>`（P4-1）：探针里派一次导出 HTML（`window.__cursive.exportHtml()`，壳绕过保存面板、图片按「嵌入」处理），结果进 E2E JSON 的 `htmlProbe`。**这一步排在「收干净」之后、跨文件搜索之前** —— findProbe 点一处命中会切到别的标签，而导出的是**当前活动标签**，顺序反了就导出了错的文档。`release.sh` 每个用例都跑一遍（渲染路径上任何一处抛异常都会在这里现形），另按用例查产物：img.md 要有 `data:image/png;base64,`（顺带守住「百分号编码的中文文件名也能读到盘」整条链）、kitchen-sink 要有锚点/表格/`tok-keyword`/`<math`、mermaid 要有烘进去的 `<svg`、callout 要有卡片与内联图标、dialect 要有目录与脚注锚点。

E2E 的第九条用例是 **links.md**（0.2.0 链接跳转，夹具由 `release.sh` 现写，另配一份只当落点的 link-target.md）：⌘+点击的四条去处各走一遍 —— 锚点跳到哪一行、本地文档开出**标签**（`windows` 仍是 1，不是新窗口）并落在目标那一节、外部地址与 `file://` 进 `smokeExternal`、四种「没能如愿」各自在 `#status-note` 留一句话（文件不在 / 没有这个锚点 / 系统没接手 / 地址带空格又看不出是哪个文件）。**文件名带空格**的落点另有一份夹具（`我的 目标 文档.md`），尖括号 / 百分号 / 裸空格三种写法必须落到同一处、同一节 —— 这条守的是整条链：渲染层拼路径、过桥、壳侧按原样读盘，中间任何一步把空格弄丢或多编码一次都会变成「找不到文件」。夹具里那节「靶子」是**给格式栏探针当靶子的**：`barProbe` 会把文档里第一个二级标题升成三级，没有它被升级的就是锚点落点，断言得跟着别人的副作用走。

验证 PDF 不要用 PDFKit 提取文本（CJK 提取严重失真），改用结构信号：**页尺寸 595×842**（P4-2 之后是真 A4；老实现出的是「595×整篇文档高」的一张长条，这一条就是它的墓碑）、页数、`strings out.pdf | grep -c "Subtype */Image"`（图片对象数）、`qlmanage -t -s 1000 -o <dir> out.pdf` 转 PNG 目检。

⚠️ 探针/E2E **只在 `CURSIVE_SMOKE` 环境变量下运行**；不带该变量启动是正常交互应用，绝不自动退出。
（历史教训：曾把 `NSApp.terminate()` 编进默认路径，导致「启动几秒后闪退」。）
从 Finder/非项目根目录启动时，cwd 不是项目根 —— renderer 资源路径按可执行文件位置向上回退（shell-swift/ 的上级）。

PASS 标准（新增：`treeProbe` 的 created/renamed/moved/deleted 全真且磁盘上不留痕、`findProbe` 的分组数/高亮数/跳转后选中文本、`windows >= 2`）：`status`=打开的文件名；`bytesEqual=true`（BOM/CRLF 指纹还原）；`counts.cm-lp-*` 视口内非零；图片用例 `img.loaded=true`；`tabHit=true`（无浮层压标签）；`tbHoleLeft/tbHoleRight/tbHitPage=true`、`trafficEnd≤72`、`|tbMidY - trafficMidFromTop| ≤ 1`（标题栏开关点得到、不撞红绿灯、与红绿灯同一条水平线）；`dblClickZoomed=true`（系统偏好非 Maximize 时该项跳过，只记 `dblClickAction`）。
测试夹具生成：见 `/tmp/cursive-e2e/`（kitchen-sink.md / crlf.md / img.md + assets），图片 URL 里的空格/中文要百分号编码（渲染层 parseImage 不接受裸空格）。

## 构建与运行

```sh
./shell-swift/release.sh              # 标准工作流：测试 + E2E 全绿才打包 dist/cursive.app
CURSIVE_DMG=1 ./shell-swift/release.sh  # 同上，额外出 DMG
./shell-swift/cursive-shell [file.md]   # 开发运行（项目根执行；资源查找 Bundle → cwd → exe 相对）
```

**架构 / 部署目标 / 链接参数只有一处**：`shell-swift/compile.sh`（0.3.0 T1 起）。
`build.sh` 与 `make-app.sh` 都调它，别再各自写 swiftc —— 那段「部署目标必须写死」的注释
此前在两个脚本里逐字复制了两份。

| 谁 | 编哪几片 | 为什么 |
|---|---|---|
| `build.sh`（开发 / release.sh 的 E2E） | **本机一片**（`uname -m`）| 快一倍，而 E2E 本来也只跑本机那片 |
| `CURSIVE_UNIVERSAL=1 build.sh`（CI） | 两片 | x86_64 在本地开发里一次都不会被编到，**CI 是唯一挡得住它悄悄烂掉的地方** |
| `make-app.sh`（打包） | **永远两片** | 开发可以只编本机那片，交出去的那份不能挑机器 |

**约定：每轮改动收尾必须跑 `release.sh`，让用户随时拿到全绿的新包。**

**应用图标那条路上的两个坑**（2026-09-20，`npm run icon`）：

- **`sips` 不认 `feGaussianBlur`** —— 写了不报错，直接当没有，糊出来是一道硬边
  （母版上实测：C 的落影变成一条 205 灰、边界处一刀切）。矢量源是**同一份 SVG 喂给
  sips 和浏览器**，所以图标里一处滤镜都不能用：软影改成描边 / 裁在形状里的径向渐变，
  纯几何，哪个渲染器出来都一样。
- **macOS 26 会把老式 `.icns` 重新遮罩并自己上投影** —— 用 `NSWorkspace.icon(forFile:)`
  把系统自带图标和本仓库的包各拉一张 1024 对照，遮罩逐像素相同（连续曲率超椭圆
  `|u/r|^2.6+|v/r|^2.6=1`，824 居于 1024，r=266），投影参数也相同（黑 26%、下移 8、σ=15）。
  两个后果：① 自己再烘一层投影只会白费（落在遮罩外，会被裁掉）或双影；
  ② 图标的圆角**画得比遮罩紧就会被裁**（旧版 `rx=185` 的四个角一直在被裁）。
  形状与配色的完整说明在 [`brand/README.md`](brand/README.md)。

## 路线图

**`ROADMAP.md` 已于 2026-09-21 收成存档：1.0 的四条门槛全部成立，清单清零。**
那份现在只剩三块与版本无关的东西 —— **四个结构性判断**（第二节）、**有意不做总表**（第三节）、
**非功能红线**（第四节）—— 它们是所有后续改动的准入条件；0.1.0–0.4.0 的任务压成了一个版本一行。
**P0–P4 那套编号只在本节的历史记录里还出现。** 本节只留「已完成（含踩坑记录）」。

### 已完成（勿重做）

1. ~~safe-file://local SchemeHandler（图片）~~ ✅ 含双重解码坑
2. ~~argv 打开文档 + E2E 验证（read→save 往返/装饰/图片）~~ ✅；**待手动验证**：打开/另存为面板、脏标记关闭拦截、Finder 双击 .md（`application(_:openFile:)` 已有雏形）
3. ~~PDF 导出~~ ✅ 文件 →「导出为 PDF…」（⌘P）：离屏 595pt(A4) WKWebView 加载同一 renderer，`__shellEmit` 注入实时内容（含未保存修改），注入打印 CSS（隐 sidebar/状态栏/drag-strip、白底、高度自适应），等 `document.fonts.ready` + 图片 `decode()` 后 `createPDF`。输出为**单页长条 PDF**（页高=内容高），打印样式在 `PDFExporter.printCSS`
4. ~~打包~~ ✅ `./shell-swift/make-app.sh`（加 `CURSIVE_DMG=1` 连 DMG 一起出）：组装 dist/Cursive.app（Info.plist 含 .md 关联 rank=Default + UTImportedTypeDeclarations 补 mdown/mkd 扩展名、NSHighResolutionCapable，icon 用 build/icon.icns）→ ad-hoc 签名 → hdiutil 打 DMG（暂存目录里带 /Applications 软链，挂载后直接拖）。产物 ~9.7MB（P1 起 mermaid + KaTeX 进包，从 3.5MB 涨上来；都是按需动态 import）。已验证：bundle 内 smoke、`open` 启动、`open -a` 带文档启动。注意：壳的 `findRendererRoot()` 三级查找顺序 Bundle Resources → cwd/out/renderer → exe 相对路径
5. ~~P0-1 最近文件 + Finder 集成~~ ✅ `NSDocumentController` 系统最近列表（打开/保存时 note）、文件菜单「打开最近」10 项 + 清除、Dock 右键；E2E 断言 `recents≥1`
6. ~~P0-2 自动保存 + 崩溃恢复~~ ✅ 停输入 2s / 切标签 / 失焦静默落盘（走 `encodeDoc` 指纹路径，E2E 断言字节一致）；无路径文档进 scratch，启动恢复为未命名标签；状态栏「已保存 HH:MM」。**坑**：恢复是异步的，不能抢走 argv/Finder 打开的那份焦点，且过滤启动空白页后必须校正 `activeId`（否则状态栏挂一个不存在的文件名）。release.sh 有专门的竞态用例（`CURSIVE_SMOKE_SCRATCH_DELAY`）
7. ~~P0-3 外部变更监听~~ ✅ 壳侧 `DispatchSource` 监听 openTabs 全部路径，0.8s 节流；**rename/delete 后必须重开重注册**（rename-replace 保存会让 fd 失效）；渲染层干净则静默重载保留滚动光标，脏则 `confirmReload`，非活动脏标签标 ⚠
8. ~~P0-4 删除 Electron~~ ✅ 只留 `src/renderer` + `src/shared`；构建链 = 根 `vite.config.ts`；`scripts/make-icon.mjs` 改为纯 `sips`+`iconutil`（不再依赖 Electron）；README / 本节同步。验收：不装 electron 也能 `npm run build` + `release.sh` 全绿

### 已完成（非 P0 清单，可插队项）

- ~~P3-4 主题系统~~ ✅ **全部完成**：浅/深/跟随系统/**护眼**四态、视图菜单、`NSApp.appearance` 同步、localStorage 持久化，外加扫 `themes/*.css` 的**用户自定义皮肤**（契约 v12）。标题栏右上角那颗月亮/太阳 = 在浅与深之间直接对切（⌃⌘D 同款），图标说的是「按下去会发生什么」
- ~~P3-5 排版偏好面板~~ ✅ `ui/prefs.ts`（⌘,）：主题/衬线/字号/行距/栏宽 + 恢复默认；改完 `view.requestMeasure()`
- ~~P2-6 表格编辑~~ ✅ **全部完成**。上半场（就地编辑）：点进单元格不再回落源码 —— `live-preview/table.ts`（`contenteditable` 格子 + `tableEditField` + `writeCell` 只改那一格 + Tab/回车/方向键/Esc 全套导航）。早先那版「`ignoreEvent` 放行 mousedown + `editTableOnClick` 把光标送进源码」已删 —— 它正是「一点就变竖线」的成因。下半场：**底部浮动工具栏**（`absolute; top:100%`，出现/消失不顶动正文；按钮 `mousedown` 必须 `preventDefault`，焦点一离开格子编辑态就散）、**悬停 +/− 手柄**（列在上边框、行在左边框，`getBoundingClientRect` 现算）、**格内行内语法**（片段从**文档自己的语法树**上采，不另写解析器 —— 方言零漂移；渲染态的格子拿 `data-rich` 记源码来比，源码态仍拿 DOM 现有文字比；格内链接不写 `href`，⌘+点击走 `openExternal`）、**「整理对齐」**（唯一重写整块的操作，`displayWidth` 按 CJK 算 2 列，**永不自动跑**、幂等）。增删行列/对齐/整理/删表全是 `(state, tableFrom, …) -> TransactionSpec` 纯函数，工具栏与手柄共用，撤销栈和保存零损耗自动成立
- ~~P1-1 KaTeX 数学公式~~ ✅ 方言层 `InlineMath`/`DisplayMath`（pandoc 收紧定界规则：开后非空白、闭前非空白且后非数字，货币符号不吃）；行内走 decorate（ViewPlugin）、块级走 `blockField`（StateField）；`MathWidget` 用 `katex.renderToString`（`throwOnError:false` 错误红色源码不崩）；CSS/字体已进产物；E2E `math.md` 断言行内/块级计数 + **KaTeX 字体真加载**（CSP 拦掉时肉眼看不出）。**katex 是按需加载的**（P4-6②）：JS 与 CSS 一起关在 `editor/live-preview/katex.ts` 里，那个模块存在的唯一理由就是**让 katex 只能被动态 import 够着** —— 任何静态 import 链一碰它，261 KB 就被拽回主 chunk，这一层白做。`renderMath()` 在模块到手前返回 **null**（顺手把加载踢起来），`fillMath()` 据此先摆源码占位、加载完再换（**正文公式与表格格内公式共用这一条**，否则「公式在表格里不显示」这种毛病只会在其中一边出现）；`CellToken` 因此**只存 `tex` 不存渲染结果**。导出是一整棵同步递归，变不成异步 —— 由 `export/index.ts` 先 `await loadKatex()`，`renderMathML()` 拿不到实例就退化成 `<code>`，不让一份导出栽在这上面
- ~~P1-2 mermaid~~ ✅ `blockField` 里 FencedCode(mermaid) → `MermaidWidget`：动态 import 独立 chunk、`eq()` 按源码+主题、`destroy()` 取消未完渲染；**render 对语法错误不抛异常而是内嵌错误 SVG —— 必须先 `parse()` 预校验**才能走「保留源码+错误提示」分支；主题切换经 `themeEffect` 派发到所有标签（冻结标签也要 `state.update` 重建，否则 widget DOM 缓存导致切回还是旧配色）；E2E `mermaid.md` 断言 svg≥1 + error≥1

- ~~P1-3 方言补齐~~ ✅ 高亮 `==…==`、上下标 `^…^`/`~…~`（GFM 删除线只认 `~~`，单 `~` 归下标，互不打架；math 元素内容原子，`$e^{-x^2}$` 不受影响）、emoji `:smile:`（EMOJI 表外的短代码保持字面量，`10:30:45` 安全）、脚注 `[^1]`（引用=上标角标，悬停显示定义、点击跳转；定义区折叠成一行，光标进入回落；**引用没有对应定义就保持字面量** —— 换成角标那是个点了没反应的假脚注，编辑器与导出同款）、`[TOC]` 目录组件（点击跳标题）。dialect.md E2E 断言六类组件计数
  - **坑 1**：`[^1]: 文字` 同时是合法的链接引用定义形状，LinkReference 会抢 —— 必须用 eager `parse` + `before: 'LinkReference'` 抢先
  - **坑 2**：eager parse 落完元素后必须 `cx.nextLine()` 把当前行推过块，否则 parsedPos 不前进，解析器原地重试直到超时（ensureSyntaxTree 拿不到全树）
  - **坑 3**：行内定界符长度必须与开定界符匹配（数学踩过，P1-3 的 == 复用同一扫描器）

- ~~P1-4 代码块增强~~ ✅ `CodeBarWidget`（语言标签 + 复制按钮，`Decoration.widget` 挂块首行，`float:right` 到右上）。复制走 `navigator.clipboard`，WKWebView 非安全上下文会失败 → 兜底 textarea + `execCommand('copy')`。副本按钮点击即刻 e.preventDefault/stopPropagation，别让 widget 默认吞事件
- ~~P1-5 图片显示增强~~ ✅ `parseImage` 支持 `=宽x高` 尺寸语法；点击图片开灯箱（body 级遮罩 + Escape 关闭，复刻 Prefs 面板叠层模式）；加载失败显示**解析后的完整路径**（decodeURI + 剥掉 safe-file://local 前缀），而不是只给 alt —— 只给 alt 排查不了是路径错还是文件缺
  - **P1-5 的尾巴：尺寸语法端到端补完**。`parseImage` 一直认得 `=600x400`，但**解析器不给节点**，所以编辑器里从来没生效过：CommonMark 的链接目的地不能带空格、`=600x400` 也不是合法链接标题，内置 Image 解析器只认下 `![alt]`（shortcut 形状），`(…)` 落进正文 —— 装饰层拿到的切片对不上 `parseImage`，屏幕上是「alt + 一串源码」。`markdown-lang.ts` 新增 `SizedImage` 行内解析器（`before: 'Image'`，`SIZED_IMAGE` 正则）把它整段咬成一个 `Image` 节点
  - **坑**：新节点**必须与内置图片同构**（`LinkMark` + `URL` + `SizeMark`），不能图省事 `cx.elt('Image', pos, end)` 造一个光杆节点 —— 装饰、导出、大纲取词、表格格内四条路径全都按**节点名/子节点**走：光杆节点的切片喂得上 `parseImage`（装饰和导出没事），但 `plainInline` 会原样吐出 `![alt](src =600x400)`，标题里带一张图就会在大纲/TOC 里挂一整行源码。`=600x400` 那一段单独叫 `SizeMark` 并入 `INLINE_MARKS`，取纯文本时一并藏掉
  - **顺手修掉的老坑**：`isHiddenInline()` —— 原来「藏行内标记 + 藏 URL」这条判断在 `plainInline` 与 `cellTokens` 里各写了一份，而且只藏 `parent === 'Link'` 的 URL，图片的 URL 会漏出来（`## ![图](a.png)` 在大纲里是「图a.png」）。现在两条路径共用同一个函数，图片 URL 也藏
  - **坑 2：解析器认领的形状，消费端也必须认**。`SIZED_IMAGE` 认 `<a b.png>`（文件名带空格时**唯一**的写法，CommonMark 自己就这么规定），但 `parseImage` 的目的地那组原来是 `([^)\s]+)` —— 空格直接断在这儿，返回 null，装饰层 `return` 掉、导出退回 `escapeHtml(raw)`，屏幕上和导出物里都是一行裸源码。**解析器测试只对着树断言是不够的**，`test/image-size.test.ts` 里「目的地写成 `<带空格.png>` 也认」当时是绿的，缺的是把同一段喂给 `parseImage` 那一半
  - **坑 3（顺带查出来的老 bug）**：尖括号那半必须**单独一组** `(?:<([^<>\n]*)>|([^)\s]+))`。原来写作 `<?([^)\s]+)>?`，`[^)\s]+` 贪婪地把收尾的 `>` 一起吃进 src（`<ab.png>` → `ab.png>`），拼出来的 `safe-file://` 找不到文件 —— 所有尖括号写法的图片，从来就是裂的
  - 验收：`test/image-size.test.ts`（节点形状逐字符断言、`= 600 x 400` 这种不认领、夹在正文中间不吃前后文、标题取词只留 alt、**节点切片喂得上 `parseImage`（含尖括号那种）**）；`test/image.test.ts` 三条尖括号回归；`test/export.test.ts` 断言导出 HTML 带 `width`/`height` 且尖括号那张没退回裸源码；**E2E `img.md` 三张图**（百分号编码中文名 / `=120x80` / `<带空格.png> =60x40`），断言导出物里有那两组宽高、没有 `![尖括号图]` 字样、编辑器里 `cm-lp-image` 计数 ≥ 3；应用实测（`=96x96` 出 96×96、`=300x` 出 300×186 按比例、光标进那一行回显源码）
- ~~块级 widget 的高度记忆~~ ✅ CM 只渲染视口附近，视口外的块按 `WidgetType.estimatedHeight` 估高（默认 -1 = 按一行算），估错就是滚动条长度、跳转落点、点击定位一起错，而且真渲染到那一块高度一换上下文就跳。`widgets.ts` 的 `heightMemo` 在 `ResizeObserver` 里走 `view.requestMeasure`（measure 阶段读 `getBoundingClientRect`，不在 DOM 更新里读）把实测高度记下来
  - **落盘那一半在 `live-preview/height-store.ts`**：只记在模块里的话，「第一次有点抖」会变成「每次开应用都抖一遍」。key = `cursive.widgetHeights`，值 = `{v, layout, entries}`，**layout 是排版条件指纹**（栏宽:字体:字号:行距:窗口高）—— 这些量都会改像素高度（图片有 `max-height: 60vh`），对不上就整份丢掉，宁可多跳一次也不按错误高度排版；版本号/坏 JSON/手改过的条目一律当没有
  - 第一次写立刻落盘（「量到了」这件事别卡在节流窗口里），连续变化合并成一次（400ms）；条目上限 256，与内存那份一致
  - **落盘那份要在文档进编辑器之前捞进内存**（`primeHeights(view)`，`main.ts` 的 `openTab` 开头调）。CM 的顺序是**先查 `estimatedHeight` 进高度表、再 `toDOM`**，而读盘原先挂在 `watchHeight` 的 write 里（要等第一个 widget 画出来、ResizeObserver 首发）—— 晚了一步，于是每次冷启动第一个块级 widget 照样跳一下，明明它的高度就在盘上。调用点卡在「chrome 与偏好都已生效、文档还没进来」那一刻：早了（view 刚建出来、`prefs.apply()` 还没跑）算出来的**排版指纹是过期的**，等于拿另一套排版下的像素高度排这一份。宽度为 0（还没上屏）时直接不预热
  - **排版指纹只有一处算**（`layoutKey(view)`）：预热与实测各写一份的话，差一个字段就是「预热进来的永远对不上、下一发实测立刻清空」
  - **量的是 widget 那个盒子（`dom`），不是 `observed`**：`observed` 只回答「谁的尺寸变了要通知我」（图片是内层 `<img>`，它解码完才知道多高），CM 要的是整个 widget 占多高 —— 小图上两者差一个行盒
  - **估值要跟着 CSS 的上限截**：文档里写的 `=4000x3000` 只是请求，`.cm-lp-image img` 还有 `max-height: 60vh` 压着。不截的话首帧按 3000px 排版、量完塌回 400px，整篇跟着跳一次
  - **图裂时先 `unwatchHeight` 再换内容**：`is-broken` 是**另一个盒子**（虚线框 + 两行小字），让它写进这张图的 key 的话，下次文件补回来了估高还是那个矮盒子
  - **已知限制：多窗口共用一份落盘**。localStorage 是整个 data store 共享的，而指纹里带了**窗口高**（图片有 `max-height: 60vh`）—— 两个高度不同的窗口会来回覆盖盘上那份，下次冷启动只有最后写的那套排版能命中。各窗口内存里那份互不干扰（`diskStore` 首读之后就在手里），所以只影响「下次开」的命中率，不影响正确性；真要修得按指纹分桶存，不值
  - **第一次见到某个块的那一下位移消不掉** —— 那时确实没人量过（这和上面「落盘那份读晚了」不是一回事：那条是量过、就在盘上、只是没赶上）。要再进一步得让壳侧在打开文档时就把本地图片的原始尺寸报上来（新通道），收益只在这一种情形，暂不做
  - 验收：`test/height-store.test.ts` 9 条（落盘那一半）；`test/widget-height.test.ts` 8 条（异步填充后更新、同图不同尺寸不共享、宽度变化废旧、**预热**、宽度为 0 不预热、**图裂摘观察者**、已移除节点不测量）
- ~~P1-6 告示块 Callout~~ ✅ `> [!note]` / `> [!danger]`：13 种类型（Obsidian 全量别名，GitHub 的 NOTE/TIP/IMPORTANT/WARNING/CAUTION 一并吃下）→ 6 档配色 + 图标 + 中文类型名；自定义标题写在类型后面，`[!note]-` 默认折起 / `[!note]+` 默认展开。三处分工：类型表与折叠状态 `editor/callout.ts`、解析 `markdown-lang.ts`、装饰 `live-preview/decorate.ts`（图标复用 `ui/icons.ts`）
  - **坑 1**：`[!danger]` 正好是合法的 shortcut 链接引用形状 —— 不 `before: 'Link'` 抢下来，整行会被渲染成一行**蓝色带下划线的坏链接**，比裸源码更让人困惑。和 `FootnoteRefParser` 同一个坑
  - **坑 2**：**类型认不认识不在解析器判**。形状是 `[!word]` 且落在段落第一个字符就一律认领成 CalloutMark；表里没有的（`[!xyz]`）由装饰层决定「不成卡片、仍是普通引用」，源码以字面量示人。打错一个字母就掉回坏链接是最糟的失败方式
  - **坑 3**：行内解析器看不到块上下文，「必须在引用块里」这一半由 `decorate.ts` 把关（父节点链上有 Blockquote）；嵌套 `> > [!note]` 只认里层那块，不递归
  - **坑 4**：**不新增块级节点** —— 它本质还是 Blockquote。装饰走**行级**（`cm-lp-callout` + `cm-lp-callout-<tone>`，首尾照 `.cm-lp-code-open/-close` 那套收圆角），**不能做成块级替换 widget**，否则块里没法打字（同代码块）
  - **坑 5**：折叠态放 `calloutFoldField`（StateField），key 用**块起点**并跟着 `changes.mapPos(…, MapMode.TrackDel)` 映射，**不存行号、不写回文档**（保存零损耗）；集合里装的是「与默认态相反」的那些块。折起来的正文是一条**跨行 replace**（首行末尾 → 块尾），只能从 StateField 出（`blockField`），ViewPlugin 出的会被拒
  - **配色**：每档只给一个主色 `--cal-<tone>`（base.css 三处同步），卡片底色由 `color-mix(in srgb, var(--cal) 8%, transparent)` 现兑 —— 浅暗两套底色不用各写一遍。`.cm-lp-callout-<tone>` 必须排在 `.cm-lp-callout` 之后：同特异度、挂同一个行元素，靠先后顺序决出 `--cal`
  - E2E `callout.md` 的 `calloutProbe`：图标数、补上的中文类型名、**危险与笔记的计算后边框色不同**（`--cal-*` 落空的话所有档会继承成同一个色）、点三角折/展（1→0→1）且文档长度不变

### 崩溃恢复只认「上次留下的」，而且只认一次

- **症状**：在 A 窗口的**未命名**文档里打几个字，再开一个窗口，那几个字跟着过去了。
- **成因**：`scratch/` 是**整个 app 一个目录**，而 `scratchList` 把目录里的 json 全发一遍。
  未命名文档停输入 2s 就静默落盘（P0-2），于是「A 窗口此刻正在编辑的草稿」和
  「上次崩溃留下的草稿」在盘上长得一模一样 —— 每个新开的窗口都会把它恢复成一个未命名标签。
  更糟的是两个窗口各存一份、各自再落盘（`scratchId` 是 `tab-<ts>-<id>`，新窗口给的是新 id），越滚越多
- **改法**（`main.swift` 的 `recoverableScratch`）：两条规矩缺一不可 ——
  ① **只认启动那一刻就在盘上的 id**（那才叫「上次留下的」），快照在
  `applicationWillFinishLaunching` 里取：**必须早于第一个窗口**，晚一步这一轮自己写的草稿就混进来了；
  ② **交出去一份就从候选集里划掉** —— 恢复是一次性的，第二个窗口不该再拿到同一份。
  `scratchDir` 因此从 `WindowController` 的计算属性提到文件级（AppDelegate 也要够得着）
- **验收**：崩溃恢复那条独立用例末尾**真开一个第二窗口**（探针参数 `secondWindow`，由
  `CURSIVE_SMOKE_SCRATCH_DELAY` 触发），断言 `scratchQueries ≥ 2`（第二个窗口确实问了）、
  `scratchHandouts == 1`（只交出去一份）、`scratchPending == 0`（候选集清空）。
  光看一个窗口是测不出这条不变量的

### 契约 v19：工作区根 = 这个窗口自己的（`workspaceRoot`，原 `lastFolder`）

- **症状**：从 Finder 双击一个 `.md`（或「打开方式」/ `open -a`），侧栏挂出来的是**上次那个文件夹**，
  和刚打开的这份文档毫不相干。
- **成因有两处，缺一不可**：① 壳侧 `setup()` 里 `treeRoot = pendingFolder ?? lastFolder` ——
  带**文件**开出来的窗口没有 `pendingFolder`，于是落到全局的 `lastFolder`；② 渲染层
  `sidebar.restore()` 问的也是 `lastFolder`。而 `setActive` 那条兜底（「没开过文件夹就把文档所在
  目录挂成树根」）**顶不上** —— 它的条件是 `!this.root`，这时 root 已经被那个历史文件夹占住了。
  自检下 `lastFolder` 一律返回 nil，所以 E2E 里一直是对的，只有真机会犯
- **改法**：`treeRoot = pendingFolder ?? parentDir(pendingOpen) ?? lastFolder`，三种来源在
  `setup()` 里一次定死；通道 `lastFolder` 改名 `workspaceRoot`，直接把这个窗口的 `treeRoot` 报回去
  （名字不改的话，它返回的东西和名字说的是两回事）。`parentDir` 要求**绝对路径**且不是 `/`
  —— 树根同时是防穿越守卫之界，相对路径守不住，挂在 `/` 上等于让文件树去读整个磁盘
- **`openFile:` 的路由也跟着改**：从前「一律塞给当前窗口」，于是一个窗口里会同时摆着 A 文件夹的树
  和 B 文件夹的文档。现在先找**工作区罩得住它的窗口**（树根就是它所在的目录，或祖先目录 ——
  后者正是 `setActive` 会逐级展开到它的那种情形），有就在那儿开新标签、把窗口提到前面；
  没有才新开一个。**同一个文件夹里的第二个文件是新标签，不是又一个窗口**
- **顺手补的竞态**：`sidebar.restore()` 在启动时是**不被等**的（`void`，见 main.ts 的顺序），
  文档可能抢先经 `setActive` 兜底把树根挂好了 —— 同一个目录就直接返回，不然 `open()` 会把
  展开状态和选中项一起清掉；真要换根，换完补一次 `setActive` 定位
- 验收：E2E 每个用例都守两条 —— 壳侧 `windowRoots[0] == /tmp/cursive-e2e`（守卫之界当场就位）、
  渲染层 `sbRoot == /tmp/cursive-e2e`（侧栏真挂在那儿）。改之前壳侧那条是空串

### 最近一轮：0.2.0（**已收尾**）

十件事，全部落地，每一件都在 `release.sh` 里有断言（红线五）：

1. **粘贴保真**（`editor/paste-rules.ts`）—— turndown 原先只加了一条删除线规则，实测：一张两行两列的表粘进来变成 `"语言\n\n年份\n\nSwift\n\n2014…"` 七个段落，`<mark>`/`<sup>`/`<sub>`/复选框的标记全丢，`<style>` 里的 CSS 当正文吐出来。补齐 GFM 表格（四条规则拼：格 → 行 → 分组 → 表；对齐认 `align` 与内联 `text-align`，`colspan` 退化成补空格子，格内换行压成空格、竖线转义）+ 方言三条 + 任务项（**整条 li 自己接管**：只给 input 加规则的话 turndown 的项目符号是 `-` + 三空格，出来 `-   [x] 文字`，而 `fmt.ts` 认任务项的正则要求恰好一个空白）+ `td.remove(['style','script',…])`。`test/paste-rules.test.ts` 16 条
2. **自动补全**（`editor/complete.ts`）—— 见上面「功能要点」。`test/complete.test.ts` 16 条
3. **⌘D 多光标** —— `allowMultipleSelections` 与 `rectangularSelection` 早就挂着，缺的只是一个**按得到的键**：`performKeyEquivalent` 把所有带 ⌘ 的事件交还菜单（判断 1），而菜单里没有这一条，于是 `searchKeymap` 的 ⌘D 一直是死的。补一条菜单项就活了 —— 不必去赌「⌘ 组合能不能落回 CodeMirror」那个 ROADMAP 里留着问号的问题
4. **复制为富文本**（契约 v20）
5. **拼写检查**（默认关）
6. **快速打开**（⌘T，契约 v21）—— 键位挑 ⌘T 而不是同类常用的 ⌘P：⌘P 在 macOS 上是打印，这份菜单里已经归了导出 PDF
7. **命令面板**（⇧⌘P）
8. **性能断言**（`test/perf.test.ts`）—— 红线三（1 万行不掉帧）原先一条自动化断言都没有，而它恰恰最容易在不知不觉中退化：判断 2 定了「块级组件一律照抄 tableField」，每加一种块级装饰就多一遍全文遍历。造一份 1 万行夹具，量 `buildBlocks` 与大纲取数，阈值按「会不会让人感觉到」订（120ms，本机实测 4ms / 8ms，每次跑都把实测值打印出来）
9. **版本历史**（契约 v22）
10. **PDF 书签**
11. **链接跳转**（`editor/link.ts`，契约 v23）—— 见上面「功能要点」。它补的是 0.2.0「导航层」那一栏最后一个空格：文件树、大纲、跨文件搜索、快速打开都是**从外面找进去**，而顺着文档里的链接读下去一条路都没有（`#锚点` 此前被当外部地址交给系统，等于点了没反应）。`test/link.test.ts` 33 条 + E2E 第九条用例

**顺带修的一处既有隐患**：`vitest.config.ts` 改成 `fileParallelism: false`。`block.test.ts` 的「不预先 ensure，复刻打开文件」和 `code.test.ts` 的 `ensureSyntaxTree(…, 5000)` 量的都是 lezer 的**挂钟时间预算**，并行跑时机器一忙就随机变红（拿 6 个满载进程压着，三次必有一次）—— 而 `release.sh` 是「测试全绿才出包」，一条随机红的测试会把发布卡住。代价是整套 2.5s → 7.5s

**E2E 那条外部变更断言也顺手改了**：原先在固定时刻采一次样（壳在 +1.5s 写 marker，探针 +3s 起跑），改成轮询等它到 3 秒。那 1.5 秒够不够取决于机器忙不忙、mermaid 那 2 MB chunk 在不在缓存里 —— 单跑十次全过、整条流水线连跑就偶尔 FAIL，而 FAIL 的是「重载没发生」这种看起来很严重、其实只晚了 200ms 的事

### 上一轮：P4 导出与分发（**已收尾**）

- ~~P4-1 导出 HTML~~ ✅ 单文件产出（样式内联 / mermaid 静态 SVG / 图片可嵌 data: URI / 公式 MathML），菜单「文件 → 导出为 HTML…」⇧⌘E，契约 v15。设计与三处有意差异见上面「功能要点」那条；**最值得记的一点**：导出与实时预览的方言不能漂移，办法不是「写一个更全的导出解析器」，而是**根本不写** —— 全文渲染读的是同一棵 `parsedTree`，块级/行内每一种构件都调编辑器那边已经在用的那个函数。对账断言写在 `test/export.test.ts`（块级拿 `buildBlocks()` 逐类比数目，行内拿 `plainInline()` 比纯文本）与 `release.sh`（每个用例都导一次）
- ~~P4-2 PDF 真分页~~ ✅ 打印导出 HTML（`printOperation` + `NSPrintInfo`），A4/Letter + 三档页边距 + 页码；「导出 PDF 是单页长条」这条已知限制到此消除。四条铁律见上面「功能要点」那条 —— 其中第 3 条（开印前碰一下打印视图就随机印空白页）值得单独记住：它会把另外三条伪装成「偶发」
- **P4 到此为止**：P4-3 复制为 HTML、P4-4 pandoc 桥接、P4-5 签名公证、P4-6③ 窗口提前建，以及整个 P5，于 2026-09-14 决定先不做，条目已从 `ROADMAP.md` 删除

### 上一轮：P3 工作区（**已全部完成**）

- ~~P3-1 收尾（重命名 / 拖拽移动 / 在 Finder 中显示）~~ ✅ 契约 v10 三条通道 + 文件树工具栏（右键之外的第二个入口）。四处坑：① 重命名的自检替身**不能与新建共用一个环境变量**（同名 = 没改，直接返回 null，probe 会一直是 false）；② `expanded` 里存的是绝对路径，改名/搬走一个目录要**按前缀整体重写**，否则整棵子树会收起来；③ 开着的标签要 `retargetTabs(from, to)` 跟着改（目录也要认，按前缀重写），不然下一次保存按旧路径写回去 = 把一个已经不在那儿的文件复活；④ 拖拽结束后紧跟着的那次 `click` 会把文件打开 —— 用一个 `dragged` 标志吃掉它
- ~~P3-2 跨文件全局搜索~~ ✅ 壳侧 `SearchOperation`（可取消、串行）+ `ui/file-search.ts`。字面量与正则**走同一条路**（字面量先 `escapedPattern` 再拼），大小写/整词两个开关因此只有一处实现。三处值得记：① **`token` 丢弃过期批次**；② **两个列**（`col` 跳转 / `textCol` 高亮，见上面「功能要点」）；③ 结果里的相对目录要挡掉 `/private` 前缀（macOS 上 `/tmp`、`/var` 是软链，树根与命中路径可能一边带一边不带，直接 `startsWith` 会把整条绝对路径当成相对段落显示出来）。**别用 `direction: rtl` 让 `text-overflow` 把省略号放到前面** —— 路径开头那个 `/` 是中性字符，双向重排会把它甩到行尾，显示成 `private/tmp/x/`（少了根斜杠，多了个假尾斜杠）；改成在 JS 里从左边截
- ~~P3-4 收尾（护眼 + 自定义皮肤）~~ ✅ 护眼是第三套确定 token（见上面「主题与排版偏好」）；皮肤扫 `themes/*.css`（契约 v12），选中的那份 `<style>` 叠在最后。设置面板里「自定义样式」那一行**单独重建**（`buildCustomRow`）—— 面板可能先于 `userThemes()` 建好，列表一到就刷它，而不是等下次开面板
- ~~P3-7 多窗口~~ ✅ 把原来的 `AppDelegate` 整体改名成 `WindowController`（每窗口一份状态），另起一个只管菜单/最近文件/窗口表的 `AppDelegate` —— 这样 diff 最小，那 260 行消息分发和 700 行探针一行没动。四个点：① 全局 `weak var appDelegate`，窗口侧要回调菜单勾选与「再开一个窗口」；② `windowWillClose` 里注销外部变更监听（fd 会一直占着）并把自己从窗口表摘掉，不摘的话 `key` 还会挑中已经关掉的窗口；③ **窗口位置记忆只给第一个窗口**（`setFrameAutosaveName` 是全局键，多窗口共用会互相覆盖，而且新窗口会精确压在旧窗口上），其余按 macOS 惯例层叠错开；④ 探针只在 `isPrimary` 上跑 —— 它末尾会 `NSApp.terminate`

### 上一轮：P3 工作区（前半）

- ~~P3-3 专注模式 + 打字机模式~~ ✅ `editor/writing-modes.ts`，两个模式共一个 Compartment（`setup.ts` 的 `writingConf`，切换 = reconfigure，与源代码模式同一套）；状态是**全局的、不随标签走**，存 localStorage `cursive.writing`，`writingNow` 当新 state 的种子，`activate()` 里 `syncWriting()` 把冻结的旧配置对齐。菜单「视图」⌥⌘F / ⌥⌘T（避开 ⌘⇧F —— 留给 P3-2 跨文件搜索）
  - **专注单元 = 空行分隔的段落**，纯行扫描、不碰语法树（roadmap 原计划是塞进 live-preview 那个 plugin 省一次遍历，实现下来根本不需要树；额外白拿一条：源代码模式下照样有效）。`focusRange()` 是纯函数，单测直接断言。**光标停在空行上时不向外扩**，否则「段落之间」那一下会把上下两段一起点亮。长文常整章不留空行，上下各限 400 行（视口就几十行，扫更远没意义）
  - **压暗交给 CSS，装饰只发给亮的那几行**：`.cursive-focus`（走 `editorAttributes`，扩展一撤类名自己就没了）+ `.cm-focus-line`。正在就地编辑的表格靠 `.cm-lp-tableview.is-editing` 排除在外（`TableWidget.paintChrome` 打的类，updateDOM 复用 DOM 也刷得到）。选择器要写成 `.cm-editor.cursive-focus …` 才压得过 CM 自己注入的主题（同为两级类选择器时只能靠注入顺序，不能赌）
  - **压暗只改文字颜色，绝不盖 opacity 遮罩**（第一版就是 `.cm-content > * { opacity: .26 }`，用户一眼看出来：「颜色不对，只有焦点才有色，其他地方有遮罩」）。整块压 opacity 会把代码块底色、图片、表格边框、mermaid 线条一起褪灰 —— 要的是「别的段落退后」，不是「别的段落被遮住」。规则写在**没被点亮的那几个**上（`:not(.cm-focus-line, …)`），亮着那行一条规则都不沾，语法高亮色原封不动；反过来写做不到 —— `color` 只有一个值，给亮行「改回去」等于把整行染成同一个色。descendant 那条 `*` 是为了压过 CM 注入的高亮类（单类选择器）。E2E `writingProbe` 现在断言 `dimOpacity == 1`、`imgOpacity == 1`、`litColor != dimColor`，守着别再回到遮罩那版
  - **打字机必须走 CM 自己的滚动目标**（`EditorView.scrollIntoView(head, {y:'start', yMargin: clientHeight*0.42})`），不能手写 `scrollDOM.scrollTop`：CM 在 measure 里有滚动锚定，行高从估算值换成实测值时它会反向补偿 scrollTop 以免画面跳动，把手写的位移抵消掉 —— 症状是**稳定偏 28px、加多少次修正都不动**（试过 8 趟收敛循环，scrollTop 一直变、光标屏幕位置一帧都没动）。dispatch 不能在 `update()` 里同步发（嵌套 dispatch），排到**宏任务**（`setTimeout(…, 0)`）—— 早先排的是 rAF，见下面 P3-8 那条「rAF 在隐藏窗口里停摆」的坑；同一批变更只排一次，`destroy()` 里取消
  - 顶部 42vh 留白（`.cm-editor.cursive-typewriter .cm-content`）是为了文档开头几行也能停到那条线上；底部 40vh 一直都在（`theme.ts` 的 `.cm-scroller`）
  - E2E `writingProbe`：专注类名开关、亮行数、`litColor != dimColor`、`dimOpacity == 1`、`imgOpacity == 1`（守着别再回到遮罩那版）、打字机顶部留白、光标行顶边落在视口 42%（±0.02）。**E2E 一开头就把两个模式摆成「都关着」**（在量任何颜色之前），不只是 writingProbe 自己那一段 —— 它们是持久化的，专注模式开着时代码块高亮会整块压成同一个灰，`codeHl.colors` 那条会莫名其妙地挂。与「每个用例开头清 scratch」同一个道理：用例不该依赖上一轮留下的状态
- ~~P3-6 大纲增强（全项）~~ ✅ 新增 `editor/headings.ts`（取数 + 四个纯函数）、`editor/inline-text.ts`（行内标记表）、`ui/menu.ts`（右键菜单，与文件树共用），`ui/outline.ts` 从 69 行重写。功能与坑见上面「功能要点」里的大纲那条，这里只记做的时候撞上的几处：
  - **两个既有缺陷**：setext 标题不再拖着 `=====`（那行是 `HeaderMark`，剥标记就一起没了），标题里的 `**粗体**`/`` `码` ``/链接/emoji 不再是裸源码。**大纲与 `[TOC]` 从此同一份取数** —— 老的 `collectHeadings` 只认 `ATXHeading`，setext 标题在 `[TOC]` 里整个看不见，而大纲看得见，同一份文档两个目录对不上。`INLINE_MARKS` 收归 `inline-text.ts` 一处，表格格内片段 `cellTokens` 也从那里取，加一种行内语法不会再出现「表格认得、大纲不认」
  - **拖拽重排是整项里唯一会改文档的操作**，必须过保存零损耗：搬完只是同一批字节换了顺序。两个边界会破坏它，`moveSectionSpec` 单独处理 —— 搬走的是**文末那一节**（不带收尾换行）就连它前面那个换行一起搬、补到新位置末尾；搬到**不带收尾换行的文末**就把自己的收尾换行挪到最前面当分隔。单测直接断言「长度不变 + 字符多重集不变」
  - **升降级 ATX 直接借 `fmt.ts`**（造一个「光标停在该标题上」的临时 state 算 changes，与菜单/格式栏同一条命令表）。setext 没法表达 3 级以上：目标 1/2 级只换下划线字符（长度都不变），3–6 级只能整块转成 ATX 写法
  - **改完立刻重建大纲，不等那 450ms 防抖**（scheduleCount 200 + scheduleOutline 250）：每行带的 `pos` 是渲染那一刻的位置，改完还拿旧的那份去算下一次操作，连点两下就搬错一段。防抖是给连续打字用的，这几个是离散命令
  - **`[hidden]` 压不过作者写的 `display:flex`**（它只是 UA 样式表里的一条）—— 过滤框的清空按钮因此在空框里也一直亮着，截图才看出来。补 `.ol-clear[hidden]{display:none}`，E2E 加了 `clearHiddenAtRest`/`clearShownWhenTyped` 两条
  - **拖拽不走 HTML5 拖放**：阈值/落点线/取消都好控，更要紧的是 `DataTransfer` 在无头自检里造不出来 —— 走 mousedown/mousemove/mouseup，E2E 才跑得通整条路径
  - `.ol-item` 现在可以用 flex 了：早先那条「不能用 flex，否则 `text-overflow` 失效」的注释成立是因为标题文字当时直接躺在 `.ol-item` 里会变成匿名 flex item；现在文字有了自己的 `.ol-text`，省略号归它管

- ~~P3-8 状态栏与统计~~ ✅ 新增 `ui/stats.ts`（`cursorLabel` / `selectedText` / `measure` / `statRows` 四个纯函数 + 一个浮层类），`shared/wordcount.ts` 从 2 个字段扩到 5 个 + `shape()`。功能见上面「功能要点」的状态栏那条，这里记三处撞上的坑 —— **后两处都不是 P3-8 自己的问题，是它把既有的隐患顶到了明面上**：
  - **`r.empty` 不等于「有东西选中」**：一次把选区整段吞掉的改写（整理表格 / 大纲搬节 / 覆盖粘贴）之后，CM 的 `SelectionRange.map` 拿 assoc=+1 算 `from`、assoc=−1 算 `to`，**并且不再归一化** —— 留下一个 `from > to` 的倒挂区间，`empty` 是 false 而 `sliceDoc` 是空串。状态栏于是挂出「已选 0 词 · 0 字符」（目检截图才看出来）。判非空一律用 `r.from < r.to`；单测里用公开 API 就能复现（选区两端**严格落在**被替换区间内部，落在边界上只会塌缩）
  - **rAF 在隐藏窗口里整个停摆**：打字机的滚动原先排在 `requestAnimationFrame` 里。窗口被别的窗口整个盖住、或落在另一个全屏 Space 上时，WKWebView 把页面判成 `visibilityState: 'hidden'`，**rAF 一次都不回调**，而 CM 自己的 scrollTarget 照样生效（实测 scrollTop 148 → 1371）—— 于是「光标行归位」单独失效，E2E 量到 `ratio≈2.3` 而不是 0.42，看起来像打字机算错了位置。连跑用例时必现（上一个实例退出把焦点还给终端，新实例在 macOS 26 上抢不回前台；试过 `.floating` + `.canJoinAllSpaces`，拉不回来，已撤），单独跑一个用例又一切正常。改成 `setTimeout(…, 0)`：同样满足「跳出 `update()`」，且不看画面是否在绘。**探针里那条也从「固定等 200ms」改成轮询到位（≤2s）** —— 大跨度滚动本来就要好几帧才收敛
  - **「保存零损耗」那条断言原来在和探针赛跑**：`bytesEqual` 比的是**源文件**与 `roundtrip.out`，而取样（`save(outPath)`）之后的探针还会改文档（大纲的降级/搬节），自动保存 2s 后把改动也写进源文件 —— 于是断言实际成立的条件是「整个探针跑得比 2s 快」，加一个探针就翻车（P3-8 加 statsProbe 时 table.md 真的翻了：源文件成了 `## 表格测试`，outPath 里还是 `#`）。现在探针末尾两步收干净：① 文档恢复成取样时那份（此后任何一次自动保存写的都是同一内容）；② 把源文件显式写回去（盖掉取样后可能已经落盘的那一次）。与探针跑多久无关了
  - E2E `statsProbe`（kitchen-sink）：行列文案、字数条两种形态、面板三列 + 8 行 × 2 个数、**面板不抢焦点**（`selDone` —— 条子上 `mousedown` 要 `preventDefault`，否则焦点一走选区就没了，「选中」那列永远是空的）、Escape 关得掉、取消选区读数复原。面板 `z-index: 400` —— CM 给 `.cm-panels` 的基础样式是 300，写成右键菜单那个 200 的话 ⌘F 开着时面板会被查找条切掉半截

- 顺手修：「视图 → 全屏」原来写的是裸 `"f"`（= ⌘F），与「编辑 → 查找」撞车，AppKit 按菜单顺序取第一个匹配，查找在前 → 全屏那条快捷键**从来没生效过**。改成 macOS 标准的 ⌃⌘F

### 上一轮：P2 手感

- ~~P3-1 文件树增删（一半）~~ ✅ 右键菜单（`ui/sidebar.ts` 的 `.sb-menu`，挂 **body** 上 —— `.sb-tree` 是 `overflow:auto`，挂里面会被裁掉）：新建文件 / 新建文件夹 / 删除。契约 v7 `createFile(dir)` `createFolder(dir)` `trashItem(path)`。**名字由壳弹原生输入框问**（渲染层不碰原生 UI），重名自动加 `-2`；**删除一律 `NSFileManager.trashItem`，不用 `removeItem`** —— 误删能在 Finder 里找回，壳侧先弹确认。三个通道都过 `safeTarget`：消解 `..`、必须绝对路径、必须落在 `treeRoot`（pickFolder 选的文件夹）或当前文档所在目录之下；名字里出现 `/` 直接拒（否则「新建文件」就成了任意路径写入）。增删之后走 `reload()` 整树重读（根 + 所有展开着的目录，浅的先加载）—— 比精确刷新某个父目录笨，但新建目录/删掉展开目录/重名加后缀这些分支一个都不用写。删掉的文件如果开着标签，`closeTab(id, true)` 丢弃关闭：**不能问「是否保存」，一保存就把文件复活了**。`CURSIVE_SMOKE` 下所有模态一律不弹（`runModal` 会把无人值守的自检卡死），名字取 `CURSIVE_SMOKE_NAME`。E2E `treeProbe` 断言工具栏四颗按钮、两份菜单项、新建、重命名、拖拽移动、删除、懒加载展开。重命名 / 拖拽移动 / 在 Finder 中显示已在本轮补齐（契约 v10，见上面「当前这一轮」）
- **两个面板的高亮同一套口径**：不铺满整行，**从文字前方**起、跟着层级缩进一起往右收，比行矮 4px。文件树背景画在 `.sb-item` 上（折叠箭头留在高亮外面 —— 它是控件，不是标签的一部分）；大纲的缩进从 `padding-left` 改成 **`margin-left`**，因为高亮画的就是 `.ol-item` 这个盒子本身，用 padding 只会把文字推走、背景照样铺满。`.ol-item` 仍然**不能用 flex**（自身文本会变成匿名 flex item，`text-overflow: ellipsis` 失效，长标题就不省略了）
- **代码块是一张卡**：`.cm-lp-code` 逐行铺背景 + 左右边框，首尾两行另加 `.cm-lp-code-open` / `-close`（`decorate.ts` 的 `edgeLine`，从 node 自己的范围算 —— `addLines` 会按视口裁剪，拿不到真正的首尾行）补上圆角、上下边框和内边距。**为什么不用块级 widget 包起来**：那样整块成了替换装饰，代码块里就没法打字了。围栏行保留可见但压到 0.72em + `--mark-idle`，当卡片的上下边用；语言名已经在 ```lang 上，`.cm-lp-codebar-lang` 因此隐藏，右上角只留复制按钮
- ~~P2-8 底部悬浮格式栏~~ ✅ `ui/format-bar.ts`：贴**编辑区**（#center，不是窗口）底部居中的胶囊条 —— 块类型下拉（正文/标题 1-6，显示当前块名）+ 行内 6 键 + 块级 5 键。**它只是 P2-1 那张命令表的第三个入口**，零编辑逻辑：点按钮 = 派 `fmt:*`，和菜单同一条路，幂等/多光标/一次 ⌘Z 全白拿。四个必须知道的点：① 条子上 `mousedown` 一律 `preventDefault`，否则焦点离开编辑器、选区没了，命令就作用错地方；② 它盖在正文上，`setup.ts` 的 `bottomOverlay` 通过 `EditorView.scrollMargins` 给滚动让出等高下边距，否则光标打到底部会躲到条子后面；③ 查找面板也是贴底的（`search({top:false})`），`syncFormatBarOffset()` 每次 update 量一下 `.cm-panels-bottom` 的高度把条子抬上去；④ 高亮由 `fmt.ts` 的 `formatStateAt()` 算，**必须与 emitForRange/emitOnLine 同源** —— 亮着的按钮点下去就得是「取消」。**显隐是两级的**：「视图」菜单那个开关管**有没有这条工具栏**（`view:toggle-format-bar`，不给快捷键，`is-hidden`，连手柄一起收，状态存 localStorage `cursive.formatBar`）；条子右端那颗折角管**摊开还是收起**（`is-collapsed`，只剩一颗 46×20 的手柄贴在原地，存 `cursive.formatBarFold`）—— 「把底下这条让开」是写字时的常用动作，不该每次去翻菜单。`bottomOverlay.height` 因此是三态：关掉 0 / 收起 `FORMAT_BAR_COLLAPSED_SPACE` / 摊开 `FORMAT_BAR_SPACE`，漏一态就会「收起来了正文底下还空着一条」。条子**贴着状态栏坐**（下沿 6px，原来是 18px）：它是压在正文上的浮层，离底越近压住的正文越少
- **P2-9 命令表补齐**（`fmt.ts` + 格式栏 + 格式菜单三处同步）：P2-1 那张表停在 18 条，而 P1-3 的方言和 P2-6 的表格编辑器之后长出来的东西一直没有任何入口。补的分两类 —— **① 行内开关 4 个**（`==高亮==` ⇧⌘H / `^上标^` ⌃⌘= / `~下标~` ⌃⌘- / `$行内公式$` ⌃⌘M），与原来那五个完全同构，`~` 与 `~~`、`$` 与 `$$` 的区分靠 `isWrapped` 里那条 `runIs`（P2-8 为 `*`/`**` 加的，白拿）；**② 插入类 8 个**（表格 ⌃⌘T / 图片 / 分隔线 / 公式块 / 告示块 / 流程图 / 脚注 / 目录），**不是开关**，走 `makeFormatSpec` 里单独的 `insert` 分支：只认主选区（多光标插三张表没意义）、不保留选区、块级骨架由 `blockSlot` 保证独占一段（`---` 紧贴文字会变成 setext 二级标题，不是分隔线）。插表格顺带发 `setTableEdit`，新表直接以渲染态出现、焦点已在第一格（与 input-rules 的表格骨架同一条路）；脚注是两处改动（光标插引用 + 文末插定义，编号取现有数字标签 max+1）。**UI 上开关与插入分开摆**：条子那一排全是开关，插入收进右端「插入」下拉 —— 它们永远不会点亮，混进同一排会让人以为坏了，而且条子早就是 `overflow-x:auto`。两个下拉互斥、各自 `position:absolute` 贴住自己那端（排进 flow 会在张开时把 bottom 锚定的条子整体顶上去）。顺序真相在 `fmt.ts` 的 `INSERT_ACTIONS`，UI 那一半写成 `Record<(typeof INSERT_ACTIONS)[number], …>`，漏配一条当场 typecheck 不过
- **格式栏顺手修掉的两个老坑**（都是 P2-1 就有、被工具栏摆到明面上的）：① 光标停在已加粗的词里再按 ⌘B 会套成 `****词****` —— 无选区那条路只看「光标所在词」，中文分词还会把 `**粗体**` 里的词切开，词边界根本碰不到星号。改成 `enclosingWrap()`：先在行内找把光标夹住的那对定界符，找不到才退回词。② `*` 会认领 `**粗体**`（B 和 I 一起亮，⌘I 还把它啃成 `*粗体*`）—— `isWrapped` 现在要求这一串同字符标记的长度**恰好**等于定界符长度（`runIs`）
- ~~P2-1 格式化命令 +「格式」菜单~~ ✅ 菜单「格式」15 项（粗/斜/下划线/删除线/行内码/链接/标题1-6/正文/代码块/引用/无序·有序列表/任务项）→ `menu` 通道 → `MenuAction` 的 `fmt:*` → `editor/fmt.ts` 的 `applyFormat`。⌘ 组合一律走原生菜单（判断 1）
  - **一次 dispatch 落一笔**：所有 changes + 新选区放进同一个事务 → ⌘Z 一步撤回；多选区每个 range 独立判开/关
  - **幂等**：已有同种格式 → 本次切换摘掉；`isWrapped` **只看选区内部首尾定界符**（不能向前 range 外取，doc 开头 from=0 会越界判失败）
  - **选区映射用 `ChangeSet.mapPos`**：手写位移图在「删除+插入」混合时混用原始/位移后坐标，会把选区映射到文档尾之外（Selection outside）；from 取 assoc -1、to 取 +1，才能把插入的定界符包进选区供下次幂等判定
  - **无选区**：光标落在词内才作用于该词（`Intl.Segmenter` 分词，中文按词切）；词外（空格/标点）→ 插空对，不偷偷包旁边的词
  - **测试坑**：纯 `EditorState.create` 默认**关多选区**，多光标用例必须显式 `EditorState.allowMultipleSelections.of(true)`，否则 `selection.ranges` 被折成单个
  - 代码块围栏摘除要连**闭围栏前的换行**一起吃掉，否则留下 `code\n`
- ~~P2-2 输入规则~~ ✅ `editor/input-rules.ts`：Enter 时表格骨架（`| a | b |` → 补分隔行+空行）与围栏骨架（` ```ts ` → 补空行+闭合围栏）；标题/引用/列表/分隔线的即时渲染由 live-preview 负责、续行由 markdownKeymap 负责，不重复造。一次事务 → ⌘Z 一步撤销
  - 围栏「是否已闭合」判定要 `gm` 正则逐行数围栏（无 `m` 时 `^` 只匹配串首，永远数不到第二个）
- ~~P2-3 列表智能~~ ✅ `editor/list-ops.ts`：Tab/⇧Tab 升降级（列表上下文优先于 indentWithTab），有序列表**向前向后扩到段边界**后整段重编号（只向后找会漏前半段），保留 `)` 分隔符风格；每行一条前缀替换 change → 缩进与重编号同一事务、不重叠。回车续行/空项退出/任务项续 `[ ]` 仍归 markdownKeymap
- ~~P2-4 智能粘贴~~ ✅ `editor/paste.ts`（`EditorView.domEventHandlers.paste`）：网页/飞书/Notion 的 HTML → turndown 转 Markdown（强调符统一 `*`/`**`，补 `~~` 删除线规则）；选中文字粘 URL → 包成 `[文字](url)`；⇧⌥⌘V 粘贴为纯文本走原生菜单 + 壳读剪贴板
  - **「粘什么」的判定**：转换结果与 plain 一致就用 plain（本编辑器自复制时不往返、不损失），不同才用转换结果；convert 注入以便 node 单测
  - **turndown 按需加载**（P4-6②）：只有「粘一段 HTML」才用得上它，首屏不背。事件处理器不能是异步的，所以**先 `preventDefault()`（这一刻已经决定自己接管了）再等模块到手**，插入晚一拍 —— 第一次粘贴多花一次本地 chunk 加载，之后一直在手
  - 契约 v4：`readClipboardText()`（`NSPasteboard.general.string`，剪贴板由壳读 — 判断 3）
- ~~P2-7 查找替换本地化~~ ✅ 查找面板走 `EditorState.phrases` 中文化；⌘G/⇧⌘G 走原生「编辑」菜单（判断 1）→ `findNext`/`findPrevious`；状态栏加 `#status-match` 显示「第 n 处 / 共 N 处」
  - **坑**：查找输入改的是 state **effect**，不是 docChanged/selectionSet —— 计数刷新必须挂在「每次 update」上，否则输完查询计数不更新
- ~~P2-5 图片粘贴落盘（粘贴部分）~~ ✅ 截图 ⌘V → 壳从 `NSPasteboard` 取图（PNG，退化走 TIFF）落盘到 `<docDir>/assets/<文档名>-<时间戳>.png`，只回相对路径，渲染层插 `![名](assets/…)`。契约 v5 `pasteImage(docDir)`
  - **坑（新增 API 必查）**：壳注入的 `window.api` 是 `callMethods` **白名单**，Swift 的 `switch` 加了 case 还不够 —— 漏加白名单时渲染层调用报 “not a function”，且只在真正触发时才发现。`readClipboardText` 当初就漏了，是 E2E 抓出来的
  - **拖拽一并完成**：`MainWebView` 注册 `.fileURL`，`handleDroppedFiles` 分流 —— .md/.markdown → `openPath`（开新标签）；图片 → `copyImageToAssets`（重名加 `-N`）后 `emit('image:dropped', relPath)`，渲染层 `onImageDropped` 在光标处插链接（契约 v6）
  - **坑（新增推送通道必查）**：壳注入脚本里 `listeners` 是**固定键注册表** —— 新事件只加 `window.api.onXxx` 不够，还要在 `const listeners = {…}` 里占位，否则 `subscribe` 抛 `undefined is not an object (.push)`。与 `callMethods` 白名单同类，两处都要动
  - 图数据不过 IPC 桥（判断 3）

### 动手前必读的四个判断（`ROADMAP.md` 第二节展开）

1. **⌘ 快捷键走原生菜单，不要走 CM keymap** —— `MainWebView.performKeyEquivalent` 对所有 ⌘ 事件返回 false。菜单里没有的 ⌘ 组合能否落回 CodeMirror 未实测；⌘B/⌘1-6 一律做成「格式」菜单项 + 扩 `MenuAction`
2. **块级组件一律照抄 `tableField`** —— StateField 提供块级装饰，ViewPlugin 会直接报错
3. **大数据不过 IPC 桥** —— 图片落盘由壳读 `NSPasteboard` 返回相对路径，别把 base64 塞进 `evaluateJavaScript`
4. **编辑器里的「态」不写回文档** —— 折叠、表格光标、查找命中都是「看的人此刻的状态」，写回去当场破掉保存零损耗。照抄 `editor/callout.ts` 的 `calloutFoldField`；要跨会话记住的走 `ui/session.ts`

原第 6/7 条（Sparkle 自动更新、显示质量打磨）已在 0.3.0 结清：自动更新**有意不做**（见 `ROADMAP.md` 第三节），显示质量那条随主题系统落地。

## 约定

- 壳代码放 `shell-swift/`，单文件渐进；**优先 AppKit，不用 SwiftUI**
- 不改 `src/renderer` / `src/shared` 的接口；壳侧发现契约缺口，先补本文件再动代码
- 改完壳必跑探针自检；涉及保存路径的改动要同时验证 BOM/CRLF 指纹还原
