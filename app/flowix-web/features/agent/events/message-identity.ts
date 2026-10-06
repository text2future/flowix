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
  // Codex app-server item ids are identical across live notifications and
  // thread/turns/list history, so wrapping them with the runId creates two
  // disjoint identity spaces for the same row. Keep provider ids unwrapped
  // so live projection rows and history rows reconcile by reference. Errors
  // stay run-scoped: they carry no provider item id and distinct failures
  // from different runs must not collapse onto one row.
  if (agentType === "codex" && role !== "error") return sourceMessageId;
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
