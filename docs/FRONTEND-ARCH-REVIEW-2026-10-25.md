# 前端架构评审（Flowix Web）

> 评审范围：`app/flowix-web/`（React 19 + Tiptap + Zustand + Tauri IPC）
> 评审方式：全量静态扫描（文件规模、依赖图、循环依赖、门禁脚本执行、构建产物分析）+ 关键路径代码阅读
> 评审日期：2026-10-25

> **状态更新（2026-11-10）**：B4 所述的四套 Markdown 管线现为三套 —— Worker parser
> （`markdown-parser.worker` / `markdown-parser-extensions.ts` / `markdown-parser.ts`）
> 已整体删除，解析改在编辑器的 `new Editor({ contentType: 'markdown' })` 内同步完成。
> 该条建议的"把共享 tokenizer/spec 收敛成唯一真源"仍然成立，真源现在是
> `createMarkdownEditorExtensions` 与 `features/editor/markdown-tokenizer-source.ts`
> 里的有界扫描工具。

---

## 1. 规模基线（先看数字）

| 指标 | 数值 |
| --- | --- |
| TS/TSX 文件 | 1,434（生产 1,039 + 测试 395） |
| 生产代码 | ≈ 166,753 行 |
| 测试代码 | ≈ 61,251 行（测试/生产 ≈ 0.37 : 1） |
| feature 模块 | 22 个（`features/*`），生产 146,792 行 |
| 全局 CSS | 17,258 行 / 44 个文件，单一入口 `styles/index.css` |
| Zustand store | 29 个 `create`，`store` 目录下 100 个 ts 文件 |
| 启动 JS | entry 1,428 KB（gzip 432 KB）；启动图 1,481 KB（gzip 465 KB） |
| 启动 CSS | 489 KB（gzip 69 KB） |
| Rust IPC 命令 | 338 个 `#[tauri::command]`，前端 321 处 `invoke` |

模块分布（生产行数 Top 8）：

```
agent                    42,401 行 / 225 文件   ← 占前端 29%
editor                   27,491 行 / 157 文件
memo                     20,978 行 / 113 文件
document                 12,285 行 /  84 文件
preferences               9,606 行 /  54 文件
multidimensional-table    9,365 行 /  45 文件
surface                   5,809 行 /  32 文件
workspace                 4,954 行 /  53 文件
```

**结论先行**：这是一个工程纪律明显高于平均水平的代码库（严格 TS、有 `any` 清零门禁、CAS 落盘、启动分阶段编排、构建预算门禁、6 万行测试）。但它已经跨过了"单团队靠约定可维护"的规模线，**分层契约在文档上是清晰的、在代码里是局部生效的**，而 `agent` 一个模块就吃掉了近三成代码量且自带第二套渲染范式。当前的主要风险不是"代码烂"，而是**架构规则的可执行性不足**——规则靠少数文件的硬编码白名单维持，规模继续增长时会出现"门禁全绿、耦合继续恶化"的静默失败。

> 复核补记（实施阶段发现）：`check:frontend-debt` 的 `MAX_EXPLICIT_ANY = 0` 门禁**当时是红着的**（`agent-data-store.ts` 有 10 处 `Record<string, any>`），`console` 计数也已超限（144 > 106）。也就是说 CI 在评审时刻并非全绿——"门禁存在"不等于"门禁守住了"。这两处已在整改中处理（`any` 归零；`console` 尚差 36 处，见整改方案 1.4）。

---

## 2. 分层意图 vs 实际依赖图

`docs/FRONTEND-MODULE-BOUNDARIES.md` 定义的目标是清晰的：

```
app / workspace / surface（协调）
        ↓ 只能走 public/
features/*（业务能力）
        ↓
lib / shared / platform（基础）
```

`npm run check:layers` 通过（扫描 1,434 文件）。但把"跨 feature 引用"全部扫出来后，实际情况是：

| 指标 | 数值 |
| --- | --- |
| 跨 feature 引用总数 | 714 |
| 走 `features/*/public/` 的 | 284（40%） |
| **直连其他模块私有路径的** | **430（60%）** |
| **互相依赖（双向）的模块对** | **38 对** |

双向依赖抽样（括号内为 A→B / B→A 引用次数）：

```
agent        ↔ editor      (18 / 6)      memo        ↔ workspace   (34 / 5)
agent        ↔ memo        (21 / 14)     document    ↔ editor      (11 / 20)
agent        ↔ workspace   (21 / 2)      document    ↔ multidimensional-table (2 / 30)
agent        ↔ preferences (9 / 11)      collection  ↔ multidimensional-table (2 / 28)
memo         ↔ shell       (1 / 21)      surface     ↔ workspace   (26 / 1)
```

这不是 DAG，是一张网。后果是具体的：

1. **Lazy 边界失效**。`app/app.tsx` 用 `lazy()` 拆了 MainWindow / Preferences / Effects，但同一个文件里静态导入了 `@features/agent/public/app-api`、`@features/preferences/public/app-api`、`@features/shortcuts/actions`。构建产物验证：entry chunk（1.43 MB）里能直接搜到 `codex`、`dsh`、`AgentSession`、`preferences` 等 Agent/偏好模块的字符串，说明这些模块已经被静态拉进入口。**懒加载只对真正被 `lazy()` 遮住的文件有效，而它依赖的那些 public API 又把上游拖回来了。**
2. **模块无法单独测试/推理**。改 `memo` 的 `note-store` 字段要读 `agent` 的 7 处直接依赖；`editor` 与 `agent` 互引，初始化顺序不可静态判定。
3. **公共入口形同虚设**。`features/agent/public/app-api.ts` 只有 24 行、直接 re-export 内部 store（`agent-data-store` / `agent-runtime-store`），本质是"给私有 store 换了个门牌"，没有收敛状态形状。

### 根因

被所有人直接 import 的那批东西——`note-store`、`document-store`、`workspace/store/*`、`surface-contract`——**在概念上属于"领域共享层"，物理上却住在某个 feature 内部**。只要它们还是某个 feature 的私有资产，其他 feature 就只能穿墙。这不是"某个文件写错了"，而是分层少了一层：缺少 `domain/`（或 `entities/`）承载"笔记 / 文档 / 面板"这类跨模块共享模型。

---

## 3. 可维护性问题

### A1【P0】架构门禁靠硬编码文件白名单，移动文件即失效

`scripts/check-layer-boundaries.mjs` 里，除了 3 条全局规则（低层不反向依赖、不直引 `@tauri-apps/*`），其余全部是**逐文件精确匹配**：

```js
r === 'features/shell/components/main-status-bar-host.tsx'
|| r === 'features/shell/hooks/use-main-middle-column-controller.tsx'
|| r === 'features/shell/components/browser-column.tsx'
... 共 21 个路径条件，其中 12 个是精确文件名
```

问题：
- 文件改名/移动 → 规则静默失效，CI 依然绿。这类"假绿灯"比没有门禁更危险，因为它提供了错误的安全感。
- 新增文件默认不受保护（规则是 allowlist 反过来的 denylist）。`features/shortcuts/actions.ts` 就是活例子：它直接 import `@features/document/use-cases/document-navigation` 和 `@features/workspace/store/workspace-focus-store`，违反文档里"跨 feature 必须走 public"的规则，但检查器不覆盖 `shortcuts`，所以从未报警。
- 60% 的私有跨模块引用能被"通过"的检查器放行，说明规则的**覆盖率**远低于规则的**表述**。

**建议**：把规则从"逐文件"改成"按模块策略表"。例如一份 `architecture.config.json`：

```json
{
  "features": {
    "workspace": { "crossFeature": "public-only" },
    "shell":     { "crossFeature": "public-only" },
    "*":         { "crossFeature": "warn", "grandfathered": ["memo->agent:7", "..."] }
  }
}
```

配套：`--update-baseline` 生成当前 430 条的基线文件，新增违规直接 fail、基线只减不增（和现有 `check-frontend-debt` 的 ratchet 思路一致，把它扩展成依赖图基线）。同时把 `import/no-cycle` 级别的检查加进 CI，先只对新增边报警。

### A2【P0】没有 Linter，也没有生效的 pre-commit

- `package.json` 里**没有任何 ESLint 依赖**，没有 `.eslintrc*` / `eslint.config.*`。
- `lefthook.yml` 整份是脚手架注释模板（`pre-commit` 全被 `#` 注释），**没有任何钩子生效**。
- 现有质量门禁只有：`tsc`（严格模式）+ 3 个自定义脚本（层边界 / 债务计数 / 包体积）。

缺失的直接后果，在代码里都能对上号：
- 439 处 `void somePromise()`，只有 300 处带 `.catch`。没有 `no-floating-promises`，异步错误只能靠人盯。
- 394 个 `useEffect` 没有任何 `exhaustive-deps` 校验，闭包陈旧依赖只能靠 review。
- `console.*` 用"总数不得超过 106"来兜底（属于用计数器代替规则）；`createLogger` 已有 127 处使用，两套日志并存。

**建议**：最低成本的一组规则就能拿回大部分收益：`typescript-eslint` 的 `no-floating-promises` + `no-misused-promises`、`react-hooks` 的 `exhaustive-deps`、`import/no-cycle`（warn）、`no-restricted-imports`（把 `@features/*/store/**` 从其他 feature 里禁掉——**这一条规则能替代掉上面 200 行硬编码**）。落地方式按目录 ratchet，先 warn 不 fail。

### A3【P1】巨型文件：单文件同时承担 view + 状态 + 持久化

| 文件 | 行数 | 内含 |
| --- | --- | --- |
| `features/multidimensional-table/table-document-view.tsx` | 3,378 | 一个 `TableDocumentViewSession` 组件占约 3,100 行，39 个 `useState` |
| `features/agent/thread-card/agent-thread-card-view.tsx` | 2,098 | 卡片视图 + 命令式 DOM 挂载 + 事件接线 |
| `features/preferences/sections/agent.tsx` | 2,085 | Provider 目录、模型表单、校验、UI，19 个 `useState` |
| `features/memo/components/notebook-file-tree.tsx` | 1,496 | 树模型构建 + 虚拟滚动 + 拖放 + 右键菜单 |
| `features/memo/components/memo-list.tsx` | 1,450 | 列表 + 分页 + 创建流程 + 排序 + 抽屉 |

这些文件不是"行数多"这么简单：它们的 `useState` 数量和职责条目说明**状态、副作用、渲染被压在同一个模块里**，任何一处改动都要通读全文。`table-document-view` 的 39 个 `useState` 尤其典型——它实际上是一个"没有抽出来的 session 层"。

**建议**：优先拆 `TableDocumentViewSession`（把表格数据/视图配置/拖拽各自提成 hook 或 store slice），再用同样方式切 `agent.tsx` 的 provider 表单。拆的时候保持"渲染层只读 view-model"，否则会变成把 3000 行挪到 3 个 1000 行文件里。

### A4【P1】两套渲染范式：React 19 之上手写了一套 DOM 框架

- 71 个文件出现 `document.createElement`，31 处给 `innerHTML` 赋值。
- `features/agent/thread-card/` 自带 `view/agent-thread-card-dom-factory.ts`（生成 DOM）、`*-controller.ts` 群（手工 `addEventListener`）、`message-item-renderer.ts`（892 行命令式渲染）。目录规模：`settings/` 4,952 行、`composer/` 4,398 行、`messages/` 4,341 行。
- 这些代码为绕开 React 的重渲染开销而选择了命令式路径，代价是：状态同步要靠手工 `update()`；没有 hooks 依赖检查；错误不会被 React ErrorBoundary 捕获；`innerHTML` 拼接需自己守 XSS（目前确实守住了：raw HTML 被渲染为文本、`href` 走协议白名单——见 `agent-thread-card-markdown.ts:428-436`、`356-367`，但这是"三处手写守卫"，不是框架保证）。

**建议**：不必推倒重来，但要划清边界并写进 `docs/`：**哪些 surface 允许命令式、必须实现 `dispose()` 契约、必须通过 `sanitize` 出口**。同时给这套控制器补一个统一的 `mount(container): { update, dispose }` 接口，避免每个 controller 各自定义生命周期（目前 `frontmatter-property-editor.ts` 42 处 `addEventListener`、0 处 `removeEventListener`，仅靠 DOM 节点被移除后由 GC 回收——这在单次挂载里可行，但在复用节点/缓存视图时会变成真实泄漏）。

### A5【P2】文档与代码漂移

`CLAUDE.md` 的"架构图"仍在描述 `flowix-web/components/editor`、`lib/store/memo-store.ts`、`windows/main/main-layout.tsx` 这套已经不存在的路径（实际是 `features/editor`、`features/*/store`、`features/shell/main-layout.tsx`）。新人按图找代码会直接失败，而这份文件正是给 AI Agent 的入口文档，错误路径会持续污染后续改动。

**建议**：架构图改为引用 `docs/FRONTEND-MODULE-BOUNDARIES.md`，只保留"入口在哪、禁止什么"，不再逐目录列举（目录清单必然过期）。

### A6【P2】IPC 无类型契约生成

Rust 侧 338 个 `#[tauri::command]`，前端 321 处 `invoke<T>('command_name', params)`，双方类型靠 `types/*.ts`（1,025 行）手工镜像维护。没有 `tauri-specta` / `ts-rs` 之类的绑定生成。

后果：改 Rust 命令的字段名，`tsc` 不会报错，只在运行时表现为 `undefined`。对笔记类应用，这类错误往往表现为"保存成功但内容丢失"。

**建议**：引入 `tauri-specta` 生成 `bindings.ts`，让 `invoke` 走生成的类型；短期做不到的话，至少给"写盘/删除/重命名"这三类命令加一层运行时参数校验。

---

## 4. 冗余代码

| # | 现象 | 证据 | 影响 |
| --- | --- | --- | --- |
| B1 | 两套图标库并存 | `lucide-react` 出现在 104 个文件；`@phosphor-icons/react` 12 个文件（偏好设置、全局搜索、状态栏等较新模块） | 视觉语言不统一；entry 同时打包两套图标数据 |
| B2 | 5 个运行时依赖完全未被引用 | `date-fns`、`react-markdown`、`remark-gfm`、`@tiptap/extension-color`、`@tiptap/extension-text-style`（`prosemirror-gapcursor` 亦被 `@tiptap/pm/gapcursor` 取代） | 装包体积、审计噪音、误导后来者选型 |
| B3 | 路径规范化散落 | 113 处手写 `replace(/\\/g, '/')…`，而 `lib/path.ts` 已有 `canonicalPath()` | Windows 路径处理不一致，是数据边界类 bug 的高发点 |
| B4 | 多套 Markdown 管线 | `marked`（Agent 消息）、`@tiptap/markdown`（编辑器序列化）、Worker parser（`markdown-parser.worker`）、`agent-thread-card-markdown-spec`（Agent 专用 tokenizer） | 同一段 Markdown 在不同 surface 渲染结果可能不同；四处都要跟 spec 演进 |
| B5 | i18n 两套调用方式 | `translate(language, key)` 105 处 vs `useI18n()` 等 hook 357 处 | 语言参数靠传参穿透，容易在异步回调里拿到过期语言 |
| B6 | 日志/提示双通道 | `createLogger` 127 处 vs 直接 `console.*` 106 处（门禁上限）；`@/lib/toast` 94 处 vs 直接 `sonner` 3 处 | 线上问题排查口径不统一 |
| B7 | 状态按 store 切分过细 | 29 个 store；`browser-column-store` 单个 store 23 个 action（导航/布局/文件树/WebView 混在一起）；跨 store `.subscribe` 30 处 | 派生状态散落，改一处要追多条订阅链 |

**说明**：B4 的多套管线有一定合理性（Worker 解析要隔离 React/Tauri 依赖，Agent 要防任意 HTML），不建议合并成一套；建议把"共享的 tokenizer/parse spec"变成唯一真源（文档里已有这个约定，`markdown-parser-extensions.ts` 是正确方向），并把"渲染器差异"写进测试。

---

## 5. 性能问题

### C1【P0】入口 chunk 单块 1.43 MB，懒加载边界被静态 public API 打穿

事实：
- `index.html` 指向的 entry chunk = 1,428 KB（gzip 432 KB），**启动图只有 12 个节点**（即几乎所有东西都在这一个文件里）。
- entry 内可直接检索到 `codex`(13)、`dsh`(16)、`AgentSession`(3)、`preferences`(6) —— Agent 会话、偏好设置的部分实现已在首屏图内。
- 原因链：`app/app.tsx` 静态导入 `@features/agent/public/app-api`（→ `agent-data-store` / `agent-runtime-store`）、`@features/shortcuts/actions`（→ workspace store + document navigation）；`manualChunks` 只显式切了 shiki / mermaid / katex，其余全部落进 entry。

影响：桌面端虽无网络加载，但 **JS 解析/编译/执行** 全在首屏同步完成；1.4 MB 单块也让"改动一行 → 用户重下整块"的更新粒度变粗。

**建议**：
1. 把 `app.tsx` 对 feature 的静态依赖改成"引导期只需要的最小切片"（例如 `refreshAgentRuntime` 改成事件/命令，不走 store hook）。
2. `manualChunks` 增加按模块的 vendor 分组（`vendor-react`、`vendor-tiptap`、`vendor-icons`），至少让"改业务代码不动 vendor 缓存"。
3. 给 entry 单独设硬预算（如 gzip 350 KB），而不是只在 3 MB 的启动总预算里兜着。

> 复核修正（实施阶段实测）：这里把"入口大"归因于静态 import 边，**只对了一半**。把 5 条静态边全部改动态后，启动 gzip 只从 474,643 变到 474,738 —— 删边不减体积。真正原因是 `output.onlyExplicitManualChunks: true` 关掉了 Rollup 的自动共享分块，被多个懒块共享的模块会被**上提到入口块**；再加上 `check-web-bundle` 把 `agent-window-effects` 算作启动根，agent 代码本来就在"启动图"口径内。而给 agent/table 加显式 `manualChunks` 反而把启动图从 1.5 MB 推到 5.0 MB。详细数据见整改方案 2.1 的实测修正。
>
> **✅ 已修复（2026-10-25）**：按 manifest 静态闭包定位到 6 条真实桥（不是 16 条 app→feature 边），其中最后 138 KB gzip 来自 `pi-cloud-model-service → agent-catalog-service → session-store` 这条被误判为"无关"的链。结果：启动图 **467,176 → 322,791 gzip（−31%）**，entry chunk 1,412 → 920 KB raw，`agent-session-store` chunk 完全离开启动图，预算 ratchet 到 340 KB。上面三条建议里第 1 条已做，第 2 条（vendor 分组）经实测有害，第 3 条已用 `check:web-bundle` 落地。

### C2【P1】预算已经失去约束力

`scripts/check-web-bundle.mjs`：

```js
const STARTUP_RAW_BUDGET = 3_000_000;   // 实际 1,517,099
const STARTUP_GZIP_BUDGET = 900_000;    // 实际 464,864
```

实际值只有预算的 **50% / 52%**。注释里写的"long-running ~849 KB gzip baseline"与当前 465 KB 已相差近一倍，说明预算被上调过、注释没跟着更新。一个允许翻倍的预算等于没有预算。

**建议**：改成 ratchet（当前值 + 3% 缓冲），并在 CI 输出里显示"距上限还差多少"，而不是只显示通过。

### C3【P1】CSS 全量单包，17k 行一次性加载

- 入口 CSS 489 KB（gzip 69 KB），包含 5 个主题、编辑器、Agent、表格、PDF 打印等全部样式。
- 201 处 `!important`，201 个顶层类选择器在 `index.css` 之外各自成体系。
- Agent 相关 CSS 单独就有 ~5,100 行（`agent-thread-card/` 3 个文件 + `agent-conversation/composer.css` 1,943 行）。

样式本身组织得比大多数项目好（有命名空间守卫 `check:agent-style-boundaries`），但"所有 surface 的 CSS 都在首屏"是结构性浪费。

**建议**：把 `agent-thread-card`、`multidimensional-table`、`pdf-print` 三块用 `import './x.css'` 挂到各自的懒加载组件上，交给 Vite 自动切分。

### C4【P2】渲染优化手段稀缺

- 67,446 行 tsx 里只有 **7 处** `React.memo`；`useCallback` 508 处、`useMemo` 192 处——说明团队在"回调稳定"上很用力，但"组件子树隔离"几乎没有。
- memo 列表已做虚拟化（`useDynamicVirtualList`，369 行，是 `@tanstack/react-virtual` 的深度适配层，带视口就绪/保持存活/滚动锚点等能力，有测试），这一点是加分项。
- 但列表卡片 `memo-card.tsx`（421 行）未 memo 化，父级 1,450 行的 `memo-list.tsx` 里 30+ 个 `useState`，任一状态变化（如菜单开合）都会重渲染整个可视区卡片。

**建议**：给列表/树的行组件加 `memo` + 稳定的 key/handler；先把 `memo-list` 里与列表无关的 UI 状态（菜单、对话框开关）下沉到子组件，减少父组件重渲染半径。

---

## 6. 鲁棒性问题

### D1【P0】错误边界只有 2 个落点，一个面板抛错=整个窗口白屏

`<ErrorBoundary>` 在生产代码里只有 3 处：`app.tsx` 两处（主窗口根 / 偏好窗口根）、`features/preferences/preferences-view.tsx` 一处（分区级）。主窗口内**所有面板（编辑器、Agent、表格、文件树）共享同一个根边界**。

对笔记应用，这意味着：一条畸形 Markdown 让表格视图抛错，用户看到的是整窗替换成错误页，未保存的编辑上下文一并丢失。

另外 `ErrorBoundary.handleRetry` 只是 `setState({hasError:false})`，没有 `key` 重置或状态清理；确定性错误会立即再次抛出（用户看到"重试"按钮但永远无效）。

**建议**：按 surface 加边界（每个中间列面板一个，fallback 只占该面板区域）；提供 `resetKeys`；把 `componentDidCatch` 接到日志/上报通道（目前只 `console.error`）。

### D2【P1】React 边界接不到命令式代码的错误

71 个文件用 `createElement` 手工构建 DOM、31 处 `innerHTML`。这些路径上的异常发生在事件回调/定时器里，不会经过 ErrorBoundary，也不在 `Promise` 链上——只会在控制台留一行。

**建议**：给命令式 surface 的入口（`mount*`/`attach*`）统一包一层 `try/catch` + 上报，并把"局部降级"（渲染失败时显示纯文本）作为默认行为。

### D3【P1】异步错误处理不成体系

- 439 处 `void promise`，300 处显式 `.catch`；无 `no-floating-promises`。
- 618 处 `catch`，抽样多为"记录后继续"，可接受；但存在 `void actions.reloadPreferences()`、`void actions.refreshAgentRuntime()`（`app/user-config-sync.ts:25,38`）这类**无 catch 的 fire-and-forget**，失败后用户侧无任何反馈。
- 4 处 `invoke(...)` 无泛型、无 catch（`platform/open-target/pending-requests.ts:39` 等）。

**建议**：统一一个 `fireAndForget(promise, {context})` 工具（内部 catch + 上报），把裸 `void` 逐步替换；配合 ESLint 规则防止回退。

### D4【P1】没有端到端测试

只有 Vitest + jsdom（395 个测试文件、6.1 万行）。没有 Playwright/WebDriver 层。而这个应用的关键风险恰恰在 jsdom 覆盖不到的地方：Tauri IPC 真实往返、WKWebView/WebView2 下的 `asset://` 加载、命令式 DOM 的真实事件序列、拖放、IME。

**建议**：不必上完整 E2E 矩阵，先加 3 条"启动冒烟"：冷启动到工作台可交互、打开笔记→改一字→落盘、Agent 面板发一条消息。这三条能挡住大部分"打包后白屏"类事故。

### D5【P2】XSS 面靠手写守卫

31 处 `innerHTML` + 8 处 `dangerouslySetInnerHTML`，仓库里**没有 DOMPurify 或任何 sanitizer 库**。Agent 消息管线的核心防线是有的（raw HTML 当文本、实体解码后再校验协议、注释写清了动机），但覆盖面不全：**Markdown 链接（`[a](javascript:...)`）的 href 会原样进入 DOM**，协议白名单只覆盖 raw `<a>` 与图片，链接只靠点击处理在打开时才拦。这类"每个渲染点自己记得守"的模型，在新增 surface 时必然漏——事实上已经漏了一处。

> 复核补记：该缺口已由 1.5 的 `agent-markdown` 冒烟探针发现并修复（`cardMarked` 增加 `link` renderer 走 `sanitizeLinkHref`）。这也说明这类断言应该放进浏览器级的冒烟，而不是只靠 jsdom 单测。

**建议**：在 `lib/` 提供一个唯一的 `renderTrustedHtml(html)` 出口（内部 sanitize），并用 `no-restricted-syntax` 禁止直接赋值 `innerHTML`。

### D6【P2】保存链路的语义可以更明确（但当前是正确的）

`enqueueDocumentCommit` 在"同 lane 被新任务替换"时，把被替换任务的 promise 直接 `finish(true)`（`document-commit-queue.ts:26-30`）——被替换者其实没写盘。当前安全，是因为 `buffer-registry.ts` 在 `saved === true` 之后还会 `await waitForSaveQueue()` 并重新校验 `currentBodyIsSaved()`（第 298-303 行）。但这依赖"调用方都记得复检"，属于隐性契约。

**建议**：把结果类型从 `boolean` 改成 `'saved' | 'superseded' | 'failed'`，让"被合并"这件事显式化。

---

## 7. 值得保留的设计（不要在这次重构里改掉）

评审不能只挑毛病，下面这些是这个项目真正的资产：

1. **文档持久化的 CAS + 单写者模型**：`buffer-registry` + `document-commit-queue` + `save-queue` 三层，latest-value 槽位而非无界队列、写前重读 expected、冲突走 `conflicted` 态而不是覆盖。这是笔记应用最关键的正确性保障，实现质量高于同类项目。
2. **启动分阶段编排**：native 阶段 + 前台阶段 + `admission` 门闸 + `runStartupStage3Task` 幂等，注释解释了"为什么 native 与前台可以乱序返回"。这类并发推理很扎实。
3. **Markdown 解析放 Worker**，并有独立体积预算（750 KB）+ 禁止 `localStorage` 进入 worker 依赖图 —— 用门禁保护架构意图的正确姿势。
4. **`any` 清零的 ratchet**（`MAX_EXPLICIT_ANY = 0`）与 `strict: true` —— 思路正确；评审时它已被突破（10 处），说明门禁需要 lint 在编辑期就拦，而不是只在 CI 尾部兜底。整改后已归零。
5. **打包链路的细节处理**：`crossorigin` 剥离、woff2 单格式、`onlyExplicitManualChunks` 防止 mermaid 被预加载 —— 说明有人真的在 WebView 里踩过坑。

---

## 8. 建议的推进顺序

| 优先级 | 动作 | 预期收益 | 成本 |
| --- | --- | --- | --- |
| P0-1 | 引入 ESLint 最小规则集（floating-promises / hooks-deps / no-restricted-imports）+ 激活 pre-commit | 用 1 条规则替代 200 行白名单；挡住新增耦合 | 0.5 天配置 + 分目录 ratchet |
| P0-2 | 层边界门禁改为"策略表 + 基线文件"，新增违规即 fail | 让 60% 的私有跨模块引用可见、可下降 | 1-2 天 |
| P0-3 | 按 surface 加 ErrorBoundary（含 resetKeys + 上报） | 消灭"单面板崩溃=整窗白屏" | 1 天 |
| P1-1 | entry 瘦身：断开 `app.tsx` 对 feature store 的静态依赖 | 首屏 JS 有 200-300 KB 下降空间 | 2-3 天，需回归启动路径 |
| P1-2 | 拆分 `TableDocumentViewSession`（39 个 useState） | 最大的可维护性单点 | 3-5 天 |
| P1-3 | 抽 `domain/`（note / document / surface 共享模型），把 `note-store`、`workspace store` 的跨模块直连收口 | 从根上打断 38 对双向依赖中最顽固的几条 | 持续，按 seam 分批 |
| P1-4 | CSS 按 surface 拆分（agent-thread-card / table / pdf-print） | 首屏 CSS −30% | 1 天 |
| P2 | 依赖清理（5 个未用包）、图标库统一、路径规范化收口、IPC 绑定生成 | 减少噪音与边界 bug | 各 0.5-1 天 |

---

## 9. 一句话总结

> 架构的**设计**是清晰的、**执行**是局部的、**约束**是纸面的。
> 当前不是"要不要重构"的问题，而是把已有的架构意图变成**机器可执行的规则**（linter + 依赖基线 + 预算 ratchet），并用一个 `domain` 层收掉 38 对双向依赖里的核心几条——否则代码量每增长 30%，这张依赖网就会再密一层，直到任何改动都需要全模块阅读。
