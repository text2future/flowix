import { captureFileBrowserContext } from './file-browser-context';
import type { PluginDescriptor } from '@platform/tauri/client';
import { canonicalPath } from '@/lib/path';
import { canonicalUrl } from '@features/workspace/store/workspace-content-identity';
import {
  flushWorkspaceDocumentPath,
  getWorkspaceDocumentState,
  pushWorkspaceDocumentHistory,
  type ArtifactHistoryEntry,
  type DocumentHistoryEntry,
} from '@features/document/public/workspace-api';
import {
  getWorkspaceMemoState,
  setCurrentWorkspaceNotebook,
  type Notebook,
} from '@features/memo/public/workspace-api';
import type { MemoItem } from '@/types/memo-item';
import {
  getPluginNoteInfo,
  type PluginArtifactRendererId,
} from '@features/plugin/public/workspace-api';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { EMPTY_WORK_COLUMN_TARGET } from '@features/workspace/store/work-column-target';
import type { WorkColumnTarget } from '@features/workspace/store/work-column-target';
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

export interface OpenMemoTargetParams {
  memoId: string;
  path: string | null;
  notebookId?: string | null;
  notebookPath?: string | null;
  history?: 'push' | 'skip';
  initialContent?: string;
  initialFocus?: 'title' | 'body';
  /** When supplied, selection is part of this navigation transaction. */
  memo?: MemoItem | null;
  /** Optional authoritative Notebook entity used during a cross-notebook open. */
  notebook?: Notebook | null;
}

export interface OpenExternalTargetOptions {
  fileBrowser?: import('../store/file-browser-target').FileBrowserContext;
  /** Explicit cross-column moves must not reactivate a BrowserColumn tab. */
  destination?: 'main-third';
  history?: 'push' | 'skip';
  scopePath?: string | null;
}

export interface OpenArtifactTargetParams {
  pointerMemoId: string;
  notebookId?: string | null;
  notebookPath?: string | null;
  pluginId?: string | null;
  renderer?: PluginArtifactRendererId | null;
  history?: 'push' | 'skip';
  /** Optional pointer memo metadata used to avoid re-reading the list item. */
  memo?: MemoItem | null;
  notebook?: Notebook | null;
}

type RetryAction = () => Promise<void>;

interface DocumentSnapshot {
  activeMemoSession: {
    memoId: string;
    path: string;
    notebookId: string | null;
    notebookPath: string | null;
    transitionId: number;
  } | null;
  activeExternalSession: {
    path: string;
    scopePath: string | null;
  } | null;
  activeAgentConversationId: string | null;
}

const retryActions = new Map<string, RetryAction>();
let retrySequence = 0;

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

function pendingMemoTarget(params: OpenMemoTargetParams): WorkColumnTarget {
  return {
    kind: 'memo',
    memoId: params.memoId,
    path: params.path ?? '',
    notebookId: params.notebookId ?? params.notebook?.id ?? null,
    notebookPath: params.notebookPath ?? params.notebook?.path ?? null,
    transitionId: null,
  };
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

function pendingArtifactTarget(params: OpenArtifactTargetParams): WorkColumnTarget {
  const noteInfo = getPluginNoteInfo(params.memo);
  const notebook = params.notebook;
  return {
    kind: 'artifact',
    pointerMemoId: params.pointerMemoId.trim(),
    notebookId: params.notebookId ?? notebook?.id ?? null,
    notebookPath: params.notebookPath ?? notebook?.path ?? null,
    pluginId: params.pluginId ?? noteInfo?.pluginId ?? null,
    renderer: params.renderer ?? noteInfo?.renderer ?? null,
  };
}

function beginNavigation(
  pendingTarget: WorkColumnTarget,
  retry: RetryAction | null,
  preservePreviousTarget = false,
): number {
  const previousRetryToken = useWorkColumnStore.getState().navigation.retryToken;
  if (previousRetryToken) retryActions.delete(previousRetryToken);

  const retryToken = retry ? `navigation-retry-${++retrySequence}` : null;
  const requestId = useWorkColumnStore.getState().beginNavigation(
    pendingTarget,
    retryToken,
    preservePreviousTarget,
  );
  if (retryToken && retry) retryActions.set(retryToken, retry);
  return requestId;
}

function commitNavigation(requestId: number, target: WorkColumnTarget): boolean {
  const state = useWorkColumnStore.getState();
  const retryToken = state.navigation.requestId === requestId ? state.navigation.retryToken : null;
  const committed = state.commitNavigation(requestId, target);
  if (committed && retryToken) retryActions.delete(retryToken);
  return committed;
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
  if (document.activeMemoSession) {
    return {
      kind: 'memo',
      memoId: document.activeMemoSession.memoId,
      path: document.activeMemoSession.path,
      notebookId: document.activeMemoSession.notebookId,
      notebookPath: document.activeMemoSession.notebookPath,
      transitionId: document.activeMemoSession.transitionId,
    };
  }
  if (document.activeExternalSession) {
    return {
      kind: 'external',
      path: document.activeExternalSession.path,
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
): Promise<void> {
  const requestId = beginNavigation(pendingTarget, retry, preservePreviousTarget);
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
  const document = getWorkspaceDocumentState();
  return {
    activeMemoSession: document.activeMemoSession
      ? {
          memoId: document.activeMemoSession.memoId,
          path: document.activeMemoSession.path,
          notebookId: document.activeMemoSession.notebookId,
          notebookPath: document.activeMemoSession.notebookPath,
          transitionId: document.activeMemoSession.transitionId,
        }
      : null,
    activeExternalSession: document.activeExternalSession
      ? {
          path: document.activeExternalSession.path,
          scopePath: document.activeExternalSession.scopePath,
        }
      : null,
    activeAgentConversationId: document.activeAgentConversationId,
  };
}

function historyEntryFromWorkColumnTarget(
  target: WorkColumnTarget,
): DocumentHistoryEntry | null {
  switch (target.kind) {
    case 'memo':
      return {
        kind: 'memo',
        memoId: target.memoId,
        notebookId: target.notebookId,
        notebookPath: target.notebookPath,
        path: target.path,
        openedAt: Date.now(),
      };
    case 'external':
      return {
        kind: 'external',
        path: target.path,
        scopePath: target.scopePath,
        openedAt: Date.now(),
      };
    case 'agent-conversation':
      return {
        kind: 'agent-conversation',
        instanceId: target.instanceId,
        openedAt: Date.now(),
      };
    case 'artifact':
      return {
        kind: 'artifact',
        pointerMemoId: target.pointerMemoId,
        notebookId: target.notebookId,
        notebookPath: target.notebookPath,
        pluginId: target.pluginId,
        renderer: target.renderer,
        openedAt: Date.now(),
      };
    default:
      return null;
  }
}

function artifactHistoryEntryFromTarget(
  target: Extract<WorkColumnTarget, { kind: 'artifact' }>,
): ArtifactHistoryEntry {
  return {
    kind: 'artifact',
    pointerMemoId: target.pointerMemoId,
    notebookId: target.notebookId,
    notebookPath: target.notebookPath,
    pluginId: target.pluginId,
    renderer: target.renderer,
    openedAt: Date.now(),
  };
}

function selectArtifactMemo(params: OpenArtifactTargetParams): void {
  const state = getWorkspaceMemoState();
  const memo = params.memo
    ?? state.memos?.find((item) => item.id === params.pointerMemoId)
    ?? null;
  if (!memo) return;
  if (!state.memos?.some((item) => item.id === memo.id)) state.upsertMemo?.(memo);
  state.setSelectedMemo(memo);
}

async function restoreDocumentSnapshot(snapshot: DocumentSnapshot): Promise<void> {
  if (snapshot.activeMemoSession) {
    await getWorkspaceDocumentState().openMemoDocument({
      memoId: snapshot.activeMemoSession.memoId,
      path: snapshot.activeMemoSession.path,
      notebookId: snapshot.activeMemoSession.notebookId,
      notebookPath: snapshot.activeMemoSession.notebookPath,
      history: 'skip',
    });
    return;
  }
  if (snapshot.activeExternalSession) {
    await getWorkspaceDocumentState().openExternalDocument(
      snapshot.activeExternalSession.path,
      { history: 'skip', scopePath: snapshot.activeExternalSession.scopePath },
    );
    return;
  }
  if (snapshot.activeAgentConversationId) {
    await getWorkspaceDocumentState().openAgentConversation(
      snapshot.activeAgentConversationId,
      { history: 'skip' },
    );
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
  const previousMemo = getWorkspaceMemoState().selectedMemo;
  const previousNotebook = getWorkspaceMemoState().selectedNotebook;
  const previousDocument = captureDocumentSnapshot();
  const previousWorkColumnTarget = targetToPreserveOnNotebookSwitch(
    useWorkColumnStore.getState().navigation.target,
    previousDocument,
  );
  let switchedNotebook = false;

  await runNavigation(
    previousWorkColumnTarget,
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
      await getWorkspaceMemoState().loadMemos({ notebookId: notebook.id });
      if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
      commitNavigation(requestId, previousWorkColumnTarget);
    },
    () => selectNotebook(notebook),
    async (requestId) => {
      if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
      if (switchedNotebook && previousNotebook?.id) {
        await setCurrentWorkspaceNotebook(previousNotebook);
      }
      if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
      getWorkspaceMemoState().setSelectedNotebook(previousNotebook);
      getWorkspaceMemoState().setSelectedMemo(previousMemo);
      await restoreDocumentSnapshot(previousDocument);
    },
    true,
  );
}

function publishMemoTargetIfCurrent(
  requestId: number,
  memoId: string,
  path: string | null,
): boolean {
  const document = getWorkspaceDocumentState();
  const session = document.activeMemoSession;
  if (
    !session
    || session.memoId !== memoId
    || (path !== null && canonicalPath(session.path) !== canonicalPath(path))
  ) return false;

  return commitNavigation(requestId, {
    kind: 'memo',
    memoId: session.memoId,
    path: session.path,
    notebookId: session.notebookId,
    notebookPath: session.notebookPath,
    transitionId: session.transitionId,
  });
}

function publishExternalTargetIfCurrent(
  requestId: number,
  path: string | null,
  scopePath: string | null,
  fileBrowser?: import('../store/file-browser-target').FileBrowserContext,
): boolean {
  const document = getWorkspaceDocumentState();
  const session = document.activeExternalSession;
  if (
    !session
    || path === null
    || canonicalPath(session.path) !== canonicalPath(path)
    || (scopePath !== null && session.scopePath !== canonicalPath(scopePath))
  ) return false;

  return commitNavigation(requestId, {
    kind: 'external',
    path: session.path,
    ...(fileBrowser ? { fileBrowser } : {}),
    scopePath: session.scopePath,
    transitionId: session.transitionId,
  });
}

export async function openMemoTarget(
  params: OpenMemoTargetParams,
): Promise<WorkspaceContentLocation | null> {
  const previousMemo = getWorkspaceMemoState().selectedMemo;
  const previousNotebook = getWorkspaceMemoState().selectedNotebook;
  const previousDocument = captureDocumentSnapshot();
  const previousTarget = useWorkColumnStore.getState().navigation.target;
  const previousArtifactHistory = previousTarget.kind === 'artifact'
    ? artifactHistoryEntryFromTarget(previousTarget)
    : null;
  const notebookId = params.notebookId ?? params.notebook?.id ?? null;
  const memo = params.memo ?? null;
  let switchedNotebook = false;

  await runNavigation(
    pendingMemoTarget(params),
    async (requestId) => {
      let targetNotebook = params.notebook
        ?? getWorkspaceMemoState().notebooks.find((item) => item.id === notebookId)
        ?? null;
      const currentNotebookId = getWorkspaceMemoState().selectedNotebookId
        ?? getWorkspaceMemoState().selectedNotebook?.id
        ?? null;

      if (notebookId && currentNotebookId !== notebookId) {
        await setCurrentWorkspaceNotebook(notebookId);
        switchedNotebook = true;
        if (!isCurrentNavigation(requestId)) return;

        if (!targetNotebook) {
          await getWorkspaceMemoState().loadNotebooks();
          if (!isCurrentNavigation(requestId)) return;
          targetNotebook = getWorkspaceMemoState().notebooks.find(
            (item) => item.id === notebookId,
          ) ?? null;
        }
        if (memo && !targetNotebook) {
          throw new Error(`Notebook is unavailable: ${notebookId}`);
        }
        if (targetNotebook) {
          getWorkspaceMemoState().setSelectedNotebook(targetNotebook);
          if (!isCurrentNavigation(requestId)) return;
        }
        await getWorkspaceMemoState().loadMemos({ notebookId });
        if (!isCurrentNavigation(requestId)) return;
      }

      if (!isCurrentNavigation(requestId)) return;
      if (memo) {
        const latest = getWorkspaceMemoState();
        latest.upsertMemo(memo);
        latest.setSelectedMemo(memo);
        if (!isCurrentNavigation(requestId)) return;
      }

      const {
        memo: _memo,
        notebook: _notebook,
        history: _history,
        ...documentParams
      } = params;
      if (!isCurrentNavigation(requestId)) return;
      await getWorkspaceDocumentState().openMemoDocument({
        ...documentParams,
        history: previousArtifactHistory ? 'skip' : params.history,
        notebookPath: params.notebookPath ?? targetNotebook?.path ?? null,
      });

      // A newer intent may have started while the document transition was
      // queued. Its session and target must remain authoritative.
      if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
      if (!publishMemoTargetIfCurrent(requestId, params.memoId, params.path)) {
        throw new Error(`Memo session was not committed: ${params.memoId}`);
      }
      useWorkspaceFocusStore.getState().focusHost('main-third');
      if (previousArtifactHistory && params.history !== 'skip') {
        pushWorkspaceDocumentHistory(previousArtifactHistory);
      }
    },
    async () => {
      await openMemoTarget(params);
    },
    async (requestId) => {
      if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
      await restoreDocumentSnapshot(previousDocument);
      if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
      if (memo && getWorkspaceMemoState().selectedMemo?.id === memo.id) {
        getWorkspaceMemoState().setSelectedMemo(previousMemo);
      }
      if (switchedNotebook) {
        const previousNotebookId = previousNotebook?.id ?? null;
        if (previousNotebookId) await setCurrentWorkspaceNotebook(previousNotebookId);
        getWorkspaceMemoState().setSelectedNotebook(previousNotebook);
      }
    },
  );
  return null;
}

export async function openExternalTarget(
  path: string | null,
  options?: OpenExternalTargetOptions,
): Promise<WorkspaceContentLocation | null> {
  const fileBrowser = options?.fileBrowser ?? captureFileBrowserContext(path, options?.scopePath);
  options = { ...options, fileBrowser, scopePath: options?.scopePath ?? fileBrowser.scopePath };
  const existing = path && options?.destination !== 'main-third'
    ? activateExistingContentForNavigation({ kind: 'external', path })
    : null;
  if (existing instanceof Promise) {
    const activated = await existing;
    if (activated) return activated;
  } else if (existing) {
    return existing;
  }

  const previousMemo = getWorkspaceMemoState().selectedMemo;
  const previousDocument = captureDocumentSnapshot();
  const previousTarget = useWorkColumnStore.getState().navigation.target;
  const previousArtifactHistory = previousTarget.kind === 'artifact'
    ? artifactHistoryEntryFromTarget(previousTarget)
    : null;
  await runNavigation(
    pendingExternalTarget(path, options),
    async (requestId) => {
      getWorkspaceMemoState().setSelectedMemo(null);
      if (!isCurrentNavigation(requestId)) return;
      await getWorkspaceDocumentState().openExternalDocument(
        path,
        previousArtifactHistory ? { ...options, history: 'skip' } : options,
      );
      if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
      const scopePath = options?.scopePath ? canonicalPath(options.scopePath) : null;
      if (path === null && !getWorkspaceDocumentState().activeExternalSession) {
        commitNavigation(requestId, EMPTY_WORK_COLUMN_TARGET);
      } else if (!publishExternalTargetIfCurrent(requestId, path, scopePath, fileBrowser)) {
        throw new Error(`External document session was not committed: ${path}`);
      }
      if (previousArtifactHistory && options?.history !== 'skip') {
        pushWorkspaceDocumentHistory(previousArtifactHistory);
      }
    },
    async () => {
      await openExternalTarget(path, options);
    },
    async (requestId) => {
      if (!isCurrentNavigation(requestId)) return;
      await restoreDocumentSnapshot(previousDocument);
      if (!isCurrentNavigation(requestId)) return;
      if (!getWorkspaceMemoState().selectedMemo) {
        getWorkspaceMemoState().setSelectedMemo(previousMemo);
      }
    },
  );
  return null;
}

/** Open a web target in the left work column. */
export async function openWebTarget(url: string): Promise<WorkspaceContentLocation | null> {
  const normalized = canonicalUrl(url);
  if (!normalized) throw new Error(`Unsupported webpage URL: ${url}`);

  const existing = activateExistingContentForNavigation({ kind: 'web', url: normalized });
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
      commitNavigation(requestId, target);
      useWorkspaceFocusStore.getState().focusHost('main-third');
    },
    async () => { await openWebTarget(normalized); },
  );
  return null;
}

/**
 * Open a durable pointer-memo artifact without creating an editable memo
 * session. The host artifact service owns loading and fallback behavior; this
 * target only records which artifact the workColumn should display.
 */
export async function openArtifactTarget(
  params: OpenArtifactTargetParams,
): Promise<WorkspaceContentLocation | null> {
  const pointerMemoId = params.pointerMemoId.trim();
  if (!pointerMemoId) return null;

  const previousHistoryEntry = historyEntryFromWorkColumnTarget(
    useWorkColumnStore.getState().navigation.target,
  );

  const target = pendingArtifactTarget({ ...params, pointerMemoId });
  await runNavigation(
    target,
    async (requestId) => {
      // Artifact rendering is independent from the editable document session,
      // but pending edits must be durable before the workColumn leaves that
      // document surface underneath the artifact.
      await flushWorkspaceDocument();
      if (!isCurrentNavigation(requestId)) return;
      if (!commitNavigation(requestId, target)) return;
      selectArtifactMemo(params);
      useWorkspaceFocusStore.getState().focusHost('main-third');
      if (params.history !== 'skip' && previousHistoryEntry) {
        pushWorkspaceDocumentHistory(previousHistoryEntry);
      }
    },
    async () => { await openArtifactTarget(params); },
  );
  return null;
}

/** Flush the active editable document without clearing its session or target. */
export async function flushWorkspaceDocument(): Promise<void> {
  const document = getWorkspaceDocumentState();
  let flushed = true;

  if (document.activeMemoSession) {
    flushed = await flushWorkspaceDocumentPath(
      { kind: 'memo', id: document.activeMemoSession.memoId },
      document.activeMemoSession.path,
    );
  } else if (document.activeExternalSession) {
    flushed = await flushWorkspaceDocumentPath(
      { kind: 'external', path: document.activeExternalSession.path },
      document.activeExternalSession.path,
      document.activeExternalSession.scopePath,
    );
  }

  if (!flushed) {
    throw new Error('Document flush did not complete');
  }
}

export async function openAgentTarget(
  instanceId: string,
  options?: { history?: 'push' | 'skip' },
): Promise<WorkspaceHostId | WorkspaceContentLocation> {
  const normalized = instanceId.trim();
  if (!normalized) return 'main-third';
  const existing = activateExistingContentForNavigation({
    kind: 'agent-conversation',
    instanceId: normalized,
  });
  if (existing instanceof Promise) {
    const activated = await existing;
    if (activated) return activated;
  } else if (existing) {
    return existing;
  }
  const previousTarget = useWorkColumnStore.getState().navigation.target;
  const previousArtifactHistory = previousTarget.kind === 'artifact'
    ? artifactHistoryEntryFromTarget(previousTarget)
    : null;
  await runNavigation(
    { kind: 'agent-conversation', instanceId: normalized },
    async (requestId) => {
      await getWorkspaceDocumentState().openAgentConversation(
        normalized,
        previousArtifactHistory ? { ...options, history: 'skip' } : options,
      );
      if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
      if (getWorkspaceDocumentState().activeAgentConversationId !== normalized) {
        throw new Error(`Agent session was not committed: ${normalized}`);
      }
      getWorkspaceMemoState().setActivePluginId(null);
      getWorkspaceMemoState().setSelectedMemo(null);
      if (!isCurrentNavigation(requestId)) return;
      commitNavigation(requestId, { kind: 'agent-conversation', instanceId: normalized });
      if (previousArtifactHistory && options?.history !== 'skip') {
        pushWorkspaceDocumentHistory(previousArtifactHistory);
      }
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
      if (document.activeMemoSession || document.activeExternalSession || document.activeAgentConversationId) {
        throw new Error('Document session was not cleared');
      }
      commitNavigation(requestId, EMPTY_WORK_COLUMN_TARGET);
    },
    () => clearWorkspaceDocument(),
  );
}

export function replaceActiveMemoPath(memoId: string, path: string): void {
  const current = getWorkspaceDocumentState().activeMemoSession;
  if (!current || current.memoId !== memoId) return;
  const requestId = beginNavigation({
    kind: 'memo',
    memoId,
    path,
    notebookId: current.notebookId,
    notebookPath: current.notebookPath,
    transitionId: null,
  }, null);
  getWorkspaceDocumentState().replaceActiveMemoPath(memoId, path);
  publishMemoTargetIfCurrent(requestId, memoId, path);
}

export async function discardMemoDocument(memoId: string): Promise<void> {
  await runNavigation(
    EMPTY_WORK_COLUMN_TARGET,
    async (requestId) => {
      await getWorkspaceDocumentState().discardMemoDocument(memoId);
      if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
      const document = getWorkspaceDocumentState();
      const target = useWorkColumnStore.getState().navigation.target;
      if (
        target.kind === 'memo'
        && target.memoId === memoId
        && !document.activeMemoSession
      ) {
        commitNavigation(requestId, EMPTY_WORK_COLUMN_TARGET);
      } else {
        commitNavigation(requestId, target);
      }
    },
    () => discardMemoDocument(memoId),
  );
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

/** Close the artifact surface while preserving any underlying document. */
export function closeArtifactTarget(): boolean {
  const workspace = useWorkColumnStore.getState();
  if (workspace.navigation.target.kind !== 'artifact') return false;
  const restoredTarget = workspace.navigation.previousTarget ?? EMPTY_WORK_COLUMN_TARGET;
  const requestId = beginNavigation(EMPTY_WORK_COLUMN_TARGET, null);
  commitNavigation(requestId, restoredTarget);
  return true;
}

/** Open a document-independent plugin workbench after the current document is flushed. */
export async function openPluginWorkbench(plugin: PluginDescriptor): Promise<void> {
  await runNavigation(
    { kind: 'plugin-workbench', plugin },
    async (requestId) => {
      await getWorkspaceDocumentState().clearDocument();
      if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
      getWorkspaceMemoState().setSelectedMemo(null);
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
      getWorkspaceMemoState().setSelectedMemo(null);
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
      getWorkspaceMemoState().setSelectedMemo(null);
      if (nextNotebook) {
        await getWorkspaceMemoState().loadMemos({ notebookId: nextNotebook.id });
        if (!isCurrentNavigation(requestId)) return;
      } else {
        getWorkspaceMemoState().setMemos([]);
      }
      commitNavigation(requestId, EMPTY_WORK_COLUMN_TARGET);
    },
    reconcile,
  );

  await reconcile();
}
