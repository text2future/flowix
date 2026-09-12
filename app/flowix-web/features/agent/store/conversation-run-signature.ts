import type { ThreadProjection } from "@features/agent/store/session-reducer";

/**
 * The list only needs these lifecycle fields. Message/progress projection
 * changes must not look like a conversation-list change.
 */
const FIELD_SEPARATOR = "\u001f";
export const EMPTY_CONVERSATION_RUN_SIGNATURE = "-";

export function getConversationRunSignature(
  projection: ThreadProjection | undefined,
): string {
  if (!projection) return EMPTY_CONVERSATION_RUN_SIGNATURE;
  const activeRun = projection.runs.activeRunId
    ? projection.runs.runs[projection.runs.activeRunId]
    : undefined;
  const status = activeRun?.status ?? projection.runs.lastRun?.status ?? EMPTY_CONVERSATION_RUN_SIGNATURE;
  const runId = activeRun?.runId ?? projection.runs.lastRun?.runId ?? EMPTY_CONVERSATION_RUN_SIGNATURE;
  const startedAt = activeRun?.startedAt ?? projection.runs.lastRun?.startedAt ?? 0;
  const currentTool = activeRun?.currentTool ?? EMPTY_CONVERSATION_RUN_SIGNATURE;
  const command = projection.runs.dshCommand ?? projection.runs.codexCommand;
  const commandStatus = command?.status ?? EMPTY_CONVERSATION_RUN_SIGNATURE;
  const commandId = command?.id ?? EMPTY_CONVERSATION_RUN_SIGNATURE;
  const commandStartedAt = command?.startedAt ?? 0;
  return `${status}${FIELD_SEPARATOR}${runId}${FIELD_SEPARATOR}${startedAt}${FIELD_SEPARATOR}${currentTool}${FIELD_SEPARATOR}${commandStatus}${FIELD_SEPARATOR}${commandId}${FIELD_SEPARATOR}${commandStartedAt}`;
}

export function splitConversationRunSignature(signature: string): {
  status: "running" | "completed" | "failed" | "cancelled" | null;
  runId: string | null;
  startedAt: number;
  currentTool: string | null;
} {
  if (!signature || signature === EMPTY_CONVERSATION_RUN_SIGNATURE) {
    return { status: null, runId: null, startedAt: 0, currentTool: null };
  }
  const [status, runId, startedAt, currentTool, commandStatus, _commandId, commandStartedAt] = signature.split(FIELD_SEPARATOR);
  const parsedStatus = status === EMPTY_CONVERSATION_RUN_SIGNATURE
    ? null
    : status as "running" | "completed" | "failed" | "cancelled";
  return {
    status: parsedStatus ?? (commandStatus === "pending" ? "running" : null),
    runId: runId === EMPTY_CONVERSATION_RUN_SIGNATURE ? null : runId,
    startedAt: Number(startedAt) || Number(commandStartedAt) || 0,
    currentTool: currentTool === EMPTY_CONVERSATION_RUN_SIGNATURE ? null : currentTool,
  };
}
