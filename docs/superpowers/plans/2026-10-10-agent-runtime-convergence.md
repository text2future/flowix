# Flowix Agent 消息与 Runtime 收敛实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 减少消息写入与运行管理的维护路径，保持历史可读，并消除启动、停止、快照恢复中的竞争窗口。

**Architecture:** 保留 runtime 注册表、ThreadProjection 与纯 reducer。实时事件及历史页作为两条消息来源，运行快照与本地操作使用内部 action，最终统一提交投影。后端使用按产品 thread 的共享操作认领，原生协议、历史来源与停止证明仍由各 runtime 负责。

**Tech Stack:** React 19 / TypeScript / Zustand / Vitest；Rust / Tokio / Tauri 2；DSH app-server 使用其子项目 Vitest。

**Spec:** 本次会话用户提供的《Flowix Agent 消息与 Runtime 管理收敛落地方案》（分析基线 a7c3cef5dc52b0aef8be243767114916d7f48f66，2026-10-09）。本文件保存实施所需的核心约束及审查修订；完整原文在会话中，执行人员应同时阅读。没有修改原方案或业务代码。

## Global Constraints

- 展示按产品 threadId 索引；provider 别名带 runtime 范围。不得覆盖关联后使旧历史失去定位。
- 一个产品 thread 最多一个普通 run；Starting、Running、Stopping 都占用槽位；不同 thread 可并发。
- 停止与终结必须匹配 threadId 和 runId；状态未知不能释放；锁内不做网络、磁盘或等待进程退出。
- steering 不默认新建 run；DSH /goal 原生调度与 /plan 注入语义保留；不另建任务队列。
- 保留空白 delta；snapshot 与 delta 显式区分；不按文本相同普遍去重。
- partial 历史不因缺失删消息；没有轮次归属与完成证明，不声明 complete-turns。
- 旧请求不得覆盖请求期间更新的消息；分支切换不得混合时间线；未确认 live cache 不释放。
- 旧格式兼容保留在明确读取入口；不改写 provider 历史；不引入事件溯源或跨 runtime 调度框架。
- 幂等只承诺当前后端进程的重试窗口；建议终结后 30 分钟、最多 4096 条接受记录，须经任务 0 验证后冻结。未过期及活跃记录不得提前淘汰。
- 不自动重发跨重启或超窗口的未知请求。新增 IPC 字段先兼容读写，再迁移调用方。
- 每个 PR 独立验证与回退；不得为对照测试启动两次真实 Agent。

## 审查结论与本次证据

审查日期：2026-10-10。目录 `D:/02 vibeworking/flowix` 是源码资料副本，没有 `.git`，不能证明与上述提交完全相同。以下为本地源码事实，不是基线提交的动态运行结果。

| 项目 | 已核对事实 | 实施意义 |
| --- | --- | --- |
| stream-event-dispatcher.ts | text_delta 使用 `!event.text.trim()`；flush 取当时 activeRunId | 空白与缓冲归属作为首批正确性修复 |
| streaming-buffer.ts | Map<string,string> 以 thread 为键 | 缓冲必须保存入队时的 run 与事件元数据 |
| agent-history-adapters.ts | Claude/OpenCode getFullHistory 仅取 50；公共契约含 piRevision/piBeforeEntryId | 全量与分页必须先区分；不能只重命名接口 |
| thread-history-slice.ts | reloadMessagesFromHistory 使用上述全量结果，存在替换并设置 hasMoreHistory=false 的路径 | 长历史回归必须覆盖调用方，而非只测 adapter |
| external-session.ts | resolveProductThreadId 按 provider 字符串反查，无 runtime 参数 | 多 runtime 同 ID 可以误归属；优先修复 |
| reduce-projection.ts | 多处旧形状转换；含 Pi 身份规则及 DSH /plan 文本识别 | 形状收敛与 provider 语义下沉分开做 |
| shared/runtime.rs | prepare_start 检查但不占位；stop_run 先 remove 再 kill | Starting 占位、停止保留槽位必须作为完整链路修改 |
| shared/process_io.rs | kill_child_tree 返回 ()，部分失败仅日志 | 必须增加可判断的停止结果；不能把返回当终止证明 |
| claude/cli.rs | prepare_start 后 spawn 异步任务；原生进程 spawn 后才 try_insert | 适合作为启动票据试点 |
| agent-session-store.ts | 运行查询后直接应用快照；缺失 run 经过时间宽限可合成 stream_end | 需要请求时版本与 run 校验；时间宽限不能替代版本 |
| hooks/use-agent-events.ts | 已保留运行查询失败前的状态，继续历史读取 | 属于已有行为，保留并补回归，不重建恢复机制 |
| sync 方法 | 在已检索 app、dsh-appserver、examples、scripts 的源码中仅发现定义、测试与注释 | 是强删除候选；还需核对公共导出和动态访问 |
| DSH command-service.js | /plan 返回 steer，/goal 返回 goal-round | 公共互斥不可抹平原生调度 |

实际执行：`npm run check:layers` 返回 11 处现有分层违规，集中在 shell 的 browser-column、browser-column-header、global-search-command、main-layout；`npm run check:frontend-debt` 因缺少 typescript 无法加载脚本。根项目和 dsh-appserver 均无 node_modules。未运行 Vitest、构建或 Rust 测试；此前 source.memoId 失败尚未复现。本轮没有安装依赖或启动真实 Agent。

## 实施前修订原方案

1. 完成标准改为：**消息来源只有实时事件与历史页；所有投影写入通过统一内部提交，运行快照和本地 action 不伪装 provider 事件。**
2. 将共享“操作认领”与现有“子进程容器”分开建模，但在现有共享设施中实现。注册表仍只注册调度；不可把 Codex/DSH 的共享 app-server 当作会话 Child。
3. 任务范围补充 commands/agent/chat.rs、commands/agent/runtime.rs、agent_wire.rs、shared/process_io.rs、agent-session-store.ts、hooks/use-agent-events.ts、运行状态 selectors、删除/切换绑定入口和 app 状态装配。仅改原文件清单不能闭环。
4. 历史契约必须给消息提供稳定轮次归属。优先复用已验证字段，否则在 HistoryPage 添加可选 `messageTurnIds: Record<string,string>`；这是 adapter 的页元数据，不新增数据库字段。缺失映射只能 partial。
5. 请求上下文补充会话实例/绑定代次，用现有 epoch 与绑定快照实现；删后重建同 ID、切换 runtime、旧别名迟到时都要失效。新增长期持久 ID 不是前提。
6. 定义 HistoryChanged、HistoryIncomplete、AlreadyRunning、IdempotencyConflict、CapacityExceeded、StopUnconfirmed 的结构化内部错误。IPC 边界短期兼容旧格式；禁止公共层匹配英文字符串。
7. 重启后的安全保证逐 runtime 验证：原生运行查询、独占进程随宿主结束、或可验证的遗留执行定位。单凭 PID 或空 registry 不足；无法证明的 runtime 明确报告 Unknown，不宣称完成重启验收。持久请求登记仍不在本期范围。
8. 30 分钟/4096 只是候选容量策略；容量覆盖全部接受记录还是仅终态必须一致。本计划建议总数含活跃，终态 TTL 从终结起算，活跃不失效；满额先删除已过期终态，再拒绝新接受，重试已有键不被容量错误挡住。
9. “每批独立可发布”只表示该批涉及 runtime 的已验证行为；Claude 试点不等于六家跨 runtime 互斥已完成。全局保证需全部入口接入后验收。

## Review Focus

- 删除后同 threadId 重建：旧历史/事件不写入新会话，归任务 2、6、8。
- 接受成功但调用 future 被取消或任务异常退出：启动票据由独立 supervisor 持有，不能静默泄漏或不安全释放，归任务 3。
- 相同 runId、附件或运行配置不同：冲突；同样请求重试：仅一次原生启动，归任务 3。
- 历史分页循环、空页持续有 cursor、读取期间分支变化：明确未完成，不能替换完整投影，归任务 5、6。
- 一家 runtime 查询失败、其他成功：失败家的缺失不可视为已结束；共享进程停止一会话不影响另一会话，归任务 4、8。

## 拆分与依赖

前端与历史为一条工作线，后端生命周期为另一条；这是工作拆分，不要求并行 Agent。

`0 → 1 → 2 → 5 → 6 → 7 → 9`

`0 → 3 → 4 → 8 → 9`

任务 2 的版本保护为任务 4 提供前端基础；任务 6 不必等待投影纯函数清理，运行推广也不必等待历史重构。每项可再按 runtime/消息类别拆提交，不能把全部内容做成一个 PR。

### 任务 0：建立可复现基线和 runtime 能力表

**Files:** 阅读 package.json、vitest.config.ts、app/Cargo.toml、dsh-appserver/package.json；更新本文件的基线记录。正式执行时在真实 Git checkout 创建实施分支。

**Interfaces:** 产出测试基线、六家 runtime 的历史来源/分页单位/停止证明/命令类别/重启恢复表，以及兼容 fixture 清单。

- [ ] 记录真实 HEAD 与工作区改动；对照 a7c3cef5 的变更，不能用当前无 Git 副本冒充基线。
- [ ] 在各自项目按锁文件安装依赖；先核实 DSH 使用的包管理器与锁文件。执行下方基线命令并保存退出码。
- [ ] 将每项失败归为已有缺陷、环境阻断、过期断言或新增回归；source.memoId 先确认产品身份契约。
- [ ] 六家分别记录停止确认与超时、分支能力、历史轮次归属、用户输入关联方式；取得 Claude journal、Hermes 旧事件、Pi 分支和 Codex 延迟落盘样本。
- [ ] 实测并冻结全量读取预算、幂等容量/TTL、客户端重试上限、性能样本。读取预算超限返回 HistoryIncomplete。
- [ ] 提交基线记录。退出：每个 runtime 有明确的可验证能力或阻断说明。

### 任务 1：修复空白与缓冲归属（首个业务 PR）

**Files:** store/stream-event-dispatcher.ts、streaming-buffer.ts、stream-event-dispatcher.test.ts；新增 store/streaming-buffer.test.ts。此处及后续 store 路径前缀均为 app/flowix-web/features/agent/。

**Interfaces:** 缓冲消费入队事件，保存 threadId、runId、agentType 与来源元数据；flush 返回有序事件批次。有 messageId/snapshot/sourceSequence 的现有同步分支先保留。无 runId 的旧事件在入队前一次解析，flush 不再补当前 runId。

- [ ] 在现有注入 scheduler 的测试中增加：`A`、空格、换行、四空格、`B` 最终逐字符一致；A run 入队→B run 开始→flush，B 不含 A 文本；reasoning/text/tool 次序不乱。
- [ ] 运行 dispatcher 测试，确认新增断言在旧实现失败。
- [ ] 仅空字符串跳过；以入队 run 分组并保留先后边界；flush 校验对应 run 的适用性。没有可靠身份的不同消息不强行合并。
- [ ] 重跑 dispatcher、buffer、message-chunks、reduce-projection 测试；检查 snapshot 重放引用不变。
- [ ] 提交 `fix: preserve stream whitespace and run ownership`。

### 任务 2：固定身份与过期请求规则

**Files:** store/external-session.ts、projection-slice.ts、agent-session-store.ts、thread-lifecycle-slice.ts、external-session.test.ts、agent-session-store.test.ts；events/agent-event-mapper.ts。

**Interfaces:** `resolveProductThreadId(threadId, runtime, resolutions, threadTypes): string`；运行/历史读取上下文使用 `{threadId, epoch, runtime, bindingSnapshot, requestedRunId, projectionAtRequest}`。运行查询附发起时投影快照；这是本地上下文。

- [ ] 增加两个 runtime 使用同一 provider ID、产品 ID 与另一 provider ID 同串、删除再建、绑定改变后旧响应到达的断言。
- [ ] 新增 deferred 查询：请求空快照后启动新 run，再返回空快照，新 run 保持；查询失败仍可加载历史。
- [ ] 将明确产品 ID 优先于别名解析；别名只在 runtime 范围找；无法唯一归属时拒绝猜测并记录诊断。
- [ ] 将请求时 epoch、绑定与 run 校验应用到提交时；保留现有 tombstone、节流与恢复触发。
- [ ] 运行身份、store、use-agent-events 相关测试，提交身份及请求保护变更。未接后端 phase 前不声称完成 Starting/Stopping 展示。

### 任务 3：共享认领、幂等和 Claude 全生命周期试点

**Files:** app/flowix-desktop/src/agent_external/shared/{runtime.rs,lifecycle.rs,process_io.rs,tests.rs}、claude/cli.rs、claude/cli/tests.rs；commands/agent/{chat.rs,runtime.rs}；app 状态装配处。

**Interfaces:** 在共享管理内定义 `accept_run(thread, runtime, run_id, fingerprint) -> Result<AcceptedRun, AcceptError>`、`attach_execution(ticket, handle)`、`request_stop(thread, run_id)`、`finalize_run(thread, run_id, confirmed_outcome)`。上述为目标语义，具体 Rust 所有权类型随现有容器确定；`AcceptedRun` 区分新接受与重复接受，只有前者启动。进程停止返回 Confirmed/Unconfirmed 及诊断，不再用 () 表达成功。

- [ ] 用屏障控制 spawn 前后：同 thread 两次独立请求只能一次接受；相同键重复返回相同接受结果；相同键不同附件/配置冲突；不同 thread 不互相等待。
- [ ] 测试 Starting 停止后迟到 handle、kill 失败、watchdog/自然完成/stop 竞争、旧 run 清理、新 run 认领，以及调用方取消。未证明结束时断言槽位仍在。
- [ ] 在公共业务启动服务原子查幂等记录并占位；避免第二个内部 chat_stream 入口绕过。锁外执行校验后的启动任务、日志/事件和实际 IO。
- [ ] 启动 supervisor 持有票据；取消意图与关联原子核验。移除操作只在 finalize 确认后执行；逻辑终结与通知是否发送分开，Tauri emit 失败仍可查询终态。
- [ ] 为实际平台实现停止确认，覆盖进程树与超时；不得将 taskkill 返回、stdout EOF 或主进程状态普遍当作所有场景的证明。
- [ ] 用可控时钟测试终结后 30 分钟、4096 上限、活跃不淘汰、已有键重试不受满额阻断；值依任务 0 冻结结果同步调整客户端。
- [ ] 运行 `cargo test --manifest-path app/Cargo.toml -p flowix-desktop --lib agent_external::shared` 和 `... --lib agent_external::claude`；真实 Claude 启停 smoke 后提交。此阶段仅声明 Claude 试点闭环。

### 任务 4：运行 IPC、前端 phase 与未知状态闭环

**Files:** app/flowix-desktop/src/agent_wire.rs、commands/agent/chat.rs、agent_external/runtime_registry.rs；前端 types/agent 相关定义、store/agent-session-store.ts、session-reducer/types.ts、run-lifecycle.ts、hooks/use-agent-events.ts、busy selectors 和运行按钮控制器。

**Interfaces:** RunInfo 可选 phase=starting/running/stopping；运行查询区分成功空结果、查询失败、原生状态未知；发送返回接受 runId，停止返回 accepted/confirmed/unconfirmed 的内部结果。旧 IPC 由边界适配。

- [ ] 先写测试：Starting/Stopping 仍 busy；停止已接受不显示已停止；旧空快照不结束新 run；一家查询失败不结束该家的运行；IPC 接受响应丢失重试不重复输入。
- [ ] 接入任务 2 的请求版本、任务 3 的结果；通过内部 action 提交快照与乐观拒绝，移除用 provider stream_end 表示未知运行的路径。
- [ ] 非接受冲突保留未发送输入；接受后失败保留输入与失败结果；未知请求不自动生成新 runId 重试。
- [ ] 运行 store、run-lifecycle、UI 控制器测试及 TypeScript 检查，提交兼容 IPC/展示变更。

### 任务 5：修复假全量，建立历史页读取契约

**Files:** store/agent-history-adapters.ts、agent-history-adapters.test.ts、thread-history-slice.ts、thread-history-slice.test.ts、history-sync.ts；按需要新增 store/history-pagination.ts 与测试。

**Interfaces:** `readHistoryPage({threadId,cursor?,limit}): Promise<HistoryPage>`；`readAllHistory(request,budget): Promise<HistoryReadResult>`。HistoryReadResult 只有 Complete 可以作为完整结果提交；Changed/Incomplete 为明确结果。limit 为完整轮次；旧 runtime 不能满足时保持显式 legacy adapter，不伪装迁移完成。

- [ ] Claude/OpenCode 各建立超过 50 轮的 fixture；调用 reloadMessagesFromHistory 后首尾都存在；中间页失败时原投影不变。
- [ ] 为重复 cursor、循环 cursor、持续空页、预算超限和快照改变写失败测试；页内旧到新，页间向前合并。
- [ ] 首先通过现有 getPage 封装正确全量遍历，修复生产缺陷；随后把初始/分页/刷新统一为 readHistoryPage，不要求一次完成全部 provider 内移。
- [ ] cursor 编码版本、runtime、会话定位与快照；adapter 校验。错误改结构化传递；公共层不解 Pi revision。
- [ ] 同一快照完整读取前不替换整条消息数组，不写 hasMore=false；测试通过后提交。避免一次读取所有历史成为默认打开行为。

### 任务 6：历史覆盖、确认与 runtime 专属来源

**Files:** store/history-sync.ts、thread-history-slice.ts、thread-lifecycle-slice.ts、external-event-replay.ts、pi-message-reconciliation.ts、codex-live-turn-cache.ts、thread-history.ts；runtime/pi-history.ts；新增 runtime/<runtime>-history-adapter.ts（仅有实际专属职责时创建）；对应历史 fixture 测试。

**Interfaces:** `HistoryPage={messages,nextCursor?,revision?,coverage,confirmedMessageIds?,messageTurnIds?}`；`applyHistoryPage(threadId,page,requestContext)` 为正式入口。coverage 为 partial / complete-turns / branch-snapshot。complete-turns 的 IDs 必须与 messageTurnIds 或现有可验证映射对应。

- [ ] 增加同 ID 实时更新晚于请求、同内容不同 ID、部分 assistant 历史、重复快照、轮次覆盖范围外消息与 Pi 分支变化测试。
- [ ] 先让所有普通历史页使用 partial；按每家的证明能力逐步开启确认与覆盖删除。历史出现 ID 不足以释放缓存。
- [ ] 分页、恢复、结束后对齐均走 applyHistoryPage；受影响行使用请求时引用/本地版本保护，不以整个投影任意变化为由永远拒绝历史进展。
- [ ] Claude journal/原生来源、Hermes 旧重放放入各自模块，兼容回放不得触发现代启动、busy 状态或实时缓存副作用；OpenCode 保留 ACP session/load 并修注释。
- [ ] Pi 分支完整读取后原子替换；读取期间旧分支可展示但不接新分支到同一时间线。Codex 仅释放全部权威确认的缓存项。
- [ ] 六家逐一通过打开、分页、恢复、完成对齐 fixture；再删除公共 runtime 排除列表与试探回退。每家单独提交，方便回退。

### 任务 7：统一内部提交、删除死入口、消除旧形状

**Files:** store/thread-history-slice.ts、projection-slice.ts、session-reducer/{types.ts,reduce-projection.ts}、message-chunks.ts、tool-chunks.ts、run-lifecycle.ts、thread-runtime-state.ts、agent-session-test-facade.ts；events/{agent-event-mapper.ts,message-identity.ts}；使用这些入口的 UI 控制器。

**Interfaces:** `applyEvent`、`applyHistoryPage` 为外部消息路径；内部 action 覆盖快照、请求开始/失败、乐观发送/拒绝、删除与绑定；投影写入集中一个提交函数。纯函数按 messages/pending/runs 分区处理。

- [ ] 将 syncRenderableMessages/syncLiveMessageState 测试改为正式事件或历史 action 驱动，保留请求期间新消息的行为断言。
- [ ] 全仓搜索标识、动态访问、公开导出与插件入口后删除两方法及过期注释；此提交不改历史来源。
- [ ] 文本→推理→工具→运行各一提交：改辅助函数消费正式分区，删除对应转换；每步执行原有行为测试及引用复用测试。
- [ ] 把 Pi ID/block 映射、DSH /plan 原生输入识别下沉 runtime 适配；避免用全局文本相等规则代替身份。适配只执行一次。
- [ ] UI 只发命令意图或本地 action，不持有独立消息事实源；通过分层静态检查阻止 UI 调用原始投影 setter。
- [ ] 旧 facade 与 ThreadState helper 仅在引用归零且兼容读取不需要时删除，提交净清理。

### 任务 8：推广其他 runtime、命令与删除/绑定保护

**Files:** 各 agent_external runtime manager、runtime_registry.rs、commands/agent 的命令/删除/绑定入口；DSH manager.rs、dsh-appserver/src/app-server/services/command-service.js、subagent-service.js 及对应测试；前端 thread-lifecycle-slice.ts。

**Interfaces:** 所有普通运行共享产品 thread 操作槽位；独占命令保留 commandId，原生调度保留 command watcher。删除/切换 guard 与 run 认领共用原子检查；仅确认在途和原生待执行工作都停止后修改绑定。

- [ ] 每家复用认领契约测试，补专属停止证明；Codex/DSH 共享 host 只停止目标 turn，不终止别的 thread。
- [ ] 测试跨 runtime 同产品 thread 并发、命令→run 原子交接、stop 旧 run 不影响新 run；测试删除请求到达后普通发送和 steering 都被拒绝。
- [ ] DSH 测试 /goal 等待空闲、/plan 当前回合注入、停止整个 goal 撤销后续工作；RPC 返回不代表 command 完成。
- [ ] 子 agent 测试仅验证父子引用与原生控制；不引入另一套生命周期状态机。
- [ ] 重启验收按任务 0 的证明策略逐家执行。不能确认遗留执行的 runtime 保持 Unknown 并阻止重叠，不用“空登记”判安全。
- [ ] 根目录 `npm --prefix dsh-appserver test`、`npm --prefix dsh-appserver run typecheck` 使用该项目已安装依赖；执行对应 Rust 与真实 runtime smoke，每家单独提交。

### 任务 9：发布验收与迁移清理

**Files:** 迁移中留下的兼容入口、门禁脚本、测试 fixture；本计划基线与完成记录。

- [ ] 每个兼容入口写明数据形态、触发条件、fixture、退出条件；删除已迁完生产旧路径，不删除仍有用户数据价值的读取转换。
- [ ] 执行全部相关前端测试、TypeScript、生产构建、分层/债务门禁与受影响 Rust 测试；DSH 单独依赖验收。
- [ ] 修复原有 11 处分层违规可单独 PR，不通过放宽门禁掩盖。债务脚本首次可运行后才记录真实基线。
- [ ] 以同机器长会话 fixture 比较首次打开、流式更新、恢复的耗时、峰值内存与渲染次数；阈值使用任务 0 冻结结果。
- [ ] 对每个受影响 runtime 在目标平台跑启动/停止/恢复/旧历史 smoke；记录版本、命令和结果。mock 不能替代此项。
- [ ] 回滚演练：停止在途执行后回退生命周期版本；只读 fixture 对照历史；不双写、不重复启动真实 Agent。
- [ ] 完成用户验收矩阵及新增幂等、容量、未知状态、删除保护场景后发布；没有真机证据的 runtime 标明未验收。

## 基线与验收命令

根项目（先安装锁定依赖）：

```powershell
npm test -- app/flowix-web/features/agent/store/stream-event-dispatcher.test.ts app/flowix-web/features/agent/store/external-session.test.ts app/flowix-web/features/agent/store/agent-history-adapters.test.ts app/flowix-web/features/agent/store/thread-history-slice.test.ts app/flowix-web/features/agent/store/session-reducer/ app/flowix-web/features/agent/store/agent-session-actions.test.ts
npm run check:layers
npm run check:frontend-debt
npm exec -- tsc --noEmit
npm run build
cargo test --manifest-path app/Cargo.toml -p flowix-desktop --lib agent_external
```

DSH 使用其锁定依赖，安装后从根项目执行：

```powershell
npm --prefix dsh-appserver test
npm --prefix dsh-appserver run typecheck
```

成功条件是命令退出 0 且确实收集了目标测试，不能把空筛选结果当通过。真实 smoke 使用独立测试会话，记录 provider 版本和平台。下方记录实施进度；未列为完成的任务仍待实施。

## 实施进度（2026-10-10）

这是未完成的实施记录。资料副本没有 `.git`，所以没有分支、提交或 PR；文件变动直接位于 `D:/02 vibeworking/flowix`。

- 已完成任务 1 的空白 delta 与缓冲 run 归属修复，含旧事件缺少有效 runId 的兼容测试。
- 任务 2 部分完成：provider 别名按 runtime 解析；无 runtime 的别名事件不会按缓存类型猜测归属；运行快照提交前比较请求时的投影引用，避免旧空快照清除查询期间的新 run。删除/切换绑定的代次保护仍待做。
- 任务 5 部分完成：Claude、OpenCode 的 getFullHistory 逐页读取；Pi 与序列分页均检测游标循环、空页无进展和读取预算。统一 HistoryPage、覆盖契约与 runtime 来源内移尚未实施。
- 后端修复：生成的 runId 改用 UUID，避免同毫秒碰撞；共享 Starting 认领、停止确认、幂等、全 runtime 接入尚未实施。
- `npm exec -- tsc --noEmit` 通过；`npm run build` 通过。受影响的 5 个前端测试文件最近一次运行 87 通过、1 失败，失败为实施前已记录的 Codex `source.memoId` 断言。此后新增 Pi 游标测试及无类型别名保护测试各自通过，整组需要最终重跑。
- `npm run check:layers` 为已有 11 处违规；`npm run check:frontend-debt` 为已有 console 111 > 106。实施未增加直接 console 调用。
- Rust CLI 已构建并放置 Tauri sidecar；桌面测试可编译，但测试进程在当前 Windows 环境启动时返回 `STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)`，未执行断言。`cargo check --manifest-path app/Cargo.toml -p flowix-desktop -j 1` 在 runId 修改后通过。Rust 行为验证仍是发布阻断项。

接续顺序：完成任务 2 的绑定与删除版本保护；先解决桌面测试运行环境，再按任务 3/4 实施原子认领、停止证明与前端 phase；随后实施任务 6/7/8/9。任何人在合入前应以真实 Git checkout 重新核对当前源码及基线。

### 2026-10-10 后续实施记录

- 历史请求现在记录发起时的产品 thread epoch、runtime 类型、原生会话绑定及每 thread 的读取版本。首次读取、分页、完整重载和 run 结束对齐均拒绝过期响应；旧请求失效且没有新请求接替时清除 loading 状态。新增绑定切换竞态测试，先复现失败再修复，相关 34 项前端测试通过，TypeScript 检查和生产构建通过。
- 共享外部 CLI registry 增加 Starting 认领、取消意图、迟到 child 登记拒绝及运行查询展示，Claude CLI 先接入。进程登记移至 stdin 写入之前，启动失败会清理已登记进程。新增共享认领测试；`cargo check` 与测试二进制编译通过。
- Windows 上 Rust 测试二进制仍在执行前因 `STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)` 退出，新增 Rust 断言尚未运行。`cargo fmt --all -- --check` 发现全工作区大量既有格式差异，未批量改写。
- 后端试点尚未覆盖完整停止证明：现有 `stop_run` 先移除 child 后执行 kill，终止不明时缺少保持 Stopping 槽位和重试清理的完整机制；跨 runtime 同产品 thread 认领、请求幂等及其余 runtime 接入仍未完成。不得将 Claude 试点视作方案完成或发布验收通过。
- 后续清理：全仓源码检索确认 `syncRenderableMessages` 与 `syncLiveMessageState` 只剩测试/过期注释引用，将相关测试改为正式行为的初始投影安排，删除两个公开方法及实现。对话详情页缓存历史改走 `applyHistoryPage(..., coverage: "partial")`；入口拒绝与当前 runtime 绑定不符的页面。前端 95 项相关测试中 94 项通过，唯一失败仍为原有 Codex `source.memoId` 断言；TypeScript 检查与生产构建通过。
- 本轮质量门禁复查：组合根一度因先前新增的无类型 provider chunk 防护达 652 行，触发第 12 条分层违规。将该判定提取到现有 `agent-chunk-routing.ts` 后重新运行，恢复为基线 11 条；TypeScript 检查通过。前端债务门禁仍为基线 console 111 > 106。
- 复核旧测试断言：`AgentConversationSource` 当前契约没有 `memoId`，失败用例自身创建的实例也从未提供该字段。将断言改为确认 `documentPath` 保留且旧 `memoId` 不被写入；同一组 5 个受影响测试文件现为 95/95 通过。
- Windows Rust 测试执行问题已定位并绕过：由 `dumpbin /imports` 与 `GetProcAddress` 核实无清单测试进程装载的 `comctl32.dll` 缺少 `TaskDialogIndirect`。只复制 `target/debug/deps` 下的测试 exe 并用 SDK `mt.exe` 给副本嵌入 Common Controls v6 清单，未改发布配置。原先 2 项 Claude 历史测试因测试夹具把 Windows 路径作为非法目录名且未转义 JSON 失败；修正后，从清单副本执行 `agent_external --test-threads=1`，280/280 通过。此前“Rust 断言未运行”的记录现由这一结果更新；仍未做真实 Claude CLI smoke。
- 增加 Starting 的双请求并发与取消后迟到 child 拒绝测试后，使用 Common Controls v6 清单测试副本执行 `agent_external --test-threads=1 --quiet`，282/282 通过。
- 将相关历史/生命周期错误输出统一走 `createLogger`，`check:frontend-debt` 通过（直接 console 103/106）。把 shell 组件跨模块调用迁至已有 agent/memo/workspace public API 的窄函数及 view model，`check:layers` 通过（扫描 985 文件），TypeScript 检查通过。5 个受影响前端测试文件 95/95 通过，生产构建与 Web bundle 预算通过。构建原有 CSS 顺序、Rollup chunk 依赖警告仍存在；新增 shell-api 导入现改为直接引用 note-repository，待下一次构建确认该条 warning 消失。
- `RunInfo` 新增可选 `phase` 字段；共享 registry 查询对 Starting 返回 `starting`、已接受启动中停止返回 `stopping`，普通运行保持旧字段兼容。Rust 282/282 外部 runtime 测试复跑通过；前端生产构建与 bundle 预算再次通过。修正 shell-api 的 noteRepository 直接导入后，新 public API 引起的 Rollup 循环警告消失，仓库原有其他警告仍在。
- 最终复核：`npm run check:layers` 与 `npm run check:frontend-debt` 均通过；相关前端测试 95/95、`npm run build`（含 TypeScript 与 bundle 预算）、Rust `agent_external` 282/282 均通过。测试用临时清单副本已删除，源目录仍非 Git checkout，未形成提交或 PR。
- 本轮仍未实现全局操作槽位/请求幂等、确认终止前保持 Stopping、所有 runtime 接入、统一覆盖证明历史契约、投影旧形状转换清理和真实 CLI smoke。后续实施必须先收敛共享 stop/terminal 证明，再推广 runtime；不得以当前 Claude Starting 试点替代这些完成条件。
- 历史请求失效修复补充同绑定首屏读取聚合：不同绑定允许新请求抢占，同绑定的重复首次读取只发一次。测试先复现二次调用，再修复后 12/12 history-slice 测试及 TypeScript 检查通过。
- 本轮最后复核：相关 5 个前端测试文件 96/96 通过；`npm run build`（含 TypeScript 与 Web bundle 预算）再次通过。分层门禁、前端债务门禁及 Rust 外部 runtime 282/282 的前次验证结果仍成立。本方案未达到完整发布验收：跨 runtime 操作槽位、停止证明/终态幂等、有限请求幂等、历史覆盖确认和真实 CLI smoke 尚待实施。

### 下一批：共享 CLI 停止占位（2026-10-10）

- `ExternalRunRegistry` 增加按 thread/run 记录的 Stopping 占位。`stop_run` 在锁内把运行 child 转为停止占位，锁外执行进程树终止，并最多等待 5 秒确认主进程退出；确认后释放，占位期间拒绝新启动。若未确认，将 child 放回登记以便同一 run 重试停止，运行查询返回 `phase: "stopping"`。
- 旧流尾、启动前 stale reaper 与 idle watchdog 在停止占位期间不抢走 child；发现先前未确认的 child 已退出时，启动前检查可以清理占位。停止请求仍使用已有可选 runId 兼容参数；跨 runtime 公共操作槽位、明确 StopUnconfirmed 返回契约和全终结路径幂等仍待下一批。
- `cargo check -p flowix-desktop` 在最终源码上通过。Windows 补充真实子进程终止测试，验证确认退出后才释放槽位。使用 `.build/cargo-target` 中的测试二进制临时嵌入 Common Controls v6 清单执行，全部 `agent_external` 284/284 通过；仓库级 `cargo fmt --all -- --check` 仍有大量既有差异，未批量改写。

### 下一步代码调整（按用户要求未构建）

- 共享 `stop_run` 返回 `Result<Option<ExternalStoppedRun>, StopUnconfirmed>`：未找到目标与终止未确认不再混为同一个 `None`。Claude、Hermes CLI/ACP、OpenCode ACP 仅在确认停止后发终结事件；Claude 的原生会话别名回退只在真正未找到时进行。
- 终止等待上限覆盖进程树终止命令及进程退出等待全过程。新增停止占位期间再次停止返回 `StopUnconfirmed`、错误 runId 返回未找到的断言。本步仅写代码，未按要求执行构建或测试；前述 284/284 属于本步修改之前的结果。

### 六部分接续改动（仅写代码，尚未验证）

- Hermes CLI、Hermes ACP、OpenCode ACP 从先检查后启动改为共享 Starting 认领和迟到 child 拒绝；ACP 控制句柄绑定 runId，旧 run 的延迟停止不能向新句柄发送 cancel 或删除新句柄。
- runtime 注册表增加按产品 thread 的普通执行认领和进程内请求记录：runId 与规范请求指纹去重，重复 IPC 等待同一 supervisor 结果，独立请求互斥；终结后保留窗口暂设 30 分钟、总上限 4096。chat IPC 与 plugin 普通执行均经该入口。通过当前 runtime 的进程内运行快照判断旧槽位何时释放；跨重启遗留执行检查仍未闭环。
- 删除/归档入口先设置后端会话保护，再停止并检查是否仍有活跃 run，未确认时拒绝删除；保护通过作用域 guard 释放。前端也在 provider 操作期间阻止新的普通发送，失败后解除保护。
- 历史回放选择从公共五 runtime 排除名单移至历史适配器能力声明，OpenCode 来源注释改为 ACP session/load。历史不透明 cursor、覆盖确认和旧状态形状收敛尚未完成；本批代码按用户要求没有构建、类型检查或运行测试，不能视为发布候选。

### 六部分后续代码审阅（仍未构建）

- 历史页增加限定 runtime/thread 的不透明 cursor，分页检测修订变化与无进展；公共投影保存下一页 cursor，旧投影数字游标暂作读取兼容。修订变化使用明确错误触发首屏重读。覆盖证明与消息确认 ID 契约尚未实现。
- 前端增加删除/归档期间的会话写入保护，DSH 临时命令结果改经 store 内部 action 提交。后端认领表读取各 runtime 的现有活跃快照，删除保护同时检查 Starting 占位；Hermes/OpenCode ACP 正常清理等待共享 stop 确认后才释放槽位。
- 本段修改按用户要求仅写代码，没有 TypeScript/Rust 编译、测试或真实 CLI 验证。六部分仍有生命周期全部终结来源、DSH 原生待执行工作撤销、历史覆盖确认、旧投影形状清理及跨重启未知执行处理等未完成项。

### 剩余代码接续（未验证）

- 前端运行 reducer 拒绝旧 run 的迟到开始、工具和终结事件改写已提交终态；未知 runId 的结束事件不再结束当前新 run。旧 run 失败保留新 run 的流式 pending。同步调整测试断言。
- DSH stop 等待原生 watcher 移除目标 run 才确认停止；interrupt 失败或超时保留占用。删除/归档另外调用 DSH 原生 goal/get 与 goal/clear，拒绝未确认的待执行 Goal 清理。
- Codex 短期 live cache 只在历史行的稳定 ID、完整内容及完成状态均得到确认时释放；原先的内容匹配仍用于旧历史展示兼容，不再作为缓存释放证明。
- 本段按要求只写代码，未执行构建、类型检查或测试。投影转换消除、所有 runtime 的原生终结证明、完整历史覆盖契约和跨重启遗留执行仍需继续实施。
- 跨 runtime 认领补充首次活跃观察标记：已接受请求在运行查询尚未显示时不因空快照释放槽位；启动调用明确失败则释放。此处仍依赖进程内观察，后端重启后的原生状态检查不在保证内。

### 停止展示与 DSH 确认（未验证）

- 前端停止请求不再立刻调用 `applyRunStopped` 伪造 Cancelled；保留活跃 run 并标记 `phase: stopping`，由权威终结事件或后续运行快照收敛。无本地 runId 时先读取后端运行快照，只对解析出的目标 runId 发停止；显式旧 runId 不回退成无范围停止。运行快照保留原有 DSH/Codex 命令状态。
- DSH coordinator 在原生 interrupt 被接受后展示 `phase: stopping`，直到 watcher 确认该 run 消失；增加运行登记测试。前端旧 run 的未知/重复终结事件不再制造新终态或触发多余投影提交。
- 这批代码仍未构建或执行测试，以上行为需要后续验证。历史覆盖契约、投影旧形状转换、跨重启未知执行仍未完成。
- 后续审阅将认领表的槽位统一映射到产品 thread ID（优先使用运行快照的 `pendingThreadId`），对缺少 runId 的原生活跃执行拒绝新启动。历史不透明 cursor 增加向旧页单调前进校验，Pi cursor 必须携带 revision。
- Thread card 与独立会话详情将 Stopping 显示为“正在停止”/“Stopping”，继续保持 busy，并禁用重复停止按钮；新增选择器测试。该轮未运行测试或构建。
- Codex 历史/实时行的内容兼容匹配增加原生 turnId 范围：相同回答文本来自不同 turn 时保留两行；缺少 turnId 的旧数据只在 legacy 范围内匹配。缓存释放需同一稳定 ID、内容与明确完成标记，增加回归用例。本轮仍未执行验证。
- reducer 的运行开始、工具状态和用量纯函数现直接接收正式投影 `runs` 分区；只在需联动 pending 消息的失败/终结路径保留旧形状适配。此修改缩小了往返转换，但尚未完成全部投影收敛。
- 共享 watchdog 不再因进程状态查询失败或空闲超时先移除 child；空闲终止与应用关闭均调用共享 stop 确认路径，确认后才释放并发布终态，未确认保持占位。此改动也未构建或执行 Rust 测试。
- Claude/Hermes CLI 自然结束现在在共享登记中轮询进程退出，确认后才移除 child；轮询间允许按 runId 停止。删除了先移除再等待的旧 helper。以上仍是未验证代码，不应视为全部 runtime 终结收敛完成。
- 历史页新增 `HistoryCoverage` 契约；尚无原生完整覆盖证明的页默认 `partial`。运行结束对齐只有在 adapter 声明完整原生 turn 并匹配 turnId 时才进入替换路径，否则保守合并，防止落盘滞后时丢失实时回复。其他 runtime 的完整覆盖证明与确认 ID 产出仍待实现。
- Codex 普通停止不再先移除活跃 turn 或提前发 StreamEnd；保留 `stopping` 运行查询状态，等待原生终结路径按 runId 移除，失败/超时保留槽位。Pi stop 不再直接调用 `finish_run`，等待已有 abort settle/清理路径终结并在查询中展示 stopping。两条路径尚未用真实 CLI 验证。
- Pi watchdog 同样改为设置停止意图、通知运行任务并等待其自行终结，超时保留 active run；应用关闭先关原生 session 再清理运行登记。Codex 共享 app-server 的关闭/崩溃路径仍需独立确认终结证明。
- Codex 共享 app-server 关闭时保持连接和活跃 turn 占位，确认子进程退出后才移除并发布终结；杀进程或等待失败时保留占位，避免并发启动另一个共享进程。`stop_all` 只先标记停止并请求中断，不提前发布合成终结。仍需真实进程场景验证。
- 投影的运行失败和结束路径改为直接处理 `runs`，`pending` 由投影 reducer 负责；删除 `ProjectionRuns` 的整形往返转换及其公开导出。历史和跨重启恢复工作仍未全部完成。本轮遵照用户要求，只修改代码，未运行构建或测试。
- 后续验证：前端相关测试、TypeScript、Rust `cargo check`、分层和前端债务门禁通过。Rust 定向测试已完成编译，但 Windows 测试进程因 `STATUS_ENTRYPOINT_NOT_FOUND` 无法启动，不能计为通过。Pi 全量历史固定首个 revision，分支变化或序号游标不前进时明确失败；新增回归测试通过。
- 停止请求 no-op/IPC 失败时改查后端目标 run 快照，确认仍在 Running 才撤销前端 Stopping；快照仍在 Stopping 或查询失败时继续占位。重复停止请求在本地合并。Pi 分支失效 IPC 改用 `HistoryChanged:pi_branch` 错误码，不再匹配英文描述。相关前端测试、TypeScript、Rust `cargo check` 与分层门禁通过。
- Codex 原生历史页现附带明确处于终态且整轮分页读取完成的 turn ID；运行中的 assistant/reasoning 行不再假定完成。前端 Codex adapter 将原生证明转成 `complete-turns` 覆盖，公共归并只在目标仍为最新轮且请求期间投影未修改时使用结束对齐，否则保守合并。相关前端测试、TypeScript、分层门禁及 Rust 测试编译通过；Windows Rust 单测进程仍受前述入口点错误影响，真实运行与重启遗留执行恢复未验证。
- Codex 历史页对旧调用方保留三参数首次读取签名；组合回归 93 项通过。新增覆盖声明仅来自 `thread/turns/list` 中有原生终态且 ID 稳定的 turn，其他页维持 partial。重启后原生执行是否仍存在，需要各 runtime 可查询的原生事实源；现有内存 registry 不能证明不存在，尚未作为完成项。
