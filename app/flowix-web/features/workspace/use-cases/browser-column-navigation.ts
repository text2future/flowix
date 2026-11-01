import type { BrowserColumnNavigationResult } from '../model/surface-opening';
import { collections, externalDocuments, notebooks } from '@platform/tauri/client';
import { collectionNotebookId } from '@features/collection/mutations';
import { parseCollectionDocumentV2, type CollectionType } from '@features/collection/model';
import { inspectCollectionRecoveryType } from '@features/collection/recovery';
import { ensureCollectionDisplay, bindCollectionDisplayPath } from '@/lib/collection-display-registry';
import { captureFileBrowserContext, resolveFileBrowserContext } from './file-browser-context';
import type { FileBrowserTarget } from '../store/file-browser-target';
import { canonicalDirectoryPath, canonicalPath } from '@/lib/path';
import { displayTitleFromFilename } from '@/lib/utils';
import { canonicalUrl, contentIdentityKey } from '@features/workspace/store/workspace-content-identity';
import {
  useBrowserColumnStore,
  type BrowserColumnTarget,
} from '@features/workspace/store/browser-column-store';
import type { WorkColumnTarget } from '@features/workspace/store/work-column-target';
import {
  findWorkspaceContentLocations,
  browserColumnTargetIdentity,
  workColumnTargetIdentity,
} from './workspace-content-activation';
import {
  enqueueBrowserColumnNavigation,
} from './browser-column-coordinator';
import {
  prepareActiveWorkColumnDocumentLeave,
} from './workspace-navigation';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';

export type BrowserColumnOpenResult = NonNullable<BrowserColumnNavigationResult>;
export type BrowserTargetOpenResult = BrowserColumnOpenResult;

function targetContentTitle(target: BrowserColumnTarget): string {
  const filenameFromPath = (path: string) => path.split(/[\\/]/).pop() ?? path;

  switch (target.kind) {
    case 'folder-collection':
      return target.folderName || target.folderPath.split(/[\\/]/).filter(Boolean).pop() || '文件夹集合';
    case 'media':
      return filenameFromPath(target.filePath);
    case 'file-browser':
      return displayTitleFromFilename(filenameFromPath(target.activeFilePath ?? target.folderPath ?? '')) || '文件';
    case 'web':
      try {
        return new URL(target.url).hostname || target.url;
      } catch {
        return target.url;
      }
    case 'agent_conversation':
      return 'Agent 会话';
  }
}

function targetContentIcon(target: BrowserColumnTarget): string | null {
  if (target.kind !== 'web') return null;
  try {
    const parsed = new URL(target.url);
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

export function openBrowserColumnTarget(target: BrowserColumnTarget): Promise<BrowserColumnNavigationResult> {
  return enqueueBrowserColumnNavigation(async () => {
    target = await prepareCollectionBrowserTarget(target);
    const alreadyOpen = !!findWorkspaceContentLocations(browserColumnTargetIdentity(target)).browserColumn;
    const id = `browser:${crypto.randomUUID()}`;
    const surfaceId = useBrowserColumnStore.getState().openContent({
      id,
      title: targetContentTitle(target),
      icon: targetContentIcon(target),
      target,
    });
    return { host: 'browser-column', surfaceId, alreadyOpen };
  });
}

export function createFileBrowserTarget(activeFilePath: string | null, scopePath: string | null = null, folderPath: string | null = null): FileBrowserTarget {
  return { kind: 'file-browser', activeFilePath, ...captureFileBrowserContext(activeFilePath, scopePath, folderPath) };
}

/** All file changes in the current surface share the save-before-switch barrier. */
export function selectBrowserColumnFile(surfaceId: string, filePath: string | null, folderPath?: string): Promise<boolean | null> {
  // Validate the event's owner when it is received. Two clicks from the same
  // mounted tree may queue before the first navigation retires that surface.
  const entry = useBrowserColumnStore.getState().current;
  if (entry?.id !== surfaceId || entry.target.kind !== 'file-browser') return Promise.resolve(false);
  const target = { ...entry.target,
    ...(folderPath !== undefined ? { folderPath } : {}), activeFilePath: filePath,
    collectionDisplay: undefined, collectionType: undefined, collectionUnavailableReason: undefined };
  return enqueueBrowserColumnNavigation(async () => {
    const prepared = await prepareCollectionBrowserTarget(target);
    useBrowserColumnStore.getState().openContent({ ...entry, target: prepared, title: targetContentTitle(prepared) });
    return true;
  });
}

/** History movement crosses exactly the same save and target-resolution barrier as opens. */
export function navigateBrowserColumnHistory(direction: 'back' | 'forward'): Promise<boolean | null> {
  return enqueueBrowserColumnNavigation(async () => {
    const state = useBrowserColumnStore.getState();
    const stack = direction === 'back' ? state.backStack : state.forwardStack;
    const entry = stack[stack.length - 1];
    if (!entry) return false;
    const target = await prepareCollectionBrowserTarget(entry.target);
    state.restoreHistoryEntry({ ...entry, target }, direction);
    return true;
  });
}

export function openBrowserColumnMarkdown(filePath: string): Promise<BrowserColumnOpenResult | null> {
  return openBrowserColumnTarget(createFileBrowserTarget(filePath));
}

/** An external drop explicitly targets the browser column, even if the file is open elsewhere. */
export function openBrowserColumnDroppedFile(filePath: string): Promise<BrowserColumnOpenResult | null> {
  return openBrowserColumnTarget(createFileBrowserTarget(filePath));
}

export function openBrowserColumnNotebookNote(
  filePath: string,
  notebookId: string,
  notebookPath: string,
): Promise<BrowserColumnOpenResult | null> {
  return openBrowserColumnTarget({
    ...createFileBrowserTarget(filePath, notebookPath),
    notebookId,
  });
}

export function openBrowserColumnText(
  filePath: string,
  scopePath: string | null,
): Promise<BrowserColumnOpenResult | null> {
  return openBrowserColumnTarget(createFileBrowserTarget(filePath, scopePath));
}

export function openBrowserColumnMedia(
  filePath: string,
  notebookId: string,
  notebookPath: string,
  resourceKind: 'image' | 'video',
): Promise<BrowserColumnOpenResult | null> {
  return openBrowserColumnTarget({
    kind: 'media',
    filePath,
    notebookId,
    notebookPath,
    resourceKind,
  });
}

export function openBrowserColumnFileBrowser(
  folderPath: string,
  activeFilePath: string | null = null,
): Promise<BrowserColumnOpenResult | null> {
  return openBrowserColumnTarget(createFileBrowserTarget(activeFilePath, folderPath, folderPath));
}

export function openBrowserColumnWebpage(url: string): Promise<BrowserColumnOpenResult | null> {
  const normalized = canonicalUrl(url);
  if (!normalized) return Promise.reject(new Error(`Unsupported webpage URL: ${url}`));
  return openBrowserColumnTarget({ kind: 'web', url: normalized });
}

export function openBrowserColumnAgentConversation(instanceId: string): Promise<BrowserColumnOpenResult | null> {
  return openBrowserColumnTarget({ kind: 'agent_conversation', instanceId });
}

/** Open the currently displayed work-column target in the right browser column. */
export function openWorkColumnTargetInBrowserColumn(
  target: WorkColumnTarget,
): Promise<BrowserColumnOpenResult | null> {
  const browserTarget: BrowserColumnTarget | null = (() => {
  switch (target.kind) {
    case 'folder-collection': return { kind: 'folder-collection', notebookId: target.notebookId,
      notebookPath: target.notebookPath, folderPath: target.folderPath, folderName: target.folderName, viewMode: target.viewMode };
      case 'media':
        return {
          kind: 'media',
          filePath: target.filePath,
          notebookId: target.notebookId ?? '',
          notebookPath: target.notebookPath ?? '',
          resourceKind: target.resourceKind,
        };
      case 'table':
      case 'media-library':
        return { ...createFileBrowserTarget(target.filePath, target.notebookPath), notebookId: target.notebookId };
      case 'collection':
        return { ...createFileBrowserTarget(target.filePath, target.notebookPath), notebookId: target.notebookId, collectionDisplay: target, collectionType: target.collectionType };
      case 'external':
        return { ...createFileBrowserTarget(target.path, target.scopePath), ...target.fileBrowser };
      case 'agent-conversation':
        return { kind: 'agent_conversation', instanceId: target.instanceId };
      case 'web':
        return { kind: 'web', url: target.url };
      default:
        return null;
    }
  })();

  if (!browserTarget) return Promise.resolve(null);

  return enqueueBrowserColumnNavigation(async () => {
    const isStillCurrentTarget = () => {
      const identity = workColumnTargetIdentity(target);
      const currentIdentity = workColumnTargetIdentity(useWorkColumnStore.getState().navigation.target);
      return !!identity && !!currentIdentity
        && contentIdentityKey(identity) === contentIdentityKey(currentIdentity);
    };
    if (!isStillCurrentTarget()) {
      return null;
    }

    // This legacy transfer opens the current Work content as a second view.
    if (target.kind !== 'agent-conversation') await prepareActiveWorkColumnDocumentLeave();
    if (!isStillCurrentTarget()) return null;

    const preparedTarget = await prepareCollectionBrowserTarget(browserTarget);
    if (!isStillCurrentTarget()) return null;

    const id = `browser:${crypto.randomUUID()}`;
    const existingContent = findWorkspaceContentLocations(
      browserColumnTargetIdentity(preparedTarget),
    ).browserColumn;
    const surfaceId = useBrowserColumnStore.getState().openContent({
      id,
      title: targetContentTitle(preparedTarget),
      icon: targetContentIcon(preparedTarget),
      target: preparedTarget,
    });
    return { host: 'browser-column', surfaceId, alreadyOpen: !!existingContent };
  });
}

/** Remove path-owned content and history after their document buffers were flushed. */
export function removeBrowserColumnContentByPath(path: string): string[] {
  return useBrowserColumnStore.getState().removeContentByFilePath(path);
}

/** Resolve identity before a browser surface can mount. */
async function prepareCollectionBrowserTarget(target: BrowserColumnTarget): Promise<BrowserColumnTarget> {
  if (target.kind === 'file-browser') {
    target = { ...target, ...resolveFileBrowserContext(target.activeFilePath, target) };
  }
  if (target.kind !== 'file-browser' || !target.activeFilePath || (!target.collectionDisplay && !/(?:\.(table|lib)\.ya?ml|\.index\.yaml)$/i.test(target.activeFilePath))) return target.kind === 'file-browser' ? { ...target, collectionType: undefined, collectionUnavailableReason: undefined } : target;
  const registered = (await notebooks.getAll()).find((notebook) => target.notebookId ? notebook.id === target.notebookId : canonicalPath(target.activeFilePath!).startsWith(`${canonicalDirectoryPath(notebook.path)}/`));
  const root = registered ? canonicalDirectoryPath(registered.path) : null;
  if (!root) throw new Error('集合需要笔记本上下文');
  const notebookId = await collectionNotebookId(root, target.notebookId);
  let envelope: ReturnType<typeof parseCollectionDocumentV2> | null = null;
  if (!target.collectionDisplay) {
    const source = await externalDocuments.read(target.activeFilePath, root);
    try { envelope = parseCollectionDocumentV2(source); }
    catch {
      return { ...target, notebookId, scopePath: root, collectionType: inspectCollectionRecoveryType(source, target.activeFilePath), collectionUnavailableReason: '集合文件格式无效' };
    }
  }
  const collectionId = target.collectionDisplay?.collectionId ?? envelope!.collection.id;
  let item: Awaited<ReturnType<typeof collections.resolve>>;
  try { item = await collections.resolve(notebookId, collectionId); }
  catch {
    return { ...target, notebookId, scopePath: root, collectionType: target.collectionType ?? (envelope?.collection.type as CollectionType | undefined) ?? 'table', collectionUnavailableReason: '集合不存在或暂时无法读取' };
  }
  if (item.identityConflict) throw new Error('集合身份冲突或格式暂不可用');
  if (item.parseState !== 'valid') return { ...target, notebookId, scopePath: root, collectionType: item.collectionType, collectionUnavailableReason: '集合文件格式无效' };
  const display = ensureCollectionDisplay({ notebookId, collectionId, viewId: target.collectionDisplay?.viewId ?? null }, target.collectionDisplay?.displayId);
  const path = `${root.replace(/\/$/, '')}/${item.relativePath}`;
  bindCollectionDisplayPath(display.displayId, path, item.indexSequence);
  return { ...target, notebookId, scopePath: root, activeFilePath: path, collectionDisplay: display, collectionType: item.collectionType, collectionUnavailableReason: undefined };
}
