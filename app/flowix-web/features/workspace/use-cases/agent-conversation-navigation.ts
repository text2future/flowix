import {
  hasWorkspaceAgentConversation,
  hydrateWorkspaceAgentConversation,
} from '@features/agent/public/workspace-session-api';
import { useWorkspaceRestoreStore } from '@features/workspace/store/workspace-restore-store';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { clearWorkspaceDocument, closeAgentTarget, openAgentTarget } from './workspace-navigation';

import { createLogger } from '@/lib/logger';
const logger = createLogger('workspace/use-cases/agent-conversation-navigation');
export async function selectAndOpenAgentConversation(
  instanceId: string,
  options?: { history?: 'push' | 'skip'; destination?: 'column-1'; blankIfMissing?: true; restoreRequestId?: number },
): Promise<void> {
  const normalized = instanceId.trim();
  if (!normalized || !isRestoreRequestCurrent(options?.restoreRequestId)) return;

  if (options?.blankIfMissing && !(await hasWorkspaceAgentConversation(normalized))) {
    const requestId = useWorkColumnStore.getState().navigation.requestId;
    try {
      const restored = await hydrateWorkspaceAgentConversation(normalized);
      if (useWorkColumnStore.getState().navigation.requestId !== requestId
        || !isRestoreRequestCurrent(options?.restoreRequestId)) return;
      if (!restored) {
        await clearWorkspaceDocument();
        useWorkspaceRestoreStore.getState().clearAgentConversation(normalized);
        return;
      }
    } catch {
      if (useWorkColumnStore.getState().navigation.requestId !== requestId
        || !isRestoreRequestCurrent(options?.restoreRequestId)) return;
      // A backend error is not proof that an empty draft has vanished. Keep
      // the target so the detail can show its normal loading error and retry.
    }
  }

  // Work placement only: both conversation lists default to the Browser column
  // and open it through a separate explicit openWorkspaceSurface request. This
  // path serves Work-targeted opens (row menu) and workspace restore.
  const host = await openAgentTarget(normalized, {
    ...options,
    destination: options?.destination ?? 'column-1',
  });
  const activeTarget = useWorkColumnStore.getState().navigation.target;
  if (activeTarget.kind !== 'agent-conversation' || activeTarget.instanceId !== normalized) return;
  useWorkspaceRestoreStore.getState().selectAgentConversation(
    normalized,
    host === 'column-1',
  );
}

export function closeAgentConversationDetail(): void {
  closeAgentTarget();
  useWorkspaceRestoreStore.getState().closeAgentConversationDetail();
}

export async function restoreAgentConversationWorkspace(
  restoreRequestId = useWorkColumnStore.getState().navigation.requestId,
): Promise<void> {
  if (!isRestoreRequestCurrent(restoreRequestId)) return;
  const store = useWorkspaceRestoreStore.getState();
  const desiredTarget = store.desiredTarget;
  const instanceId = desiredTarget?.kind === 'agent-conversation'
    ? desiredTarget.instanceId.trim()
    : '';
  if (!instanceId) return;

  const blankIfMissing = desiredTarget?.kind === 'agent-conversation'
    && desiredTarget.blankIfMissing === true;
  const navigationRevision = restoreRequestId;
  let restored: Awaited<ReturnType<typeof hydrateWorkspaceAgentConversation>> = null;
  let restoreFailed = false;

  try {
    restored = await hydrateWorkspaceAgentConversation(instanceId);
  } catch (error) {
    restoreFailed = true;
    logger.error('Failed to restore agent conversation', { error });
  }

  const currentTarget = useWorkspaceRestoreStore.getState().desiredTarget;
  if (
    useWorkColumnStore.getState().navigation.requestId !== navigationRevision
    || !isRestoreRequestCurrent(restoreRequestId)
    || currentTarget?.kind !== 'agent-conversation'
    || currentTarget.instanceId.trim() !== instanceId
    || useWorkColumnStore.getState().navigation.phase === 'loading'
  ) return;

  if (!restoreFailed && restored === null) {
    // A rebuilt session store also invalidates formerly persisted selections.
    // Confirmed absence returns to the ordinary empty work column.
    try {
      await clearWorkspaceDocument();
      const latest = useWorkspaceRestoreStore.getState().desiredTarget;
      if (latest?.kind !== 'agent-conversation' || latest.instanceId.trim() !== instanceId) return;
      useWorkspaceRestoreStore.getState().clearAgentConversation();
      return;
    } catch (error) {
      logger.error('Failed to clear missing empty conversation target', { error });
    }
  }

  if (blankIfMissing && restored) {
    useWorkspaceRestoreStore.getState().setDesiredTarget({
      kind: 'agent-conversation',
      instanceId,
    });
  }

  // The detail owns missing/error presentation and retry. Keep the restored
  // target visible even when this eager lookup did not return an instance.
  await selectAndOpenAgentConversation(instanceId, {
    history: 'skip',
    restoreRequestId,
    ...(blankIfMissing && restoreFailed ? { blankIfMissing: true as const } : {}),
  });
}

function isRestoreRequestCurrent(requestId: number | undefined): boolean {
  return requestId === undefined || useWorkColumnStore.getState().navigation.requestId === requestId;
}
