/**
 * 给新创建的 AgentConversationInstance 填一份"初始 runtime_config"。
 *
 * 文件区域 (cwd / workspacePaths / notebookPath) 不在卡片插入时读取；它们
 * 会在首次提交前由 ensureConversationWorkspaceSnapshot 解析并冻结。这样既
 * 避免插入阶段 store 尚未 hydrate 的 race，也保证后续 turn 不随全局配置变化。
 *
 * 这里只种子 model / access / reasoningEffort 的全局默认, 以及创建时所属
 * notebookId ── 提交时据此读取该笔记本 `.flowix/agent.json` 中的 add-dir
 * 配置。未选笔记本时 notebookId 为 undefined，提交侧不会附加资料目录。
 */
import type { AgentTypeKey, RuntimeConfig } from "@/types/agent";
import { DEFAULT_AGENT_TYPE_KEY } from "@/lib/agent-types";
import { useAgentAccessStore } from "@features/agent/store/agent-access-store";
import { useMemoStore } from "@features/memo/store/memo-store";

export function buildInitialInstanceRuntimeConfig(
  agentType: AgentTypeKey = DEFAULT_AGENT_TYPE_KEY,
): RuntimeConfig {
  const accessState = useAgentAccessStore.getState();
  const notebookId = useMemoStore.getState().selectedNotebook?.id ?? undefined;
  const defaultRuntime = accessState.config.defaults?.runtime?.[agentType];

  return {
    ...(defaultRuntime?.model ? { model: defaultRuntime.model } : {}),
    ...(defaultRuntime?.access ? { access: defaultRuntime.access } : {}),
    ...(defaultRuntime?.reasoningEffort
      ? { reasoningEffort: defaultRuntime.reasoningEffort }
      : {}),
    ...(defaultRuntime?.mode
      ? { deepseekHarness: { mode: defaultRuntime.mode } }
      : {}),
    notebookId,
  };
}
