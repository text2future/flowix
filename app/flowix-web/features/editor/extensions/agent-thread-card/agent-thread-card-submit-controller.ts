import type { AgentTypeKey } from "@/types/agent";
import type { AgentConversationSource } from "@features/agent/store/agent-conversation-store";
import { useAgentConversationStore } from "@features/agent/store/agent-conversation-store";
import { buildInitialInstanceRuntimeConfig } from "@features/agent/store/initial-runtime-config";
import { useChatStore } from "@features/agent/store/chat-store";
import { ensureAgentThreadCardThread } from "@features/editor/extensions/agent-thread-card/agent-thread-card-submit";
import { upsertAgentThreadCardConversationInstance } from "@features/editor/extensions/agent-thread-card/runtime/thread-card-conversation";

export interface SubmitAgentThreadCardConversationInput {
  prompt: string;
  fallbackTitle: string;
  typeKey: AgentTypeKey;
  currentThreadId: string | null;
  currentInstanceId: string | null;
  currentTitle: string;
  runtimeHandleId: string;
  source: AgentConversationSource;
  role: {
    memoId: string | null;
    name: string | null;
  };
  isFirstMessage: boolean;
  documentContext: string;
  buildTitle: (prompt: string, fallback: string) => string;
  loadAgentRoleBody: (memoId: string) => Promise<string | null>;
  onThreadBound: (binding: {
    instanceId: string;
    threadId: string;
    typeKey: AgentTypeKey;
  }) => void;
}

export async function submitAgentThreadCardConversation(
  input: SubmitAgentThreadCardConversationInput,
): Promise<void> {
  let nextThreadId = input.currentThreadId;
  let nextInstanceId = input.currentInstanceId;
  let nextTitle =
    input.currentTitle || input.buildTitle(input.prompt, input.fallbackTitle);
  let nextTypeKey = input.typeKey;

  if (!nextInstanceId) {
    const instance = useAgentConversationStore.getState().createInstance({
      agentType: nextTypeKey,
      title: nextTitle,
      threadId: nextThreadId,
      source: input.source,
      role: input.role,
      // 与 ensureInstanceBinding / insertAgentThreadCard 同: instance
      // 创建瞬间把 runtime_config 快照写进 DB, 不再让 cwd 兜底链依赖
      // 启动 race 窗口内的 selectedNotebook / agent-access store.
      runtimeConfig: buildInitialInstanceRuntimeConfig(nextTypeKey),
    });
    nextInstanceId = instance.instanceId;
  }

  if (!nextThreadId) {
    const ensured = await ensureAgentThreadCardThread({
      prompt: input.prompt,
      fallbackTitle: input.fallbackTitle,
      typeKey: input.typeKey,
      currentThreadId: input.currentThreadId,
      runtimeHandleId: input.runtimeHandleId,
      instanceId: nextInstanceId,
      buildTitle: input.buildTitle,
    });

    if (ensured) {
      nextThreadId = ensured.threadId;
      nextTitle = ensured.title;
      nextTypeKey = ensured.typeKey;
      useAgentConversationStore.getState().updateThread(nextInstanceId, {
        agentType: ensured.typeKey,
        threadId: ensured.threadId,
      });
    }
  }

  if (!nextThreadId) {
    throw new Error("Agent thread id was not created");
  }

  const conversation = upsertAgentThreadCardConversationInstance({
    instanceId: nextInstanceId,
    agentType: nextTypeKey,
    title: nextTitle,
    threadId: nextThreadId,
    source: input.source,
    role: input.role,
  });
  nextInstanceId = conversation.instanceId;
  const runtimeConfig = conversation.instance.runtimeConfig ?? null;

  const roleBody =
    input.isFirstMessage && input.role.memoId
      ? await input.loadAgentRoleBody(input.role.memoId)
      : null;

  const sendPromise = useChatStore
    .getState()
    .sendMessageToThread(nextThreadId, input.prompt, nextTypeKey, {
      instanceId: nextInstanceId,
      conversationTitle: nextTitle,
      currentNoteContent: input.documentContext,
      agentRoleMemoId: input.role.memoId ?? undefined,
      agentRoleName: input.role.name ?? undefined,
      isFirstMessage: input.isFirstMessage,
      agentRoleBody: roleBody,
      runtimeConfig,
    });

  input.onThreadBound({
    instanceId: nextInstanceId,
    threadId: nextThreadId,
    typeKey: nextTypeKey,
  });

  await sendPromise;
}
