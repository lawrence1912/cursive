# 表格就地编辑（P2-6）

> 面向改这块代码的人。**为什么这么写**在这里，**写成什么样**看
> `src/renderer/editor/live-preview/table.ts`。
>
> 上半场 = 就地编辑（点进格子直接改字）；下半场 = 底部浮动工具栏 / 悬停手柄 /
> 格内行内语法 / 「整理对齐」。两半共用同一批纯函数，见最后一节。

## 问题

表格一直是块级渲染成真表格的（`blockField` → `TableWidget`），但**光标一碰到就整块换回
`| a | b |` 源码** —— 这是 live-preview 的通用 reveal 规则（`reveal.ts`）。于是「想改表格」
在体感上等于「表格消失、变成一堆竖线」。旧的点击路径 `editTableOnClick` 做的正是这件事：
把光标送进源码里对应的那一格，靠 reveal 顺势把整块换成源码再让用户打字。

## 路线选择：为什么不抄 nomo

参考实现 nomo（Tauri + ProseMirror + prosemirror-tables）：表格永远是真表格，打字只改 PM 文档，
markdown 是**惰性反推**出来的，所以表格从不回落源码、光标也不跳。

代价在序列化那头 —— `serializeTable()` 把整张表重写成 `| ${cells.join(' | ')} |`：

- 手工对齐的列宽（`| 姓名     | 年龄 |`）**一次编辑全部压成单空格**
- 分隔行永远重写，无对齐的 `---` 会变成 `:---`
- 破行的行补齐空格子

cursive 有「**保存零损耗**（字节不变，E2E 有断言）」这条硬约束，对标矩阵里这是相对同类编辑器的唯一净胜项，不能为了表格丢掉。所以：**手感抄 nomo，实现不抄** —— 不走「AST 往返」，
走「只替换那一格的源码片段」。副作用是 nomo 那个「改一格整表 diff」的毛病顺手躲掉了。

## 关键机制：widget 里的 contenteditable 单元格

地基是「块级 widget 内部开一个可编辑岛」。CM6 对这件事是有明确支持的，下面每条都在
`node_modules/@codemirror/view@6.43.11/dist/index.js` 里逐条核过（行号是那个版本的）：

| 事实 | 位置 | 意味着 |
|---|---|---|
| `readMutation`：命中 widget tile 一律 `return null` | `:7468` | 格子里的 DOM 改动**不会**被当成编辑写回文档 —— 浏览器可以随便改我们的格子 |
| `onSelectionChange`：`root.activeElement != contentDOM` 直接 return | `:7236` | 焦点在格子里时，选区变化不会被 CM 读走 → **不会触发 reveal** |
| `DocView.updateSelection`：`focused / fromPointer / selectionNotFocus` 全不成立就 return | `:3036` | CM 不会反过来抢格子里的光标 |
| `hasFocus` 要求 `activeElement == contentDOM` | `:8606` | 编辑格子时 `.cm-focused` 为假 → drawSelection 画的假光标自动隐藏，不会双光标 |
| `hideNativeSelection`：`.cm-content & :focus { caret-color: initial !important }` | `:9607` | 聚焦格子里的**原生光标本来就可见**，不用额外抢；但选区底色会被顶成系统 `Highlight`，要自己覆盖回 `--sel` |
| `findWidget` pass1：同构造函数 + `updateDOM() === true` 就复用 DOM | `:2556` | 只要实现 `updateDOM`，每次 dispatch 后 **DOM 不重建 → 焦点和光标不丢** |
| `WidgetTile.of`：给 widget 根节点写死 `contentEditable = "false"` | `:2155` | 根不可编辑、格子单独开 `contenteditable="plaintext-only"` = 编辑岛，WebKit 原生支持 |
| `handleEvent` → `eventBelongsToEditor`：widget 的 `ignoreEvent()` 为真则 CM 的 handler/observer **全部**跳过 | `:4552` `:4867` | 格子里的按键不进 CM keymap（Tab 不缩进、回车不插行），代价是 **⌘Z 得自己转发** |

所以 `TableWidget.ignoreEvent` 从「只放行 mousedown」改成 **全部忽略**（默认值），
事件全部由 widget 自己在 `toDOM` 里挂的监听处理；`editTableOnClick` 整个删掉。

## 状态模型：CM 选区就是「正在编辑哪一格」的唯一真相

- `tableEditField: StateField<number | null>` 存**正在编辑的表格块起点**（随 changes 映射）。
- 进入编辑 = `dispatch({ selection: { anchor: 该格源码位置 }, effects: setTableEdit.of(tableFrom) })`。
- 字段的更新规则：带 `setTableEdit` 就照它走；否则**任何 `docChanged || tr.selection` 的事务都清空它**。
  于是 widget 自己发的每一笔事务都必须重新带上这个 effect —— 换来的是「切标签回来、
  state 里还留着旧编辑态」那类悬空自动消失。
- `buildBlocks()`：`editing = (tableEditFrom === node.from)`，为真就**跳过 reveal 判定**照常出 widget；
  `decorate.ts` 的 `Table` 分支同理（`revealed && !editing` 才铺 `.cm-lp-table` 行样式）。
- widget 只是把选区**镜像**成 DOM 焦点：`active = {row, col, offset}` 由选区 head 反算。
  于是「点击 / Tab / 方向键进表」三条路径统一成同一件事 —— **移动 CM 选区**，聚焦交给 `updateDOM`。

> 取字段必须写 `state.field(tableEditField, false)`（允许缺失）：`test/block.test.ts` 调
> `buildBlocks` 时只装了 `cursiveMarkdown()`，没装 `livePreview()`，直接 `state.field(f)` 会抛。

## 写回：只替换那一格

`cellSpan()` 算出「行内第 n 格文字」的区间，写回就是一次
`changes: { from: line.from + span.from, to: line.from + span.to, insert: 转义后的文本 }`。

```
| a        | b    | c      |     改第一格 a → a2
| a2        | b    | c      |    只动了 a 那一个字符，后面的 padding 原样保留
```

源码里的列宽会因此变得参差 —— 但用户看的是渲染态，而文件的其余字节一个没动。
「整理对齐」留作以后的显式命令，**不自动跑**。

`escapeCell()` 负责把 `|` 转成 `\|`、换行压成空格、首尾 trim —— 格内粘贴多行文本时全靠它兜。

## 键盘语义

| 键 | 行为 |
|---|---|
| Tab / ⇧Tab | 下一格 / 上一格；**末格 Tab 自动新建一行**并进首格；首格 ⇧Tab 进入工具栏 |
| 工具栏 ← / →、Home / End | 切换可用按钮；Esc 返回当前格，末按钮 Tab 也返回当前格 |
| Enter | 同列下一行；末行则新建一行 |
| ↑ / ↓ | 同列换行；出界则退出表格，光标落到表格前/后一行并 `view.focus()` |
| ← / → | 只在格首 / 格尾时跨格，其余交给浏览器原生移动光标 |
| Esc | 清空 `tableEditField` → 整块回显管道符源码，光标停在刚才那一格（**保留的逃生口**） |
| ⌘Z / ⇧⌘Z | **归菜单**：`edit:undo`/`edit:redo` → 渲染层调 CM 的 `undo`/`redo`。widget 里那两条转发（keydown、`beforeinput` 的 historyUndo）留着当兜底，见下 |

从表格**外面**用方向键走进来（↓/→ 撞上块首、↑/← 撞上块尾）也进单元格，判定直接查
`blockField` 里那个位置的 widget 是不是 `TableWidget`。

> **⌘Z 为什么不能由格子自己接**（0.4.0 修）：判断 1 说带 ⌘ 的键全归菜单系统，
> 而「编辑」菜单里那条撤销原先挂 AppKit 的 `undo:` —— 撤的是 **WebKit 自己那套 DOM 编辑撤销栈**。
> 表格一改结构，`updateDOM` 会把整张表的格子重建（`buildRows`），WebKit 栈顶那条记录指着的
> 元素当场没了：它**既不派 `beforeinput` 也不做事**，而 `canUndo` 还是真 —— 菜单项照亮、
> 照吃 ⌘Z，一按下去一点反应都没有（「在格子里打过字之后回车加一行，⌘Z 失灵」，偶发）。
> 现在撤销走 `MenuAction`，格子里那两条转发退成兜底。E2E 的 `tableEdit.undoRound` 复刻整个现场。

> **不用 `EditorView.atomicRanges`**：那是全体块级 widget 的总开关，会顺带让数学块 / mermaid /
> 脚注定义再也用方向键进不去。表格只需要 4 个键的拦截，套 `Prec.high()` 排在 `defaultKeymap` 前面即可。

## 与其它功能的交汇点

- **P2-2 表格骨架**（`input-rules.ts` `expandTableOnEnter`）：补出骨架的那一笔顺手带
  `setTableEdit`，新表格立刻以渲染态出现、光标直接进第一格。源代码模式下没有这个字段，
  CM 会原样忽略该 effect，安全。
- **P2-1 格式化菜单**（`fmt.ts` `applyFormat`）：走原生菜单 → 直接读 `view.state` 派事务，
  **不经过 CM keydown**，所以焦点在格子里照样能用（ROADMAP 判断 1 的红利）。前提是格内光标
  要同步回 CM 选区（widget 在 `keyup` / `mouseup` 上做），否则 ⌘B 会作用到陈旧的位置。
- **P2-4 智能粘贴**（`paste.ts`）：`smartPaste()` 是 CM 的 domEventHandler，在格子里不触发，
  格内粘贴退化成原生纯文本粘贴，多行由 `escapeCell` 压成一行。已知取舍。
- **P2-3 列表 Tab / `indentWithTab`**：主 keymap 在格子里根本不触发，与表格的 Tab 互不感知。

## 风险与兜底

1. **CM 把别的表格的 DOM 抢去复用**（`findWidget` pass1 会拿所有同类 widget 的 DOM 来试）
   → `updateDOM` 第一行守 `this.editing !== dom.contains(document.activeElement)` 就 `return false`：
   正在编辑的 widget 只认「焦点在里面」那一份 DOM，反之亦然。最坏退化成重建 DOM（掉焦点），
   不会串内容。
2. **IME 中文连打** → `input` 里 `isComposing` 跳过、`compositionend` 再写；`updateDOM` 不碰
   正在合成的那一格。和 `livePreviewPlugin` 里现有的 `wasComposing` 是同一类处理。
3. **表格正在被打出来的时候**（`|a|b|` 还没打完分隔行）→ 那时还不是 `Table` 节点；成为 `Table`
   的瞬间光标在里面但 `tableEditField` 是空的 → 走原来的 reveal 显示源码，用户继续打字不受影响。
   **这是刻意保留的**，否则光标会被困在一个看不见的替换区间里。
4. **焦点不在编辑器时的表格**（点了文件树 / 大纲）→ `tableEditField` 不因失焦而清空，
   表格保持渲染态；等用户点回正文，选区一动字段自然清空。
5. **文档一打开光标就已经在表里**（0.4.0 修）→ `createState` 末尾的 `adoptTableAtCursor`
   认一次光标，在里面就直接进编辑态。有两条**谁都没按过键**的路径会这样：文档**以表格开头**
   （新 state 的光标就在 0，正落在块首）、以及**会话恢复**（上次停在表里的位置原样放回去）。
   两条都不经过点击/方向键那些会发 `setTableEdit` 的入口，不认这一次的话整张表以
   `| --- |` 源码开门 —— 这就是「表格打开的时候是源码」那个毛病。

   **只在文档刚出现那一刻认**，不能改成「光标进表就进编辑态」：上面判断 3 和 Esc 逃生口
   都是「光标在表里但没有编辑态、而且必须留在源码里」，与这一条只能靠时机区分。
   会话恢复因此要把光标**在建 state 时**就给进去（`EditorOptions.cursor`）——
   建完再 `update` 一次选区就已经错过了这一刻。

## 下半场：工具栏 / 手柄 / 格内语法 / 整理对齐

### 结构改写一律是纯函数

`insertColAt` / `deleteCol` / `deleteRow` / `setAlign` / `tidyTable` / `deleteTable` 全部是
`(state, tableFrom, …) -> TransactionSpec | null`，不碰 DOM。于是：

- 工具栏按钮、悬停手柄、以后的菜单项**共用同一批函数**，不会各写一遍各错一遍；
- 单测（`test/table.test.ts`）能直接断言源码文本，不用起浏览器；
- 撤销栈、保存零损耗全都自动成立 —— 它们本来就只认「一次 dispatch」。

改写的口径与 `writeCell` 一致：**只动该动的那几个字节**。增删列在「槽位边界」插入或删除
（`slots()` 给的是两根竖线之间的整段，含 padding），其余列一个字节不动；整列对齐只改分隔行
那一格，而且**冒号是从破折号里换出来的**（`:-------` ↔ `-------:` 同宽），否则每点一次对齐
源码就宽一格。

两个刻意的例外，都是「用户明确要求的重排」：

- **`tidyTable`（整理对齐）** —— 唯一会重写整块的操作。按 `displayWidth()`（CJK 算 2 列）
  把所有列补到等宽。**永不自动跑**，只在按下工具栏那颗「整理」时发生；算出来和原文一样就
  返回 null，所以幂等、也不会产生空事务。
- **追加末列时补一根尾边界竖线** —— `a | b` 这种没有尾边界的写法里，空的末格根本不可表达
  （`splitRow` 会把结尾那根竖线当边界吃掉），只能补上。

### 底部浮动工具栏

`absolute; top: 100%` 挂在表格下沿 —— **出现和消失都不把正文顶动一行**。只在就地编辑时
`hidden = false`。按钮的置灰/高亮由 `TableWidget.paintChrome` 从**widget 自己那份数据**算
（`updateDOM` 拿不到 `view`，这也是 `TableData` 必须是纯数据的原因）。

两个必须记住的细节：

1. 按钮上 `mousedown` 一律 `preventDefault()`。焦点一旦离开格子，编辑态就散了，工具栏会在
   自己被点中的那一瞬间消失。
2. 点击时**重新从 `view.state` 现算** `tableAt()` + `activeCellAt()`，不吃 widget 实例里的
   旧数据 —— 与 `wire()` 里所有事件同一条铁律。

### 悬停 +/− 手柄

鼠标扫到哪一格，就在那一列的上边框、那一行的左边框上各浮一颗药丸（`＋` 插入 / `−` 删除），
位置用 `getBoundingClientRect` 现算，横向滚动和列宽变化都自动跟上；`updateDOM` 里
`moveHandles()` 负责表格重排后把它们挪到新位置，那一格没了就收起来。整层 `pointer-events: none`，
只有药丸自己 `auto` —— 否则鼠标扫过表格就点不进格子了。表头那一行的 `−` 直接不出现。

### 格内行内语法

渲染态的格子里 `**粗体**` 就是粗体，`$x^2$` 是公式，`:smile:` 是表情 —— 正在编辑的那一格
仍然显示源码（`richAt()` 对当前格返回 null）。

片段（`CellToken[]`）由 `cellTokens()` 从**文档自己的语法树**上采，不是另写一个小解析器：
格里的方言与正文永远一致，不会出现「正文认得、格子不认」的漂移（P4-1 导出那条点名的风险，
在这里提前躲掉）。`RICH_RE` 先扫一眼有没有可能的语法字符，绝大多数纯文本格子连树都不用遍历。

三个坑：

- DOM 文字 ≠ 源码，所以 `fillCell` 对渲染态的格子拿 `data-rich` 记住的源码来比，
  对源码态的格子仍然拿 DOM 现有文字比（用户刚敲进去的字不能被重写）；
- 点进渲染态的格子要把 DOM 光标折回源码偏移 —— 每个片段外层的 `<span data-at>` 就是为这个，
  `caretOffset()` 读它；
- 格内链接**不写 `href`**：格子在 contenteditable 里，真 href 一点就把 WebView 导航走了。
  URL 存在 `data-href`，⌘/Ctrl + 点击由 `wire()` 走 `openExternal`，和正文同一条路。

### 程序性聚焦要挡住 focusin

`focusCell()` 置 `syncing` 标志再 `focus() + placeCaret()`。不挡的话跟着来的那发 `focusin` 会
拿「刚聚焦、还没放光标」的偏移 0 反过来改选区，⇧Tab 想停在格尾就永远停不住。

## 验收

```sh
npm run typecheck && npx vitest run
./shell-swift/release.sh          # table.md 那条是主战场
```

E2E（`shell-swift/main.swift` 的 `tableEdit` / `handles` 探针）断言的是：点进单元格后
**表格还在**（不是回落源码）、`activeElement` 是那个 td、改完之后同一行**其余列的 padding
一字不动**（这一条就是这套方案相对 nomo 的全部意义）；工具栏露面、「下插行」真加了一行、
「整列居中」写进了分隔行、「整理」之后每一行的**显示宽度一致**（壳外用 Python 的
`east_asian_width` 核）、`**粗体**` 渲染成了 `<strong>`、悬停之后两颗药丸都在。

`tableEdit.undoRound` 单守撤销那条路（0.4.0 修）：在**末行**那一格里打一个字（WebKit 的编辑
撤销栈因此压着一条真记录 —— 这是「偶发」的另一半）→ 回车加一行（整张表的格子重建，那条记录
当场作废）→ 走菜单 `edit:undo` / `edit:redo`。断言是「撤销逐字节回到加行之前、**只撤那一行**
（打的字还在）、重做拿得回来、表格还留在渲染态」。单测那一半在 `test/table.test.ts` 的
「表格里的撤销」（八个动作逐个：改了 → 一步撤回原样）。

`CURSIVE_SMOKE_SHOT=<路径>` 截的图里能直接看到工具栏与手柄（探针最后会把光标放回第一格
并补一次 mouseover，就是为了目检这两样）。
