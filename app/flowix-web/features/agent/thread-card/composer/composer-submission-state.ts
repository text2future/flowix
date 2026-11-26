import type { AgentTypeKey } from "@/types/agent";
import type { ThreadProjection } from "@features/agent/store/session-reducer";
import { selectAgentThreadCardRuntimeView } from "../agent-thread-card-selectors";
import { COMPOSER_SLASH_COMMANDS } from "./composer-commands";

export type ComposerSubmissionKind = "message" | "command";

export interface ComposerRuntimeState {
  agentType: AgentTypeKey;
  isModelRunning: boolean;
  isStopping: boolean;
  isCommandRunning: boolean;
  isCommandStoppable: boolean;
  isSubmitting: boolean;
  isAvailable: boolean;
}

export interface ComposerSubmissionState {
  action: "send" | "queue" | "stop" | "busy";
  label: "send" | "stop" | "running" | "stopping";
  disabled: boolean;
  canSubmit: boolean;
  kind: ComposerSubmissionKind;
}

export function getComposerSubmissionKind(agentType: AgentTypeKey, prompt: string): ComposerSubmissionKind {
  const name = /^\/([a-z0-9_-]+)(?:\s|$)/iu.exec(prompt.trim())?.[1]?.toLowerCase();
  return COMPOSER_SLASH_COMMANDS.some((command) =>
    command.agentType === agentType && command.name === name &&
    (command.execution === "dsh-command" || command.execution === "codex-command"),
  ) ? "command" : "message";
}

/** One policy for the button, Enter and direct slash selections. */
export function selectComposerSubmissionState(input: ComposerRuntimeState & {
  prompt: string;
  hasAttachments: boolean;
  hasPendingAttachments: boolean;
  kind?: ComposerSubmissionKind;
}): ComposerSubmissionState {
  const kind = input.kind ?? getComposerSubmissionKind(input.agentType, input.prompt);
  const hasInput = !!input.prompt.trim() || input.hasAttachments;
  const supportsQueue = ["codex", "dsh", "pi"].includes(input.agentType);
  // Codex's native command endpoint has no attachment payload.
  const supportsAttachments = kind !== "command" || input.agentType !== "codex" || !input.hasAttachments;
  const canSubmit = input.isAvailable && hasInput &&
    supportsAttachments &&
    !input.hasPendingAttachments && !input.isSubmitting && !input.isStopping &&
    !input.isCommandRunning &&
    (!input.isModelRunning || (kind === "message" && supportsQueue));

  let action: ComposerSubmissionState["action"] = "send";
  // `stopping` stays clickable. A stop request can be dropped (runtime does not
  // confirm it, WebView reloads mid-abort), and a disabled button would then
  // leave a stuck run with no way out. Re-sending Stop is idempotent; the store
  // dedupes rapid double clicks and clears a run the runtime no longer owns.
  if (input.isStopping) action = "stop";
  else if (input.isCommandStoppable) action = "stop";
  else if (input.isCommandRunning || input.isSubmitting) action = "busy";
  else if (input.isModelRunning) {
    action = !hasInput || !supportsQueue ? "stop" : kind === "message" ? "queue" : "send";
  }
  return {
    action,
    label: input.isStopping ? "stopping" : action === "busy" ? "running" : action === "stop" ? "stop" : "send",
    disabled: !input.isAvailable || (action !== "stop" && !canSubmit),
    canSubmit,
    kind,
  };
}

/** Adapt the canonical thread projection once, without host-specific flags. */
export function getComposerRuntimeState(
  agentType: AgentTypeKey,
  projection: ThreadProjection | undefined,
  isSubmitting: boolean,
  isAvailable: boolean,
): ComposerRuntimeState {
  const runtime = selectAgentThreadCardRuntimeView({
    state: projection ? { ...projection.runs, messages: projection.messages } : undefined,
    typeKey: agentType, isLoading: !!projection?.runs.isLoading, isCreating: false,
  });
  return {
    agentType, isModelRunning: runtime.isModelRunning,
    isStopping: runtime.status === "stopping",
    isCommandRunning: runtime.isDshCommandRunning || runtime.isCodexCommandRunning ||
      !!projection?.messages.some((message) => message.isLoading &&
        (message.messageType === "dsh-command" || message.messageType === "codex-command")),
    isCommandStoppable: runtime.isCodexCommandStoppable,
    isSubmitting, isAvailable,
  };
}
