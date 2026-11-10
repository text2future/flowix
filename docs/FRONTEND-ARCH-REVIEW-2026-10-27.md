# 前端架构评审与评分（Flowix Web）

> 评审范围：`app/flowix-web/`（1,071 个生产文件 / 169,719 行；405 个测试文件 / 62,168 行）
> 评审方式：实测。`tsc` / `eslint` / 4 个门禁脚本 / 全量单测 / 构建产物 / 自写依赖图扫描（跨模块边、双向依赖、Tarjan 强连通分量）
> 评审日期：2026-10-27　｜　上一版：`FRONTEND-ARCH-REVIEW-2026-10-25.md`

> **状态更新（2026-11-10）**：文中提到的 Worker 解析器已删除 ——
> `features/editor/markdown-parser.worker.ts`、`markdown-worker-dom.ts`、
> `markdown-parser-extensions.ts`、`markdown-parser.ts` 不再存在，Markdown 解析改在
> `new Editor({ contentType: 'markdown' })` 内同步进行；懒加载块清单里也没有
> `markdown-parser.worker` 了。当前的 Markdown 管线为三套（`marked` 用于 Agent 消息、
> `@tiptap/markdown` 用于编辑器、`agent-thread-card-markdown-spec` 用于 Agent 专用
> tokenizer）。

---

## 0. 评分结论

| 维度 | 权重 | 得分 | 一句话判断 |
| --- | --- | --- | --- |
| 分层与模块边界 | 20 | **14** | 蓝图和门禁都是真的，但 58% 的跨模块引用仍在穿墙 |
| 架构简洁度 | 15 | **10** | 一套 React 应用里并存两套渲染范式、两套图标、两条 i18n 路径 |
| 类型安全与错误处理 | 20 | **14** | 类型纪律接近满分，异步错误可见性拖后腿 |
| 可维护性 | 20 | **13** | 文件普遍小而清晰，但 16 个千行文件把风险集中了 |
| 性能与产物体积 | 10 | **7** | 启动图有真预算，CSS 没有 |
| 工程基建与门禁 | 15 | **14** | 这仓库最强的一块，接近行业上游水平 |
| **合计** | **100** | **72** | **B+ / 良好** |

**趋势**：相对 10-25 那版（等效约 58–60 分），两个月内分数抬升 12 分以上，且抬升是结构性的（门禁可执行、启动图降 31%、错误边界下沉），不是修修补补。

**当前最该警惕的一句话**：这套架构的「设计—门禁—执行」已经三件齐了，唯一缺的是**清偿节奏**——基线文件记着 443 条债，但没有"每周必须减少 N 条"的机制，于是账本变成了安乐椅。

---

## 1. 规模基线

| 指标 | 数值 |
| --- | --- |
| 生产 TS/TSX | 1,071 文件 / 169,719 行 |
| 测试 | 405 文件 / 3,036 用例 / 62,168 行（测试∶生产 ≈ 0.37∶1） |
| feature 模块 | 20 个 |
| 文件规模分布 | <100 行 607 个（57%）· 100–300 行 319 个（30%）· 300–600 行 91 个 · 600–1,000 行 34 个 · >1,000 行 **16 个** |
| 平均文件 | ≈158 行 |
| Zustand store | 31 个 `create`，store 目录 16,884 行 |
| 全局 CSS | 42 文件 / 207 个 `!important` / 单包 487 KB |
| 启动 JS | 1,040,586 raw / **324,006 gzip**（预算 340 KB） |
| 依赖 | 生产依赖 65 个，其中 **5 个零引用** |

模块规模（含测试行数）：

```
agent       332 文件   69,680 行   ← 占前端 30%
editor      219 文件   37,323 行
memo        161 文件   28,296 行
document    119 文件   16,364 行
multidim-table 80 文件 12,388 行
preferences  64 文件   10,631 行
surface      54 文件    7,919 行
workspace    82 文件    7,766 行
shell        45 文件    5,626 行
其余 11 个模块合计 ≈ 14,000 行
```

---

## 2. 分层与模块边界（14 / 20）

### 2.1 做对的部分：规则第一次变成机器可执行

`architecture.config.json` + `architecture-baseline.json` + `scripts/check-architecture.mjs`（158 行）构成了一个**策略表 + 债务账本**的门禁：

- 4 类规则（跨 feature 私有、组合根私有、低层反向、Tauri 直引）由配置文件驱动，不靠路径白名单；
- 新增违规直接 `exit 1`，存量记入基线（443 条引用 + 36 对双向依赖）；
- 会主动提示"可收紧基线：N 条引用已消失"，基线只减不增有方向感；
- `eslint.config.mjs` 里的 `no-restricted-imports` **从文件系统动态推导**每个 feature 的私有子路径——新增 feature 自动生效，文件改名不会让规则静默失效。

这直接解决了上一版最大的问题（"改个文件名门禁就绿了"）。**这是本次评分提升的主要来源。**

### 2.2 实测的依赖真相

我按 alias + 相对路径全量解析后统计（排除测试文件）：

| 指标 | 数值 | 含义 |
| --- | --- | --- |
| 跨 feature 引用总数 | 768 | — |
| 走 `public/` | 319（42%） | 合法的消费契约 |
| **私有路径直连** | **449（58%）** | 穿墙 |
| **双向依赖对** | **25 对** | feature 级不是 DAG |
| 文件级循环（Tarjan SCC>1） | **15 组 / 81 文件** | 初始化顺序不可静态判定 |
| 低层 → features/app 反向 | **0** | ✅ 干净 |
| `@tauri-apps/*` 越出 platform | **1** | ✅ 基本干净 |

Top 双向依赖（A→B / B→A）：

```
document ↔ editor            (11 / 20)
document ↔ multidim-table    ( 2 / 27)
agent    ↔ editor            (18 /  4)
agent    ↔ memo              (16 /  5)
collection ↔ multidim-table  ( 1 / 17)
collection ↔ media-library   ( 2 / 14)
multidim-table ↔ properties  (11 /  3)
agent    ↔ document          ( 7 /  6)
```

被依赖最多的模块（债务集中处）：`document 89 · memo 69 · editor 47 · collection 44 · workspace 40 · properties 38`。

**根因没变**：缺一层 `domain/`。`note-store`、`document-store`、`workspace/store/*`、`surface-contract` 在概念上是**领域共享模型**，物理上却住在某个 feature 里，别的 feature 只能穿墙。`lib/` 现在同时在承担两件事——通用工具（`path.ts`、`logger.ts`、`safe-link.ts`）和领域模型（`agent-types.ts`、`membership.ts`、`property-types.ts`），这也是为什么会看到 `lib/store/` 这种位置（foundation 层里放全局 store）。

### 2.3 判定

- 规则覆盖率：**从 0 到基本全覆盖**（这是质的改变）
- 规则遵守率：**42%**（这是量的现实）
- 得分逻辑：架构意图 20 分满分应给 18；遵守率把分数压到 14。

---

## 3. 架构简洁度（10 / 15）

### 3.1 亮点

- **组合根很薄**：`app/` 只有 28 个文件 / 3,529 行，`app.tsx` 不含任何业务逻辑，只有 lazy 边界 + 启动门闸 + 错误边界。
- **启动编排有设计**：`StartupGate` + `applyNativeStartupStatus` + `runStartupStage3Task`，注释解释了"为什么 native 阶段与前台阶段可以乱序返回"。
- **保存链路是全仓最高水平的一段**：`document-commit-queue` 用 latest-value 槽位而非无界队列、lane 分离（body/title）、慢操作埋点、被替换任务显式 `finish(true)`；`buffer-registry` 写前重读 expected。这是笔记类应用最关键的正确性所在，做得比多数同类项目扎实。

### 3.2 扣分项

| 现象 | 证据 | 代价 |
| --- | --- | --- |
| React 之上还有一套 DOM 框架 | 906 处 `document.createElement`、62 处 `innerHTML =`、8 处 `dangerouslySetInnerHTML`；`agent/thread-card/{view,settings,composer,messages}` 各 300+ KB 的命令式控制器 | 两套生命周期语义；React ErrorBoundary 接不到这条路径的异常；状态同步靠手工 `update()` |
| 20 个 feature 形态不统一 | 有的 `public/` 是真 view-model 适配（`workspace/public/shell-api`），有的只是 re-export 门牌（`agent/public/shell-api` 直接转出 9 个组件），有的把内部状态形状漏出来（`useBrowserColumnAgentHeaderModel` 返回 `conversationRegistry.instances`） | "public API" 的语义不统一，消费方无法预判稳定性 |
| 两套图标库 | lucide-react 107 文件 / phosphor-icons 63 文件 | 视觉语言分裂 + 双份图标数据进包 |
| 两条 i18n 调用路径 | `translate(language, key)` 108 处 vs hook 334 处 | 异步回调里容易拿到过期语言 |
| 5 个零引用依赖 | `date-fns` `react-markdown` `remark-gfm` `@tiptap/extension-color` `@tiptap/extension-text-style` | 装包体积、审计噪音、误导选型 |

Markdown 管线有 4 套（`marked` / `@tiptap/markdown` / Worker parser / Agent 专用 tokenizer）——**这个我不建议合并**，Worker 隔离与 Agent 防任意 HTML 都是合理动机；但应把 tokenizer/parse spec 收敛成唯一真源（`markdown-parser-extensions.ts` 已经是正确方向），并用测试锁住渲染差异。

---

## 4. 类型安全与错误处理（14 / 20）

### 4.1 做对的

| 项 | 实测 |
| --- | --- |
| `tsc --noEmit` | ✅ 零错误 |
| `strict` + `noUnusedLocals` + `noUnusedParameters` | ✅ |
| 显式 `any` | **0**（门禁 + ESLint `no-explicit-any: error` 双保险） |
| `no-floating-promises` | `error` 级 |
| 直接 `console.*` | 100 / 上限 106（ratchet 中） |
| `createLogger` 结构化日志 | 189 处 |
| IPC 错误归一 | `platform/tauri/errors.ts` 提供错误码识别，且**不做反向依赖**（翻译函数由调用方注入） |

**错误边界已经下沉**——这是上一版 P0 的修复：

- 根边界 2 个（主窗口 / 偏好窗口），带 `resetKeys={[hash]}`
- `shared/surface-boundary.tsx`：面板级边界，有 `resetKeys`、`epoch` 自增触发真正重挂载、日志走 `createLogger`
- `main-layout.tsx` 内 4 处 `SurfaceBoundary`（工作区 / 列表 / Agent 列 / 状态栏）
- `WorkspaceSurfaceErrorBoundary` 按 surface 逐个包裹渲染器

"一个畸形 Markdown 让整窗白屏"的风险基本消除。

### 4.2 扣分项

**D1【P1】门禁绿了，但错误仍然看不见。**
457 处裸 `void somePromise()`。`void` 在语法上满足 `no-floating-promises`，语义上等于"失败无任何人知道"。团队已经写了 `lib/fire-and-forget.ts`（内含 catch + 日志），但只被用了 **23 次**。这说明规则装上了、习惯没跟上——最典型的"门禁通过 ≠ 问题解决"。

**D2【P1】IPC 无类型绑定生成。**
346 处 `invoke<T>`（只有 4 处裸调用，态度是好的），但 `types/*.ts`（1,025 行）是**手工镜像** Rust 结构体。改字段名 `tsc` 不报错，运行时表现为 `undefined`——对笔记应用往往意味着"保存成功但内容丢失"。无 `tauri-specta` / `ts-rs`。

**D3【P2】没有统一的 HTML 安全出口。**
有 `lib/safe-link.ts`（协议白名单 + 控制字符拦截，写得很细），但 62 处 `innerHTML` 各自守各自的。没有 DOMPurify 类库，也没有 `renderTrustedHtml()` 这样的唯一收口。目前没出问题，是因为每个渲染点都记得守——这种模型在新增 surface 时必然漏。

**D4【P0】测试当前是红的。**

```
Test Files  13 failed | 392 passed (405)
Tests       31 failed | 3005 passed (3036)
Errors      31 errors
```

并且 `stable-caret.ts` 在 jsdom 下抛 `this.resizeObserver?.unobserve is not a function` 导致 runner 中途崩溃（第二次跑直接 exit 1、日志截断）。

其中一部分可归因于工作区 77 个未提交的前端文件；但 `table-record-row.test.ts`、`tag-incremental.test.ts`、`use-document-titlebar-colors.test.tsx` 等失败用例的源码与测试文件均**未被改动**，说明存在存量红灯。无论归因如何，结论一致：**CI 的 `Unit tests` 一步会失败，主干不是绿的**。

---

## 5. 可维护性（13 / 20）

### 5.1 结构是健康的

- 57% 的文件不足 100 行，30% 在 100–300 行之间；长尾只有 16 个文件超千行。
- 文档密度罕见：`docs/` 41 篇 md，`FRONTEND-MODULE-BOUNDARIES.md` 明确写了状态归属表和导航事务的 5 个步骤——这是"能被人接管"的前提。
- `check:frontend-debt`、`check:agent-style-boundaries`、`check:editor-tag-layout` 这类"针对具体脏点"的门禁，说明有人在用工具对抗熵增。

### 5.2 三个真实的痛点

**M1【P1】巨型文件把风险集中。**
| 文件 | 行数 | 内含量 |
| --- | --- | --- |
| `multidimensional-table/table-document-view.tsx` | 3,352 | 单个 session 组件，**39 个 `useState`** |
| `preferences/sections/agent.tsx` | 2,085 | Provider 目录 + 模型表单 + 校验 + UI，19 个 `useState` |
| `agent/thread-card/agent-thread-card-view.tsx` | 2,076 | 卡片视图 + 命令式挂载 + 事件接线 |
| `agent/thread-card/settings/external-agent-settings-controller.ts` | 2,457 | 控制器 |
| `memo/components/notebook-file-tree.tsx` | 1,671 | 树模型 + 虚拟滚动 + 拖放 + 右键菜单 |

`table-document-view` 与两个月前那版基本没动（3,378 → 3,352 行）。39 个 `useState` 说明这里缺一个 session 层，不是"文件太长"这么简单。

**M2【P1】i18n 在部分模块实质上是坏的。**
非 i18n 源码里有 **1,107 个中文字面量，分布在 133 个文件**：

```
notebook-agent-settings-dialog.tsx  152
table-document-view.tsx             102
table-secondary-views.tsx            50
multidimensional-table/model.ts      44
slash-menu-dropdown.tsx              33
csv-preview.tsx                      31
```

多语言切换时，表格、媒体库、Agent 设置、斜杠菜单会中英混排。这不是风格问题，是功能缺陷。

**M3【P2】渲染隔离手段稀缺。**
638 处 `useCallback` vs **7 处 `React.memo`**。团队在"回调稳定"上很用力，但几乎不做子树隔离——`memo-list.tsx`（1,450 行、20 个 `useState`）里任一 UI 状态变化都会重渲染可视区卡片。虚拟化做得不错（`useDynamicVirtualList` 是深度适配层且有测试），但没有被 memo 化保护。

---

## 6. 性能与产物体积（7 / 10）

| 项 | 实测 | 判断 |
| --- | --- | --- |
| 启动图 | 1,040,586 raw / **324,006 gzip** | ✅ 远低于 340 KB ratchet（两月前 467 KB） |
| entry chunk | 1,203 KB raw | ⚠️ 单块仍大 |
| 入口 CSS | **487 KB 单包** | ❌ 全部 surface 的样式首屏加载 |
| `!important` | 207 处 | ⚠️ 样式优先级靠蛮力 |
| 最大懒块 | katex 770 KB / markdown-parser.worker 709 KB / markdown-editor 652 KB | ✅ 都已被懒加载隔离 |
| 样式组织 | 42 个文件、单一入口 `styles/index.css`、Agent 有命名空间守卫 | ✅ 组织得好，只是没切分 |

`manualChunks` + `onlyExplicitManualChunks` 的取舍有实测依据（注释记录了"给 agent/table 加显式 chunk 反而把启动图从 1.5 MB 推到 5.0 MB"），这种"踩过坑并留下证据"的决策质量很高。

**唯一明显的结构性浪费**：`agent-thread-card`（约 5,100 行）、`multidimensional-table`（890 行）、`pdf-print` 这三块 CSS 完全可以用 `import './x.css'` 挂到各自的懒加载组件上，交给 Vite 自动切分——预计首屏 CSS 可降 30% 以上。这件事上一版就提了，没做。

---

## 7. 工程基建与门禁（14 / 15）

这是全仓最强的部分。CI（`.github/workflows/ci.yml`）的 web job 有 **12 个检查步骤**：

```
package-manager 策略 → note-rename 边界 + 其单测 → tsc → 生产构建
→ 打包预算 → 层边界 → 架构策略+基线 → ESLint → 前端债务 ratchet
→ 全量单测 → 真实 Chromium 冒烟（boot / save-pipeline / agent-markdown）
```

外加 Rust job（clippy + workspace 单测）与 DSH 打包不变量 job；`lefthook.yml` 的 pre-commit 对暂存文件跑 ESLint + 架构检查。

几个特别值得保留的设计：

1. **真实浏览器冒烟不引 Playwright**：esbuild 打包探针页 → `chrome --dump-dom` → 解析 JSON，零新增依赖。三个 case 覆盖"打包后能不能跑"，正是 jsdom 覆盖不到的地方。
2. **前端债务 ratchet**：`MAX_EXPLICIT_ANY = 0`、console 上限 106，用计数器而非口号。
3. **Agent 样式边界守卫**：静态命名空间检查 + 三面对比，防止 Agent 样式污染 `editor.css`。

扣 1 分的原因：**pre-commit 不跑测试、不跑全量 lint**，只对 staged 文件跑 ESLint。于是"本地能提交、CI 才红"的窗口一直存在——今天这个工作区就是活的例子（3 条新架构违规 + 31 个失败用例同时存在）。

---

## 8. 问题清单（按优先级）

| # | 级别 | 问题 | 证据 | 修复方向 |
| --- | --- | --- | --- | --- |
| 1 | **P0** | 主干不绿 | 3 条新违规 + 31 失败用例 + jsdom 崩溃 | 先修红灯；pre-commit 加 `vitest related` 或至少挡住已红文件 |
| 2 | **P0** | 缺 domain 层，449 条私有直连无清偿计划 | 25 对双向依赖、15 组文件级循环 | 抽 `domain/`（note / document / surface / property），按 seam 分批搬迁；给基线设"每周 −N"目标 |
| 3 | **P1** | 3 个千行 UI 文件 | 3,352 行 / 39 useState | 先拆 `TableDocumentViewSession` 的状态层，保持"渲染层只读 view-model" |
| 4 | **P1** | 457 处裸 `void` | `fireAndForget` 仅 23 处 | ESLint 加 `no-void`（或 restrict `void <call>`），推广 `fireAndForget` |
| 5 | **P1** | IPC 无绑定生成 | 346 处手写泛型 vs 1,025 行手工镜像类型 | 引入 `tauri-specta` 生成 `bindings.ts`；短期内给"写盘/删除/重命名"加运行时校验 |
| 6 | **P1** | 1,107 处硬编码中文 | 133 个文件 | 按模块搬进词表；加一条"非 i18n 目录禁止中文字面量"的 lint（先 warn） |
| 7 | **P2** | CSS 单包 487 KB | 全部 surface 首屏 | 三块 CSS 挂到懒加载组件 |
| 8 | **P2** | 无统一 sanitize 出口 | 62 处 `innerHTML` | `lib/` 提供唯一 `renderTrustedHtml()`；`no-restricted-syntax` 禁裸赋值 |
| 9 | **P2** | 5 个零引用依赖 + 两套图标库 | lucide 107 / phosphor 63 | 删包；图标统一（建议保留 lucide，新模块逐步迁移） |
| 10 | **P2** | 渲染隔离缺失 | 7 处 `memo` vs 638 处 `useCallback` | 列表/树行组件加 `memo`，把菜单/弹窗状态下沉 |

---

## 9. 两版之间实际发生了什么（值得记下来）

| 项 | 10-25 | 10-27 | 变化 |
| --- | --- | --- | --- |
| ESLint | 无 | 动态推导的跨 feature 规则 + 类型感知规则 | 从 0 到 1 |
| 架构门禁 | 逐文件硬编码白名单 | 策略表 + 基线（443+36） | 质的改变 |
| 显式 `any` | 10 处（门禁红） | 0 | ✅ |
| 错误边界 | 3 处（整窗级） | 根 2 + 面板 5 + surface 级 | ✅ |
| 启动图 gzip | 467 KB | 324 KB | −31% |
| 双向依赖对 | 38 | 25 | −34% |
| 测试 | 假设绿 | 13 文件 / 31 用例红 | ⚠️ 新问题 |
| CSS 首屏 | 489 KB | 487 KB | 未动 |
| 巨型文件 | 3,378 行 | 3,352 行 | 未动 |

**判断**：重构的方向和执行力都已经验证过了（启动图那 −31% 是靠 manifest 静态闭包定位到 6 条真实桥，不是瞎改）。现在缺的不是能力，是**把"门禁"变成"节奏"**——红灯有人当天修、基线每周减、CSS 和大文件各排一个批次。

---

## 10. 一句话总结

> 这是一套**设计清晰、门禁到位、执行打七折**的架构。
> 72 分不是"写得不好"，而是"该清的账还没清"：449 条私有直连是账，16 个千行文件是账，1,107 处硬编码中文是账，31 个红灯也是账。
> 好消息是——账本已经摊开在 `architecture-baseline.json` 里了，这比大多数团队的起点高得多。
