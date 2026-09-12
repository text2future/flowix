import type { ComposerSlashSkill } from "@features/agent/thread-card/composer/composer-slash-command-controller";
import type { AgentEvent } from "@/types/agent";
import { agent } from "@platform/tauri/client/agent";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";

type CodexSkillRecord = {
  name?: unknown;
  description?: unknown;
  shortDescription?: unknown;
  interface?: unknown;
  whenToUse?: unknown;
  modelInvocable?: unknown;
};

/**
 * `skills/list` returns one result per requested cwd. The actual skill list
 * is nested below each result's `skills` field, rather than directly below
 * the response's `data` field. Keep this parser tolerant of both that shape
 * and older/forward-compatible envelopes used by Codex app-server versions.
 */
export function parseCodexSkills(value: unknown): readonly ComposerSlashSkill[] {
  const records: unknown[] = [];

  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!current || typeof current !== "object") return;

    const record = current as CodexSkillRecord & {
      data?: unknown;
      skills?: unknown;
    };
    if (typeof record.name === "string") {
      records.push(current);
      return;
    }

    // Current app-server shape: data -> [{ cwd, skills: [...] }]. Also
    // handles data.skills and data.skills.data from adjacent protocol builds.
    visit(record.skills);
    visit(record.data);
  };

  visit(value);

  const seen = new Set<string>();
  return records
    .map(asSkill)
    .filter((skill): skill is ComposerSlashSkill => {
      if (!skill || seen.has(skill.name)) return false;
      seen.add(skill.name);
      return true;
    });
}

function asSkill(value: unknown): ComposerSlashSkill | null {
  if (!value || typeof value !== "object") return null;
  const record = value as CodexSkillRecord;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) return null;
  const skillInterface = record.interface && typeof record.interface === "object"
    ? record.interface as { displayName?: unknown; shortDescription?: unknown }
    : undefined;
  return {
    name,
    description: typeof record.description === "string" ? record.description : "",
    displayName: typeof skillInterface?.displayName === "string"
      ? skillInterface.displayName
      : undefined,
    shortDescription: typeof skillInterface?.shortDescription === "string"
      ? skillInterface.shortDescription
      : typeof record.shortDescription === "string"
        ? record.shortDescription
        : undefined,
    whenToUse: typeof record.whenToUse === "string" ? record.whenToUse : undefined,
    modelInvocable: typeof record.modelInvocable === "boolean" ? record.modelInvocable : undefined,
  };
}

/** Read project-scoped Codex skills without creating a model turn. */
export async function listCodexSkills(cwd: string): Promise<readonly ComposerSlashSkill[]> {
  if (!cwd.trim()) return [];
  const capabilities = await agent.getCodexProjectCapabilities(cwd);
  if (!capabilities.skills.ok) throw new Error(capabilities.skills.error ?? "Failed to load Codex skills");
  return parseCodexSkills(capabilities.skills.value);
}

/** Native Codex commands occupy the same thread as model turns and must keep
 * both composer surfaces in their running state until their terminal event. */
export function hasPendingCodexCommand(threadId: string | null | undefined): boolean {
  if (!threadId) return false;
  const projection = useAgentSessionStore.getState().threadProjections[threadId];
  return (
    projection?.runs.codexCommand?.status === "pending" ||
    !!projection?.messages.some(
      (message) => message.messageType === "codex-command" && message.isLoading,
    )
  );
}

export interface CodexCommandLifecycle {
  runId: string;
  commandId: string;
}

function createLifecycleId(prefix: string, threadId: string): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${threadId}-${random}`;
}

export function createCodexCommandLifecycle(threadId: string): CodexCommandLifecycle {
  const commandId = createLifecycleId("codex-command", threadId);
  return {
    commandId,
    runId: createLifecycleId("codex-command-run", threadId),
  };
}

/**
 * Start the product-owned command projection before any IPC/connection work.
 * This closes the gap where a fast `/goal` finishes before the backend's
 * pending event can produce a paint, and uses the same ids as the backend so
 * its acknowledgement updates this row in place.
 */
export function beginCodexSlashCommand(
  threadId: string,
  command: string,
  lifecycle: CodexCommandLifecycle,
): void {
  const event: AgentEvent = {
    kind: "codex_command",
    agentType: "codex",
    threadId,
    runId: lifecycle.runId,
    timestamp: Date.now(),
    id: lifecycle.commandId,
    command,
    status: "pending",
  };
  useAgentSessionStore.getState().dispatch(event);
}

export function finishCodexSlashCommand(
  threadId: string,
  command: string,
  lifecycle: CodexCommandLifecycle,
  status: "error" | "cancelled" = "error",
  result?: string,
): void {
  useAgentSessionStore.getState().dispatch({
    kind: "codex_command",
    agentType: "codex",
    threadId,
    runId: lifecycle.runId,
    timestamp: Date.now(),
    id: lifecycle.commandId,
    command,
    status,
    result,
  });
}

export function executeCodexSlashCommand(
  threadId: string,
  command: string,
  cwd?: string | null,
  lifecycle?: CodexCommandLifecycle,
): Promise<unknown> {
  return agent.executeCodexSlashCommand(
    threadId,
    command,
    cwd ? { codex: { cwd } } : undefined,
    lifecycle,
  );
}
