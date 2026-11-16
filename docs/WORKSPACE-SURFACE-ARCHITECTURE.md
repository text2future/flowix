# Workspace Surface 架构与打开协议

## 目标与边界

主列（`column-1`，index 0）与副列（`column-2`，index 1）是 workspace 的两个列实例：负责导航、布局、实例和焦点。它们把目标数据及视图上下文交给公共 surface 系统，不各自登记 renderer。`workspaceSurfaceRegistry` 是唯一 surface 能力与列支持声明（`columns: WorkspaceColumnIndex[]`，按零基位置声明）；公共 renderer 表只按 `rendererId` 装载实现。列间渲染差异（loading 归属、文件树外壳、导航 view id）由 `SurfaceRenderPolicy` 按列声明一次，renderer 不感知自己是第几列；公共挂载统一走 `SurfaceHostView`。

## 公共注册及列支持范围

列支持范围来自 `features/workspace/surface-registry.ts`：

| Surface | 主列（index 0） | 副列（index 1） |
| --- | --- | --- |
| Markdown、代码、CSV、图片、视频、表格、媒体库、HTML、DOCX、不可预览文件 | ✓ | ✓ |
| 媒体资源、Agent 对话、网页 | ✓ | ✓ |
| 文件浏览器 | ✓ | ✓ |
| 思维导图、插件产物 | ✓ | — |
| 插件工作台 | ✓ | ✓ |

表格和媒体库集合分别归入 `file-table`、`file-media-library`。打开文件夹时使用集合 surface；旧 `document-list` 已不再是 workspace surface。媒体库内部的照片列表是 renderer 内部视图，不另占 workspace surface。

## 打开入口审计

产品入口按来源分组如下。目标路由最终都应经过 `openSurfaceAtPosition` / `openSurfaceInColumn`；列 adapter 再调用既有导航 use-case。下列组件和 use-case 当前已使用公共入口：

| 来源 | 主要入口 |
| --- | --- |
| 笔记列表、搜索/最近内容、笔记链接与提及 | `memo-list.tsx`、`open-by-target.ts`、`open-notebook-note.ts`、编辑器 note-link / note-mention 扩展 |
| 笔记本文件树、文件夹集合、访问文件 | `notebook-file-tree.tsx`、`notebook-folder-view.tsx`、`notebook-access-files-list.tsx`、`work-file-browser-view.tsx` |
| 表格/媒体库引用和媒体墙 | `table-reference-node.tsx`、`media-library-reference-node.tsx`、`media-library-photo-wall.tsx` |
| Agent 对话和消息内链接/附件 | 对话列表、任务区、搜索、状态栏、新建、fork、消息内链接/附件均通过 `openSurfaceAtPosition`；副列仅由显式请求指定 |
| 浏览器 tab 操作、网页和文件 | `browser-column.tsx`、`browser-column-registry.tsx`、副列文件 renderer |
| 拖放、插件工作台及产物 | `external-file-drop-overlay.tsx`、`plugin-workbench.tsx`、`plugin-agent-workbench.tsx` |
| 历史、恢复和应用级请求 | `document-navigation.ts`、启动恢复、main-window effects / business controller |

导航 use-case 内部直接调用 `openBrowserColumnTarget`、`openExternalTarget`、`openCollectionTarget` 等属于列 adapter / 事务实现。Agent 产品入口统一调用 `openSurfaceAtPosition`；协议内部保留 Agent hydration、恢复、选择状态和空草稿处理。恢复流程仍可在恢复边界调用 Agent 导航 helper。公共副列 API 已移除按 surface 类型拆分的打开方法；`createFileBrowserTarget` 只负责构造目标数据。副列 tab 的"在主列打开"操作也已改为提交主列 surface 请求。未来新增产品入口应依赖 `open-surface-api.ts`，而不是依赖具体列导航函数。

## 公共打开协议

打开入口按定位方式分两个：

- `openSurfaceAtPosition({ index, target, options })`：**位置优先**，产品级入口。主点击（笔记、文件树、对话行）传 `index: 0`；显式"在右栏打开"传 `index: 1`。index 通过 `placement` 解析到当时的列实例。
- `openSurfaceInColumn({ columnId, target, options })`：**实例优先**，列内动作（tab 切换、历史回放等）。交换位置后仍作用于原实例。

两者最终都提交 `WorkspaceSurfaceOpenRequest`（`host: 'column-1' | 'column-2'`），由 `openWorkspaceSurface` use-case 执行：

- 同一内容可分别拥有一个主列 view 和一个副列 tab。副列内按内容身份复用 tab 并激活，不重复创建同内容 tab。
- 打开 target 不接受 `empty`。清空是 workspace 状态变更，不是打开 surface。
- 成功返回 `{ status: 'opened' | 'activated', host, location }`。
- 被新导航取代或副列保存屏障阻止时返回 `{ status: 'cancelled', host, reason: 'navigation-cancelled' }`。
- 领域错误通过 Promise rejection 传递，不伪装成取消或成功。
- 副列底层 `alreadyOpen` 是列 adapter 的内部结果；公共调用方只看 `status` 与 `location`。

主列 adapter 会在导航完成后核对请求 identity 是否成为主列当前目标；若导航已经被较新的事务取代，则返回 cancelled。只有同一内容将同时挂载到两个列时，打开协议才会 flush 另一侧；副列打开无关 surface 不会提交主列的编辑；主列更换内容时仍会保存即将离开的编辑器。副列 coordinator 在切换或替换副列 tab 前执行当前 tab 的 flush；失败时返回取消，调用方保留现有 tab。编辑器保存/数据解析等实际错误继续 rejection。

## Renderer presentation 与 lifecycle 覆盖

下表按 renderer 代码盘点：静态 presentation 来自公共注册和 host target；“动态”指 renderer 向公共运行时通道发布信息。内部组件已有自己的加载/保存 UI，不代表它已接入公共 surface 状态或生命周期。

| Surface | Presentation | Lifecycle / 编辑状态 |
| --- | --- | --- |
| Markdown | 静态标题/图标；DocumentContainer 发布真实读取 loading / error / ready；插件预览动态更新外观与能力 | DocumentContainer 注册 ready、flush、discard、focus、dispose |
| Code | 静态标题/图标；DocumentContainer 发布真实读取 loading / error / ready | DocumentContainer 生命周期已注册 |
| CSV | 动态发布文件名及读取 loading / error / ready；加载错误通过公共 retry action 重试。分隔符选择仍由 renderer 内联呈现；保存进度和冲突沿用 CSV actionable notice | 公共 flush 等待同一保存 Promise 及保存期间产生的新 revision；冲突/失败返回 false，草稿仍由 CSV 保留；不提供 discard |
| Image / Video / Media | 动态发布文件名与 loading / error / ready / unsupported；错误提供 retry。图片在 DOM 解码完成后 ready，视频在授权并读取 metadata 后 ready | 只读，无编辑 lifecycle |
| Table | 动态发布集合标题及 content loading / error / ready；错误支持重载，引用的 `table.id` 与当前文件不一致时发布 `unavailable/stale-context`。单元格、保存和集合操作反馈留在 TableDocumentView | 公共 flush 同时等待集合事务与单元格属性队列；事务失败、字段错误或 session 切换返回 false；不提供 discard |
| Media library | 动态发布集合标题及 content loading / error / ready；错误支持重载。筛选、导入/删除及保存反馈留在 MediaLibraryView | 公共 flush 等待配置、重命名及导入/删除的完整事务，嵌套配置写入不提前释放屏障；失败返回 false；不提供 discard |
| HTML | 预览 iframe 发布 loading / error / ready 与重试；源码视图发布 DocumentContainer 的读取状态 | DocumentContainer 生命周期已注册 |
| DOCX | 动态发布标题、预览 loading / error / ready、重试与 reveal/convert 操作；转换进度、结果和警告通过公共 notices 发布 | 预览为只读；转换动作由组件管理 |
| Unavailable | 动态发布标题、unsupported 状态和 reveal/default-app 操作；Browser 文件浏览器发布 MIME 解析状态，识别为代码时切换公共外观、能力和 ready 状态 | 识别为代码时使用 DocumentContainer lifecycle；其他 fallback 只读 |
| File browser | 当前目录静态；活动文件后动态更新外观、能力和 loading / unavailable / ready | 文件内容 renderer 自行注册；目录外壳没有编辑 lifecycle |
| Agent conversation | 动态发布 agent 图标、从 session store 派生的标题，以及 hydration loading / error / missing / ready；错误和 missing 提供重试 | 没有 workspace surface lifecycle；消息发送/草稿由 Agent 自身管理 |
| Web | 静态外观；现在动态发布 hostname 标题、favicon、loading / error / ready 和重试动作 | 无编辑 lifecycle；Work 状态由 renderer 管理，Browser 导航状态由 tab runtime 管理 |
| Mindmap / Plugin artifact | 插件产物加载时动态发布标题、状态和重试；注册提供默认外观/能力 | 只读渲染，无编辑 lifecycle |
| Plugin workbench | 静态外观；插件生成中、生成失败和产物列表读取失败发布公共 notices；列表空态与刷新状态保留在组件内 | 无文档编辑 lifecycle |

CSV、Table、Media library 已接入公共 flush；它们只承诺等待已经提交的编辑事务，不会自动提交尚未确认的配置表单草稿。三类没有可安全复用的 discard 实现，因此副列关闭 API 在它们不支持 discard 时仍执行 flush，失败保留当前 tab。两个列都登记当前挂载 view；主列保存入口查询 mounted view lifecycle，避免按文件类型重建 renderer 的实例 key。

动态状态代码覆盖已补齐 Table / Media library 的 content loading、error、retry 和 ready。单元格校验、筛选/配置草稿及导入/删除反馈继续留在相应操作附近；它们不是缺少公共加载状态。Table / Media library 的保存进度和失败反馈仍由领域组件呈现，CSV 保存进度和冲突继续由现有 actionable notice 管理；只有产品需要在 tab 级汇总保存状态时，才应扩展通用 notice，而不能同时重复显示 toast、inline 提示和 surface notice。HTML iframe 的失败事件受浏览器行为限制，应用内错误覆盖需要实际桌面验收；HTML 与 Code 源码视图共用 DocumentContainer 的文件读取状态。插件工作台将产物列表加载提示留在列表区域，公共层接收列表读取失败和 Agent 插件运行状态。

## 实施状态

1. **公共模型与注册：已完成。** Surface kind、target、identity、宿主支持、能力、外观和状态由 workspace 公共模型定义；宿主只传目标与 context。
2. **共享渲染链路：已完成。** `workspaceSurfaceRendererRegistry` 从公共 surface 注册生成 rendererId 映射；两个列共用 renderer 实现与公共挂载 `SurfaceHostView`，列差异由 `SurfaceRenderPolicy` 声明。重型 renderer lazy load。
3. **运行时展示与生命周期：代码覆盖已完成，集成验收待进行。** Markdown / Code 文档读取、表格、媒体库、HTML 预览、Browser 文件解析、插件产物、网页、媒体资源、DOCX、不可预览文件、Agent 对话和 CSV 均可发布其适用的动态 presentation；Markdown、Code、HTML、CSV、Table、Media library 注册公共 lifecycle。Table / Media library 的单元格和领域操作反馈、CSV 保存通知保持在现有操作上下文；表格引用身份变化已进入公共 unavailable 状态。需在桌面应用验证异步重试、HTML iframe 错误展示和各 renderer 的标题/ready 时序。
4. **旧打开 API 收敛：产品入口已统一。** 功能层可见的按类型打开方法、work-column transfer 别名和 plugin-workbench 独立打开入口已移除；Agent 产品入口也统一使用 `openSurfaceAtPosition`。Agent helper 仅由公共协议 adapter 和恢复边界调用。副列 tab 转到主列的动作（`openBrowserContentInMainColumn`）内部提交同一公共打开协议。副列 adapter 的 `alreadyOpen` 只存在内部 use-case。旧持久化目标兼容仍保留在恢复边界。

## 当前评估与优先级（2026-10-15）

核心公共注册、共享 renderer 与位置入口（主列默认 / 副列显式）的路由设计已落地；全量迁移与产品验收尚未完成。思维导图和插件产物目前只注册主列支持；通用协议不意味着每种 surface 已支持两个列。

此前扩大回归记录：surface / workspace 与 CSV、媒体库、表格单元格队列相关测试共 36 个文件、170 项，166 通过、4 失败。集合导航 3 项失败与复用分支提前返回有关：pending 激活被拒绝后仍返回 existing，阻止新事务；已有集合直接复用也跳过类型变化和 unavailable 的重新检查。Agent 的旧测试预期已更新为默认 Work 行为；本次入口迁移后尚未重跑回归。最近一次 TypeScript 检查通过。依赖层检查仍有一个独立违规：`preferences/sections/environment-config.tsx` 直接导入 Tauri process 插件。

建议按以下顺序收尾：

1. 修复集合复用、并发请求和重新校验语义；重跑相关回归。
2. 在实际应用中验收两个列的长内容滚动、通知占位、同内容双开、保存失败阻止切换/关闭及异步重试。此前滚动修复用真实 Chromium 的独立布局复现验证，并非整个桌面应用端到端验证。
3. 在桌面应用验收 Table / Media library 的 loading / error / retry 和重载行为；按领域保留单元格、配置表单和局部操作反馈。检查 CSV 通知与保存体验是否有重复提示。
4. 完成 DOCX、视频、Agent 动态标题及失效请求的集成验证；核对声明能力与可执行操作；验证 HTML / Code / Plugin workbench 已发布的状态和重试操作。

插件 Browser 支持是功能扩展，应在上述收尾之后单独实施。旧恢复数据兼容只在恢复边界保留，不为清理而移除。

## Surface presentation 盘点维度

共享 renderer 与状态容器必须保持有界的 flex 高度链：内容 slot 和 renderer wrapper 都使用 `flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden`。通知占用布局高度，状态遮罩覆盖内容；加载/错误期间保留 renderer 的挂载身份。实际滚动由 renderer 内部的编辑器、表格或媒体视图负责，公共容器不新增滚动区域。新增包装层不得断开这个高度链，否则内部 `h-full` / `flex-1` 会失去约束而随内容扩展，两个列都会无法滚动。

每个 renderer 的公共展示必须能表达：

- 标题与图标（含异步解析后的更新）；
- 标题栏样式、内容背景、加载/错误状态背景、空态装饰；
- loading / empty / ready / unavailable / error 状态，以及可执行的恢复动作；
- host、viewId、focused、readOnly 和 initialFocus；
- capabilities 与 actions，且声明能力和实际可用操作一致；
- 可编辑 surface 的 ready、flush、discard、focus 与 dispose 生命周期。

静态默认值由公共注册给出；依赖实际文件、MIME、插件结果或编辑模式的信息由 renderer 通过按 `viewId` 隔离的 runtime presentation 发布。不要在列 chrome 中按 surface kind 复制这些判断。

## 验收要点与后续事项

- 新增 surface 只在公共注册声明 rendererId、支持 host、能力和外观，并为数据定义公共 target；renderer implementation 表提供 rendererId 对应实现。
- Work、Browser 不直接登记 renderer；两边同 kind 使用同一 renderer，差异通过 render context 表达。
- 所有产品打开入口使用公共协议；内部导航 adapter 不泄漏给功能层。
- opened 表示创建了 view，activated 表示复用了并聚焦已有 view，cancelled 表示请求未完成；错误始终 rejection。
- 可编辑 renderer 的 flush 必须等待完整事务；不支持 discard 的 surface 不可跳过关闭前的 flush。
- Table、Media library 已发布公共 content loading / error / retry / ready；单元格与局部操作反馈保留在领域 UI。桌面验收后再判断是否需要新增 surface notices 汇总保存状态，避免和现有提示重复。确认 HTML / Code / Plugin workbench 的异步错误与重试在两个列表现一致。
- 已增加媒体资源加载/失败重试/ready 与过期读取丢弃、CSV 加载失败及公共 retry action 的回归测试；本轮既有 CSV 保存/恢复、表格队列、媒体库复合事务和 host lifecycle 路由也有定向覆盖。类型检查与 diff 检查见实施汇报。
