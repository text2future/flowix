import type { AgentTypeKey } from "@/types/agent";
import type { ThreadListItem } from "@/types";

/**
 * Per-agent-type 持有的 thread 元数据 patch helper。
 *
 * 这些 patch 都只覆盖一个字段 (activeThreadIds / threadLists / currentThreadTitles),
 * 写到一个 `type` key 下, 其他字段保持不变。 用 immutable 浅 spread 形式
 * 适配 zustand setState 的 callback 用法。
 */
export type AgentTypeMap<T> = Partial<Record<AgentTypeKey, T>>;

export interface ActiveThreadSlice {
  activeThreadIds: AgentTypeMap<string | undefined>;
  currentThreadTitles: AgentTypeMap<string | undefined>;
  threadLists: AgentTypeMap<ThreadListItem[]>;
}

/**
 * 给 chat-store 自身做 activeThreads / title / list 读写的最短契约。
 * chat-store (ChatStore) 满足这个子集 ── 把它当鸭子类型传进来。
 */
export type ChatStoreShape = ActiveThreadSlice;

/**
 * 获取某 agent 的 active thread id ── 持久化的"上一次激活"指针。
 * UI 切换 thread 时, 通过 setActive*ThreadId 维护。
 */
export function getActiveThreadIdForType(
  state: ChatStoreShape,
  type: AgentTypeKey,
): string | undefined {
  return state.activeThreadIds[type];
}

/**
 * 某 agent 已加载的历史 thread 列表 ── storeAction 启动时被 setThreadList /
 * loadThread*List 整体覆盖, UI 渲染 thread 树时读这份。
 */
export function getThreadListForType(
  state: ChatStoreShape,
  type: AgentTypeKey,
): ThreadListItem[] {
  return state.threadLists[type] ?? [];
}

/**
 * 某 agent 正在编辑的 thread 标题 (用户编辑但还没持久化到 SQLite 之前的 in-memory
 * 版本)。 UI 在 thread title bar 显示这个, 比 threadList 的 title 更新更及时。
 */
export function getCurrentTitleForType(
  state: ChatStoreShape,
  type: AgentTypeKey,
): string | undefined {
  return state.currentThreadTitles[type];
}

/**
 * 修复 #12: 之前 `activeAgentTypeKey: type` 是副作用 ── 切到 codex thread
 * 会顺带把 activeAgentTypeKey 改成 codex, 多 panel / 多 instance 并发场景
 * 下其中一个 panel 的 setActiveThreadId 会污染另一个 panel 的 send 路径。
 *
 * 现在只更新 activeThreadIds[type], activeAgentTypeKey 由 setActiveAgentThread
 * (跨 runtime 切换) / setActiveAgentTypeKey (纯 type 切换) 显式管理 ──
 * 与命名意图对齐。 内部 callers (loadThread / loadCodexThread / ...) 在被调用
 * 时 activeType.key 已经匹配, 所以该副作用本就是冗余的 ── 删掉零行为变化。
 */
export function activeThreadUpdate(
  state: ChatStoreShape,
  type: AgentTypeKey,
  threadId: string | undefined,
): Partial<ChatStoreShape> {
  return {
    activeThreadIds: {
      ...state.activeThreadIds,
      [type]: threadId,
    },
  };
}

export function threadListUpdate(
  state: ChatStoreShape,
  type: AgentTypeKey,
  list: ThreadListItem[],
): Partial<ChatStoreShape> {
  return {
    threadLists: {
      ...state.threadLists,
      [type]: list,
    },
  };
}

export function titleUpdate(
  state: ChatStoreShape,
  type: AgentTypeKey,
  title: string | undefined,
): Partial<ChatStoreShape> {
  return {
    currentThreadTitles: {
      ...state.currentThreadTitles,
      [type]: title,
    },
  };
}