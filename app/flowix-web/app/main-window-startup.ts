import {
  initializeNotebookContext,
  markMemoLibraryStartupError,
} from '@features/memo/public/app-api';
import { waitForInitialDocumentLoad } from '@features/document/public/startup-api';
import {
  captureWorkspaceRestoreTarget,
  restoreDocumentListWorkspace,
  restoreAgentConversationWorkspace,
  restoreExternalDocumentWorkspace,
  restoreMediaWorkspace,
  restoreTableWorkspace,
  restoreCollectionWorkspace,
  setWorkspaceRestoreStatus,
  type PersistedWorkspaceTarget,
} from '@features/workspace/public/startup-api';
import { boot } from '@platform/tauri/client';

let startupAttemptSequence = 0;

/**
 * Run the main-window startup stages in one failure-aware transaction.
 *
 * Notebook identity is resolved before workspace restoration. The cards query
 * then loads independently inside its view, so it cannot block folders or
 * conversations.
 */
export async function initializeMainWindowStartup(): Promise<void> {
  const startedAt = performance.now();
  const nativeRuntime = isTauriRuntime();
  const startupAttemptId = `${Date.now()}-${++startupAttemptSequence}`;
  const logStage = (stage: string) => {
    const elapsedMs = Math.round(performance.now() - startedAt);
    console.info('[perf:startup]', stage, { elapsedMs });
    if (nativeRuntime) void boot.recordStartupStage(stage, elapsedMs, startupAttemptId).catch(() => undefined);
  };
  let startupNotebookId: string | null = null;
  if (nativeRuntime) {
    await boot.waitForStartupReady();
    logStage('native-ready');
  }
  try {
    if (nativeRuntime) {
      try {
        startupNotebookId = await boot.getStartupNotebookId();
        logStage('notebook-selected');
      } catch (error) {
        markMemoLibraryStartupError(error);
        throw error;
      }
    }
    await initializeNotebookContext(startupNotebookId);
    logStage('notebook-context-ready');
    const desiredTarget = captureWorkspaceRestoreTarget();
    setWorkspaceRestoreStatus('restoring');
    try {
      await restoreDesiredTarget(desiredTarget);
      logStage('workspace-restored');
      setWorkspaceRestoreStatus('restored');
      const outcome = await waitForInitialDocumentLoad();
      logStage(`initial-document-${outcome}`);
    } catch (error) {
      // Keep desiredTarget unchanged. Temporary permission, mount, or IPC
      // failures can then be retried on the next launch.
      setWorkspaceRestoreStatus('unavailable');
      throw error;
    }
  } finally {
    if (nativeRuntime) {
      // The first callback runs before paint; the second frame confirms that
      // the restored content had a chance to appear before disk scans begin.
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => resolve());
      }));
      logStage('first-workspace-paint');
      await boot.notifyStartupInteractive().catch(() => undefined);
    }
  }
}

async function restoreDesiredTarget(target: PersistedWorkspaceTarget | null): Promise<void> {
  if (!target) return;
  if (target.kind === 'external') {
    await restoreExternalDocumentWorkspace(target);
    return;
  }
  if (target.kind === 'media') {
    await restoreMediaWorkspace(target);
    return;
  }
  if (target.kind === 'collection') {
    await restoreCollectionWorkspace(target);
    return;
  }
  if (target.kind === 'table') {
    await restoreTableWorkspace(target);
    return;
  }
  if (target.kind === 'document-list') {
    restoreDocumentListWorkspace(target);
    return;
  }
  await restoreAgentConversationWorkspace();
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined'
    && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}
