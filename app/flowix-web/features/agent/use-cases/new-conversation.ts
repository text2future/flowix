import { buildInitialInstanceRuntimeConfig } from '@features/agent/store/initial-runtime-config';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { useNoteStore } from '@features/memo/store/note-store';
import { isAgentTypeEnabled } from '@features/preferences/public/runtime-api';
import { AGENT_TYPES, isAgentTypeSelectable } from '@/lib/agent-types';
import type { AgentType } from '@/types/agent';
import {
  getNewConversationAgentSelection,
  type NewConversationAgentSelection,
} from '@features/agent/runtime/new-conversation-agent-selection';
import type { AgentTypeKey } from '@/types/agent';
import { createLogger } from '@/lib/logger';

const logger = createLogger('agent/use-cases/new-conversation');

/** Agent types that may start a new conversation (catalog order, user-enabled only). */
export function listSelectableAgentTypes(): AgentType[] {
  return AGENT_TYPES.filter((type) => isAgentTypeSelectable(type.id) && isAgentTypeEnabled(type.id));
}

/** Refresh status in the background and decide from the latest known snapshot. */
export function requestNewConversationAgentSelection(): NewConversationAgentSelection {
  const runtime = useAgentRuntimeStore.getState();
  void runtime.refreshIfStale();
  return getNewConversationAgentSelection(
    runtime.statusByType,
    runtime.isChecking,
    isAgentTypeEnabled,
  );
}

function createAgentConversationInstance(typeKey: AgentTypeKey, notebookId: string | null) {
  return useAgentSessionStore.getState().createInstance({
    agentType: typeKey,
    title: '',
    threadId: null,
    source: { kind: 'dedicated', notebookId, documentPath: null },
    runtimeConfig: buildInitialInstanceRuntimeConfig(typeKey),
  });
}

/** 新会话的开屏位置。调用方显式指定，store 与焦点状态不参与推断。 */
export type AgentConversationDestination = 0 | 1;

function openAgentConversation(
  instanceId: string,
  destination: AgentConversationDestination = 1,
): void {
  if (destination === 1) {
    // 与对话列表点行同一条路径：browser 列自己管理 surface 与可见性。
    void openWorkspaceSurface({
      index: 1,
      target: { kind: 'agent-conversation', instanceId },
    }).catch((error: unknown) => {
      logger.error('Failed to open Agent conversation in browser column', { error });
    });
    return;
  }
  void openWorkspaceSurface({
    index: 0,
    target: { kind: 'agent-conversation', instanceId, blankIfMissing: true },
  });
}

/** Create a conversation instance for the browser column's host-specific navigation. */
export function createBrowserColumnAgentConversation(typeKey: AgentTypeKey, notebookId: string): string {
  return createAgentConversationInstance(typeKey, notebookId).instanceId;
}

/** Drop an empty Browser conversation when its navigation is cancelled before mounting. */
export function discardUnopenedBrowserColumnAgentConversation(instanceId: string): void {
  const instance = useAgentSessionStore.getState().conversationRegistry.instances[instanceId];
  if (instance && !instance.threadId) useAgentSessionStore.getState().removeInstance(instanceId);
}

/** Create and open a blank conversation scoped to a notebook. */
export function createAndOpenAgentConversation(typeKey: AgentTypeKey, notebookId: string | null): void {
  const instance = createAgentConversationInstance(typeKey, notebookId);
  openAgentConversation(instance.instanceId);
}

/** 随「新建会话」带过去的首条提示词；会话挂载时一次性消费。 */
export interface PendingAgentConversationPrompt {
  prompt: string;
  /** true：挂载后直接提交；false：只预填，留给用户编辑。 */
  autoSend: boolean;
}

export interface AgentConversationPromptOptions {
  destination?: AgentConversationDestination;
  autoSend?: boolean;
}

// 入口（集合底部输入框、文件夹首页）把输入框草稿随「新建会话」带过来：一次性
// 消费即删，避免常驻全局状态。
const pendingInitialPrompts = new Map<string, PendingAgentConversationPrompt>();

/** Create and open a conversation carrying a prompt (pre-filled, or auto-submitted). */
export function createAndOpenAgentConversationWithPrompt(
  typeKey: AgentTypeKey,
  notebookId: string | null,
  prompt: string,
  options: AgentConversationPromptOptions = {},
): void {
  const trimmed = prompt.trim();
  const instance = createAgentConversationInstance(typeKey, notebookId);
  if (trimmed) {
    pendingInitialPrompts.set(instance.instanceId, {
      prompt: trimmed,
      autoSend: options.autoSend === true,
    });
  }
  openAgentConversation(instance.instanceId, options.destination ?? 1);
}

/** Consume the one-shot initial prompt registered for a new conversation. */
export function consumeAgentConversationInitialPrompt(
  instanceId: string,
): PendingAgentConversationPrompt | null {
  const pending = pendingInitialPrompts.get(instanceId) ?? null;
  pendingInitialPrompts.delete(instanceId);
  return pending;
}

export function createAndOpenPiConversation(): void {
  const notebookId = useNoteStore.getState().selectedNotebook?.id ?? null;
  createAndOpenAgentConversation('pi', notebookId);
}
