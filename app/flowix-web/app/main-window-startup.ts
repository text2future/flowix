import {
  initializeNotebookContext,
  markMemoLibraryStartupError,
  resumePendingNoteLinkUpdates,
} from '@features/memo/public/app-api';
import {
  captureWorkspaceRestoreTarget,
  restoreLegacyFolderListWorkspace,
  restoreAgentConversationWorkspace,
  restoreExternalDocumentWorkspace,
  restoreMediaWorkspace,
  restoreTableWorkspace,
  restoreCollectionWorkspace,
  restoreFolderCollectionWorkspace,
  restoreSessionTarget,
  setWorkspaceRestoreStatus,
  type PersistedWorkspaceTarget,
} from '@features/workspace/public/startup-api';
import { boot } from '@platform/tauri/client';
import { useWorkspaceStartupStore } from '@/lib/store/workspace-startup-store';
import { getWorkspaceNavigationRevision } from '@features/workspace/public/shell-api';
import { getWorkspaceMemoState } from '@features/memo/public/workspace-api';
import { admitStartupStage3, runStartupStage3Task } from '@/lib/startup-stage3';
import { waitForWorkbenchMounted } from '@/lib/workbench-mount';

import { createLogger } from '@/lib/logger';
const logger = createLogger('app/main-window-startup');
let startupAttemptSequence = 0;
let startupPromise: Promise<void> | null = null;
let workspaceRestorationPromise: Promise<void> = Promise.resolve();

/** Agent history catch-up yields to the selected target, with a liveness bound. */
export async function waitForWorkspaceRestoration(maxWaitMs = 2_000): Promise<void> {
  let timeout: number | undefined;
  await Promise.race([
    workspaceRestorationPromise,
    new Promise<void>((resolve) => {
      timeout = window.setTimeout(resolve, maxWaitMs);
    }),
  ]);
  if (timeout !== undefined) window.clearTimeout(timeout);
}

/**
 * Stage 2 ends when notebook identity and the interactive shell are available.
 * Restored content loads independently, with view-local loading/error states.
 */
export function initializeMainWindowStartup(): Promise<void> {
  if (startupPromise) return startupPromise;
  const { status } = useWorkspaceStartupStore.getState();
  if (status === 'ready' || status === 'degraded') {
    admitStartupStage3();
    void runStartupStage3Task('pending-note-link-updates', resumePendingNoteLinkUpdates);
    return Promise.resolve();
  }
  startupPromise = performMainWindowStartup().finally(() => { startupPromise = null; });
  return startupPromise;
}

async function performMainWindowStartup(): Promise<void> {
  const startedAt = performance.now();
  const nativeRuntime = isTauriRuntime();
  let nativeReady = !nativeRuntime;
  const startupAttemptId = `${Date.now()}-${++startupAttemptSequence}`;
  const logStage = (stage: string) => {
    const elapsedMs = Math.round(performance.now() - startedAt);
    logger.info('perf:startup', { stage, elapsedMs });
    if (nativeRuntime) void boot.recordStartupStage(stage, elapsedMs, startupAttemptId).catch(() => undefined);
  };
  // Keep only workbench prerequisites in this awaited chain. Content hydration
  // and optional services start after the shell has painted.
  const runTask = async <T,>(task: string, operation: () => Promise<T>): Promise<T> => {
    useWorkspaceStartupStore.setState({ task });
    logStage(`task:${task}:start`);
    const result = await operation();
    logStage(`task:${task}:complete`);
    return result;
  };
  useWorkspaceStartupStore.setState({
    status: 'running', task: 'native-ready', error: null,
  });
  try {
    if (nativeRuntime) {
      await boot.waitForStartupReady();
      nativeReady = true;
      useWorkspaceStartupStore.setState({ nativePhase: 'ready', nativeStage: 'workspacePreparation', nativeProgress: null, nativeError: null });
      logStage('native-ready');
    }
    const startupNotebookIdPromise = nativeRuntime
      ? runTask('notebook-selection', async () => {
          try {
            return await boot.getStartupNotebookId();
          } catch (error) {
            markMemoLibraryStartupError(error);
            throw error;
          }
        })
      : Promise.resolve(null);
    await runTask('notebook-context', () => initializeNotebookContext(startupNotebookIdPromise));
    await startupNotebookIdPromise;
    logStage('notebook-selected');
    const hasNotebook = getWorkspaceMemoState().notebooks.length > 0;
    const desiredTarget = hasNotebook ? captureWorkspaceRestoreTarget() : null;
    const navigationRevision = getWorkspaceNavigationRevision();
    // Release the shell before reading documents, tables or agent histories.
    useWorkspaceStartupStore.setState({ status: 'ready', task: null, error: null });
    setWorkspaceRestoreStatus(desiredTarget ? 'restoring' : 'restored');
    await waitForWorkbenchMounted();
    await afterShellPaint();
    if (nativeRuntime) {
      logStage('first-workspace-paint');
      await boot.notifyStartupInteractive().catch(() => undefined);
    }
    const shouldRestoreTarget = getWorkspaceNavigationRevision() === navigationRevision;
    const restorePromise = shouldRestoreTarget
      ? restoreDesiredTarget(desiredTarget, navigationRevision)
      : Promise.resolve();
    // Do not let low-priority Agent history recovery race the selected surface.
    // The promise is observed without blocking the workbench startup barrier.
    workspaceRestorationPromise = restorePromise.then(() => undefined, () => undefined);
    admitStartupStage3();
    void runStartupStage3Task('pending-note-link-updates', resumePendingNoteLinkUpdates);
    logStage('stage3-admitted');
    nativeReady = false; // The success path already released native startup.
    if (!shouldRestoreTarget) {
      setWorkspaceRestoreStatus('restored');
      return;
    }
    // Do not await hydration from the startup barrier. Each navigation operation
    // owns its cancellation identity so later user navigation wins.
    void restorePromise.then(() => {
      logStage('workspace-restore-settled');
      setWorkspaceRestoreStatus('restored');
    }).catch((error) => {
      const targetStillDesired = JSON.stringify(captureWorkspaceRestoreTarget()) === JSON.stringify(desiredTarget);
      if (targetStillDesired) {
        logger.warn('Workspace content restoration unavailable:', error);
        setWorkspaceRestoreStatus('unavailable');
      } else {
        logStage('workspace-restore-superseded');
        setWorkspaceRestoreStatus('restored');
      }
    });
  } catch (error) {
    useWorkspaceStartupStore.setState({
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    logStage(`task:${useWorkspaceStartupStore.getState().task}:failed`);
    throw error;
  } finally {
    if (nativeRuntime && nativeReady) {
      // A stage-2 retry screen can also paint and release independent work.
      await waitForWorkbenchMounted();
      await afterShellPaint();
      const status = useWorkspaceStartupStore.getState().status;
      logStage(status === 'ready' ? 'first-workspace-paint' : `foreground-${status}-paint`);
      await boot.notifyStartupInteractive().catch(() => undefined);
    }
  }
}

function afterShellPaint(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => resolve());
  }));
}

async function restoreDesiredTarget(target: PersistedWorkspaceTarget | null, requestId: number): Promise<void> {
  if (!target || getWorkspaceNavigationRevision() !== requestId) return;
  if (target.kind === 'web' || target.kind === 'file-browser' || target.kind === 'plugin-workbench') {
    await restoreSessionTarget(target, requestId);
    return;
  }
  if (target.kind === 'external') {
    await restoreExternalDocumentWorkspace(target, requestId);
    return;
  }
  if (target.kind === 'media') {
    await restoreMediaWorkspace(target, requestId);
    return;
  }
  if (target.kind === 'collection') {
    await restoreCollectionWorkspace(target, requestId);
    return;
  }
  if (target.kind === 'folder-collection') {
    await restoreFolderCollectionWorkspace(target, requestId);
    return;
  }
  if (target.kind === 'table') {
    await restoreTableWorkspace(target, requestId);
    return;
  }
  if (target.kind === 'document-list') {
    await restoreLegacyFolderListWorkspace(target, requestId);
    return;
  }
  await restoreAgentConversationWorkspace(requestId);
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined'
    && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}
