# 侧边栏（文件树 / 笔记列表）代码审计

范围：`app/flowix-web` 下侧边栏相关模块（`features/memo/components`、`features/memo/store`、`features/memo/services`、`features/shell/components`、`shared/ui`）。
性质：只读审计，本次未修改任何源码。

## 1. 审计方法（可复核）

1. **可达性分析**：从 `entrypoints/desktop.tsx` 出发解析全部 `import` / 动态 `import()`，按 `@/`、`@app/`、`@features/`、`@platform/`、`@shared/` 别名建图，找出从生产入口不可达的源文件。
2. **导出符号引用扫描**：对目标目录所有 `export function|const|class|type|interface` 统计全仓 token 引用次数，零外部引用者列为候选（排除 `.test/.spec` 后仍为零才算）。
3. **人工阅读**：对上述候选逐个打开确认，并对核心渲染链路（`notebook-file-tree.tsx`、`folder-file-tree.tsx`、`use-folder-tree.ts`、`note-store.ts`）逐段核对。
4. 标注规则：**已确认** = 有 grep 零命中或代码直读证据；**需确认** = 依赖运行时行为或产品意图，需人工判断。

## 2. 结论摘要

- 侧边栏「排序 / 路径规范化 / 选择判定」的核心是单点的（`compareTreeItems`、`canonicalPath`、`memo-list-selection.ts`），结构没有失控。
- 真正的冗余集中在四处：**整树遍历重复 4~5 遍**、**路径原语各写一份（最多 8 处，标准库已有）**、**笔记列表过滤谓词两份且已经不一致**、**分区可见性判定两份且已经产生实际错判**。
- 死代码约 **604 行**（6 个文件级 + 若干符号），其中最确定的是两个「导航抽屉」旧实现与一个滚动锚定 hook。

## 3. A 类：未使用代码

### 3.1 文件级不可达（生产入口到不了，均已 grep 确认无 import）

| 文件 | 行数 | 说明 |
|---|---|---|
| `features/memo/components/notebook-access-files-list.tsx` | 222 | 「笔记本访问文件列表」。功能已被 Agent 云访问区（collection/agent composer）取代，无任何引用。 |
| `features/memo/components/memo-list-navigation-drawer.tsx` | 131 | 包裹 `TagTree` 的旧滑出抽屉。无 import。 |
| `features/memo/components/note-navigation-drawer.tsx` | 127 | `NoteNavigationPanel` 的旧抽屉容器。**注意**：`NoteNavigationPanel` 本身仍在用（`public/shell-api.ts:20`），死的是这层抽屉外壳。 |
| `features/memo/components/memo-list/use-memo-list-scroll-anchor.ts` | 70 | 列表滚动锚定 hook。除自身测试外零引用；且它依赖的 `[data-note-list-content]` 全仓**从未被渲染**（只在它自己和测试里出现），说明列表早已换用 `use-dynamic-virtual-list` 的 `preserveScrollAnchor`。 |
| `shared/ui/skill-market-loading-skeleton.tsx` | 36 | 零引用骨架屏。 |
| `features/memo/components/memo-create-location.ts` | 18 | `parentRelativePathForTreeCreate` 零引用（新建落点逻辑已迁到 `use-notebook-tree-creation` 一侧）。 |

小计 604 行（含同目录 `.test.tsx` 需一并删除）。

### 3.2 符号级死代码

| 符号 | 位置 | 证据 |
|---|---|---|
| `setActiveCustomFilter` | `store/note-store.ts:229`（声明）、`:568-583`（实现） | 全仓仅这 2 行，无调用方、无 `getState()` 使用。自定义筛选实际走 `setDataCondition`。 |
| `loadedRootPath` / `setLoadedRootPath` | `components/use-folder-tree.ts:176`、`:408`、`:438`、`:808`、`:822` | 只有写入（2 处）与返回（1 处），**没有任何读取方**；还被放进 deps，写一次就整体重建返回值。 |
| `flattenLoadedTree` | `components/use-folder-tree.ts:834-858` | 生产零引用，仅 `use-folder-tree.test.tsx` 使用；等价于 `buildLoadedTreeIndex(...).items`。 |
| `initializeNoteLibrary` | `use-cases/initialize-note-library.ts:160`，经 `public/app-api.ts:14` 转出 | 生产零调用，只有测试用；启动实际走 `initializeNotebookContext`。**需确认**是否保留给老版本迁移。 |
| `buttonVariants` | `shared/ui/button.tsx` | 零引用（组件内部未用 cva）。 |
| `memoListQuery` / `memoListNextCursor` | `store/note-store.ts:205-206` | 组件 selector 从不订阅，只被 store 内部读。属实现细节写进了公共 store 接口，建议标注 internal 或下沉。 |
| `MemoListPreviewPhase`、`SelectedNoteIdentity`、`MoveTagReport`、`DeleteTagReport`、`IndexedMemoRefreshResult`、`CustomViewDocumentType` | 各对应文件 | 类型仅本文件/本模块用，多导出了一层。低价值清理。 |

补充：`folder-file-tree.tsx:53-59` 的 `formatTimestamp` 与项目中至少 8 处「YYYY-MM-DD HH:mm」手写格式化重复（`preferences/sections/cloud-sync.tsx:52`、`document/components/note-properties/date-value-input.tsx:33` 等），属于全局问题，不限于侧边栏。

> 说明：`*Props` 类型的零引用导出（约 20 个）不建议动——组件对外类型是本模块契约，删了没有收益。

## 4. B 类：冗余逻辑

### 4.1 同一棵树的派生要遍历 4~5 遍

全部由 `nodes` 变化触发，各自一次全树 walk：

1. `components/use-folder-tree.ts:871-895` `buildLoadedTreeIndex`
2. `components/use-notebook-tree-derived.ts:26-43` `addPinnedTreeItems`
3. `components/use-folder-tree.ts:980-994` `flattenFolderSubtrees`（`notebook-file-tree.tsx:361-364` 调用）
4. `components/use-notebook-tree-derived.ts:56-62` 先建 rows，再遍历建 `rowIndexByPath`
5. `use-pinned-section-items.ts:89` 把 `loadedItems` 再建一次 Map，`:100` 再跑一次 `flattenFolderSubtrees`

建议：合并为 `useNotebookTreeModel()`，一次遍历产出 `{ items, byPath, folderPaths, rows, rowIndexByPath }`，第 5 项复用第 1 项的 `byPath`。

### 4.2 路径原语：标准库已有，仍各写一份

`lib/path.ts` 已提供 `isPathInDirectory`（:93）、`parentDirectoryPath`（:48）、`fileNameFromPath`（:109）、`canonicalDirectoryPath`（:42）。但：

- 「path 是否等于或位于目录 X 之下」至少 8 处各自实现：`use-folder-tree.ts:32`、`:39-41`、`use-notebook-tree-sections.ts:44-47`、`use-notebook-pinned-expansion.ts:19-20`、`use-notebook-tree-file-actions.ts:94-97`、`use-notebook-tree-clipboard.ts:89-90`、`use-notebook-tree-drag-controller.ts:207`（另 `:278`、`:483` 同类）、`use-folder-tree.ts:619-620`。
- 「取父目录」在同一文件里手写 4 遍：`folder-file-tree.tsx:165`、`:190`、`:226`、`:251`。
  其中 `:165` 是 `item.fullPath.slice(0, item.fullPath.replace(/\/+$/, '').lastIndexOf('/'))`——**无斜杠时 `lastIndexOf` 返回 -1，`slice(0, -1)` 会截掉末字符**；`parentDirectoryPath` 有 `separatorIndex >= 0` 兜底。
- 「取 basename」5 处：`use-folder-tree.ts:901`、`:94`、`use-notebook-pinned-notes.ts:60`、`use-pinned-section-items.ts:64`、`lib/path.ts:109`。
- 「改名后整体搬迁路径集合」两份骨架：`use-folder-tree.ts:43-55`（`Set`）与 `use-notebook-tree-sections.ts:40-50`（`string[]`）。

### 4.3 笔记列表过滤：store 内两份谓词，且已不一致

- 权威实现：`note-store.ts:371-403` `matchesMemoListQuery`，覆盖 `plugin / custom / color / favorited / todos / agents / tagged / thisWeek / thisMonth`。
- 缩水副本：`note-store.ts:697-713`（`upsertCreatedNote` 内联），**缺 `color`、`thisWeek`、`thisMonth` 三个分支**。

后果：`activeFilter === 'color'` 时新建笔记会被插进颜色筛选列表；`thisWeek/thisMonth` 下同理。
调用方 `memo-list.tsx:416-427`、`note-creation-api.ts:23-27` 都直接调 `upsertCreatedNote`，没有像 `createNote`（`note-store.ts:885-895`）那样先经 `getVisibleCreateFilter` 归一化。

修法：`upsertCreatedNote` 内改为复用 `matchesMemoListQuery`，删掉 697-713 的手写分支。

同类问题：`dataCondition` 判定在 6 处各调一次（`note-store.ts:344`、`:359`、`:377`、`:411-413`、`:762-764`、`:789-791`）；`tagId` 归一化（`activeFilter === 'tagged' ? selectedTagId : null`）写了 5 份（`note-store.ts:293`、`:610-611`、`memo-list.tsx:176`、`use-memo-list-load-controller.ts:32`、`initialize-note-library.ts:51`）；查询键组装 7 处，其中 `use-memo-list-load-controller.ts:26-38` 与 `:98-107` 是同一文件内重复计算。

### 4.4 分区可见性：hook 与视图各判一次，已产生错判

- 权威：`components/use-notebook-tree-section-layout.ts:35-41`，`agents` 分区要求 `Boolean(notebookId) && agentSectionHeight > 0`。
- 重复：`components/notebook-tree-sections-view.tsx:124` 只判 `agents.notebookId && !hidden.includes('agents')`，**没有高度条件**。

结果：agents 区首帧高度为 0 时，视图照常渲染，但 `layout.visible.indexOf('agents') === -1`，于是 `sectionMenu`（`:108-113`）算出 `canMoveUp=false`、`canMoveDown = -1 < len-1 = true`——**第一个分区却显示「可下移」**。同一文件 `:138`、`:153`、`:186`、`:204` 也各自复写了一遍可见性条件。

### 4.5 其它可收敛点（低风险，收益一般）

- `pinnedItemPaths`（`notebook-file-tree.tsx:337`）与 `pinnedNavigationItems`（`:338-340`）对同一数组连着 map 两次。
- `rowIndexByPath` 已建好（`use-notebook-tree-derived.ts:57-61`，key 用 `canonicalPath(fullPath)`，值就是 rows 下标），但 `notebook-file-tree.tsx:828-833` 的 `folderDropHighlight` 仍对 `renderRows` 做 `findIndex` 线性扫描。
- 滚动定位的行高数学写了 3 份：`use-notebook-tree-interaction.ts:232-237`、`:267-280`、`notebook-file-tree.tsx:522-527`。
- `use-notebook-tree-creation.tsx:40-41` 两个导出名（`openNewMediaLibraryDialog` 与 `handleCreateMediaLibraryAtPath`）指向同一实现，唯一差别是前者的 `parentPath` 可选，两个名字都在调用点出现。
- `use-notebook-tree-section-layout.ts:74-76` 与 `:77-79` 两个高度回调逐字相同。
- `use-folder-tree.ts:416-422` 与 `:624-630` 的失败分支 5 行逐字重复。
- 刷新入口有 7 个（`refresh` / `refreshDirectory` / `retryDirectory` / `refreshDirectories` / `refreshDirectoriesNow` / `refreshRootPreservingExpansion` / `reload`），对外可收敿为 `refresh(path?)` + `reload()`。
- `useNotebookTreeSections` 被实例化两次（`notebook-file-tree.tsx:290` 与 `notebook-tree-visibility-list.tsx:7`），各自读一次偏好、各注册一次全局监听；`updateSections` 有广播，但 `pinnedFolders` 状态是两份。

## 5. C 类：读代码时发现的实质缺陷（非风格问题）

1. **`upsertCreatedNote` 过滤缺分支**（见 4.3）——颜色/时间筛选下会插入不该出现的笔记。
2. **分区菜单 canMoveUp/Down 错判**（见 4.4）——首个分区可「下移」。
3. **`folder-file-tree.tsx:165` 父目录截取无边界兜底**——路径无 `/` 时截掉末字符（是否可达取决于 `fullPath` 是否总是绝对路径，**需确认**）。
4. **`use-notebook-tree-derived.ts:35` 返回的 `items` 不含置顶项**，与同函数的 `itemByPath` / `folderPaths` 不自洽。当前调用方只取后两者，属潜在陷阱。
5. **`hasVisibleItems` 与 `visibleTreeItems` 不同源**：`notebook-file-tree.tsx:540` 用 `rootChildren.length > 0` 判空态，而实际渲染依据是 `visibleTreeItems`（`:361`）。

## 6. 建议处理顺序

**P0（先修行为，1 处改动）**
1. `note-store.ts:697-713` 改调 `matchesMemoListQuery`。
2. `notebook-tree-sections-view.tsx` 的四处可见性判断改为只读 `layout.visible`（顺带修 canMoveUp/Down）。

**P1（删死代码，纯删除、无需回归）**
3. 删 3.1 的 6 个文件（604 行）及对应测试。
4. 删 3.2 的 `setActiveCustomFilter`、`loadedRootPath`、`flattenLoadedTree`、`buttonVariants`。

**P2（结构性收敛，需要排期）**
5. 路径原语统一到 `lib/path.ts`（4.2），优先做 `folder-file-tree.tsx` 的 4 处，改动局部、可单测覆盖。
6. 树派生合并为 `useNotebookTreeModel()`（4.1），这是性能收益最大的一步，但触及文件树核心，需配合现有 `use-folder-tree.test.tsx`、`use-notebook-tree-derived.test.ts` 回归。
7. 查询键与 tagId 归一化收敛为选择器（4.3 后半）。

## 7. 需确认项

- `initializeNoteLibrary` 是否仍需保留给老版本数据迁移。
- 两条事件刷新总线（`memo-list-refresh-service` 与 `app/main-window-effects.tsx` 的 memo dispatcher）是否会对同一次写入都触发；决定能否合并。
- 分区高度公式（`use-notebook-tree-section-layout.ts:43-52`）与真实 DOM 存在 2~4px 偏差（`TREE_HEADER_HEIGHT=30` vs 实际 `h-7=28`；分页行 `h-8=32` 却按 `TREE_ROW_SIZE=34` 计），是否会造成滚动偏移累积。

## 8. 处理记录（2026-11-14）

### 已修

| 项 | 改动 |
|---|---|
| `upsertCreatedNote` 过滤缺分支 | `note-store.ts` 新增 `currentListQuery()` 统一构造查询，`upsertCreatedNote` 改为复用 `matchesMemoListQuery`，删掉 697-713 手写分支。补回归用例 `note-store.test.ts`「skips a created note that the active color filter excludes」。 |
| 分区可见性重复判定 | `use-notebook-tree-section-layout.ts` 拆出 `renderableSectionOrder`（视图可挂载，agents 只看 `notebookId`）与 `visibleSectionOrder`（占空间，用于排序）；`notebook-tree-sections-view.tsx` 五处判断统一读 `layout.renderable`，删掉重复的 `hidden` / 条目数判断；`sectionMenu` 的 `canMoveDown` 加 `visibleIndex >= 0` 兜底。**注意**：不能把 agents 直接按 `visible` 渲染，它必须先挂载才能测出高度，否则永远不显示。 |

### 已删除

| 文件 | 行数 |
|---|---|
| `features/memo/components/note-navigation-drawer.tsx` | 127 |
| `features/memo/components/memo-list-navigation-drawer.tsx` | 131 |
| `features/memo/components/memo-list/use-memo-list-scroll-anchor.ts` + `.test.tsx` | 70 + 测试 |
| `features/memo/components/memo-create-location.ts` + `.test.ts` | 18 + 测试 |
| `shared/ui/skill-market-loading-skeleton.tsx` | 36 |

符号：`note-store.ts` 删 `setActiveCustomFilter`（声明 + 实现）；`use-folder-tree.ts` 删只写不读的 `loadedRootPath` 及其 setter/deps、删与 `buildLoadedTreeIndex` 同构的 `flattenLoadedTree`（其回归用例已迁到 `buildLoadedTreeIndex`）；`shared/ui/button.tsx` 的 `buttonVariants` 改为内部常量、不再导出（它仍被 `Button` 使用，不能删）。

### 暂缓（原因）

- `features/memo/components/notebook-access-files-list.tsx`：仍不可达，但当前工作区里它正被另一处在途改动修改（菜单色板统一）。等那次改动落地后再删，避免与在途工作冲突。
- `folder-file-tree.tsx` 的 4 处手写父目录截取：该文件有较大未提交改动 + 新增 `folder-file-tree.rename-slot.test.tsx`，改动区域虽不重叠但同文件并发编辑风险高，建议单独一次提交处理。
- 树派生合并（§4.1）：性能收益最大，但触及文件树核心，需专项排期。

### 验证

- `npx tsc --noEmit`：仅剩 `shared/ui/intro-card.tsx` 报错，该文件是他人新建的未跟踪文件，与本次无关。
- `npx eslint` 改动文件：0 error，1 个**预先存在**的 `exhaustive-deps` warning（`use-folder-tree.ts:719`，不在改动区）。
- `npx vitest run`：`note-store.test.ts` 29 通过；`use-folder-tree` / `use-notebook-tree-sections` / `notebook-file-tree` 合计 120 通过 + 1 expected fail。
- `check-layer-boundaries`：通过。`check-architecture` / `check-frontend-debt` 失败项全部来自他人未提交的 `work-documents` 模块与冻结文件增长，与本次改动无关。

## 9. 专项需求：文件树派生计算合并（§4.1）

### 9.1 问题定义

`useFolderTree` 的 `nodes` 是整体替换的（`use-folder-tree.ts:171`，`useState<Map>` + 每次目录刷新换新 Map）。它一变，`notebook-file-tree.tsx` 里四条**各自独立**的 `useMemo` 派生链同时失效，每条都从同一棵树重新走一遍：

| 环节 | 位置 | 遍历规模 | 必要性 |
|---|---|---|---|
| 加载索引（items / itemByPath / folderPaths） | `use-folder-tree.ts:843` | **N** | 必要，唯一真相源 |
| 置顶区取节点 | `use-pinned-section-items.ts:89` | **N** | **不必要**——`new Map(loadedItems.map(...))` 与上一步 `itemByPath` 逐键等价 |
| 置顶补充索引 | `use-notebook-tree-derived.ts:26` | **N**（Map/Set 整体复制） | 部分必要，可下沉为覆盖层 |
| 可见扁平 | `use-folder-tree.ts:940` | **V** + 每层 `[...items].sort()` | 必要；比较器每次比较调 2 次 `canonicalDirectoryPath`（`:892`） |
| 渲染行 | `notebook-tree-render-rows.ts:53` | **V** | 必要 |
| 兄弟位序（counts / positions） | `notebook-tree-render-rows.ts:32`、`:37` | **V × 2** | 可压成「计数 + 回填」或按父分组一次算 |
| 行号索引 | `use-notebook-tree-derived.ts:57` | **V** | 应与建行同趟 |

即：N 侧 3 遍、V 侧 5 遍。之前那轮「三张表分开算」已经合过（`buildLoadedTreeIndex` 注释 `:830-836` 记录了这件事），**剩下的是没合完的部分**，不是从未做过。

### 9.2 为什么它不只是风格问题

1. 同一套「路径必须先 `canonicalPath`」的不变量在 4 处各写一遍，任何一处漏掉就是静默的键错位（§5.4 已经出现过：`items` 不含置顶项而同函数的 `itemByPath` 含 —— 现在靠「调用方只取后两者」维持）。
2. `useMemo` 依赖数组里同时挂 `rootChildren` / `nodes` / `loadedItems` / `pinnedSectionItems`，链式失效面很大，加字段时很难判断谁会重算。
3. 要动排序或置顶语义（如新增一种分区），必须同时改 4 处并保持顺序一致。

### 9.3 不变量（合并时必须保住，否则静默坏）

1. `items` / `itemByPath` / `folderPaths` 必须同一趟遍历产出，键统一 `canonicalPath`，值取 `nodes.get(key) ?? candidate`（根与父的 `children` 只是单层占位）。
2. 置顶分区有**独立展开集合**（`use-notebook-pinned-expansion`），不得复用 files 树的 `expanded`。
3. `addPinnedTreeItems` 在「没有新路径」时必须返回原对象引用——拖拽/剪贴板/交互控制器靠这个引用稳定跳过重算。
4. `posInSet` / `setSize` 直接喂 `aria-posinset` / `aria-setsize`（`notebook-tree-row.tsx:479-480`），语义是「同一父目录下第几个 / 共几个」，草稿行不计数。
5. 排序契约五级不可变：文件夹在前 → 置顶序 → 隐藏目录聚前 → 用户排序 → 名称兜底（`compareTreeItems`）。
6. `flattenFolderSubtrees` 是共享实现（访问空间、集合文件夹树也用），改签名需同步 `folder-file-tree.tsx` 与 `use-folder-tree.test.tsx`。

### 9.4 分档（收益 / 风险）

- **档 A｜低风险，纯去重**：`buildPinnedSectionItems` 改收 `itemByPath`，删掉那次 N 全量 Map；`buildNotebookTreeRenderModel` 建行同趟建 `rowIndexByPath`。N 从 3 降到 2，V 从 5 降到 4，行为零变化。
- **档 B｜中风险**：`attachTreeSiblingMetadata` 两遍压成「一遍计数 + 一遍回填」，并把它并入 `buildNotebookTreeRenderRows` 的建行趟。V 从 4 降到 3。
- **档 C｜高风险，本轮不做**：`flattenVisibleTree` 与建行合成一次遍历（现在扁平结果只给 rows 和交互层用，可让 rows 携带父路径直接消费）；`addPinnedTreeItems` 改覆盖层 Map 消除 O(N) 复制。

### 9.5 准入条件（先测再改）

用现成的 `window.__flowixPerf.dump()`，构造「1k 节点 / 200 可见行 / 一次 watcher 刷新」的场景，记录 `nodes` 变更到首帧的时间与长任务归因。

- 若单次派生 < 8ms 且不长于 1 帧预算：本专项降级为「结构整理」，随档 A 顺手做，不单独排性能窗口。
- 若 > 16ms 或出现在 `save_probe` 的慢帧里：按档 A → B → C 依次推进，每档单独提交、单独回归。

### 9.6 验收

- 遍历次数：N 侧 3 → 1（档 C 后），V 侧 5 → ≤3（档 B 后）。
- 现有用例全绿：`use-folder-tree.test.tsx`、`use-notebook-tree-derived.test.ts`、`use-pinned-section-items.test.ts`、`notebook-file-tree.test.tsx`（含 `buildLoadedTreeIndex` 调用次数断言 `:356`）。
- 新增一条同源一致性用例：同一 state 下 `items.length === itemByPath.size`，且置顶补充后 `itemByPath` 不丢键、`items` 与 `itemByPath` 仍自洽。

### 9.7 非目标

- 不改虚拟化（已按 `TREE_ROW_SIZE` 走 measured 虚拟滚动）。
- 不改 watcher 的整体替换策略（它是索引一致性的前提）。
- 不做树结构缓存 / 增量 diff。
