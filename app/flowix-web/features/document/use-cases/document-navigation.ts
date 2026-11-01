import {
  documentHistoryEntryKey,
  useDocumentHistoryStore,
  type DocumentHistoryEntry,
} from '@features/document/store/document-history-store';
import { useDocumentStore } from '@features/document/store/document-store';
import {
  historyEntryFromWorkColumnTarget,
} from '@features/workspace/public/note-navigation-api';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { openFolderCollection, openFolderCollectionFromFolder } from '@features/workspace/public/main-window-api';
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
    await openWorkspaceSurface({
      host: 'main-third',
      target: { ...entry, kind: 'collection-reference' },
      options: { history: 'skip' },
    });
    return entry;
  }
  if (entry.kind === 'folder-collection') {
    // 回放文件夹首页时 history 必须为 skip：栈的推进由 commitBack/ForwardNavigation 负责。
    await openFolderCollectionFromFolder(entry.notebookId, entry.folderPath, 'main-third', { history: 'skip' });
    const openedEntry = historyEntryFromWorkColumnTarget(useWorkColumnStore.getState().navigation.target);
    if (!openedEntry) throw new Error('无法恢复文件夹历史记录');
    return openedEntry;
  }
  if (entry.kind === 'document-list') {
    await openFolderCollection(entry.scope.notebookId ?? '', entry.scope.path, { history: 'skip' });
    const openedEntry = historyEntryFromWorkColumnTarget(useWorkColumnStore.getState().navigation.target);
    if (!openedEntry) throw new Error('无法恢复旧文件夹历史记录');
    return openedEntry;
  }
  if (entry.kind === 'agent-conversation') {
    await openWorkspaceSurface({
      host: 'main-third',
      target: {
        kind: 'agent-conversation',
        instanceId: entry.instanceId,
        ...(entry.blankIfMissing ? { blankIfMissing: true as const } : {}),
      },
      options: { history: 'skip' },
    });
    return entry;
  }
  if (entry.kind === 'web') {
    await openWorkspaceSurface({ host: 'main-third', target: { kind: 'web', url: entry.url }, options: { history: 'skip' } });
    return entry;
  }
  if (entry.kind === 'media') {
    await openWorkspaceSurface({
      host: 'main-third',
      target: {
        kind: 'media',
        filePath: entry.filePath,
        notebookId: entry.notebookId,
        notebookPath: entry.notebookPath,
        resourceKind: entry.resourceKind,
      },
      options: { history: 'skip' },
    });
    return entry;
  }
  await openWorkspaceSurface({
    host: 'main-third',
    target: { kind: 'external', path: entry.path, scopePath: entry.scopePath, transitionId: null },
    options: { history: 'skip' },
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
    !== documentHistoryEntryKey(target)) return false;

  if (direction === 'back') {
    useDocumentHistoryStore.getState().commitBackNavigation(current, discardCount);
  } else {
    useDocumentHistoryStore.getState().commitForwardNavigation(current, discardCount);
  }

  return true;
}

let historyNavigationSequence = 0;
