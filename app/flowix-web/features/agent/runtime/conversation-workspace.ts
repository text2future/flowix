import type {
  ConversationWorkspaceState,
  RuntimeConfig,
  WorkspaceSnapshot,
} from "@/types/agent";
import { normalizeWorkspacePath } from "@features/agent/runtime/workspace-path";

function normalizeSnapshot(value: unknown): WorkspaceSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<WorkspaceSnapshot>;
  const cwd = normalizeWorkspacePath(candidate.cwd);
  if (!cwd || !Array.isArray(candidate.workspacePaths)) return null;
  const workspacePaths = Array.from(new Set(
    candidate.workspacePaths.map(normalizeWorkspacePath).filter(Boolean),
  ));
  return {
    version: 1,
    cwd,
    workspacePaths,
    ...(candidate.notebookId ? { notebookId: candidate.notebookId } : {}),
    ...(candidate.notebookPath ? { notebookPath: normalizeWorkspacePath(candidate.notebookPath) } : {}),
    capturedAt: Number.isFinite(candidate.capturedAt) ? candidate.capturedAt! : 0,
  };
}

export function normalizeConversationWorkspaceState(
  runtimeConfig: RuntimeConfig | null | undefined,
): ConversationWorkspaceState | null {
  const value = runtimeConfig?.workspaceState;
  if (value?.version === 1) {
    const desired = normalizeSnapshot(value.desired);
    const applied = value.applied ? normalizeSnapshot(value.applied) : null;
    if (
      desired &&
      Number.isInteger(value.revision) &&
      value.revision >= 1 &&
      Number.isInteger(value.appliedRevision) &&
      value.appliedRevision >= 0 &&
      value.appliedRevision <= value.revision
    ) {
      return { ...value, desired, applied };
    }
  }
  const legacy = normalizeSnapshot(runtimeConfig?.workspaceSnapshot);
  if (!legacy) return null;
  return {
    version: 1,
    desired: legacy,
    applied: legacy,
    revision: 1,
    appliedRevision: 1,
  };
}

export function createInitialWorkspaceState(
  snapshot: WorkspaceSnapshot,
): ConversationWorkspaceState {
  return {
    version: 1,
    desired: snapshot,
    applied: null,
    revision: 1,
    appliedRevision: 0,
  };
}

export function selectDesiredWorkspace(
  current: ConversationWorkspaceState,
  desired: WorkspaceSnapshot,
): ConversationWorkspaceState {
  if (
    current.desired.cwd === desired.cwd &&
    current.desired.workspacePaths.join("\0") === desired.workspacePaths.join("\0")
  ) return current;
  return {
    version: 1,
    desired,
    applied: current.applied,
    revision: current.revision + 1,
    appliedRevision: current.appliedRevision,
  };
}
