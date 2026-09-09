import type { RuntimeConfig, WorkspaceSnapshot } from "@/types/agent";
import { resolveNotebookAgentFiles } from "@/lib/agent-access-defaults";
import { resolvePrimaryWorkspace } from "@features/agent/runtime/primary-workspace";
import { normalizeWorkspacePath } from "@features/agent/runtime/workspace-path";
import { useAgentAccessStore } from "@features/agent/store/agent-access-store";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import { useMemoStore } from "@features/memo/store/memo-store";
import {
  createInitialWorkspaceState,
  normalizeConversationWorkspaceState,
} from "@features/agent/runtime/conversation-workspace";

function uniquePaths(paths: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      paths
        .map(normalizeWorkspacePath)
        .filter((path): path is string => Boolean(path)),
    ),
  );
}

/** Treat persisted JSON as untrusted and only accept complete snapshots. */
export function normalizeWorkspaceSnapshot(
  value: unknown,
): WorkspaceSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.cwd !== "string" ||
    !Array.isArray(candidate.workspacePaths) ||
    !candidate.workspacePaths.every((path) => typeof path === "string")
  ) {
    return null;
  }
  const cwd = normalizeWorkspacePath(candidate.cwd);
  if (!cwd) return null;
  const notebookId =
    typeof candidate.notebookId === "string" ? candidate.notebookId.trim() : "";
  const notebookPath =
    typeof candidate.notebookPath === "string"
      ? normalizeWorkspacePath(candidate.notebookPath)
      : "";
  return {
    version: 1,
    cwd,
    workspacePaths: uniquePaths(candidate.workspacePaths as string[]),
    ...(notebookId ? { notebookId } : {}),
    ...(notebookPath ? { notebookPath } : {}),
    capturedAt:
      typeof candidate.capturedAt === "number" &&
      Number.isFinite(candidate.capturedAt)
        ? candidate.capturedAt
        : 0,
  };
}

function migrateLegacyWorkspace(
  runtimeConfig: RuntimeConfig,
  fallbackNotebookId?: string,
  fallbackNotebookPath?: string,
): WorkspaceSnapshot | null {
  const files = runtimeConfig.files;
  const folders = Array.isArray(files?.folders)
    ? files.folders.filter((path): path is string => typeof path === "string")
    : [];
  const notebooks = Array.isArray(files?.notebooks)
    ? files.notebooks.filter((path): path is string => typeof path === "string")
    : [];
  const cwd = normalizeWorkspacePath(
    runtimeConfig.cwd ??
      files?.workspace ??
      folders[0] ??
      notebooks[0],
  );
  if (!cwd) return null;
  const notebookPath = uniquePaths(notebooks)[0] ?? fallbackNotebookPath;
  const resolvedNotebookId = runtimeConfig.notebookId ?? fallbackNotebookId;
  return {
    version: 1,
    cwd,
    workspacePaths: uniquePaths([
      cwd,
      ...folders,
      ...notebooks,
      notebookPath,
    ]),
    ...(resolvedNotebookId ? { notebookId: resolvedNotebookId } : {}),
    ...(notebookPath ? { notebookPath } : {}),
    capturedAt: Date.now(),
  };
}

/**
 * Return the workspace selected for the next turn, capturing and persisting
 * an initial selection when an old/new instance does not have one yet.
 */
export function ensureConversationWorkspaceSnapshot(
  instanceId: string,
): RuntimeConfig {
  // Persist the workspace snapshot on the canonical conversation instance.
  const session = useAgentSessionStore.getState();
  const instance = session.getInstance(instanceId);
  if (!instance) throw new Error("Agent session instance was not found");

  const runtimeConfig = instance.runtimeConfig ?? {};
  const workspaceState = normalizeConversationWorkspaceState(runtimeConfig);
  if (workspaceState) {
    if (!runtimeConfig.workspaceState) {
      session.setRuntimeConfig(instanceId, { workspaceState });
    }
    return {
      ...runtimeConfig,
      workspaceState,
      workspaceSnapshot: workspaceState.desired,
    };
  }
  const existing = normalizeWorkspaceSnapshot(runtimeConfig.workspaceSnapshot);
  if (existing) {
    const resolvedNotebookId = runtimeConfig.notebookId ?? existing.notebookId;
    if (!runtimeConfig.notebookId && resolvedNotebookId) {
      session.setRuntimeConfig(instanceId, {
        notebookId: resolvedNotebookId,
        workspaceSnapshot: existing,
      });
    }
    return {
      ...runtimeConfig,
      ...(resolvedNotebookId ? { notebookId: resolvedNotebookId } : {}),
      workspaceSnapshot: existing,
    };
  }

  const memoState = useMemoStore.getState();
  const configuredNotebookId = runtimeConfig.notebookId;
  const notebook =
    (configuredNotebookId
      ? memoState.notebooks.find((item) => item.id === configuredNotebookId)
      : null) ??
    (!configuredNotebookId || memoState.selectedNotebook?.id === configuredNotebookId
      ? memoState.selectedNotebook
      : null);
  const notebookId = configuredNotebookId ?? notebook?.id;
  const notebookPath = normalizeWorkspacePath(notebook?.path);

  let snapshot = migrateLegacyWorkspace(runtimeConfig, notebookId, notebookPath);
  if (!snapshot) {
    const accessState = useAgentAccessStore.getState();
    const defaultFiles = resolveNotebookAgentFiles(
      accessState.config,
      accessState.notebookConfigs,
      notebookId,
    );
    const primary = resolvePrimaryWorkspace({ defaultFiles, notebookPath });
    if (primary.kind === "empty") {
      // Do not permanently freeze an empty startup/hydration race.
      return runtimeConfig;
    }
    snapshot = {
      version: 1,
      cwd: primary.path,
      workspacePaths: uniquePaths(defaultFiles?.folders ?? []),
      ...(notebookId ? { notebookId } : {}),
      ...(notebookPath ? { notebookPath } : {}),
      capturedAt: Date.now(),
    };
  }

  const resolvedNotebookId = runtimeConfig.notebookId ?? snapshot.notebookId;
  session.setRuntimeConfig(instanceId, {
    workspaceSnapshot: snapshot,
    workspaceState: createInitialWorkspaceState(snapshot),
    ...(resolvedNotebookId ? { notebookId: resolvedNotebookId } : {}),
  });
  return {
    ...runtimeConfig,
    ...(resolvedNotebookId ? { notebookId: resolvedNotebookId } : {}),
    workspaceSnapshot: snapshot,
    workspaceState: createInitialWorkspaceState(snapshot),
  };
}

/** Mark the send boundary for the current desired workspace revision. This is
 * intentionally local optimistic state: the backend still validates and
 * commits the actual cwd before running. A workspace selected during an
 * in-flight turn increments `revision`, leaving it pending until next send.
 */
export function markConversationWorkspaceStarted(instanceId: string): void {
  const session = useAgentSessionStore.getState();
  const instance = session.getInstance(instanceId);
  if (!instance) return;
  const state = normalizeConversationWorkspaceState(instance.runtimeConfig);
  if (!state || state.appliedRevision >= state.revision) return;
  session.setRuntimeConfig(instanceId, {
    workspaceState: {
      ...state,
      applied: state.desired,
      appliedRevision: state.revision,
      error: undefined,
    },
  });
}
