import {
  documentHistoryEntryKey,
  useDocumentHistoryStore,
  type DocumentHistoryEntry,
} from '@features/document/store/document-history-store';
import { useDocumentStore } from '@features/document/store/document-store';
import { selectAndOpenAgentConversation } from '@features/workspace/use-cases/agent-conversation-navigation';
import {
  openExternalTarget,
  openCollectionTarget,
  openMediaTarget,
  openWebTarget,
  openDocumentListTarget,
  historyEntryFromWorkColumnTarget,
} from '@features/workspace/use-cases/workspace-navigation';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';

export type DocumentHistoryDirection = 'back' | 'forward';

function currentHistoryEntry(): DocumentHistoryEntry | null {
  const workColumnTarget = useWorkColumnStore.getState().navigation.target;
  const workColumnHistoryEntry = historyEntryFromWorkColumnTarget(workColumnTarget);
  if (workColumnHistoryEntry) return workColumnHistoryEntry;

  const state = useDocumentStore.getState();
  const external = state.activeExternalSession;
  if (external) {
    return {
      kind: 'external',
      path: external.fileIdentity.path,
      scopePath: external.scopePath,
      openedAt: external.openedAt,
    };
  }
  return state.activeAgentConversationId
    ? {
        kind: 'agent-conversation',
        instanceId: state.activeAgentConversationId,
        openedAt: Date.now(),
      }
    : null;
}

async function openHistoryEntry(entry: DocumentHistoryEntry): Promise<DocumentHistoryEntry> {
  if (entry.kind === 'collection') {
    await openCollectionTarget(entry, { history: 'skip', destination: 'main-third' });
    return entry;
  }
  if (entry.kind === 'document-list') {
    openDocumentListTarget({
      kind: 'document-list',
      displayId: entry.displayId,
      scope: entry.scope,
      filters: entry.filters,
    }, { history: 'skip' });
    return entry;
  }
  if (entry.kind === 'agent-conversation') {
    await selectAndOpenAgentConversation(entry.instanceId, {
      history: 'skip',
      destination: 'main-third',
    });
    return entry;
  }
  if (entry.kind === 'web') {
    await openWebTarget(entry.url, { history: 'skip', destination: 'main-third' });
    return entry;
  }
  if (entry.kind === 'media') {
    await openMediaTarget({
      filePath: entry.filePath,
      notebookId: entry.notebookId,
      notebookPath: entry.notebookPath,
      resourceKind: entry.resourceKind,
      history: 'skip',
      destination: 'main-third',
    });
    return entry;
  }
  await openExternalTarget(entry.path, {
    history: 'skip',
    scopePath: entry.scopePath,
    destination: 'main-third',
  });
  return entry;
}

export async function navigateDocumentHistory(direction: DocumentHistoryDirection): Promise<boolean> {
  const navigationId = ++historyNavigationSequence;
  const current = currentHistoryEntry();
  const history = useDocumentHistoryStore.getState();
  const stack = direction === 'back' ? history.backStack : history.forwardStack;
  const currentKey = documentHistoryEntryKey(current);
  let discardCount = 0;
  let target: DocumentHistoryEntry | null = null;
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const candidate = stack[index];
    discardCount += 1;
    if (documentHistoryEntryKey(candidate) !== currentKey) {
      target = candidate;
      break;
    }
  }
  if (!target) return false;

  let openedTarget: DocumentHistoryEntry;
  try {
    openedTarget = await openHistoryEntry(target);
  } catch {
    // Navigation errors are surfaced by the workspace transaction. Keep both
    // history stacks untouched so the user can retry the same destination.
    return false;
  }

  if (navigationId !== historyNavigationSequence) return false;
  if (documentHistoryEntryKey(currentHistoryEntry()) !== documentHistoryEntryKey(openedTarget)) {
    return false;
  }

  const currentStack = direction === 'back'
    ? useDocumentHistoryStore.getState().backStack
    : useDocumentHistoryStore.getState().forwardStack;
  if (documentHistoryEntryKey(currentStack[currentStack.length - discardCount] ?? null)
    !== documentHistoryEntryKey(openedTarget)) return false;

  if (direction === 'back') {
    useDocumentHistoryStore.getState().commitBackNavigation(current, discardCount);
  } else {
    useDocumentHistoryStore.getState().commitForwardNavigation(current, discardCount);
  }

  return true;
}

let historyNavigationSequence = 0;
