import { resolveAgentPreferenceRuntimeConfig } from "@features/agent/store/agent-user-preferences";
import { useAgentWorkspaceStore } from "@features/agent/store/agent-workspace-store";
import type { ChatMessage } from "@/types";
import { errorMessage } from "@/lib/error-message";
import type { AgentRuntimeConfig, AgentTypeKey, RuntimeConfig } from "@/types/agent";
import { buildAgentRuntimeConfig } from "@features/agent/runtime/agent-runtime-spec";
import {
  normalizeWorkspaceSnapshot,
} from "@features/agent/runtime/workspace-snapshot";
import { normalizeConversationWorkspaceState } from "@features/agent/runtime/conversation-workspace";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import { ensureAgentPreferencesReady } from "@features/agent/store/agent-data-store";
import { useNoteStore } from "@features/memo/store/note-store";
import { agentClient } from "@features/agent/store/agent-client";
import { withNotebookSkillDisplayNames } from "./notebook-skill-display-names";

export const DSH_AGENT_TYPE = "dsh" as const satisfies AgentTypeKey;

export function isDshCompactCommand(command: string): boolean {
  return /^\/compact(?:[\t\n\r ]*)$/iu.test(command.trim());
}

/** Refresh the DSH-owned surface after a command that can rewrite history. */
export async function refreshDshConversationHistory(
  threadId: string,
): Promise<ChatMessage[]> {
  return useAgentSessionStore
    .getState()
    .reloadMessagesFromHistory(DSH_AGENT_TYPE, threadId);
}

/**
 * Display a command outcome in the conversation when DSH did not create a
 * visible message of its own. This is intentionally transient: the next
 * authoritative DSH history load removes it, so it cannot become fake durable
 * conversation history.
 */
export function appendTransientDshCommandResult(
  threadId: string,
  text: string,
): void {
  const content = text.trim();
  if (!content) return;
  useAgentSessionStore.getState().appendTransientCommandResult(threadId, content);
}

export interface DshCommandMessage {
  content: string;
  llmContent: string;
  agentType: typeof DSH_AGENT_TYPE;
  runtimeConfig: AgentRuntimeConfig;
  imagePaths: string[];
}

/**
 * Convert Flowix's persisted per-conversation settings into the DSH wire
 * shape. The desktop command path shares this exact shape with chat_stream;
 * passing the UI-only top-level RuntimeConfig would silently lose cwd/model.
 */
export function buildDshCommandMessage(
  command: string,
  instanceRuntimeConfig?: RuntimeConfig | null,
  imagePaths: string[] = [],
): DshCommandMessage {
  const preferences = resolveAgentPreferenceRuntimeConfig(DSH_AGENT_TYPE, instanceRuntimeConfig ?? undefined);
  const workspaceSnapshot =
    normalizeConversationWorkspaceState(instanceRuntimeConfig)?.desired ??
    normalizeWorkspaceSnapshot(instanceRuntimeConfig?.workspaceSnapshot);
  const notebookId = instanceRuntimeConfig?.notebookId;
  const notebook = notebookId
    ? useNoteStore.getState().notebooks.find((item) => item.id === notebookId)
    : useNoteStore.getState().selectedNotebook;
  const defaultFiles = !workspaceSnapshot && notebookId
    ? useAgentWorkspaceStore.getState().workspaceActions.getNotebookFiles(notebookId)
    : undefined;

  const runtimeConfig = buildAgentRuntimeConfig({
    typeKey: DSH_AGENT_TYPE,
    notebookPath: workspaceSnapshot?.notebookPath ?? notebook?.path,
    permissionMode: preferences.access?.sandbox ?? "danger-full-access",
    codexModel: preferences.model?.key ?? "inherit",
    codexReasoningEffort: preferences.reasoningEffort ?? "medium",
    instanceRuntimeConfig: preferences,
    defaultFiles,
    workspaceSnapshot,
  });

  return {
    content: command,
    llmContent: command,
    agentType: DSH_AGENT_TYPE,
    runtimeConfig,
    imagePaths,
  };
}

export async function executeDshCommand(input: {
  threadId: string;
  command: string;
  runtimeConfig?: RuntimeConfig | null;
  imagePaths?: string[];
}): Promise<unknown> {
  await ensureAgentPreferencesReady(DSH_AGENT_TYPE);
  return agentClient.executeDeepSeekHarnessCommand(
    input.threadId,
    input.command,
    buildDshCommandMessage(input.command, input.runtimeConfig, input.imagePaths),
  );
}

export interface DshCommandConversation {
  threadId: string;
  runtimeConfig?: RuntimeConfig | null;
}

/**
 * Shared DSH command lifecycle for every Flowix composer surface. DSH owns
 * command/run + command/done; this helper only refreshes the authoritative
 * projection and delegates focus, export, and localized error UI.
 */
export async function runDshCommand(input: {
  command: string;
  imagePaths?: string[];
  ensureConversation: (command: string) => Promise<DshCommandConversation>;
  onError?: (message: string) => void;
  onLogError?: (message: string, error: unknown) => void;
  onSaveExport?: (filename: string, content: string) => Promise<void>;
  onFocus?: () => void;
  sendFailedText?: string;
  rejectOnFailure?: boolean;
}): Promise<void> {
  const isCompact = isDshCompactCommand(input.command);
  let commandThreadId: string | null = null;
  try {
    const ensured = await input.ensureConversation(input.command);
    commandThreadId = ensured.threadId;
    const result = await executeDshCommand({
      threadId: ensured.threadId,
      command: input.command,
      runtimeConfig: ensured.runtimeConfig,
      imagePaths: input.imagePaths,
    });
    const execution = dshCommandResult(result);
    if (!execution.ok && input.rejectOnFailure) {
      throw new Error(execution.text || `DSH command failed: ${input.command}`);
    }

    if (isCompact) {
      const previousCheckpointIds = new Set(
        useAgentSessionStore
          .getState()
          .threadProjections[ensured.threadId]?.messages
          .filter((message) => message.messageType === "context-compaction")
          .map((message) => message.id),
      );
      let messages: Awaited<ReturnType<typeof refreshDshConversationHistory>> = [];
      try {
        messages = await refreshDshConversationHistory(ensured.threadId);
      } catch (error) {
        input.onLogError?.("Failed to refresh DSH history after compact", error);
      }
      const hasNewCheckpoint = messages.some(
        (message) =>
          message.messageType === "context-compaction" &&
          !previousCheckpointIds.has(message.id),
      );
      if (!hasNewCheckpoint && execution.text) {
        appendTransientDshCommandResult(ensured.threadId, execution.text);
      }
      return;
    }

    if (!execution.ok) {
      try {
        await refreshDshConversationHistory(ensured.threadId);
      } catch {
        input.onError?.(execution.text || `DSH command failed: ${input.command}`);
      }
      return;
    }
    try {
      await refreshDshConversationHistory(ensured.threadId);
    } catch (error) {
      input.onLogError?.("Failed to refresh DSH history after command", error);
    }
    if (execution.content !== undefined) {
      await input.onSaveExport?.(
        execution.filename || "dsh-session.json",
        execution.content,
      );
    }
  } catch (error) {
    if (input.rejectOnFailure) throw error;
    const message = errorMessage(error).trim();
    if (isCompact && commandThreadId) {
      appendTransientDshCommandResult(
        commandThreadId,
        message || input.sendFailedText || "DSH command failed",
      );
    } else {
      input.onError?.(message || input.sendFailedText || "DSH command failed");
    }
  } finally {
    input.onFocus?.();
  }
}

export async function listDshSkills(input: {
  threadId: string;
  runtimeConfig?: RuntimeConfig | null;
}): Promise<ReadonlyArray<{
  name: string;
  description: string;
  displayName?: string;
  path?: string;
  scope?: string;
  whenToUse?: string;
  modelInvocable?: boolean;
}>> {
  const result = await agentClient.listDeepSeekHarnessSkills(
    input.threadId,
    buildDshCommandMessage("/skill", input.runtimeConfig),
  );
  const workspace = normalizeConversationWorkspaceState(input.runtimeConfig)?.desired
    ?? normalizeWorkspaceSnapshot(input.runtimeConfig?.workspaceSnapshot);
  const notebookId = input.runtimeConfig?.notebookId ?? workspace?.notebookId;
  const noteState = useNoteStore.getState();
  const notebook = notebookId
    ? noteState.notebooks.find((item) => item.id === notebookId)
    : noteState.selectedNotebook;
  return withNotebookSkillDisplayNames(
    workspace?.notebookPath ?? notebook?.path ?? "",
    Array.isArray(result?.skills) ? result.skills : [],
  );
}

export function dshCommandResult(result: unknown): {
  ok: boolean;
  text: string;
  filename?: string;
  content?: string;
} {
  const value = result && typeof result === "object"
    ? result as Record<string, unknown>
    : {};
  const execution = value.execution && typeof value.execution === "object"
    ? value.execution as Record<string, unknown>
    : value;
  const commandResult = execution.result && typeof execution.result === "object"
    ? execution.result as Record<string, unknown>
    : execution;
  const kind = String(commandResult.kind ?? "success").toLowerCase();
  const text = typeof commandResult.text === "string" ? commandResult.text : "";
  const exportValue = value.export && typeof value.export === "object"
    ? value.export as Record<string, unknown>
    : undefined;
  return {
    ok: kind !== "error",
    text,
    ...(typeof exportValue?.filename === "string" ? { filename: exportValue.filename } : {}),
    ...(typeof exportValue?.content === "string" ? { content: exportValue.content } : {}),
  };
}
