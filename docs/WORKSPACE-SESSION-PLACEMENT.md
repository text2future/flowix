# Workspace 会话与容器分离

## 状态所有权

work（内部容器 ID 为 main-third）和 browser 是固定的布局位置。primary-session、
secondary-session 使用完全相同的 WorkspaceSession 模型，活动状态唯一保存在
workspace-session-store。

每个会话包含：

- navigation.current：稳定条目 ID、统一 target、标题、图标和打开时间。
- navigation.backStack / forwardStack：同一种条目结构、相同的容量与去重规则。
- navigation.transaction：加载阶段、请求版本、待打开目标及失败信息。
- headerState：按 Surface ID 保存地址栏等内容相关 Header 状态。
- viewStates：按 Surface ID 保存网页内部 URL 历史等运行数据。
- notebookSwitchesInFlight：仍在进行的会话上下文切换。
- runtime：稳定的渲染器命名空间，与物理容器 ID 使用不同类型。

SessionSurfaceTarget 和 SessionNavigationTransaction 定义在 model 层。
旧 WorkColumnTarget 等名称仅为兼容类型别名，不再定义另一份模型。

## 写入与导航

commitTarget 对两侧调用同一个纯 reducer，在一次 store 更新中提交当前内容和
历史。文件、网页、Agent、集合和插件工作台使用同一历史规则。交换本身不增加
历史条目，文件夹内的视图切换不创建重复的文件夹访问记录。

session-navigation.ts 是两侧唯一的前进后退算法。保存和目标解析仍交给已有
Surface 打开协议；保存拒绝、打开失败或请求过期时，历史不推进。历史回放保留
Surface ID，并携带 navigationEntryId，避免重新生成展示身份。

旧 work-column-store、browser-column-store、document-history-store 和
session-web-runtime-store 不再创建 Zustand store，也不再独立持久化。
它们通过 createStoreFacade 提供旧选择器及动作名称；缓存只是从 SessionStore
派生的快照，不存在反向订阅或两份可写数据。

document-history 的旧条目结构、agent_conversation 等旧拼写只存在于兼容和
旧数据导入边界。公开会话 API 直接读取 SessionStore，不再拼接不同后端的快照。

## 容器与 Header

placement 将容器映射到会话，交换只更新两个 sessionId。容器宽度、右栏可见性、
侧栏状态和窗口控件占位不交换。右栏可见性与分栏比例保存在根级 browserLayout，
不属于会话内容。

内容保持在原有 React 树中，通过 CSS Grid 调整展示位置。交换不跨父节点移动
DOM，也不更换 Portal 容器；编辑器、iframe、Agent 与 Header 不因交换而重建。

SessionHostEnvironment 为 Header 提供当前容器环境。标题、内容操作和历史属于
会话；关闭右栏、展开侧栏、Header 几何尺寸属于容器。焦点跟随会话，分隔条和
笔记列表预览入口固定在布局层。

## 持久化与迁移

统一快照继续使用 flowix.workspace.session-placement 键，版本为 2，兼容原有
版本 1 的容器归属和 Header 设置。快照包含两个会话、容器归属和 browserLayout。

首次迁移导入旧 browser 内容及历史、document-history、网页状态和启动恢复意图。
版本 2 中的空会话和空历史也是有效状态，不会被旧键中的残留数据重新填充。
旧启动恢复 store 仍保存启动流程/Agent 列表相关信息；活动内容以统一快照为准。

恢复会验证目标和条目结构、重建瞬时事务状态、保留 Surface ID。进程内的请求、
DOM 句柄和事件函数不会反序列化。文档历史兼容接口的 persist.rehydrate 仅为旧数据
显式导入入口，不再是独立持久化后端。

## 视图恢复协议

视图快照保存在 `sessions[sessionId].viewStates[entryId].recovery`，协议版本为 1。
它与网页运行状态共存，复用统一持久化入口；历史回放复用条目 ID，交换不改写快照。
旧版没有 recovery 的会话仍可正常恢复。

渲染器通过 SessionViewRecoveryContext 获取解析时绑定的会话与条目，再使用具名
slot 读写状态。slot 表示内容内的视图角色，不能使用物理容器位置或 DOM 路径。
同一条目可以同时保存正文编辑器、源码编辑器、媒体等多个 slot。

协议约束：

- 只保存经过白名单验证的可序列化数据，不保存 DOM、编辑器实例、函数和运行任务。
- 每个条目最多 32 个 slot，每个会话最多 200 个视图状态，拒绝非有限数和非法范围。
- 写入节流为 250ms；卸载、pagehide 和页面隐藏时提交最后快照。
- 同 slot 的新适配器取得所有权后，旧适配器的延迟提交失效；已清空的条目不能被复活。
- 未就绪的渲染器返回 null，不能用加载占位的零值覆盖已保存状态。
- 恢复不抢焦点、不增加内容编辑的 undo 记录。媒体恢复位置但不自动播放。
- 延迟加载的滚动内容在布局可用后恢复；用户主动滚动会取消待完成的恢复。

已接入的适配器：

| 视图 | 重建 / 重启后恢复 |
| --- | --- |
| Markdown | 文本选区方向、节点/全文选区、滚动位置；外部内容变化时约束到合法位置 |
| 代码 / 源码编辑器 | 主选区方向、垂直和水平滚动位置 |
| 视频 | 播放进度、音量、静音和播放速度；metadata 就绪后恢复，超出时长时截断 |
| 图片 | 预览区域滚动位置 |
| 集合页面 | 整页横向和纵向滚动位置 |
| 网页 | 既有统一模型中的 URL 与导航历史 |

## 能力边界与后续适配

交换仍保持原实例挂载，因此未接入快照的视图在交换时继续保留内存状态。
恢复协议不等同于整个运行进程的序列化：编辑器 undo 栈、代码多光标、Agent 分页
消息阅读锚点、思维导图缩放/折叠、各集合面板内部状态，以及第三方 iframe 内部
DOM 状态尚未接入上述恢复协议；不能宣称它们已支持重启恢复。
这些视图应通过语义 slot 和自身的 ready 生命周期接入，不使用 DOM 树扫描推断状态。
第三方网页/沙箱插件必须提供合作式恢复接口，父页面无法直接完整捕获内部状态。
未保存的文档内容继续由既有文档保存流程处理，不放入视图快照。

## 验证

测试覆盖两侧相同提交规则、原子当前内容/历史提交、旧接口双向可见性、单一
持久化入口、旧数据导入、快照恢复优先级、稳定 Surface ID、保存拒绝、取消
导航、过期操作和交换后继续导航。

视图恢复测试覆盖同一条目的序列化回读、会话与 slot 隔离、交换和历史保留、
旧实例竞争写入、卸载与 pagehide 提交、未就绪占位保护、异步滚动内容及用户意图
取消恢复，以及真实 Markdown / CodeMirror 实例销毁重建和视频 metadata 恢复。

第一阶段已在原始 HEAD 上复现 registry-transitions.test.tsx 的 unavailable-file
用例失败；该失败与会话改动无关。
