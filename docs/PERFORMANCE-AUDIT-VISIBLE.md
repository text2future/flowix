# Flowix 性能审查 · 独立复核（肉眼可见问题）

审查日期：2026-10-19
范围：`app/flowix-web`、`app/flowix-desktop`、`app/flowix-core`、`app/flowix-sync`
方法：纯静态阅读 + 当前构建产物（`.build/web-dist`，2026-10-19 21:58）度量。**没有运行时 profiling**，所有结论都附代码位置，可逐条复核。

本文与 `docs/PERFORMANCE-REVIEW.md` 的关系：那份文档是修复流水账（八批）。本文是一次独立复核，不重复已修项，只回答两件事——**哪些旧结论还成立**、**哪些问题还没被记录**。

> **状态更新（2026-11-10）**：本文记录的 Worker 解析链路已移除 ——
> `features/editor/markdown-parser.worker.ts`、`markdown-worker-dom.ts`、
> `markdown-parser-extensions.ts`、`markdown-parser.ts` 均已删除，编辑器现在在
> `new Editor({ content, contentType: 'markdown' })` 里同步解析（主线程），
> `initialParsedContent` 预解析入口同时移除。因此文中"Worker 主动抛错把活推回主线程"
> 一节已经失效。若要恢复 Worker 隔离，注意解析结果体积（400 KB 列表型文档的 JSON doc
> 是 3.4 MB，结构化克隆的反序列化仍在主线程）。

---

## 0. 结论速览

| 体感症状 | 根因 | 优先级 | 状态 |
| --- | --- | --- | --- |
| 首屏白屏偏长、冷启动慢 | 入口 CSS 单文件 442 KB 阻塞渲染；zh-CN 文案 126 KB 进主包 | P1 | 未改 |
| 大笔记打开明显变慢 | 解析随块数二次增长（96 KB 分块文档 113 ms，同大小单块 1 ms） | P1 | 已修 |
| 打开某些笔记整窗定住 | worker 拒收（卡片 / 原始 HTML）→ 回退主线程同步解析整篇 | P2 | 已修 |
| 打开笔记固定多付一遍词法 | `containsRawHtmlToken` 先完整 lex，`parse` 再 lex 一次 | P2 | 已修（随上条移除） |
| 笔记 A→B→A 反复切换，每次都重新解析 | 解析结果无跨文档缓存，用完即释放 | P2 | 新发现 |
| 云同步时界面偶发发涩 | 状态栏 1 秒一次同步 IPC，命令跑主线程并新建 SQLite 连接 | P2 | 新发现 |
| 拖拽块排序时掉帧 | 每帧遍历全文档列表项 + 逐项 `getBoundingClientRect` | P2 | 未改 |
| 大目录翻页慢 | 每页完整 `readdir` 再截断 | P1 | 未改 |

**一句话**：历史八批该修的确实修好了（见 §4）。现在"肉眼可见"的剩余问题不在渲染管线的算法上，而是集中在 **首屏资源**、**笔记打开路径的主线程回退**、以及 **几个每秒级的小轮询/重复序列化**。

---

## 1. 当前启动资源实测

用 `.build/web-dist/.vite/manifest.json` 展开**静态 import 闭包**（不含动态 import）：

| 指标 | raw | gzip |
| --- | --- | --- |
| JS（`index.html` + `app/main-window/main-window.tsx` 闭包，8 个 chunk） | 1,102 KB | **334 KB** |
| 入口 CSS（单文件 `index-Dt_pGGtG.css`） | 442 KB | **63 KB** |

参考：比修复文档记录的 457 KB gzip 启动 JS 明显下降，说明后续拆分生效了。现在**CSS 已经成为首屏最大的单块静态资源**。

构成（源码侧，共 509 KB）：

```
styles/index.css 一次 @import 了：
  editor.css 63K / editor-frontmatter.css 36K / multidimensional-table.css 23K
  editor-code-block.css 22K / pdf-print.css 22K / editor-mermaid / editor-attachment-link ...
  theme/{light,dark,rock,mist,ember}.css  ← 5 套主题全部进首屏
  fonts.css（16 个 @font-face，Inter 6 个字重）
```

`styles/index.css:15-46`。这些都是 `<link rel=stylesheet>` 阻塞首帧的资源，编辑器/表格/PDF 打印在首屏一个都用不到。

---

## 2. 新发现（既有文档未覆盖）

### 2.1 卡片 / 原始 HTML 的笔记回退到主线程同步解析（已实测确认）

> 本节结论来自真实 `markdown-parser.worker` 模块 + 真实扩展集的运行测试，不是静态推断。初版报告里"表格引用 / 媒体库引用也会触发"的判断**是错的**，已按实测修正。

**触发面（逐个形态实测）**

| 笔记内容 | worker 结果 |
| --- | --- |
| 普通 markdown、管道表格、公式、任务列表 | 通过 |
| `<!-- flowix:table-reference ... -->` | 通过（扩展 tokenizer 已消费） |
| `<!-- flowix:media-library-reference ... -->` | 通过（同上） |
| `<!-- flowix:table ... -->` / `<!-- flowix:media ... -->` | 通过（同上） |
| **AI 对话卡片**（`<!-- flowix:agent-thread-card ... -->` 与旧 `::agent-thread-card{`） | **拒收**：worker 注册表里没有该扩展 |
| **任意原始 HTML**：`<div>` `<span>` `<br>` `<img>` `<!-- 普通注释 -->` | **拒收**：lexer 产出 `html` token |

**代码链三处**

1. `features/editor/markdown-parser.worker.ts:35-41` 主动抛错，把活推回主线程；
2. `document-container.tsx:200-205` 把失败当成"没有预解析结果"（`finishWith(null, ...)`）；
3. `markdown-editor.tsx:702-703` 拿到 `undefined` 就 `contentType: 'markdown'`，由 `new Editor()` 同步解析整篇。

**成本（node 环境，非 jsdom）**

| 笔记大小 | 主线程解析 |
| --- | --- |
| 24 KB | 8 ms |
| 49 KB | 24 ms |
| 96 KB | 79 ms |
| 191 KB | 298 ms |

**修正后的判断**：机制真实，触发面也广（本机实测：278 篇笔记里 51 篇含原始 HTML；另一笔记本 111 篇里 86 篇含对话卡片），但**"整窗定住"只在大笔记成立**。典型笔记 1–50 KB 对应 5–30 ms，感知不到；≥150 KB 才会进入 100 ms–1 s 的阻塞区间。它应该从 P1 降到 **P2**，真正的 P1 是下面的二次复杂度。

**修复：已落地（2026-10-19），三步**

1. **补 3 个节点**：`createMarkdownParserExtensions()` 缺 `TableRow / TableHeader / TableCell`，而 `FlowixTable` 的 content 表达式要求 `tableRow+`，所以 worker 的 HTML 路径一建 schema 就抛 `No node type or group 'tableRow' found`。补上后 `<div>/<span>/<br>/<img>/<!-- -->` 全部能在 worker 里解析，输出与主线程路径**逐字节一致**。
2. **把卡片 spec 搬进 worker**：新增 `agent-thread-card-markdown-spec.ts`，把 `markdownTokenizer / parseMarkdown / renderMarkdown` 从 NodeView 文件里抽出来，主编辑器用 `...agentThreadCardMarkdownSpec` 复用（`table-reference-node.tsx:302` 已是这个模式），worker 注册 `AgentThreadCardMarkdownExtension`。新旧两种卡片写法都能产出 `agentThreadCard` 节点。
3. **"接受过滤"兜底**：删掉两个 `throw`，worker 改为 `try { parse } catch { 把 html token 折成纯文本重试一次 }`；再失败才 `postMessage({ ok: false })`，不会静默降级到主线程。

做完的效果：**只有一条解析路径**，所有笔记都在 worker 里解析，主线程不再承担整篇 markdown → JSON；同时删掉了每次打开都多跑一遍的 `containsRawHtmlToken` 预检查（固定省一半词法开销）。

验证（2026-10-19）：`tsc --noEmit` 通过；新增 `markdown-parser-regressions.test.ts` 9 项全通过（新/旧卡片、块级与行内 HTML、`<br>`、`<img>`、注释、HTML 表格、flowix 引用标记）；`agent-thread-card.test.ts` 的 8 项失败在改动前后完全一致，属既有问题。

### 2.2 解析是二次复杂度（已定位并修复）

同一份 96 KB 文档，只改分块数量就足以暴露问题：1,181 个短段落要 113 ms，单个长段落只要 1 ms。原生 `marked` 对同样内容只要 2–5 ms（191 KB），所以二次增长来自 tiptap 的 `MarkdownManager` 包装层。

CPU profile（96 KB / 1157 块，连续 8 次 lex，合计 835 ms）定位到两个来源：

| 占比 | 热点 | 来源 |
| --- | --- | --- |
| ~31% | `tokenize` → `parseIndentedBlocks` | `@tiptap/extension-list` 的列表 tokenizer 在每个块起点对**剩余全文**做 `src.split("\n")` |
| ~38% | 各 tokenizer 的 `start(src)` 正则 | 项目自有的块级 tokenizer，每个块都扫一遍剩余文档 |

**修法（已落地）**

1. **列表 tokenizer 加 O(1) 守卫**（`features/editor/markdown-list-tokenizer.ts`）：`orderedList` / `taskList` 先在 2 KB 前缀上判断这行是不是列表，不是就直接返回。`StarterKit` 关掉 `bulletList` / `orderedList`，改注册带守卫的版本——必须替换而不是叠加，`extend` 之后若原扩展仍在注册表里会跑两遍（实测 49 KB 从 35 ms 变 58 ms）。
2. **`start()` 有界化**（`features/editor/markdown-tokenizer-source.ts`）：新增 `scanHead / boundedIndexOf / boundedSearch`，把扫描限制在 2048 字符前缀。改了 9 个块级 tokenizer：math、web-card、flowix-table（`flowix:table` / `table-widths` 两处）、table-reference、media-library-reference、video、image、agent-thread-card。**行内 tokenizer 没动**（`strong` / `highlight` / `noteReference` / `fileAttachment`），它们的 `src` 是段落文本，长度本来有限，截断反而会造成长段落里标记失效。

**实测（隔离进程 + 取中位数，`scripts/bench-markdown-parse.mjs`）**

| 文档大小 | 修复前 | 修复后 | 变化 |
| --- | --- | --- | --- |
| 50 KB | 31 ms | 5 ms | -84% |
| 100 KB | 115 ms | 9 ms | -92% |
| 200 KB | 425 ms | 16 ms | -96% |
| 400 KB | 1,628 ms | 30 ms | -98% |

每翻倍约 2 倍，二次曲线消失。基准脚本 `node scripts/bench-markdown-parse.mjs` 会为每个变体单独起进程，避免同进程 JIT/GC 互相污染——这一条很关键：在同进程里对比时，守卫版本一度显示出"更慢"的错误结论。

**尚未覆盖的形状：碎片化的列表（观察项，暂不修）**

守卫只对"不是列表"的块短路。块本身是列表时仍然走原 tokenizer，而它在开头就把**剩余全文** `split("\n")` 成行数组，再逐行匹配。但真实影响比"列表密集"这个说法要窄得多——关键区别是**一条列表被消费几次**：

| 400 KB 文档形状 | 耗时 |
| --- | --- |
| 段落为主 | 20 ms |
| **一条连续长列表** | **36 ms** |
| 混合（一半是两行短列表） | 350 ms |
| 全是两行短列表，且相互独立 | 4,917 ms |

一条连续列表是线性的：tokenizer 一次就消费完整条列表，只 `split` 一次。真正的病态形状是"**大量彼此独立的短列表**"——每个列表都要重新 split 剩余全文。50 KB 的这种文档约 103 ms，仍在可接受范围；要上千条独立短列表才会进入秒级。

结论：**暂不修**。理由是代价与风险不匹配——

- 要修就得先算出每个列表块的结尾，需要同时理解嵌套、宽松列表（项间空行）、缩进续行、列表内的围栏代码块；判断偏差会静默改变文档结构（一个列表裂成两个）。
- 现实数据里没有触发条件：本机最大笔记 46 KB，对应最坏形状约 0.1 s。
- 正确的长期修法在上游：`parseIndentedBlocks` 应该在遇到第一个不匹配行时就停，而不是先把整篇拆成行数组。那是 tiptap 里十几行的改动，比在应用层复刻列表语法安全。

先观测：worker 已经回报 `workerMs`，打开文档时也有 `[perf:open-doc]` 轨迹。若线上出现 `workerMs` 超过 ~200 ms 的笔记，再按上面的顺序处理（上游优先）。基准脚本保留 `--shape=list` 作为已知最坏情况基线。

回归测试：`markdown-parser-regressions.test.ts` 20 项，覆盖数学块、web card、表格元数据/宽度、两类引用、媒体样式、笔记引用、三种列表，全部与主编辑器解析结果对比。

另：`containsRawHtmlToken` 让每篇笔记都先完整 `lexer()` 一遍再做 `parse()`，即**固定 2 倍词法开销**。已随 2.1 一起删除。

### 2.3 笔记切换没有解析缓存（P2）

`features/document/components/document-container.tsx:173-208`：每次 mount 都起一个新的 worker 请求；解析结果存入组件 state（`:184`），编辑器消费后立刻释放：

```ts
setParsedMarkdownDocument((parsed) => (parsed?.key === markdownParserKey ? null : parsed));
```
`document-container.tsx:679-681`

配合 `key={documentInstanceKey}`（`:624` / `:651`），A→B→A 要解析三次。对"在几篇长笔记之间来回看"的高频用法，这部分成本是纯浪费。

建议：在 `markdown-parser.ts` 里加一个按 `hash(content)` + 长度做键的小 LRU（3~5 条即可），命中直接 resolve，不需要跨文档生命周期管理。

### 2.4 主布局每次 render 都 stringify，并在 render 期写模块级 store（P2）

`features/shell/main-layout.tsx:905`：

```tsx
startupIdentity={JSON.stringify(navigationState.target)}
```

每次主布局重渲都重新序列化一个 target 对象（含 notebookId / path）。虽然字符串本身不大，但：

`features/surface/registry.tsx:157` 在**函数体（render 阶段）**直接调用：

```tsx
if (content.status === 'empty') {
  reportEmptyWorkspaceSurfaceForIdentity('main-third', startupIdentity);
```

而 `features/surface/workspace-surface-runtime.ts:58-64` 会写模块级 Map 并 `emitStartup()`：

```ts
emptySurfaceIdentityByHost.set(host, identity);
...
startupOutcomes.set(host, 'ready');
emitStartup();
```

这是在 render 期间产生副作用并通知订阅者，属于 React 严格模式下的隐患（可能触发"渲染中更新另一个组件"），同时让"空态"渲染路径带上字符串分配 + Map 写入。

建议：`startupIdentity` 用 `useMemo` 拼成稳定 key（`notebookId + ':' + path`）；上报逻辑挪进 `useEffect`。

### 2.5 云同步期间，状态栏每秒一次同步 IPC（P2）

`features/shell/components/status-bar/status-bar.tsx:174-196`：只要云同步在进行，就 `setInterval(refreshPendingOperationCount, 1000)`。

对应后端是**同步命令**：

- `app/flowix-desktop/src/commands/cloud.rs:318-326` —— `pub fn cloud_list_pending_file_operation_counts(...)`，无 `async`
- `app/flowix-sync/src/store/v2.rs:314-315` —— 每次调用 `self.open()` 新建连接，再跑一条带 `UNION ALL` + `JOIN` 的聚合查询

Tauri v2 里非 async 命令在主线程执行，所以云同步期间等于每秒在主线程上开一次 SQLite 连接 + 跑一次聚合。同步本身已经在压磁盘，这个轮询会叠加到同一个线程上——正好是"云同步时界面发涩"的典型形态。

建议：改成后端在计数变化时 `emit`，前端订阅；短期至少把命令改 `async + spawn_blocking`，并把 1s 拉长到 3~5s。

---

## 3. 旧结论复核：仍然成立

| # | 问题 | 位置 | 现状 |
| --- | --- | --- | --- |
| 1 | 入口 CSS 全量阻塞首屏（编辑器/表格/PDF/5 套主题） | `styles/index.css:15-46` | 442 KB / 63 KB gzip，未拆分 |
| 2 | `zh-CN` 文案 eager 进主包 | `lib/i18n/locales.ts:1`（126 KB 源文件） | 未改；en-US 已动态加载，默认语言仍在全量 |
| 3 | 目录分页每页完整 `readdir` | `flowix-desktop/src/commands/document_list.rs:349` | 仅优化了排序（`select_nth_unstable_by`，`:301/:316`），I/O 未减少 |
| 4 | 拖拽每帧全文档扫描 + 逐项 `getBoundingClientRect` | `features/editor/extensions/block-drag.ts:532-548` | 未改；`doc.descendants` 内逐项取 rect，每个 pointer 移动周期全量重算 |
| 5 | 巨型组件（状态广度） | `memo-list.tsx` 30 个 `useState` / 1,586 行；`table-document-view.tsx` 49 个 `useState` / 3,606 行 | 虚拟化把代价限制在"可见行"，但容器自身的 render body 仍整体重跑 |
| 6 | 双图标库并存 | 61 文件用 `@phosphor-icons/react`，99 文件用 `lucide-react` | 未收敛 |

补充说明第 5 条的实际影响：`memo-list.tsx` 里任何一次局部交互（菜单开合、重命名、hover 保活）都会重跑整个容器函数体，重新创建可见行的 React 元素。因为 `MemoCard` 是 `memo` 的（`memo-card.tsx:438`），子组件渲染被挡住了，但元素创建 + props diff 仍在，代价随可见行数（约 10~15）线性增长——**目前可接受，但它没有任何上限保护**，加一个面板或一层包装就会变差。

---

## 4. 复核确认已修好（不要重复投入）

以下都逐一验证过代码，结论与修复文档一致：

- **主列表窗口化**：`features/memo/components/memo-list/memo-list-rows.tsx` 用 `useDynamicVirtualList` + `MemoCard` memo + 交互行保活，5k 条不再常驻 DOM。
- **树行 O(1) 查表**：`note-store.ts` 的 `noteIndexFor()`（WeakMap 按数组 identity 缓存）+ `notebook-tree-row.tsx` 查表，替代了原来的 `notes.find(...)` 线性扫描。
- **编辑器装饰局部化**：`tag.ts` / note-link / attachment 走 `shared/textblock-ranges.ts` 的受影响文本块范围，不再每键全文重扫。
- **Shiki 按块缓存**：`shiki-tokenizer.worker.ts` 的 LRU + 打开文档的 token 复用，+150ms 空闲才重算。
- **保存链路去重**：恢复草稿合并、正文队列按字节比对跳过重复写、正文单一来源（不再每次保存把全文提到容器 state）。
- **后端 async 化**：`get_file_tree`（`file.rs:897`）、`search_path_notes`（`memo/reads.rs:391`）都已是 `async`；目录元数据改成按路径定向查询（`file.rs:215-231` 不再读整本笔记投影）。
- **媒体库**：`document-list-view.tsx` 的 scroll/ResizeObserver 合并到 rAF + 列内虚拟化；派生数据 `useMemo`。
- **启动**：`main-window-startup.ts:85-92` 笔记本 ID 与 notebook 列表并发，不再串行等两跳 IPC。
- **气泡菜单 / 工具栏 / 大纲**：事务比较与 debounce 已就位。
- **Agent 消息流式渲染**：`message-list-renderer.ts` 的 `patchLastRenderedAgentMessage` 只重渲最后一条，历史消息按 render item 引用比较跳过——这块做得比一般实现好。

---

## 5. 建议处理顺序

| 状态 | 事项 | 说明 |
| --- | --- | --- |
| 已完成 | 解析单路径化 | §2.1，三步全部落地 |
| 已完成 | 解析二次复杂度 | §2.2，列表守卫 + `start()` 有界化，400 KB 从 1,628 ms 降到 30 ms |
| 下一步 | 入口 CSS 拆分（P1） | 编辑器和多维表格样式跟随各自 lazy chunk；`pdf-print.css` 改成导出时再注入；主题只保留当前 `data-theme`（或至少把 `rock/mist/ember` 拆出去）。目标：入口 CSS 从 442 KB 降到 100 KB 以内 |
| 之后 | 目录分页与拖拽几何（P1/P2） | 目录分页先加目录级 mtime 快照缓存；拖拽改成拖拽开始时缓存块矩形（文档 transaction / 滚动 / resize 时失效） |
| 之后 | 状态栏轮询（P2） | 改事件推送 + 命令异步化 |
| 之后 | 解析缓存（P2） | 按内容 hash 的小 LRU，省掉 A→B→A 的重复解析 |
| 随迭代 | 结构性债务（P3） | 巨型组件拆分、双图标库收敛 |

复测命令：`npm run bench:markdown -- --sizes=50,100,200,400`（每个变体独立进程，避免同进程 JIT/GC 互相污染）。

---

## 6. 需要运行时数据才能定级的

以下都在静态层面可疑，但没有采样，不建议直接动手：

- **`eager` 图片**：`document-list-view.tsx:190` 媒体卡片在窗口化后仍用 `loading="eager"`。因为只挂载视口附近卡片，实际可能是对的——需要测首屏内存与网络瀑布再判断。
- **Agent 流式期间 React 重渲**：`agent-conversation-detail.tsx:174` 订阅整个 `threadProjections[id]`，流式每个 token 都会让 detail 容器重渲一次（消息 DOM 是命令式增量更新的，所以 JS 工作量不在这部分）。需要 React Profiler 确认这是否构成可感知成本。
- **`@font-face` 6 个 Inter 字重**：有 `font-display: swap`，不阻塞，但会有字形回退闪烁。需确认实际用到几个字重。
