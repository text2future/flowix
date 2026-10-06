import { captureFileBrowserContext } from './file-browser-context';
import { notes as notesClient, type PluginDescriptor, type MarkdownLocation } from '@platform/tauri/client';
import { canonicalPath } from '@/lib/path';
import { resourceKindFromPath } from '@features/editor/public/code-file';
import { canonicalUrl } from '@features/workspace/store/workspace-content-identity';
import {
  flushWorkspaceDocumentPath,
  getWorkspaceDocumentState,
  recordWorkspaceDocumentNavigation,
  replaceWorkspaceDocumentPath,
  type DocumentHistoryEntry,
} from '@features/document/public/workspace-api';
import {
  useBrowserColumnStore,
} from '@features/workspace/store/browser-column-store';
import { documentIdentityFromFile } from '@features/document/public/workspace-api';
import {
  ensureFileDisplayIdentity,
  suspendFileDisplayReconciliation,
} from '@/lib/file-display-registry';
import {
  getWorkspaceMemoState,
  setCurrentWorkspaceNotebook,
  type Notebook,
} from '@features/memo/public/workspace-api';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { EMPTY_WORK_COLUMN_TARGET } from '@features/workspace/store/work-column-target';
import type { DocumentListTarget, WorkColumnTarget } from '@features/workspace/store/work-column-target';
import {
  useWorkspaceFocusStore,
  type WorkspaceHostId,
} from '@features/workspace/store/workspace-focus-store';
import {
  activateExistingWorkspaceContent,
  activateExistingWorkspaceContentAsync,
  findExistingWorkspaceContent,
  type WorkspaceContentLocation,
} from './workspace-content-activation';
import type { ContentIdentity } from '@features/workspace/store/workspace-content-identity';
import {
  useWorkspaceRestoreStore,
  type PersistedWorkspaceTarget,
} from '@features/workspace/store/workspace-restore-store';

export interface OpenExternalTargetOptions {
  fileBrowser?: import('../store/file-browser-target').FileBrowserContext;
  /** Explicit cross-column moves must not reactivate a BrowserColumn tab. */
  destination?: 'main-third';
  history?: 'push' | 'skip';
  scopePath?: string | null;
  notebookId?: string | null;
  markdownLocation?: MarkdownLocation | null;
  initialFocus?: 'title' | 'body';
}

export interface OpenMediaTargetParams {
  filePath: string;
  notebookId?: string | null;
  notebookPath: string | null;
  resourceKind?: 'image' | 'video';
  history?: 'push' | 'skip';
  destination?: 'main-third';
}

type RetryAction = () => Promise<void>;

type DocumentSnapshot = Pick<
  ReturnType<typeof getWorkspaceDocumentState>,
  'activeExternalSession' | 'activeAgentConversationId'
>;

const retryActions = new Map<string, RetryAction>();
let retrySequence = 0;

/**
 * Let a selection-only update reach the screen before document navigation
 * starts doing synchronous editor work. A single rAF runs before the browser
 * paints, so the second frame is intentional: the first frame is the one in
 * which React can paint the selected memo card.
 */
/**
 * Keep the no-op/main-third path synchronous. BrowserColumn activation is the
 * only path which needs to cross the save-before-unmount barrier.
 */
function activateExistingContentForNavigation(
  identity: ContentIdentity,
): WorkspaceContentLocation | null | Promise<WorkspaceContentLocation | null> {
  const existing = findExistingWorkspaceContent(identity);
  if (!existing) return null;
  if (existing.host === 'main-third') {
    activateExistingWorkspaceContent(identity);
    return existing;
  }
  return activateExistingWorkspaceContentAsync(identity);
}

function pendingExternalTarget(
  path: string | null,
  options?: OpenExternalTargetOptions,
): WorkColumnTarget {
  return {
    kind: 'external',
    path: path ?? '',
    scopePath: options?.scopePath ? canonicalPath(options.scopePath) : null,
    transitionId: null,
  };
}

function pendingMediaTarget(params: OpenMediaTargetParams): WorkColumnTarget {
  const resourceKind = params.resourceKind ?? resourceKindFromPath(params.filePath);
  if (resourceKind !== 'image' && resourceKind !== 'video') {
    throw new Error(`Unsupported media resource: ${params.filePath}`);
  }
  return {
    kind: 'media',
    filePath: params.filePath,
    notebookId: params.notebookId ?? null,
    notebookPath: params.notebookPath,
    resourceKind,
  };
}

function beginNavigation(
  pendingTarget: WorkColumnTarget,
  retry: RetryAction | null,
  preservePreviousTarget = false,
  showWorkColumnLoading = true,
): number {
  const previousRetryToken = useWorkColumnStore.getState().navigation.retryToken;
  if (previousRetryToken) retryActions.delete(previousRetryToken);

  const retryToken = retry ? `navigation-retry-${++retrySequence}` : null;
  const requestId = useWorkColumnStore.getState().beginNavigation(
    pendingTarget,
    retryToken,
    preservePreviousTarget,
    showWorkColumnLoading,
  );
  if (retryToken && retry) retryActions.set(retryToken, retry);
  return requestId;
}

function commitNavigation(
  requestId: number,
  target: WorkColumnTarget,
  history: 'push' | 'skip' = 'skip',
): boolean {
  const state = useWorkColumnStore.getState();
  const retryToken = state.navigation.requestId === requestId ? state.navigation.retryToken : null;
  const previousTarget = state.navigation.target;
  const committed = state.commitNavigation(requestId, target);
  if (committed) {
    if (retryToken) retryActions.delete(retryToken);
    if (history === 'push') {
      recordWorkspaceDocumentNavigation(
        historyEntryFromWorkColumnTarget(previousTarget),
        historyEntryFromWorkColumnTarget(target),
      );
    }
    const desiredTarget: PersistedWorkspaceTarget | null = target.kind === 'document-list'
      ? target
      : target.kind === 'table'
        ? { kind: 'table', filePath: canonicalPath(target.filePath), notebookPath: target.notebookPath ? canonicalPath(target.notebookPath) : null, notebookId: target.notebookId }
      : target.kind === 'media-library'
        ? { kind: 'external', path: canonicalPath(target.filePath), scopePath: target.notebookPath }
      : target.kind === 'external' && target.path
        ? { kind: 'external', path: canonicalPath(target.path), scopePath: target.scopePath }
        : target.kind === 'media'
          ? {
              kind: 'media',
              filePath: canonicalPath(target.filePath),
              notebookId: target.notebookId,
              notebookPath: target.notebookPath ? canonicalPath(target.notebookPath) : null,
              resourceKind: target.resourceKind,
            }
          : target.kind === 'agent-conversation'
            ? { kind: 'agent-conversation', instanceId: target.instanceId }
            : null;
    useWorkspaceRestoreStore.getState().setDesiredTarget(desiredTarget);
  }
  return committed;
}

/** Open a folder/filter list as a first-class work-column history destination. */
export function openDocumentListTarget(
  target: DocumentListTarget,
  options?: { history?: 'push' | 'skip' },
): void {
  const requestId = beginNavigation(target, null, false, false);
  commitNavigation(requestId, target, options?.history ?? 'push');
}

export function captureWorkspaceRestoreTarget(): PersistedWorkspaceTarget | null {
  return useWorkspaceRestoreStore.getState().desiredTarget;
}

export async function restoreExternalDocumentWorkspace(
  restored: Extract<PersistedWorkspaceTarget, { kind: 'external' }>,
): Promise<void> {
  await openExternalTarget(restored.path, {
    scopePath: restored.scopePath,
    history: 'skip',
    destination: 'main-third',
  });
}

export function restoreTableWorkspace(
  restored: Extract<PersistedWorkspaceTarget, { kind: 'table' }>,
): Promise<void> {
  return openTableTarget(restored.filePath, restored.notebookPath, restored.notebookId, { history: 'skip' });
}

export async function openTableTarget(
  filePath: string,
  notebookPath: string | null,
  notebookId: string | null,
  options?: { history?: 'push' | 'skip'; destination?: 'main-third' },
): Promise<void> {
  const normalizedPath = canonicalPath(filePath);
  const normalizedNotebookPath = notebookPath ? canonicalPath(notebookPath) : null;
  const workspaceMemo = getWorkspaceMemoState();
  const resolvedNotebookId = notebookId
    ?? workspaceMemo.notebooks.find((notebook) => normalizedNotebookPath && canonicalPath(notebook.path) === normalizedNotebookPath)?.id
    ?? (workspaceMemo.selectedNotebook?.path && normalizedNotebookPath
      && canonicalPath(workspaceMemo.selectedNotebook.path) === normalizedNotebookPath
      ? workspaceMemo.selectedNotebook.id
      : null);
  ensureFileDisplayIdentity(normalizedPath);
  const target: WorkColumnTarget = { kind: 'table', filePath: normalizedPath, notebookPath: normalizedNotebookPath, notebookId: resolvedNotebookId };
  const existing = options?.destination === 'main-third'
    ? null
    : activateExistingContentForNavigation({ kind: 'external', path: normalizedPath });
  if (existing instanceof Promise) {
    if (await existing) return;
  } else if (existing) return;
  const requestId = beginNavigation(target, null, false, false);
  commitNavigation(requestId, target, options?.history ?? 'push');
}

export async function openMediaLibraryTarget(
  filePath: string,
  notebookPath: string | null,
  notebookId: string | null,
  options?: { history?: 'push' | 'skip'; destination?: 'main-third' },
): Promise<void> {
  const normalizedPath = canonicalPath(filePath);
  const normalizedNotebookPath = notebookPath ? canonicalPath(notebookPath) : null;
  const workspaceMemo = getWorkspaceMemoState();
  const resolvedNotebookId = notebookId
    ?? workspaceMemo.notebooks.find((notebook) => normalizedNotebookPath && canonicalPath(notebook.path) === normalizedNotebookPath)?.id
    ?? (workspaceMemo.selectedNotebook?.path && normalizedNotebookPath
      && canonicalPath(workspaceMemo.selectedNotebook.path) === normalizedNotebookPath
      ? workspaceMemo.selectedNotebook.id
      : null);
  ensureFileDisplayIdentity(normalizedPath);
  const target: WorkColumnTarget = {
    kind: 'media-library',
    filePath: normalizedPath,
    notebookPath: normalizedNotebookPath,
    notebookId: resolvedNotebookId,
  };
  const existing = options?.destination === 'main-third'
    ? null
    : activateExistingContentForNavigation({ kind: 'external', path: normalizedPath });
  if (existing instanceof Promise) {
    if (await existing) return;
  } else if (existing) return;
  const requestId = beginNavigation(target, null, false, false);
  commitNavigation(requestId, target, options?.history ?? 'push');
}

export async function restoreMediaWorkspace(
  restored: Extract<PersistedWorkspaceTarget, { kind: 'media' }>,
): Promise<void> {
  await openMediaTarget({
    filePath: restored.filePath,
    notebookId: restored.notebookId,
    notebookPath: restored.notebookPath,
    resourceKind: restored.resourceKind,
    history: 'skip',
  });
}

export function restoreDocumentListWorkspace(
  restored: DocumentListTarget,
): void {
  openDocumentListTarget(restored, { history: 'skip' });
}

function isCurrentNavigation(requestId: number): boolean {
  return useWorkColumnStore.getState().isCurrentNavigation(requestId);
}

/** A notebook switch changes list context, not the workColumn target. */
function targetToPreserveOnNotebookSwitch(
  target: WorkColumnTarget,
  document: DocumentSnapshot,
): WorkColumnTarget {
  if (target.kind !== 'empty') return target;
  if (document.activeExternalSession) {
    return {
      kind: 'external',
      path: document.activeExternalSession.fileIdentity.path,
      scopePath: document.activeExternalSession.scopePath,
      transitionId: null,
    };
  }
  if (document.activeAgentConversationId) {
    return {
      kind: 'agent-conversation',
      instanceId: document.activeAgentConversationId,
    };
  }
  return EMPTY_WORK_COLUMN_TARGET;
}

async function runNavigation(
  pendingTarget: WorkColumnTarget,
  operation: (requestId: number) => Promise<void>,
  retry: RetryAction,
  rollback?: (requestId: number) => Promise<void>,
  preservePreviousTarget = false,
  showWorkColumnLoading = true,
): Promise<void> {
  const requestId = beginNavigation(
    pendingTarget,
    retry,
    preservePreviousTarget,
    showWorkColumnLoading,
  );
  try {
    await operation(requestId);
  } catch (error) {
    const workspace = useWorkColumnStore.getState();
    if (workspace.isCurrentNavigation(requestId)) {
      // Enter failed before compensation. Selection listeners must not turn a
      // failed navigation into a second, competing clear request.
      workspace.failNavigation(requestId, error);
      try {
        await rollback?.(requestId);
      } catch {
        // The original navigation error is the actionable failure. The
        // best-effort compensation is intentionally not allowed to hide it.
      }
    }
    throw error;
  }
}

function captureDocumentSnapshot(): DocumentSnapshot {
  const { activeExternalSession, activeAgentConversationId } = getWorkspaceDocumentState();
  return { activeExternalSession, activeAgentConversationId };
}

export function historyEntryFromWorkColumnTarget(
  target: WorkColumnTarget,
): DocumentHistoryEntry | null {
  switch (target.kind) {
    case 'document-list':
      return {
        kind: 'document-list',
        displayId: target.displayId,
        scope: target.scope,
        filters: target.filters,
        openedAt: Date.now(),
      };
    case 'external': {
      if (!target.path) return null;
      return {
        kind: 'external',
        path: target.path,
        scopePath: target.scopePath,
        openedAt: Date.now(),
      };
    }
    case 'table':
      return target.filePath ? {
        kind: 'external',
        path: target.filePath,
        scopePath: target.notebookPath,
        openedAt: Date.now(),
      } : null;
    case 'media-library':
      return target.filePath ? {
        kind: 'external',
        path: target.filePath,
        scopePath: target.notebookPath,
        openedAt: Date.now(),
      } : null;
    case 'media': {
      if (!target.filePath) return null;
      return {
        kind: 'media',
        filePath: target.filePath,
        notebookId: target.notebookId,
        notebookPath: target.notebookPath,
        resourceKind: target.resourceKind,
        openedAt: Date.now(),
      };
    }
    case 'agent-conversation':
      return {
        kind: 'agent-conversation',
        instanceId: target.instanceId,
        openedAt: Date.now(),
      };
    case 'web':
      if (!canonicalUrl(target.url)) return null;
      return {
        kind: 'web',
        url: target.url,
        openedAt: Date.now(),
      };
    default:
      return null;
  }
}

async function restoreDocumentSnapshot(snapshot: DocumentSnapshot): Promise<void> {
  if (snapshot.activeExternalSession) {
    await getWorkspaceDocumentState().openExternalDocument(
      snapshot.activeExternalSession.fileIdentity.path,
      {
        scopePath: snapshot.activeExternalSession.scopePath,
        notebookId: snapshot.activeExternalSession.notebookId,
        notebookPath: snapshot.activeExternalSession.notebookPath,
        relativePath: snapshot.activeExternalSession.relativePath,
        indexable: snapshot.activeExternalSession.indexable,
        initialFocus: snapshot.activeExternalSession.initialFocus,
      },
    );
    return;
  }
  if (snapshot.activeAgentConversationId) {
    await getWorkspaceDocumentState().openAgentConversation(snapshot.activeAgentConversationId);
    return;
  }
  await getWorkspaceDocumentState().clearDocument();
}

export async function retryLastNavigation(): Promise<void> {
  const navigation = useWorkColumnStore.getState().navigation;
  const token = navigation.phase === 'failed' ? navigation.retryToken : null;
  const retry = token ? retryActions.get(token) : undefined;
  if (!retry) throw new Error('No retryable navigation is available');
  await retry();
}

export function dismissNavigationFailure(): void {
  const token = useWorkColumnStore.getState().dismissNavigationFailure();
  if (token) retryActions.delete(token);
}

/** Switch the main workspace notebook as one navigation transaction. */
export async function selectNotebook(notebook: Notebook): Promise<void> {
  const previousNotebook = getWorkspaceMemoState().selectedNotebook;
  const previousDocument = captureDocumentSnapshot();
  const previousWorkColumnTarget = targetToPreserveOnNotebookSwitch(
    useWorkColumnStore.getState().navigation.target,
    previousDocument,
  );
  const clearPreviousTarget = previousWorkColumnTarget.kind === 'media'
    && previousWorkColumnTarget.notebookId !== notebook.id;
  const nextWorkColumnTarget = clearPreviousTarget
    ? EMPTY_WORK_COLUMN_TARGET
    : previousWorkColumnTarget;
  let switchedNotebook = false;
  useWorkColumnStore.getState().beginNotebookSwitch?.();

  try {
    await runNavigation(
      nextWorkColumnTarget,
      async (requestId) => {
        // Flush first. Changing the backend notebook before this point could
        // make a pending save observe the wrong notebook context. Keep the
        // document session alive so the workColumn remains visible while the
        // notebook and middle-column list change.
        await flushWorkspaceDocument();
        if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;

        await setCurrentWorkspaceNotebook(notebook);
        switchedNotebook = true;
        if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;

        getWorkspaceMemoState().setSelectedNotebook(notebook);
        await getWorkspaceMemoState().loadNotes({ notebookId: notebook.id });
        if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
        if (clearPreviousTarget) {
          await getWorkspaceDocumentState().clearDocument();
          if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
        }
        commitNavigation(requestId, nextWorkColumnTarget);
      },
      () => selectNotebook(notebook),
      async (requestId) => {
        if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
        if (switchedNotebook && previousNotebook?.id) {
          await setCurrentWorkspaceNotebook(previousNotebook);
        }
        if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
        getWorkspaceMemoState().setSelectedNotebook(previousNotebook);
        await restoreDocumentSnapshot(previousDocument);
      },
      true,
      clearPreviousTarget,
    );
  } finally {
    useWorkColumnStore.getState().endNotebookSwitch?.();
  }
}

function publishExternalTargetIfCurrent(
  requestId: number,
  path: string | null,
  scopePath: string | null,
  fileBrowser?: import('../store/file-browser-target').FileBrowserContext,
  history: 'push' | 'skip' = 'push',
): boolean {
  const document = getWorkspaceDocumentState();
  const session = document.activeExternalSession;
  if (
    !session
    || path === null
    || canonicalPath(session.fileIdentity.path) !== canonicalPath(path)
    || (scopePath !== null && session.scopePath !== canonicalPath(scopePath))
  ) return false;

  return commitNavigation(requestId, {
    kind: 'external',
    path: session.fileIdentity.path,
    ...(fileBrowser ? { fileBrowser } : {}),
    scopePath: session.scopePath,
    transitionId: session.transitionId,
  }, history);
}

export async function openExternalTarget(
  path: string | null,
  options?: OpenExternalTargetOptions,
): Promise<WorkspaceContentLocation | null> {
  if (path && /\.lib\.ya?ml$/i.test(path)) {
    const capturedFileBrowser = options?.fileBrowser ?? captureFileBrowserContext(path, options?.scopePath);
    const scopePath = options?.scopePath ?? capturedFileBrowser.scopePath;
    const notebookId = options?.notebookId
      ?? options?.fileBrowser?.notebookId
      ?? getWorkspaceMemoState().notebooks.find((notebook) => scopePath && canonicalPath(notebook.path) === canonicalPath(scopePath))?.id
      ?? capturedFileBrowser.notebookId
      ?? null;
    await openMediaLibraryTarget(path, scopePath, notebookId, { history: options?.history, destination: options?.destination });
    return null;
  }
  if (path && /\.table\.ya?ml$/i.test(path)) {
    const capturedFileBrowser = options?.fileBrowser ?? captureFileBrowserContext(path, options?.scopePath);
    const scopePath = options?.scopePath ?? capturedFileBrowser.scopePath;
    const notebookId = options?.notebookId
      ?? options?.fileBrowser?.notebookId
      ?? getWorkspaceMemoState().notebooks.find((notebook) => scopePath && canonicalPath(notebook.path) === canonicalPath(scopePath))?.id
      ?? capturedFileBrowser.notebookId
      ?? null;
    await openTableTarget(path, scopePath, notebookId, { history: options?.history, destination: options?.destination });
    return null;
  }
  const markdownLocation = path && /\.(md|markdown)$/i.test(path)
    ? options?.markdownLocation ?? await notesClient.resolveLocation(path)
    : null;
  const capturedFileBrowser = options?.fileBrowser ?? captureFileBrowserContext(path, options?.scopePath);
  const fileBrowser = markdownLocation?.notebookId
    ? { ...capturedFileBrowser, notebookId: markdownLocation.notebookId }
    : capturedFileBrowser;
  options = {
    ...options,
    fileBrowser,
    markdownLocation,
    scopePath: options?.scopePath ?? markdownLocation?.notebookPath ?? fileBrowser.scopePath,
  };
  const existing = path && options?.destination !== 'main-third'
    ? activateExistingContentForNavigation({ kind: 'external', path })
    : null;
  if (existing instanceof Promise) {
    const activated = await existing;
    if (activated) return activated;
  } else if (existing) {
    return existing;
  }

  const previousNotebook = getWorkspaceMemoState().selectedNotebook;
  const previousPathNote = getWorkspaceMemoState().selectedNote;
  let switchedNotebook = false;
  const previousDocument = captureDocumentSnapshot();
  await runNavigation(
    pendingExternalTarget(path, options),
    async (requestId) => {
      if (markdownLocation?.notebookId && markdownLocation.notebookId !== (
        getWorkspaceMemoState().selectedNotebookId ?? getWorkspaceMemoState().selectedNotebook?.id
      )) {
        await setCurrentWorkspaceNotebook(markdownLocation.notebookId);
        switchedNotebook = true;
        if (!isCurrentNavigation(requestId)) return;
        let notebook = getWorkspaceMemoState().notebooks.find((item) => item.id === markdownLocation.notebookId);
        if (!notebook) {
          await getWorkspaceMemoState().loadNotebooks();
          if (!isCurrentNavigation(requestId)) return;
          notebook = getWorkspaceMemoState().notebooks.find((item) => item.id === markdownLocation.notebookId);
        }
        if (notebook) {
          getWorkspaceMemoState().setSelectedNotebook(notebook);
          await getWorkspaceMemoState().loadNotes({ notebookId: notebook.id });
          if (!isCurrentNavigation(requestId)) return;
        }
      }
      getWorkspaceMemoState().setSelectedNote(markdownLocation?.indexable && markdownLocation.relativePath && markdownLocation.notebookId
        ? { notebookId: markdownLocation.notebookId, relativePath: markdownLocation.relativePath }
        : null);
      if (!isCurrentNavigation(requestId)) return;
      await getWorkspaceDocumentState().openExternalDocument(
        path,
        {
          scopePath: options?.scopePath,
          notebookId: markdownLocation?.notebookId,
          notebookPath: markdownLocation?.notebookPath,
          relativePath: markdownLocation?.relativePath,
          indexable: markdownLocation?.indexable,
          initialFocus: options?.initialFocus,
        },
      );
      if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
      const scopePath = options?.scopePath ? canonicalPath(options.scopePath) : null;
      if (path === null && !getWorkspaceDocumentState().activeExternalSession) {
        commitNavigation(requestId, EMPTY_WORK_COLUMN_TARGET);
      } else if (!publishExternalTargetIfCurrent(
        requestId,
        path,
        scopePath,
        fileBrowser,
        options?.history ?? 'push',
      )) {
        throw new Error(`External document session was not committed: ${path}`);
      }
    },
    async () => {
      await openExternalTarget(path, options);
    },
    async (requestId) => {
      if (!isCurrentNavigation(requestId)) return;
      await restoreDocumentSnapshot(previousDocument);
      if (!isCurrentNavigation(requestId)) return;
      getWorkspaceMemoState().setSelectedNote(previousPathNote);
      if (switchedNotebook) {
        await setCurrentWorkspaceNotebook(previousNotebook?.id ?? null);
        getWorkspaceMemoState().setSelectedNotebook(previousNotebook);
      }
    },
  );
  return null;
}

/** Open an image/video as a resource surface, without creating a document session. */
export async function openMediaTarget(
  params: OpenMediaTargetParams,
): Promise<WorkspaceContentLocation | null> {
  const filePath = params.filePath.trim();
  if (!filePath || !params.notebookPath?.trim()) return null;
  const target = pendingMediaTarget({ ...params, filePath });
  const existing = params.destination === 'main-third'
    ? null
    : activateExistingContentForNavigation({ kind: 'media', path: filePath });
  if (existing instanceof Promise) {
    const activated = await existing;
    if (activated) return activated;
  } else if (existing) {
    return existing;
  }

  const previousDocument = captureDocumentSnapshot();
  await runNavigation(
    target,
    async (requestId) => {
      await flushWorkspaceDocument();
      if (!isCurrentNavigation(requestId)) return;
      await getWorkspaceDocumentState().clearDocument();
      if (!isCurrentNavigation(requestId)) return;
      if (!commitNavigation(requestId, target, params.history ?? 'push')) return;
      useWorkspaceFocusStore.getState().focusHost('main-third');
    },
    async () => { await openMediaTarget(params); },
    async (requestId) => {
      if (!isCurrentNavigation(requestId)) return;
      await restoreDocumentSnapshot(previousDocument);
      if (!isCurrentNavigation(requestId)) return;
    },
  );
  return null;
}

/** Open a web target in the left work column. */
export async function openWebTarget(
  url: string,
  options?: { history?: 'push' | 'skip'; destination?: 'main-third' },
): Promise<WorkspaceContentLocation | null> {
  const normalized = canonicalUrl(url);
  if (!normalized) throw new Error(`Unsupported webpage URL: ${url}`);

  const existing = options?.destination === 'main-third'
    ? null
    : activateExistingContentForNavigation({ kind: 'web', url: normalized });
  if (existing instanceof Promise) {
    const activated = await existing;
    if (activated) return activated;
  } else if (existing) {
    return existing;
  }

  const target: WorkColumnTarget = { kind: 'web', url: normalized };
  await runNavigation(
    target,
    async (requestId) => {
      await flushWorkspaceDocument();
      if (!isCurrentNavigation(requestId)) return;
      commitNavigation(requestId, target, options?.history ?? 'push');
      useWorkspaceFocusStore.getState().focusHost('main-third');
    },
    async () => { await openWebTarget(normalized, options); },
  );
  return null;
}

/** Flush the active editable document without clearing its session or target. */
export async function flushWorkspaceDocument(): Promise<void> {
  const document = getWorkspaceDocumentState();
  let flushed = true;

  if (document.activeExternalSession) {
    flushed = await flushWorkspaceDocumentPath(
      documentIdentityFromFile(document.activeExternalSession.fileIdentity),
      document.activeExternalSession.fileIdentity.path,
      document.activeExternalSession.scopePath,
    );
  }

  if (!flushed) {
    throw new Error('Document flush did not complete');
  }
}

export async function openAgentTarget(
  instanceId: string,
  options?: { history?: 'push' | 'skip'; destination?: 'main-third' },
): Promise<WorkspaceHostId | WorkspaceContentLocation> {
  const normalized = instanceId.trim();
  if (!normalized) return 'main-third';
  const existing = options?.destination === 'main-third'
    ? null
    : activateExistingContentForNavigation({
        kind: 'agent-conversation',
        instanceId: normalized,
      });
  if (existing instanceof Promise) {
    const activated = await existing;
    if (activated) return activated;
  } else if (existing) {
    return existing;
  }
  await runNavigation(
    { kind: 'agent-conversation', instanceId: normalized },
    async (requestId) => {
      await getWorkspaceDocumentState().openAgentConversation(
        normalized,
      );
      if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
      if (getWorkspaceDocumentState().activeAgentConversationId !== normalized) {
        throw new Error(`Agent session was not committed: ${normalized}`);
      }
      getWorkspaceMemoState().setActivePluginId(null);
      if (!isCurrentNavigation(requestId)) return;
      commitNavigation(
        requestId,
        { kind: 'agent-conversation', instanceId: normalized },
        options?.history ?? 'push',
      );
    },
    async () => {
      await openAgentTarget(normalized, options);
    },
  );
  return 'main-third';
}

export async function clearWorkspaceDocument(): Promise<void> {
  await runNavigation(
    EMPTY_WORK_COLUMN_TARGET,
    async (requestId) => {
      await getWorkspaceDocumentState().clearDocument();
      if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
      const document = getWorkspaceDocumentState();
      if (document.activeExternalSession || document.activeAgentConversationId) {
        throw new Error('Document session was not cleared');
      }
      commitNavigation(requestId, EMPTY_WORK_COLUMN_TARGET);
    },
    () => clearWorkspaceDocument(),
  );
}

/** Update every live reference to an external file after an in-place rename. */
export function replaceExternalDocumentPath(
  displayId: string,
  previousPath: string,
  path: string,
): void {
  const previous = canonicalPath(previousPath);
  const next = canonicalPath(path);
  const selectedNote = getWorkspaceMemoState().selectedNote;
  const activeExternal = getWorkspaceDocumentState().activeExternalSession;

  const resumeDisplayIdReconciliation = suspendFileDisplayReconciliation();
  try {
    replaceWorkspaceDocumentPath({
      kind: 'md',
      path: previous,
      displayId,
    }, next);
    if (activeExternal?.indexable && selectedNote
      && selectedNote.notebookId === activeExternal.notebookId
      && selectedNote.relativePath === activeExternal.relativePath) {
      const updatedRelativePath = getWorkspaceDocumentState().activeExternalSession?.relativePath;
      if (updatedRelativePath) {
        getWorkspaceMemoState().setSelectedNote({
          notebookId: selectedNote.notebookId,
          relativePath: updatedRelativePath,
        });
      }
    }
    useWorkColumnStore.getState().replaceExternalPath(previous, next);
    useBrowserColumnStore.getState().replaceExternalPath(previous, next);
    const restored = useWorkspaceRestoreStore.getState().desiredTarget;
    if (restored?.kind === 'external' && canonicalPath(restored.path) === previous) {
      useWorkspaceRestoreStore.getState().setDesiredTarget({
        ...restored,
        path: next,
      });
    }
  } finally {
    resumeDisplayIdReconciliation();
  }
}

export function closeAgentTarget(): void {
  const workspace = useWorkColumnStore.getState();
  const wasActive = !!getWorkspaceDocumentState().activeAgentConversationId
    || workspace.navigation.target.kind === 'agent-conversation';
  const requestId = wasActive ? beginNavigation(EMPTY_WORK_COLUMN_TARGET, null) : null;
  getWorkspaceDocumentState().closeAgentConversation();
  if (requestId !== null && !getWorkspaceDocumentState().activeAgentConversationId) {
    commitNavigation(requestId, EMPTY_WORK_COLUMN_TARGET);
  }
}

/**
 * Leave the plugin workbench target without touching the active document.
 * Artifact-tool plugins use this path because they are second-column filters
 * and must preserve whatever the third column is currently showing.
 */
export function clearPluginWorkbenchTarget(): boolean {
  const workspace = useWorkColumnStore.getState();
  if (workspace.navigation.target.kind !== 'plugin-workbench') return false;
  const requestId = beginNavigation(EMPTY_WORK_COLUMN_TARGET, null);
  commitNavigation(requestId, EMPTY_WORK_COLUMN_TARGET);
  return true;
}

/** Open a document-independent plugin workbench after the current document is flushed. */
export async function openPluginWorkbench(plugin: PluginDescriptor): Promise<void> {
  await runNavigation(
    { kind: 'plugin-workbench', plugin },
    async (requestId) => {
      await getWorkspaceDocumentState().clearDocument();
      if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
      getWorkspaceMemoState().setActiveFilter('all');
      getWorkspaceMemoState().setActivePluginId(plugin.manifest.id);
      if (!isCurrentNavigation(requestId)) return;
      commitNavigation(requestId, { kind: 'plugin-workbench', plugin });
    },
    () => openPluginWorkbench(plugin),
  );
}

/** Close the plugin workbench and clear the document it owns, if any. */
export async function closePluginWorkbench(): Promise<boolean> {
  const workspace = useWorkColumnStore.getState();
  const previousTarget = workspace.navigation.target;
  if (previousTarget.kind !== 'plugin-workbench') return false;
  await runNavigation(
    EMPTY_WORK_COLUMN_TARGET,
    async (requestId) => {
      await getWorkspaceDocumentState().clearDocument();
      if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
      getWorkspaceMemoState().setActivePluginId(null);
      if (!isCurrentNavigation(requestId)) return;
      commitNavigation(requestId, EMPTY_WORK_COLUMN_TARGET);
    },
    () => closePluginWorkbench().then(() => undefined),
  );
  return true;
}

/** Reconcile local selection after an already-confirmed notebook deletion. */
export async function reconcileDeletedNotebook(
  deletedNotebookId: string,
  notebooks: Notebook[],
): Promise<void> {
  const wasSelected = (getWorkspaceMemoState().selectedNotebookId
    ?? getWorkspaceMemoState().selectedNotebook?.id
    ?? null) === deletedNotebookId;

  if (!wasSelected) {
    getWorkspaceMemoState().setNotebooks(notebooks);
    return;
  }

  const nextNotebook = notebooks[0] ?? null;
  const reconcile = () => runNavigation(
    EMPTY_WORK_COLUMN_TARGET,
    async (requestId) => {
      // Apply the replacement list and fallback selection atomically. This
      // prevents the main-window notebook sync effect from observing a brief
      // null selection between removing the active notebook and selecting the
      // first remaining notebook.
      getWorkspaceMemoState().setNotebooks(notebooks, nextNotebook?.id ?? null);
      await getWorkspaceDocumentState().clearDocument();
      if (!isCurrentNavigation(requestId)) return;

      await setCurrentWorkspaceNotebook(nextNotebook);
      if (!isCurrentNavigation(requestId)) return;

      getWorkspaceMemoState().setSelectedNotebook(nextNotebook);
      if (nextNotebook) {
        await getWorkspaceMemoState().loadNotes({ notebookId: nextNotebook.id });
        if (!isCurrentNavigation(requestId)) return;
      } else {
      }
      commitNavigation(requestId, EMPTY_WORK_COLUMN_TARGET);
    },
    reconcile,
  );

  await reconcile();
}
