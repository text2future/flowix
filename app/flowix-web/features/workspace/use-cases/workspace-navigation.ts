import { selectNotebookInSecondColumn } from './select-column-notebook';
import { getSessionId, useWorkspaceSessionStore } from '../store/workspace-session-store';
import { sessionFor } from '../model/workspace-session';
import { getWorkspaceHostSurfaceLifecycle } from '../store/surface-lifecycle-store';
import { resolveSessionDocumentContext } from './session-document-context';
import { prepareCollectionBrowserTarget } from './browser-column-navigation';
import type { FileBrowserTarget } from '../model/surface-target';
import { flushBrowserViewBeforeOpeningWork } from './prepare-browser-document-for-work';
import { NavigationCancelledError } from '@/lib/navigation-cancelled-error';
import { ensureCollectionDisplay, bindCollectionDisplayPath, findCollectionDisplayPath } from '@/lib/collection-display-registry';
import { collections, externalDocuments, files, notebooks } from '@platform/tauri/client';
import { parseCollectionDocumentV2 } from '@features/collection/model';
import { repairCollectionFile, inspectCollectionRecoveryType } from '@features/collection/recovery';
import { captureFileBrowserContext } from './file-browser-context';
import { notes as notesClient, type PluginDescriptor, type MarkdownLocation } from '@platform/tauri/client';
import { canonicalDirectoryPath, canonicalPath, isPathInDirectory, joinNotebookMemoPath, notebookRelativeDirectoryPath, samePath } from '@/lib/path';
import { resourceKindFromPath } from '@features/editor/public/code-file';
import { canonicalUrl } from '@features/workspace/store/workspace-content-identity';
import {
  documentIdentityFromFile,
  prepareWorkspaceDocumentLeave,
  getWorkspaceDocumentState,
  replaceWorkspaceDocumentPath,
  type DocumentHistoryEntry,
} from '@features/document/public/workspace-api';
import {
  useBrowserColumnStore,
} from '@features/workspace/store/browser-column-store';
import {
  suspendFileDisplayReconciliation,
} from '@/lib/file-display-registry';
import {
  getWorkspaceMemoState,
  setCurrentWorkspaceNotebook,
  type Notebook,
} from '@features/memo/public/workspace-api';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { EMPTY_WORK_COLUMN_TARGET, workColumnTargetFilePath, workColumnTargetShowsBlockingLoading } from '@features/workspace/store/work-column-target';
import type { WorkColumnTarget } from '@features/workspace/store/work-column-target';
import type { FolderCollectionSurfaceTarget } from '../model/surface-target';
import type { LegacyFolderListTarget } from '../model/legacy-folder-list';
import {
  useWorkspaceFocusStore,
  type WorkspaceColumnId,
} from '@features/workspace/store/workspace-focus-store';
import {
  activateExistingWorkspaceContent,
  activateExistingWorkspaceContentAsync,
  findWorkspaceContentForNavigation,
  type WorkspaceContentLocation,
} from './workspace-content-activation';
import type { ContentIdentity } from '@features/workspace/store/workspace-content-identity';
import {
  useWorkspaceRestoreStore,
  type PersistedWorkspaceTarget,
} from '@features/workspace/store/workspace-restore-store';

export interface OpenExternalTargetOptions {
  /** The surface-opening boundary has already flushed the matching Browser view. */
  browserDocumentPrepared?: boolean;
  /** Delayed startup resolution must not replace newer user navigation. */
  restoreRequestId?: number;
  fileBrowser?: import('../store/file-browser-target').FileBrowserContext;
  /** Explicit cross-column moves must not reactivate a BrowserColumn tab. */
  destination?: 'column-1';
  history?: 'push' | 'skip';
  scopePath?: string | null;
  notebookId?: string | null;
  markdownLocation?: MarkdownLocation | null;
  initialFocus?: 'title' | 'body';
  treeReveal?: 'created-note';
}

export interface OpenMediaTargetParams {
  filePath: string;
  notebookId?: string | null;
  notebookPath: string | null;
  resourceKind?: 'image' | 'video';
  history?: 'push' | 'skip';
  destination?: 'column-1';
  /** Startup restoration lease, checked before navigation side effects begin. */
  restoreRequestId?: number;
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
 * Keep the no-op/column-1 path synchronous. BrowserColumn activation is the
 * only path which needs to cross the save-before-unmount barrier.
 */
function activateExistingContentForNavigation(
  identity: ContentIdentity,
  destination?: WorkspaceContentLocation['host'],
): WorkspaceContentLocation | null | Promise<WorkspaceContentLocation | null> {
  const existing = findWorkspaceContentForNavigation(identity, destination);
  if (!existing) return null;
  if (existing.host === 'column-1') {
    // A persisted target is only navigation intent. After a window reload its
    // document runtime is absent; focusing it would skip the actual file load.
    if (identity.kind === 'external') {
      const loaded = getWorkspaceDocumentState().activeExternalSession;
      if (!loaded || !samePath(loaded.fileIdentity.path, identity.path)) return null;
    }
    // The visible target is not the latest intent while another target loads.
    // Clicking it must start a new transaction so the pending request is stale.
    if (existing.state === 'active' && useWorkColumnStore.getState().navigation.phase === 'loading') {
      return null;
    }
    activateExistingWorkspaceContent(identity, existing.host);
    return existing;
  }
  return activateExistingWorkspaceContentAsync(identity, existing.host);
}

function pendingExternalTarget(
  path: string | null,
  options?: OpenExternalTargetOptions,
): WorkColumnTarget {
  return {
    kind: 'external',
    path: path ?? '',
    ...(options?.treeReveal ? { treeReveal: options.treeReveal } : {}),
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
  const committed = state.commitNavigation(requestId, target, history);
  if (committed) {
    if (retryToken) retryActions.delete(retryToken);
    const desiredTarget: PersistedWorkspaceTarget | null = target.kind === 'web' || target.kind === 'file-browser' ? target : target.kind === 'folder-collection'
      ? target
      : target.kind === 'collection'
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
            ? {
                kind: 'agent-conversation',
                instanceId: target.instanceId,
                ...(target.blankIfMissing ? { blankIfMissing: true as const } : {}),
              }
            : null;
    useWorkspaceRestoreStore.getState().setDesiredTarget(desiredTarget);
  }
  return committed;
}

export function captureWorkspaceRestoreTarget(): PersistedWorkspaceTarget | null {
  const current = sessionFor(useWorkspaceSessionStore.getState(), 'column-1').navigation.current;
  const target = current?.target ?? null;
  const owned = target && 'notebookId' in target ? target.notebookId : null;
  if (owned && !getWorkspaceMemoState().notebooks.some((notebook) => notebook.id === owned)) {
    useWorkspaceRestoreStore.getState().setDesiredTarget(null);
    useWorkspaceSessionStore.getState().updateSession(getSessionId('column-1'), (session) => ({
      ...session, navigation: { ...session.navigation, current: null,
        transaction: { ...session.navigation.transaction, phase: 'idle', pendingTarget: null, previousTarget: null } },
    }));
    return null;
  }
  if (!target || target.kind === 'empty') return null;
  return target.kind === 'media-library'
    ? { kind: 'external', path: target.filePath, scopePath: target.notebookPath }
    : target;
}

export async function restoreExternalDocumentWorkspace(
  restored: Extract<PersistedWorkspaceTarget, { kind: 'external' }>,
  restoreRequestId = useWorkColumnStore.getState().navigation.requestId,
): Promise<void> {
  if (!isRestoreRequestCurrent(restoreRequestId)) return;
  // Startup restoration must validate its captured revision before beginning a
  // navigation; an explicit user click can supersede this metadata lookup.
  const markdownLocation = /\.(md|markdown)$/i.test(restored.path)
    ? await notesClient.resolveLocation(restored.path)
    : null;
  if (!isRestoreRequestCurrent(restoreRequestId)) return;
  await openExternalTarget(restored.path, {
    restoreRequestId,
    markdownLocation,
    scopePath: restored.scopePath,
    history: 'skip',
    destination: 'column-1',
  });
}

export function restoreTableWorkspace(
  restored: Extract<PersistedWorkspaceTarget, { kind: 'table' }>,
  restoreRequestId = useWorkColumnStore.getState().navigation.requestId,
): Promise<void> {
  return openContentleTarget(restored.filePath, restored.notebookPath, restored.notebookId, { history: 'skip', restoreRequestId });
}

export async function openCollectionTarget(
  reference: { notebookId: string; collectionId: string; viewId?: string | null; displayId?: string; relativePathHint?: string; filePath?: string },
  options?: { history?: 'push' | 'skip'; destination?: 'column-1'; refresh?: boolean; restoreRequestId?: number },
): Promise<void> {
  if (!isRestoreRequestCurrent(options?.restoreRequestId)) return;
  const { notebookId, collectionId } = reference;
  const identity: ContentIdentity = { kind: 'collection', notebookId, collectionId, viewId: reference.viewId ?? null };
  const navigation = useWorkColumnStore.getState().navigation;
  const liveTarget = [navigation.pendingTarget, navigation.target].find((target) => target?.kind === 'collection'
    && target.notebookId === notebookId && target.collectionId === collectionId);
  const needsResolution = options?.refresh || options?.destination === 'column-1'
    || (liveTarget?.kind === 'collection' && (liveTarget.unavailableReason || liveTarget.viewId !== identity.viewId));
  if (!needsResolution) {
    const existing = await activateExistingContentForNavigation(identity, options?.destination);
    if (!isRestoreRequestCurrent(options?.restoreRequestId)) return;
    if (existing) return;
  }
  const notebook = getWorkspaceMemoState().notebooks.find((item) => item.id === notebookId)
    ?? (getWorkspaceMemoState().selectedNotebook?.id === notebookId ? getWorkspaceMemoState().selectedNotebook : null)
    ?? (await notebooks.getAll()).find((item) => item.id === notebookId);
  if (!isRestoreRequestCurrent(options?.restoreRequestId)) return;
  if (!notebook) throw new Error('集合所属笔记本不存在');
  const descriptor = ensureCollectionDisplay({ notebookId, collectionId, viewId: reference.viewId ?? null }, reference.displayId);
  const previousTarget = useWorkColumnStore.getState().navigation.target;
  const knownPath = reference.filePath || (reference.relativePathHint
    ? `${canonicalDirectoryPath(notebook.path)}/${reference.relativePathHint}` : null)
    || findCollectionDisplayPath(descriptor.displayId)
    || (previousTarget.kind === 'collection' && previousTarget.notebookId === notebookId && previousTarget.collectionId === collectionId
      ? previousTarget.filePath : '');
  const placeholder: Extract<WorkColumnTarget, { kind: 'collection' }> = {
    kind: 'collection', ...descriptor, filePath: knownPath, notebookPath: canonicalDirectoryPath(notebook.path), collectionType: 'table', name: '正在打开集合',
  };
  const requestId = beginNavigation(placeholder, null, false, false);
  if (!isCurrentNavigation(requestId)) return;
  let item: Awaited<ReturnType<typeof collections.resolve>> | null = null;
  let unavailableReason: string | undefined;
  try { item = await collections.resolve(notebookId, collectionId); }
  catch (error) { unavailableReason = String(error).includes('IDENTITY_CONFLICT') ? '集合身份冲突，请先为副本生成新 ID' : '集合不存在或暂时无法读取'; }
  if (!isCurrentNavigation(requestId)) return;
  const filePath = item ? `${canonicalDirectoryPath(notebook.path)}/${item.relativePath}` : knownPath;
  if (item?.identityConflict) unavailableReason = '集合身份冲突，请先为副本生成新 ID';
  if (item && item.parseState !== 'valid') unavailableReason = item.parseState === 'unsupported' ? '此集合版本暂不支持' : '集合文件格式无效';
  if (item && !unavailableReason && descriptor.viewId) {
    try {
      const envelope = parseCollectionDocumentV2(await externalDocuments.read(filePath, notebook.path));
      if (!isCurrentNavigation(requestId)) return;
      const payload = envelope.payload;
      const views = payload.views.items as Array<{ id: string }>;
      // Tables resolve stale embedded/history view IDs against the file's
      // remembered view, then document order, in their shared selection policy.
      if (envelope.collection.type !== 'table' && !views.some((view) => view.id === descriptor.viewId)) unavailableReason = '此视图已不存在，请重新选择视图';
    } catch { unavailableReason = '无法读取集合视图'; }
  }
  if (useWorkColumnStore.getState().navigation.requestId !== requestId) return;
  if (filePath && !bindCollectionDisplayPath(descriptor.displayId, filePath, item?.indexSequence)) {
    // The first attempt already advanced the navigation revision. Carry that
    // revision into the retry so the startup restore lease does not reject its
    // own retry as stale; a later user navigation will still supersede it.
    return openCollectionTarget(reference, {
      ...options,
      restoreRequestId: requestId,
    });
  }
  const target: Extract<WorkColumnTarget, { kind: 'collection' }> = {
    kind: 'collection', ...descriptor, filePath, notebookPath: canonicalDirectoryPath(notebook.path),
    collectionType: item?.collectionType ?? 'table', name: item?.name ?? '集合不可用',
    ...(unavailableReason ? { unavailableReason } : {}),
  };
  try {
    await getWorkspaceDocumentState().clearDocument();
  } catch (error) {
    if (isCurrentNavigation(requestId)) useWorkColumnStore.getState().failNavigation(requestId, error);
    throw error;
  }
  if (!isCurrentNavigation(requestId)) return;
  commitNavigation(requestId, target, options?.history ?? 'push');
  useWorkspaceFocusStore.getState().focusColumn('column-1');
}

async function resolveCollectionFileNotebook(
  filePath: string,
  notebookPath: string | null,
  notebookId: string | null,
): Promise<Notebook> {
  if (!filePath.trim()) throw new Error('集合文件路径已丢失，请从文件树重新打开此文件');
  const workspace = getWorkspaceMemoState();
  const fileDirectory = canonicalDirectoryPath(canonicalPath(filePath).replace(/[\\/][^\\/]*$/, ''));
  const containsFile = (item: Notebook) => notebookRelativeDirectoryPath(item.path, fileDirectory) !== null;
  // File browser surfaces can be restored before the memo library has loaded
  // its notebook list. Refresh it here so nested notebooks and stale cached
  // paths resolve to the actual owner of this collection file.
  let candidates: Notebook[];
  try { candidates = (await notebooks.getAll()).filter(containsFile); }
  catch { candidates = [...workspace.notebooks, ...(workspace.selectedNotebook ? [workspace.selectedNotebook] : [])].filter(containsFile); }
  const requestedNotebook = notebookId
    ? candidates.find((item) => item.id === notebookId)
    : null;
  const hintedPathNotebook = notebookPath
    ? candidates.find((item) => canonicalPath(item.path) === canonicalPath(notebookPath))
    : null;
  const notebook = requestedNotebook ?? hintedPathNotebook
    ?? candidates.sort((left, right) => canonicalPath(right.path).length - canonicalPath(left.path).length)[0];
  if (!notebook) throw new Error('无法确定集合所属笔记本');
  return notebook;
}

/** Reopen a collection from its file and return to its configured default view. */
export async function resetCurrentCollectionView(
  filePath: string,
  notebookPath: string | null,
  notebookId: string | null,
  location: { host: 'column-1' } | { host: 'column-2'; surfaceId: string } = { host: 'column-1' },
): Promise<void> {
  const notebook = await resolveCollectionFileNotebook(filePath, notebookPath, notebookId);
  const root = canonicalDirectoryPath(notebook.path);
  const resolvedId = notebook.id;
  const repaired = await repairCollectionFile(filePath, root);
  if (location.host === 'column-2') {
    let display: ReturnType<typeof ensureCollectionDisplay> | undefined;
    try {
      const item = await collections.resolve(resolvedId, repaired.collectionId);
      if (!item.identityConflict && item.parseState === 'valid' && item.collectionType === repaired.collectionType) {
        const descriptor = ensureCollectionDisplay({ notebookId: resolvedId, collectionId: repaired.collectionId, viewId: null });
        if (bindCollectionDisplayPath(descriptor.displayId, filePath, item.indexSequence)) display = descriptor;
      }
    } catch { /* The direct file view below does not depend on catalog readiness. */ }
    useBrowserColumnStore.getState().selectFileBrowserFile(
      location.surfaceId, filePath, display, repaired.collectionType,
    );
    return;
  }

  try {
    await openCollectionTarget({ notebookId: resolvedId, collectionId: repaired.collectionId, filePath }, { refresh: true });
  } catch {
    await openCollectionFileDirectly(filePath, root, resolvedId, repaired.collectionType);
    return;
  }
  const active = useWorkColumnStore.getState().navigation.target;
  if (active.kind !== 'collection' || active.collectionId !== repaired.collectionId || active.unavailableReason) {
    await openCollectionFileDirectly(filePath, root, resolvedId, repaired.collectionType);
  }
}

async function openCollectionFileDirectly(
  filePath: string,
  notebookPath: string,
  notebookId: string,
  type: 'table' | 'media_library' | 'work_documents',
  unavailableReason?: string,
  history: 'push' | 'skip' = 'skip',
): Promise<void> {
  const target: WorkColumnTarget = type === 'table'
    ? { kind: 'table', filePath, notebookPath, notebookId, ...(unavailableReason ? { unavailableReason } : {}) }
    : type === 'media_library'
      ? { kind: 'media-library', filePath, notebookPath, notebookId, ...(unavailableReason ? { unavailableReason } : {}) }
      : { kind: 'external', path: filePath, scopePath: notebookPath, transitionId: null };
  await runNavigation(target, async (requestId) => {
    await getWorkspaceDocumentState().clearDocument();
    if (!isCurrentNavigation(requestId)) return;
    commitNavigation(requestId, target, history);
    useWorkspaceFocusStore.getState().focusColumn('column-1');
  }, async () => { await openCollectionFileDirectly(filePath, notebookPath, notebookId, type, unavailableReason, history); });
}

async function openCollectionFile(filePath: string, notebookPath: string | null, notebookId: string | null, options?: { history?: 'push' | 'skip'; destination?: 'column-1'; restoreRequestId?: number }): Promise<void> {
  if (!isRestoreRequestCurrent(options?.restoreRequestId)) return;
  const notebook = await resolveCollectionFileNotebook(filePath, notebookPath, notebookId);
  if (!isRestoreRequestCurrent(options?.restoreRequestId)) return;
  const root = canonicalDirectoryPath(notebook.path);
  const source = await externalDocuments.read(filePath, root);
  if (!isRestoreRequestCurrent(options?.restoreRequestId)) return;
  let envelope: ReturnType<typeof parseCollectionDocumentV2>;
  try { envelope = parseCollectionDocumentV2(source); }
  catch {
    // Invalid content still owns a selectable file surface with a recovery
    // action. Never roll the navigation back merely because parsing failed.
    await openCollectionFileDirectly(filePath, root, notebook.id, inspectCollectionRecoveryType(source, filePath), '集合文件格式无效', options?.history ?? 'push');
    return;
  }
  await openCollectionTarget({ notebookId: notebook.id, collectionId: envelope.collection.id, filePath }, options);
}
/**
 * 打开文件夹集合 ── **旧入口，只服务历史回放里的 `document-list` 条目**。
 *
 * 它以前自己写 `.index.yaml`（v2 单类型模板），而「点文件夹 → 文件夹首页」
 * （`openFolderCollectionFromFolder`）在缺集合时是点域 tab 才 ensure 成 v3 hybrid：
 * 同一个动作有两条建集合路径，产出两种文件，首次打开的头图与文件树操作区也因此
 * 各走一套渲染。现在统一走后者 —— 这里不再写盘，建集合只剩
 * `ensureFolderCollection` 一条路径（模板唯一：v3 hybrid）。
 */
export async function openFolderCollection(
  notebookId: string,
  path: string,
  options?: { history?: 'push' | 'skip'; restoreRequestId?: number },
): Promise<void> {
  if (!isRestoreRequestCurrent(options?.restoreRequestId)) return;
  const folderPath = canonicalDirectoryPath(path);
  const workspace = getWorkspaceMemoState();
  const notebook = (notebookId ? workspace.notebooks.find((item) => item.id === notebookId) : undefined)
    ?? workspace.notebooks.find((item) => notebookRelativeDirectoryPath(item.path, folderPath) !== null);
  if (!notebook) throw new Error('无法确定文件夹所属笔记本');
  if (notebookRelativeDirectoryPath(notebook.path, folderPath) === null) throw new Error('文件夹不属于当前笔记本');
  const indexPath = `${folderPath}/.index.yaml`;
  // 已有但损坏的集合保留「格式无效 + 修复入口」这一条诊断（不再顺带建文件）。
  const source = await files.read(indexPath, notebook.path);
  if (!isRestoreRequestCurrent(options?.restoreRequestId)) return;
  if (source !== null) {
    try { parseCollectionDocumentV2(source); }
    catch {
      await openCollectionFileDirectly(
        indexPath, notebook.path, notebook.id, inspectCollectionRecoveryType(source, indexPath),
        '集合文件格式无效', options?.history ?? 'push',
      );
      return;
    }
  }
  const folderName = folderPath.split(/[\\/]/).filter(Boolean).pop() ?? notebook.name;
  await openFolderCollectionChooserTarget(
    { kind: 'folder-collection', folderPath, notebookId: notebook.id, notebookPath: notebook.path, folderName },
    options?.restoreRequestId,
    options?.history ?? 'skip',
  );
}

export async function openFolderCollectionChooserTarget(
  target: FolderCollectionSurfaceTarget,
  restoreRequestId?: number,
  history: 'push' | 'skip' = 'skip',
): Promise<void> {
  if (!isRestoreRequestCurrent(restoreRequestId)) return;
  const notebook = getWorkspaceMemoState().notebooks.find((item) => item.id === target.notebookId);
  if (!notebook || notebookRelativeDirectoryPath(notebook.path, target.folderPath) === null) {
    throw new Error('文件夹不属于当前笔记本');
  }
  const requestId = beginNavigation(target, null, false, false);
  try {
    await prepareActiveWorkColumnDocumentLeave();
  } catch (error) {
    if (isCurrentNavigation(requestId)) useWorkColumnStore.getState().failNavigation(requestId, error);
    throw error;
  }
  if (isCurrentNavigation(requestId)) commitNavigation(requestId, target, history);
}

export async function openFolderCollectionFromFolder(
  notebookId: string,
  path: string,
  host: WorkspaceColumnId = 'column-1',
  options?: { history?: 'push' | 'skip' },
): Promise<void> {
  const folderPath = canonicalDirectoryPath(path);
  const notebook = getWorkspaceMemoState().notebooks.find((item) => item.id === notebookId);
  if (!notebook) throw new Error('无法确定文件夹所属笔记本');
  // 任意文件夹点击统一进「文件夹首页」（FolderHomeView），不再因为存在可读的
  // .index.yaml 就直接跳进集合视图；集合入口由首页里的笔记 / 媒体库 tab 提供。
  const folderName = folderPath.split(/[\\/]/).filter(Boolean).pop() ?? notebook.name;
  const target: FolderCollectionSurfaceTarget = {
    kind: 'folder-collection', folderPath, notebookId, notebookPath: notebook.path, folderName,
  };
  if (host === 'column-1') {
    await openFolderCollectionChooserTarget(target, undefined, options?.history ?? 'push');
  } else {
    const { openWorkspaceSurface } = await import('@features/workspace/public/session-opening-api');
    await openWorkspaceSurface({ columnId: host, target, options });
  }
}

export function openContentleTarget(filePath: string, notebookPath: string | null, notebookId: string | null, options?: { history?: 'push' | 'skip'; destination?: 'column-1'; restoreRequestId?: number }): Promise<void> {
  return openCollectionFile(filePath, notebookPath, notebookId, options);
}
export function openMediaLibraryTarget(filePath: string, notebookPath: string | null, notebookId: string | null, options?: { history?: 'push' | 'skip'; destination?: 'column-1'; restoreRequestId?: number }): Promise<void> {
  return openCollectionFile(filePath, notebookPath, notebookId, options);
}
export function restoreCollectionWorkspace(restored: Extract<PersistedWorkspaceTarget, { kind: 'collection' }>, restoreRequestId = useWorkColumnStore.getState().navigation.requestId): Promise<void> {
  return openCollectionTarget(restored, { history: 'skip', restoreRequestId });
}
export function restoreFolderCollectionWorkspace(restored: FolderCollectionSurfaceTarget, restoreRequestId = useWorkColumnStore.getState().navigation.requestId): Promise<void> {
  return openFolderCollectionChooserTarget(restored, restoreRequestId);
}

export async function restoreMediaWorkspace(
  restored: Extract<PersistedWorkspaceTarget, { kind: 'media' }>,
  restoreRequestId = useWorkColumnStore.getState().navigation.requestId,
): Promise<void> {
  if (!isRestoreRequestCurrent(restoreRequestId)) return;
  await openMediaTarget({
    filePath: restored.filePath,
    notebookId: restored.notebookId,
    notebookPath: restored.notebookPath,
    resourceKind: restored.resourceKind,
    history: 'skip',
    restoreRequestId,
  });
}

export async function restoreLegacyFolderListWorkspace(
  restored: LegacyFolderListTarget,
  restoreRequestId = useWorkColumnStore.getState().navigation.requestId,
): Promise<void> {
  await openFolderCollection(restored.scope.notebookId ?? '', restored.scope.path, { history: 'skip', restoreRequestId });
}

function isRestoreRequestCurrent(requestId: number | undefined): boolean {
  return requestId === undefined || useWorkColumnStore.getState().navigation.requestId === requestId;
}

function stripRestoreRequestId<T extends { restoreRequestId?: number }>(options: T | undefined): Omit<T, 'restoreRequestId'> | undefined {
  if (!options) return undefined;
  const copy = { ...options };
  delete copy.restoreRequestId;
  return copy;
}

function isCurrentNavigation(requestId: number): boolean {
  return useWorkColumnStore.getState().isCurrentNavigation(requestId);
}

async function runNavigation(
  pendingTarget: WorkColumnTarget,
  operation: (requestId: number) => Promise<void>,
  retry: RetryAction,
  rollback?: (requestId: number) => Promise<void>,
  preservePreviousTarget = false,
  showWorkColumnLoading = workColumnTargetShowsBlockingLoading(pendingTarget),
): Promise<void> {
  const requestId = beginNavigation(
    pendingTarget, retry, preservePreviousTarget, showWorkColumnLoading,
  );
  try {
    if (!isCurrentNavigation(requestId)) return;
    const lifecycle = getWorkspaceHostSurfaceLifecycle('column-1');
    if (lifecycle?.flush && !await lifecycle.flush()) {
      throw new NavigationCancelledError('Surface draft could not be retained');
    }
    if (!isCurrentNavigation(requestId)) return;
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
      if (error instanceof NavigationCancelledError && workspace.isCurrentNavigation(requestId)) {
        commitNavigation(requestId, workspace.navigation.target);
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
    case 'file-browser': return { ...target, openedAt: Date.now() };
    case 'folder-collection':
      return { kind: 'folder-collection', folderPath: target.folderPath, notebookId: target.notebookId, openedAt: Date.now() };
    case 'collection':
      return { kind: 'collection', displayId: target.displayId, notebookId: target.notebookId, collectionId: target.collectionId, viewId: target.viewId, relativePathHint: target.filePath.startsWith(`${target.notebookPath}/`) ? target.filePath.slice(target.notebookPath.length + 1) : undefined, openedAt: Date.now() };
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
        ...(target.blankIfMissing ? { blankIfMissing: true as const } : {}),
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
export async function selectNotebook(
  notebook: Notebook,
): Promise<void> {
  if (getSessionId(0) === 'column-2') {
    await selectNotebookInSecondColumn(notebook);
    return;
  }
  const previousNotebook = getWorkspaceMemoState().selectedNotebook;
  const previousDocument = captureDocumentSnapshot();
  let switchedNotebook = false;
  let clearedDocument = false;
  useWorkColumnStore.getState().beginNotebookSwitch?.();

  try {
    await runNavigation(
      EMPTY_WORK_COLUMN_TARGET,
      async (requestId) => {
        if (!isCurrentNavigation(requestId)) return;
        await getWorkspaceDocumentState().clearDocument();
        clearedDocument = true;
        if (!isCurrentNavigation(requestId)) return;

        await setCurrentWorkspaceNotebook(notebook);
        switchedNotebook = true;
        if (!isCurrentNavigation(requestId)) return;

        getWorkspaceMemoState().setSelectedNotebook(notebook);
        commitNavigation(requestId, EMPTY_WORK_COLUMN_TARGET);
      },
      () => selectNotebook(notebook),
      async (requestId) => {
        if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
        if (switchedNotebook) {
          await setCurrentWorkspaceNotebook(previousNotebook?.id ?? null);
        }
        if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
        // Selection has not been published on a failed switch. Avoid calling
        // its setter: doing so would reset list and filter state on rollback.
        if (clearedDocument) await restoreDocumentSnapshot(previousDocument);
      },
      true,
      true,
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
  treeReveal?: 'created-note',
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
    ...(treeReveal ? { treeReveal } : {}),
    ...(fileBrowser ? { fileBrowser } : {}),
    scopePath: session.scopePath,
    transitionId: session.transitionId,
  }, history);
}

export async function openExternalTarget(
  path: string | null,
  options?: OpenExternalTargetOptions,
): Promise<WorkspaceContentLocation | null> {
  if (!isRestoreRequestCurrent(options?.restoreRequestId)) return null;
  if (path && /\.index\.yaml$/i.test(path)) {
    const capturedFileBrowser = options?.fileBrowser ?? captureFileBrowserContext(path, options?.scopePath);
    const scopePath = options?.scopePath ?? capturedFileBrowser.scopePath;
    const notebookId = options?.notebookId
      ?? options?.fileBrowser?.notebookId
      ?? getWorkspaceMemoState().notebooks.find((notebook) => scopePath && canonicalPath(notebook.path) === canonicalPath(scopePath))?.id
      ?? capturedFileBrowser.notebookId
      ?? null;
    await openCollectionFile(path, scopePath, notebookId, { history: options?.history, destination: options?.destination, restoreRequestId: options?.restoreRequestId });
    return null;
  }
  if (path && /\.workdocs\.ya?ml$/i.test(path)) {
    const capturedFileBrowser = options?.fileBrowser ?? captureFileBrowserContext(path, options?.scopePath);
    const scopePath = options?.scopePath ?? capturedFileBrowser.scopePath;
    const notebookId = options?.notebookId
      ?? options?.fileBrowser?.notebookId
      ?? getWorkspaceMemoState().notebooks.find((notebook) => scopePath && canonicalPath(notebook.path) === canonicalPath(scopePath))?.id
      ?? capturedFileBrowser.notebookId
      ?? null;
    await openCollectionFile(path, scopePath, notebookId, { history: options?.history, destination: options?.destination, restoreRequestId: options?.restoreRequestId });
    return null;
  }
  if (path && /\.lib\.ya?ml$/i.test(path)) {
    const capturedFileBrowser = options?.fileBrowser ?? captureFileBrowserContext(path, options?.scopePath);
    const scopePath = options?.scopePath ?? capturedFileBrowser.scopePath;
    const notebookId = options?.notebookId
      ?? options?.fileBrowser?.notebookId
      ?? getWorkspaceMemoState().notebooks.find((notebook) => scopePath && canonicalPath(notebook.path) === canonicalPath(scopePath))?.id
      ?? capturedFileBrowser.notebookId
      ?? null;
    await openMediaLibraryTarget(path, scopePath, notebookId, { history: options?.history, destination: options?.destination, restoreRequestId: options?.restoreRequestId });
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
    await openContentleTarget(path, scopePath, notebookId, { history: options?.history, destination: options?.destination, restoreRequestId: options?.restoreRequestId });
    return null;
  }
  const existing = path
    ? activateExistingContentForNavigation(
        { kind: 'external', path },
        options?.destination ?? undefined,
      )
    : null;
  if (existing instanceof Promise) {
    const activated = await existing;
    if (!isRestoreRequestCurrent(options?.restoreRequestId)) return null;
    if (activated) return activated;
  } else if (existing) {
    if (!isRestoreRequestCurrent(options?.restoreRequestId)) return null;
    return existing;
  }

  const previousNotebook = getWorkspaceMemoState().selectedNotebook;
  const previousPathNote = getWorkspaceMemoState().selectedNote;
  let switchedNotebook = false;
  const previousDocument = captureDocumentSnapshot();
  const retryOptions = { ...stripRestoreRequestId(options), browserDocumentPrepared: false };
  await runNavigation(
    pendingExternalTarget(path, options),
    async (requestId) => {
      if (path && !options?.browserDocumentPrepared && !await flushBrowserViewBeforeOpeningWork({ kind: 'external', path })) {
        throw new NavigationCancelledError('Document switch cancelled because the Browser document could not be saved');
      }
      if (!isCurrentNavigation(requestId)) return;
      const markdownLocation = path && /\.(md|markdown)$/i.test(path)
        ? options?.markdownLocation ?? await notesClient.resolveLocation(path)
        : null;
      if (!isCurrentNavigation(requestId)) return;
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
        options?.treeReveal,
      )) {
        throw new Error(`External document session was not committed: ${path}`);
      }
    },
    async () => {
      await openExternalTarget(path, retryOptions);
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
  if (!isRestoreRequestCurrent(params.restoreRequestId)) return null;
  const filePath = params.filePath.trim();
  if (!filePath || !params.notebookPath?.trim()) return null;
  const target = pendingMediaTarget({ ...params, filePath });
  const existing = activateExistingContentForNavigation(
    { kind: 'media', path: filePath },
    params.destination,
  );
  if (existing instanceof Promise) {
    const activated = await existing;
    if (!isRestoreRequestCurrent(params.restoreRequestId)) return null;
    if (activated) return activated;
  } else if (existing) {
    if (!isRestoreRequestCurrent(params.restoreRequestId)) return null;
    return existing;
  }

  const previousDocument = captureDocumentSnapshot();
  const retryParams = stripRestoreRequestId(params)!;
  await runNavigation(
    target,
    async (requestId) => {
      await getWorkspaceDocumentState().clearDocument();
      if (!isCurrentNavigation(requestId)) return;
      if (!commitNavigation(requestId, target, params.history ?? 'push')) return;
      useWorkspaceFocusStore.getState().focusColumn('column-1');
    },
    async () => { await openMediaTarget(retryParams); },
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
  options?: { history?: 'push' | 'skip'; destination?: 'column-1' },
): Promise<WorkspaceContentLocation | null> {
  const normalized = canonicalUrl(url);
  if (!normalized) throw new Error(`Unsupported webpage URL: ${url}`);

  const existing = activateExistingContentForNavigation(
    { kind: 'web', url: normalized },
    options?.destination,
  );
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
      await prepareActiveWorkColumnDocumentLeave();
      if (!isCurrentNavigation(requestId)) return;
      commitNavigation(requestId, target, options?.history ?? 'push');
      useWorkspaceFocusStore.getState().focusColumn('column-1');
    },
    async () => { await openWebTarget(normalized, options); },
  );
  return null;
}

/** Capture and retain the document before replacing its visible work surface. */
export async function prepareActiveWorkColumnDocumentLeave(): Promise<void> {
  const active = resolveSessionDocumentContext(useWorkColumnStore.getState().navigation.target,
    getWorkspaceDocumentState().activeExternalSession, getWorkspaceMemoState().notebooks);
  if (!active) return;
  const prepared = await prepareWorkspaceDocumentLeave(
    documentIdentityFromFile(active.fileIdentity),
    active.fileIdentity.path,
    active.scopePath,
  );
  if (!prepared) throw new NavigationCancelledError('Document draft could not be retained');
}

export async function openAgentTarget(
  instanceId: string,
  options?: { history?: 'push' | 'skip'; destination?: 'column-1'; blankIfMissing?: true; restoreRequestId?: number },
): Promise<WorkspaceColumnId | WorkspaceContentLocation> {
  const normalized = instanceId.trim();
  if (!normalized || !isRestoreRequestCurrent(options?.restoreRequestId)) return 'column-1';
  const navigationOptions = options ? {
    ...(options.history ? { history: options.history } : {}),
    ...(options.destination ? { destination: options.destination } : {}),
    ...(options.blankIfMissing ? { blankIfMissing: true as const } : {}),
  } : undefined;
  const existing = activateExistingContentForNavigation(
    { kind: 'agent-conversation', instanceId: normalized },
    options?.destination ?? undefined,
  );
  if (existing instanceof Promise) {
    const activated = await existing;
    if (!isRestoreRequestCurrent(options?.restoreRequestId)) return 'column-1';
    if (activated) return activated;
  } else if (existing) {
    if (!isRestoreRequestCurrent(options?.restoreRequestId)) return 'column-1';
    return existing;
  }
  await runNavigation(
    {
      kind: 'agent-conversation',
      instanceId: normalized,
      ...(navigationOptions?.blankIfMissing ? { blankIfMissing: true as const } : {}),
    },
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
      const committed = commitNavigation(
        requestId,
        {
          kind: 'agent-conversation',
          instanceId: normalized,
          ...(navigationOptions?.blankIfMissing ? { blankIfMissing: true as const } : {}),
        },
        navigationOptions?.history ?? 'push',
      );
      if (committed) useWorkspaceFocusStore.getState().focusColumn('column-1');
    },
    async () => {
      await openAgentTarget(normalized, navigationOptions);
    },
  );
  return 'column-1';
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

function clearSelectedWorkspaceNoteIf(matchesPath: (path: string) => boolean): void {
  const memoState = getWorkspaceMemoState();
  const selectedNote = memoState.selectedNote;
  if (!selectedNote) return;
  const notebook = memoState.notebooks.find((item) => item.id === selectedNote.notebookId)
    ?? (memoState.selectedNotebook?.id === selectedNote.notebookId ? memoState.selectedNotebook : null);
  const selectedPath = notebook && joinNotebookMemoPath(notebook.path, selectedNote.relativePath);
  if (selectedPath && matchesPath(selectedPath)) memoState.setSelectedNote(null);
}

/** Clear the active work-column view when its backing file has been deleted. */
export async function clearWorkspaceTargetForDeletedFile(filePath: string): Promise<boolean> {
  clearSelectedWorkspaceNoteIf((selectedPath) => samePath(selectedPath, filePath));

  const matchesPath = (target: WorkColumnTarget | null | undefined) => {
    const path = target ? workColumnTargetFilePath(target) : null;
    return Boolean(path && samePath(path, filePath));
  };
  const restoreStore = useWorkspaceRestoreStore.getState();
  const desired = restoreStore.desiredTarget;
  const desiredPath = desired?.kind === 'external'
    ? desired.path
    : desired && 'filePath' in desired ? desired.filePath : null;
  if (desiredPath && samePath(desiredPath, filePath)) restoreStore.setDesiredTarget(null);

  const navigation = useWorkColumnStore.getState().navigation;
  const targetMatches = matchesPath(navigation.target);
  const pendingMatches = matchesPath(navigation.pendingTarget);
  const previousMatches = matchesPath(navigation.previousTarget);
  if (!targetMatches && !pendingMatches && !previousMatches) return false;

  if (targetMatches || pendingMatches) await clearWorkspaceDocument();

  // Committing an empty target intentionally preserves navigation history for
  // ordinary closes. A deleted file must not remain as a rollback target.
  const latestNavigation = useWorkColumnStore.getState().navigation;
  if (matchesPath(latestNavigation.previousTarget)) {
    useWorkspaceSessionStore.getState().updateSession(getSessionId('column-1'), (session) => ({ ...session,
      navigation: { ...session.navigation, transaction: { ...session.navigation.transaction, previousTarget: null } },
    }));
  }
  return targetMatches || pendingMatches;
}

/** Clear work and browser targets that would become valid again after a same-path folder import. */
export async function clearWorkspaceTargetsForDeletedDirectory(directoryPath: string): Promise<void> {
  const isInsideDeletedDirectory = (path: string | null | undefined) => (
    Boolean(path && isPathInDirectory(path, directoryPath))
  );
  const navigation = useWorkColumnStore.getState().navigation;
  clearSelectedWorkspaceNoteIf(isInsideDeletedDirectory);

  const workTargetIsInside = (target: WorkColumnTarget | null) => {
    if (!target) return false;
    if (target.kind === 'folder-collection') return isInsideDeletedDirectory(target.folderPath);
    return isInsideDeletedDirectory(workColumnTargetFilePath(target));
  };
  const targetIsInside = workTargetIsInside(navigation.target);
  const pendingTargetIsInside = workTargetIsInside(navigation.pendingTarget);
  const clearWorkTarget = targetIsInside || pendingTargetIsInside;

  useBrowserColumnStore.getState().clearTargetsUnderDirectory(directoryPath);

  const restoreStore = useWorkspaceRestoreStore.getState();
  const desiredTarget = restoreStore.desiredTarget;
  const desiredPath = desiredTarget
    ? desiredTarget.kind === 'external'
      ? desiredTarget.path
      : desiredTarget.kind === 'agent-conversation'
        ? null
        : 'filePath' in desiredTarget
          ? desiredTarget.filePath
          : 'folderPath' in desiredTarget
            ? typeof desiredTarget.folderPath === 'string' ? desiredTarget.folderPath : null
            : null
    : null;
  if (isInsideDeletedDirectory(desiredPath)) restoreStore.setDesiredTarget(null);

  if (clearWorkTarget) await clearWorkspaceDocument();

  const latestNavigation = useWorkColumnStore.getState().navigation;
  if (workTargetIsInside(latestNavigation.previousTarget)) {
    useWorkspaceSessionStore.getState().updateSession(getSessionId('column-1'), (session) => ({ ...session,
      navigation: { ...session.navigation, transaction: { ...session.navigation.transaction, previousTarget: null } },
    }));
  }
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
    const applied = replaceWorkspaceDocumentPath({
      kind: 'md',
      path: previous,
      displayId,
    }, next);
    if (!applied) return;
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
export async function openPluginWorkbench(plugin: PluginDescriptor, history: 'push' | 'skip' = 'push'): Promise<void> {
  await runNavigation(
    { kind: 'plugin-workbench', plugin },
    async (requestId) => {
      await getWorkspaceDocumentState().clearDocument();
      if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
      getWorkspaceMemoState().setActiveFilter('all');
      getWorkspaceMemoState().setActivePluginId(plugin.manifest.id);
      if (!isCurrentNavigation(requestId)) return;
      commitNavigation(requestId, { kind: 'plugin-workbench', plugin }, history);
    },
    () => openPluginWorkbench(plugin, history),
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

/** The primary runtime can render the same file-browser target as the secondary runtime. */
export async function openWorkFileBrowserTarget(target: FileBrowserTarget, history: 'push' | 'skip', restoreRequestId?: number) {
  const prepared = await prepareCollectionBrowserTarget(target);
  if (prepared.kind !== 'file-browser' || !isRestoreRequestCurrent(restoreRequestId)) return;
  await runNavigation(prepared, async (requestId) => {
    await getWorkspaceDocumentState().clearDocument();
    if (!isCurrentNavigation(requestId)) return;
    commitNavigation(requestId, prepared, history);
    useWorkspaceFocusStore.getState().focusColumn('column-1');
  }, async () => { await openWorkFileBrowserTarget(target, history); });
}
