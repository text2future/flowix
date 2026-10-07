import type { AgentTypeKey } from "@/types/agent";

const CANONICAL_EXTERNAL_AGENTS = new Set<AgentTypeKey>([
  "codex",
  "claude",
  "hermes",
  "pi",
  "opencode",
  "deepseek-harness",
]);

export function canonicalAgentMessageId(
  agentType: AgentTypeKey,
  runId: string,
  role: "user" | "assistant" | "reasoning" | "system" | "tool" | "tool-call" | "error",
  sourceMessageId: string | undefined,
): string | undefined {
  if (!sourceMessageId || !CANONICAL_EXTERNAL_AGENTS.has(agentType)) {
    return sourceMessageId;
  }
  if (sourceMessageId.startsWith("msg:")) return sourceMessageId;
  // Codex item ids and Pi session entry ids are stable across live events and
  // history, so wrapping them with runId creates disjoint identities for one
  // row. Keep provider ids unchanged. Errors stay run-scoped because they
  // have no provider message id and distinct failures must remain separate.
  if ((agentType === "codex" || agentType === "pi") && role !== "error") {
    return sourceMessageId;
  }
  return `msg:${agentType}:${runId}:${role}:${sourceMessageId}`;
}

export function completedRunUserMessageId(
  agentType: AgentTypeKey | undefined,
  runId: string,
): string {
  const legacyId = `user-${runId}`;
  return agentType
    ? canonicalAgentMessageId(agentType, runId, "user", legacyId) ?? legacyId
    : legacyId;
}
