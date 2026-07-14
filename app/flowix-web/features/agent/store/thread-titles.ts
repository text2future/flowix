import type { AgentTypeKey } from "@/types/agent";
import type { ThreadListItem } from "@/types";
import { getAgentType } from "@/lib/agent-types";
import { translate, type AppLanguage } from "@features/i18n";
import { stripSystemBlock } from "@features/agent/message";
import { useUserSettingsStore } from "@features/preferences/store/user-settings-store";

/** 读取当前 AppLanguage ── zustand store 不在 React 树里也能用 .getState()。 */
function getLanguage(): AppLanguage {
  return useUserSettingsStore.getState().settings.language;
}

function isExternalAgentType(type: AgentTypeKey): boolean {
  return type !== "flowix";
}

function defaultExternalThreadTitle(type: AgentTypeKey): string {
  if (type === "codex")
    return translate(getLanguage(), "agent.codexSession.title");
  if (type === "claude")
    return translate(getLanguage(), "agent.claudeSession.title");
  return `${getAgentType(type).name} session`;
}

function defaultThreadTitle(type: AgentTypeKey): string {
  if (type === "flowix")
    return translate(getLanguage(), "agent.chat.unnamedConversation");
  if (type === "hermes") return "Hermes session";
  return defaultExternalThreadTitle(type);
}

/**
 * Strip 系统块 + 折叠空白 ── 历史 thread title 进入 store 之前统一标准化,
 * 避免 stray 空白字符引起 "为什么它看起来不一样" 这类查找困难的小问题。
 */
function normalizeThreadTitle(title: string | null | undefined): string {
  return stripSystemBlock(title ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 能否持久化 thread title (实际更新 SQLite `threads.title`):
 * - external runtime (Codex / Claude / Gemini / Hermes / OpenClaw) 的 thread
 *   title 由后端管理, 不在前端写 localStorage / SQLite。
 * - flowix / 本地 session 的 title 可以持久化。
 */
function canPersistThreadTitle(type: AgentTypeKey): boolean {
  return !getAgentType(type).capabilities.externalSessionBacked;
}

/**
 * 三段 fallback 拿到 thread 的可显示标题:
 * 1. 真实 threadLists 中的 title
 * 2. 若是当前 active thread, 用 currentThreadTitles 的当前标题
 * 3. external agent 的 default title / flowix 的 "新会话" i18n 文本
 *
 * reconcileRunningRunsFromSnapshot 走这条路径生成 thread card 标题。
 */
function getConversationTitleForThread(
  state: {
    threadLists: Partial<Record<AgentTypeKey, ThreadListItem[]>>;
    activeThreadIds: Partial<Record<AgentTypeKey, string | undefined>>;
    currentThreadTitles: Partial<Record<AgentTypeKey, string | undefined>>;
  },
  type: AgentTypeKey,
  threadId: string,
): string {
  const list = state.threadLists[type] ?? [];
  const fromList = list.find((item) => item.threadId === threadId)?.title;
  if (fromList !== undefined) return fromList;
  const fromActive =
    state.activeThreadIds[type] === threadId
      ? state.currentThreadTitles[type]
      : undefined;
  if (fromActive !== undefined) return fromActive;
  return isExternalAgentType(type)
    ? defaultExternalThreadTitle(type)
    : translate(getLanguage(), "agent.chat.newConversation");
}

export {
  canPersistThreadTitle,
  defaultExternalThreadTitle,
  defaultThreadTitle,
  getConversationTitleForThread,
  getLanguage,
  isExternalAgentType,
  normalizeThreadTitle,
};