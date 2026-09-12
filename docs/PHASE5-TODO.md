---
key: gmxv77no
---

# Phase 5 续做清单 — Agent Session Store 重构收尾

> 分支 `refactor/agent-session-store`。本文件是阶段 2b / 3 的接续指南,供新会话无需重新评估即可继续。

## 完成状态（2026-08-04）

Phase 5 已完成，以下原清单保留为历史实施记录。

- `useAgentSessionStore` 现直接拥有 dispatch/chunk bridge、load、rename、send、stop、delete、snapshot reconcile 和 instance/message actions。
- Agent Thread Card 的消息、运行态、分页、会话实例与 metadata 均直接读写 `sessionMeta` / `conversationRegistry` / `threadProjections`。
- 已删除 `chat-store.ts`、`agent-conversation-store.ts`、`session-mirror.ts`、旧 chat persist/migration、legacy load/snapshot helper 与 late binding。
- Conversation/ThreadState 类型已迁到存活模块；生产代码不再引用旧 store。
- 旧 `STORAGE_KEYS.CHAT` 首次迁移后自动删除，仅保留 `AGENT_SESSION` 持久化源。
- 原 `chat-store.test.ts` 行为规范已迁为 `agent-session-actions.test.ts`，通过 test-only facade 写入并断言 canonical Session Store；外部事件 replay 测试已直接 re-root。
- 验证：全量 Vitest 通过、`tsc --noEmit` 通过、层级边界与前端债务门禁通过、`npm run build` 通过。

> 注意：未在本次自动化会话中执行需要真实 Tauri runtime 的手工消息链路验证。

## 一、当前状态(2026-08-04)

已落地(全程 605 测试绿,2 个 commit `8a3d4e8` + `ff98ca1`):

| 阶段 | 内容 |
|---|---|
| Phase 4 | 生产消费点全迁 `useAgentSessionStore` |
| 阶段 0 | session store 加 `persist`(`STORAGE_KEYS.AGENT_SESSION`)+ 旧 `STORAGE_KEYS.CHAT` 迁移;修复 settings 不持久化回归 |
| 阶段 1 | instance 方法 direct(`hydrateFromBackend`/`renameInstance`/`removeInstance`/`removeInstancesForThread`/`resolveSessionByThreadId`)+ `conversation-run-sync` 迁 session |
| 阶段 2a | conv message actions direct(`mergeMessages`/`syncRenderableMessages`/`syncLiveMessageState`/`loadMessages`/`loadMoreMessages`)+ forwarders(`loadThreadCache`/`loadMoreHistory`)+ **删 conv late-binding** |

**剩余**:阶段 2b(dispatch 系列 + MEDIUM action)+ 阶段 3(2 HARD + 测试 re-root + 类型搬家 + 删 store/mirror)。

## 二、关键架构事实(新会话必读)

- **session store**(`agent-session-store.ts`)三 sub-projection:`sessionMeta` / `conversationRegistry` / `threadProjections`
- **ThreadProjection 形状**(`session-reducer/types.ts`):`{ messages, pending{assistantId,reasoningId}, pagination{oldestSequence,hasMoreHistory,loadingInitial,loadingMore}, runs{isLoading,activeRunId,runs,lastRun} }`
- legacy `chat-store.ThreadState` 扁平 9 字段;projection 嵌套。adapter:`session-mirror.ts:41 projectionToLegacyThreadState(p)`
- **reference stability**:`agent-thread-card-view.tsx` 靠 `_threadStateCache` + `===` subscription(`thread-card-subscriptions-controller.ts:233`)。来自 session reducer(`dispatch`/`setThreadProjection` 保持 sibling slot 引用稳定 + no-op 短路)。删 mirror 不影响。**新 selector 只 return store 内部引用,绝不 `.map()`/对象字面量。**
- chat-store late-binding(`_bindChatStore`/`chatStore`)还在 —— 给剩余 chat delegate 用。conv late-binding 已删。
- `session-mirror.ts` 5 subscription 还在。reverse instance sync 还在(chat-store action 仍写 conv-store)。**删 mirror 要等所有 chat action 搬完**。
- persist 已在 session store(`AGENT_SESSION`)。chat-store 还 persist `CHAT`(过时,Phase 5 删)。

## 三、阶段 2b 续做

### 2b-1 dispatch 系列(3 个,stream 核心,有循环障碍)

action:`dispatchAgentEvent` / `flushAgentEventBuffer` / `dispatchAgentChunk`(session-store delegate L391-393 → `chatStore()`)

chat-store 实现:`dispatchAgentEvent`=streamDispatcher.dispatch;`flush`=streamDispatcher.flushBuffer;`dispatchAgentChunk`=`mapAgentChunkToEvent(chunk, get())`+`recordAgentChunkMapped`+`dispatchAgentEvent`。streamDispatcher 在 chat-store factory 创建(`chat-store.ts:234`)。

**障碍**:
1. **循环依赖**:`createStreamEventDispatcher` 在 `stream-event-dispatcher.ts`,该模块 import `useAgentSessionStore`。session-store import 它 → 循环。
2. **mapAgentChunkToEvent state 适配**:`mapAgentChunkToEvent(chunk, state: AgentEventMapperState)`(`events/agent-event-mapper.ts:66`)读 `state.threadStates` / `threadTypes` / `externalSessionResolutions`。session 只有 `threadProjections`。

**解法**:
1. 循环:延迟创建 dispatcher —— session store 用 lazy getter(`let _d; function d(){ return _d ??= createStreamEventDispatcher(); }`),运行时(非模块级)解析。stream-event-dispatcher 内部已 late 用 `useAgentSessionStore.getState()`,运行时解析 OK。
2. state 适配:`dispatchAgentChunk` 内构造 `{ externalSessionResolutions: sessionMeta.externalSessionResolutions, threadTypes: sessionMeta.threadTypes, threadStates: 从 threadProjections 构造 }`。**内联** projection→ThreadState adapter(避免 import session-mirror 加循环)。stream 高频 —— 先用 `resolveExternalChunkThreadId` 解析 threadId,只构造单 entry(性能)。

import:`createStreamEventDispatcher`(lazy)、`mapAgentChunkToEvent`+`AgentEventMapperState`(`events/agent-event-mapper`)、`recordAgentChunkMapped`(`diagnostics/agent-run-trace`)、`ThreadState` type(`thread-runtime-state`)。

**测试**:chat-store.test 大量用 `dispatchAgentChunk` 驱动流。搬 session direct 后 chat-store.dispatchAgentChunk 保留(test 用),session direct 需覆盖(stream lifecycle 在 `agent-session-store.test` 已 1 case,扩到 chunk mapping)。

### 2b-2 MEDIUM action(7 个,数据结构重写)

session-store delegate L370-390 → `chatStore()`。每个:读 chat-store `get()`→ 改 session `get()`;写 chat-store `set` → 改 session `set`/`setSessionMeta`/`setThreadProjection`;`setWithMetaMirror`(`chat-store.ts:252-275`)5 处 → 折叠成 `setSessionMeta`。

- `loadThreadList` 家族(`load-thread-actions.ts:loadThreadListForType`,~12 行,5 个 collapse 成 1):写 `threadListUpdate`/`activeThreadUpdate`。搬 session:`setSessionMeta(threadLists/activeThreadIds/threadTypes)`。
- `loadThread` 家族(`load-thread-actions.ts:loadThreadForType`,~55 行,5 个 collapse 成 1):写 `activeThreadUpdate`/`threadTypes`/`threadStates` + `replayExternalEventsForThread`(非 flowix/codex/claude/opencode)OR `session.loadMessages`。搬 session:`setSessionMeta`+`setThreadProjection`+ 重构 `replayExternalEventsForThread` 去 `(set,get)` closure。
- `stopThreadRun`(`chat-store.ts:775-829`,55 行):已写 `setThreadProjection`(L787)。剩 `streamDispatcher.flushBuffer` + `agentClient.stopChatStream` + 读 `threadTypes`→`sessionMeta.threadTypes`。
- `renameThread`(`chat-store.ts:550-605`,56 行):`setWithMetaMirror`(title+threadList)+ `agentClient.updateThreadTitle` + reload list + rollback。
- `renameAgentConversation`(`chat-store.ts:607-648`,42 行):resolve instance + `conv.renameInstance`(→ `session.renameInstance` direct)+ `renameThread`。
- `migrateThreadState`(`chat-store.ts:334-390`,57 行):已写 `setThreadProjection`+`setSessionMeta`。剩 `conv.resolveSessionByThreadId`(→ session direct)+ chat-store set(mirror-only,删)。easy-medium。

**测试**:chat-store.test 50 case 测这些(行为规范)。搬 session direct 后 chat-store action 保留(test 用);session direct 需覆盖 —— 扩 `agent-session-store.test`(现 12 case)覆盖 rename/migrate/send/stop/load,或 re-root chat-store.test case。

## 四、阶段 3

### 4-1 HARD action(2 个,最高风险)
- `reconcileRunningRunsFromSnapshot`(`chat-store.ts:845-1005`,160 行):3 phase(session resolve + snapshot→ThreadsMap 写 + projection merge + 3s grace-window fail-out)。`snapshot-reconcile.ts`(135 行,`reconcileThreadStatesFromRunningSnapshot`)操作 legacy ThreadsMap,是 prime orphan。搬 session:统一成 projection-only。grace window 规则微妙(`chat-store.test:1017/973` 覆盖)。**最高优先仔细**。
- `deleteThread`(`chat-store.ts:467-548`,82 行):`agentClient.deleteThread`+`conv.removeInstancesForThread`(→ session direct)+`removeThreadProjection`+`setWithMetaMirror` 清 `threadStates`/`threadTypes`/`externalSessionResolutions`/`activeThreadIds`/`currentThreadTitles`(4 字段条件清除,注释记多个 latent bug)。

### 4-2 测试 re-root(~60 case)
- `chat-store.test`(50 case,2400 行):de-facto 行为规范。chat-store 删后 case 迁 `agent-session-store.test`(扩到 ~60)或重写。最大测试成本。
- `external-event-replay.test`:replayExternalEventsForThread 重写后改。
- `agent-thread-card.test`(3316 行,集成测试):延后到删 store 时。
- 4 个 mock 测试(submit/cache/external-service/workspace-snapshot):已 Phase 4 改过。

### 4-3 类型搬家(~20 文件)
- `ThreadState` ×10 文件:已在 `thread-runtime-state.ts`,chat-store re-export。repoint import(机械)。
- `AgentConversationInstance`/`Source`/`MessageState`/`Role`/`CreateInput` + `ChatStore` iface + 4 selector(`selectAgentConversationRunStatus` 等)+ `acquireAgentChunkBridge`:住 chat-store/conv-store,搬到存活模块。
- barrel `index.ts`:删 legacy re-export,留 `useAgentSessionStore`。
- `chat-store-migration.ts`:chat-store persist 删后 orphan,删。

### 4-4 删 store/mirror
- 删 `chat-store.ts` / `agent-conversation-store.ts` / `session-mirror.ts` / `startSessionMirror` 调用(`chat-store.ts:236`)
- 删 chat-store late-binding(`_bindChatStore`/`chatStore`/`_chatGetState`)+ `setWithMetaMirror`
- 确认无生产/测试引用后删

## 五、验证

每批:`npx vitest run <路径>` 全绿。最终:`npx vitest run`(全量,目标 >605)+ `npx tsc --noEmit`(0)+ 手动 `npm run tauri:dev`(发消息→流式→重命名→切线程→删除,确认 draft 不丢/标题/历史/删除)。

## 六、已知坑(别踩)
- **reference stability**:见二。新 selector return 内部引用。
- **persist**:session 已 persist `AGENT_SESSION`。chat-store 还 persist `CHAT`(过时)。删 chat-store 时清 CHAT key + `chat-store-migration.ts`。
- **reverse mirror**:chat-store action 仍写 conv-store → reverse mirror 还在。删 mirror 要等所有 chat action 搬完(否则启动 desync `conversationRegistry`,经 `ensureConversationInstanceForThread`)。
- **dispatch 循环**:见 2b-1。
- **双写过渡**:`CHAT` + `AGENT_SESSION` 并存(预期)。首次升级 session 从 CHAT 迁移一次。

## 七、推荐推进顺序

1. **2b-1 dispatch**(单独一轮,先解循环 + 适配 + 测试)
2. **2b-2 MEDIUM**(load 家族 → rename/migrate)
3. **4-1 HARD**(snapshot reconcile → deleteThread)
4. **4-3 类型搬家**(机械,可并行)
5. **4-2 测试 re-root**
6. **4-4 删 store/mirror**(最后,前置全完成)
