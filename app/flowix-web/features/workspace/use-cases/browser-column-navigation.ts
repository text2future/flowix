import { collections, externalDocuments, notebooks } from '@platform/tauri/client';
import { collectionNotebookId } from '@features/collection/mutations';
import { parseCollectionEnvelope } from '@features/collection/model';
import { ensureCollectionDisplay, bindCollectionDisplayPath } from '@/lib/collection-display-registry';
import { captureFileBrowserContext } from './file-browser-context';
import type { FileBrowserTarget } from '../store/file-browser-target';
import { canonicalDirectoryPath, canonicalPath, fileLocatorKey } from '@/lib/path';
import { displayTitleFromFilename } from '@/lib/utils';
import { canonicalUrl, contentIdentityKey } from '@features/workspace/store/workspace-content-identity';
import {
  canMoveBrowserColumnTargetToWorkColumn,
  useBrowserColumnStore,
  type BrowserColumnOpenDisposition,
  type BrowserColumnTab,
  type BrowserColumnTarget,
} from '@features/workspace/store/browser-column-store';
import type { WorkColumnTarget } from '@features/workspace/store/work-column-target';
import {
  activateExistingWorkspaceContent,
  activateExistingWorkspaceContentAsync,
  findExistingWorkspaceContent,
  browserColumnTargetIdentity,
  workColumnTargetIdentity,
} from './workspace-content-activation';
import {
  enqueueBrowserColumnNavigation,
} from './browser-column-coordinator';
import {
  openCollectionTarget,
  openAgentTarget,
  openExternalTarget,
  openMediaTarget,
  openWebTarget,
  closeAgentTarget,
  clearWorkspaceDocument,
  flushWorkspaceDocument,
} from './workspace-navigation';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import type { ContentIdentity } from '@features/workspace/store/workspace-content-identity';

export type BrowserColumnOpenResult =
  | { host: 'main-third'; alreadyOpen: true }
  | { host: 'browser-column'; tabId: string; alreadyOpen: boolean };

function openResult(
  location: ReturnType<typeof activateExistingWorkspaceContent>,
): BrowserColumnOpenResult | null {
  if (!location) return null;
  return location.host === 'main-third'
    ? { host: 'main-third', alreadyOpen: true }
    : { host: 'browser-column', tabId: location.tabId, alreadyOpen: true };
}

function targetTabTitle(target: BrowserColumnTarget): string {
  const filenameFromPath = (path: string) => path.split(/[\\/]/).pop() ?? path;

  switch (target.kind) {
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

function targetTabIcon(target: BrowserColumnTarget): string | null {
  if (target.kind !== 'web') return null;
  try {
    const parsed = new URL(target.url);
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

export function openBrowserColumnTarget(
  target: BrowserColumnTarget,
  disposition: BrowserColumnOpenDisposition = 'focus-existing',
): Promise<BrowserColumnOpenResult | null> {
  let id = target.kind === 'agent_conversation'
      ? `agent:${target.instanceId}`
      : target.kind === 'web'
        ? `web:${canonicalUrl(target.url) ?? target.url}`
    : target.kind === 'file-browser'
          ? target.activeFilePath ? fileLocatorKey(target.activeFilePath) : `file-browser:${target.folderPath}`
        : target.kind === 'media'
            ? fileLocatorKey(target.filePath)
          : 'empty';

  return enqueueBrowserColumnNavigation(async () => {
    target = await prepareCollectionBrowserTarget(target);
    if (target.kind === 'file-browser' && target.collectionDisplay) id = target.collectionDisplay.displayId;
    let moveWorkColumnTarget = false;
    if (disposition === 'focus-existing') {
      const existing = findExistingWorkspaceContent(browserColumnTargetIdentity(target));
      if (existing?.host === 'main-third') {
        const workTarget = useWorkColumnStore.getState().navigation.target;
        const workIdentity = workColumnTargetIdentity(workTarget);
        const requestedIdentity = browserColumnTargetIdentity(target);
        moveWorkColumnTarget = !!workIdentity
          && contentIdentityKey(workIdentity) === contentIdentityKey(requestedIdentity);
        if (!moveWorkColumnTarget) {
          activateExistingWorkspaceContent(browserColumnTargetIdentity(target));
          return openResult(existing);
        }
        // List-column "open in right" is a move when the same content is
        // already in the work column. Save before mounting the right-side copy.
        if (target.kind !== 'agent_conversation') await flushWorkspaceDocument();
        if (moveWorkColumnTarget) {
          const currentIdentity = workColumnTargetIdentity(useWorkColumnStore.getState().navigation.target);
          if (!currentIdentity || contentIdentityKey(currentIdentity) !== contentIdentityKey(requestedIdentity)) {
            return null;
          }
        }
      }
      if (existing?.host === 'browser-column') {
        const store = useBrowserColumnStore.getState();
        const existingTab = store.tabs.find((candidate) => candidate.id === existing.tabId);
        if (target.kind === 'file-browser') {
          if (existingTab?.target.kind === 'file-browser') {
            // Upgrade a standalone file tab to a file-browser tab in place.
            // The tab identity stays stable while the resource context and
            // tree preferences are added.
            store.updateFileBrowserContext(existing.tabId, {
              folderPath: target.folderPath,
              notebookId: target.notebookId,
              scopePath: target.scopePath,
            });
            if (target.activeFilePath) {
              store.selectFileBrowserFile(existing.tabId, target.activeFilePath, target.collectionDisplay);
            }
          }
        }
        store.commitTab(existing.tabId);
        if (moveWorkColumnTarget) {
          if (target.kind === 'agent_conversation') closeAgentTarget();
          else await clearWorkspaceDocument();
        }
        return { host: 'browser-column', tabId: existing.tabId, alreadyOpen: true };
      }
    }

    if (disposition === 'open-in-column') {
      const store = useBrowserColumnStore.getState();
      const key = contentIdentityKey(browserColumnTargetIdentity(target));
      const existing = store.tabs.find((tab) => contentIdentityKey(browserColumnTargetIdentity(tab.target)) === key);
      if (existing) {
        store.commitTab(existing.id);
        if (moveWorkColumnTarget) {
          if (target.kind === 'agent_conversation') closeAgentTarget();
          else await clearWorkspaceDocument();
        }
        return { host: 'browser-column', tabId: existing.id, alreadyOpen: true };
      }
    }
    // Directory opens reuse their browsing tab after file-identity lookup.
    // Independent file opens keep their own stable tabs.
    if (target.kind === 'file-browser' && target.folderPath && disposition !== 'replace-active') {
      const store = useBrowserColumnStore.getState();
      const folderTarget = target;
      const folderTab = store.tabs.find((tab) => tab.target.kind === 'file-browser'
        && tab.target.folderPath && canonicalPath(tab.target.folderPath) === canonicalPath(folderTarget.folderPath!)
        && tab.target.notebookId === folderTarget.notebookId);
      if (folderTab) {
        if (target.activeFilePath) store.selectFileBrowserFile(folderTab.id, target.activeFilePath, target.collectionDisplay);
        store.commitTab(folderTab.id);
        if (moveWorkColumnTarget) {
          await clearWorkspaceDocument();
        }
        return { host: 'browser-column', tabId: folderTab.id, alreadyOpen: true };
      }
    }
    const tabId = useBrowserColumnStore.getState().openTab({
      id,
      title: targetTabTitle(target),
      icon: targetTabIcon(target),
      target,
    }, disposition);
    if (moveWorkColumnTarget) {
      if (target.kind === 'agent_conversation') closeAgentTarget();
      else await clearWorkspaceDocument();
    }
    return { host: 'browser-column', tabId, alreadyOpen: false };
  });
}

export function createFileBrowserTarget(activeFilePath: string | null, scopePath: string | null = null, folderPath: string | null = null): FileBrowserTarget {
  return { kind: 'file-browser', activeFilePath, ...captureFileBrowserContext(activeFilePath, scopePath, folderPath) };
}

/** All file changes in an existing tab share the save-before-switch barrier. */
export function selectBrowserColumnFile(tabId: string, filePath: string | null, folderPath?: string): Promise<boolean | null> {
  const select = () => enqueueBrowserColumnNavigation(async () => {
    const state = useBrowserColumnStore.getState();
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab || tab.target.kind !== 'file-browser') return false;
    const existing = filePath ? state.tabs.find((candidate) => candidate.id !== tabId
      && candidate.target.kind === 'file-browser' && candidate.target.activeFilePath
      && canonicalPath(candidate.target.activeFilePath) === canonicalPath(filePath)) : null;
    if (existing) { state.commitTab(existing.id); return true; }
    if (folderPath !== undefined) state.switchFileBrowserFolder(tabId, folderPath);
    const prepared = await prepareCollectionBrowserTarget({ ...tab.target, activeFilePath: filePath, collectionDisplay: undefined });
    const location = findExistingWorkspaceContent(browserColumnTargetIdentity(prepared));
    if (location && !(location.host === 'browser-column' && location.tabId === tabId)) { activateExistingWorkspaceContent(browserColumnTargetIdentity(prepared)); return true; }
    state.selectFileBrowserFile(tabId, prepared.kind === 'file-browser' ? prepared.activeFilePath : filePath, prepared.kind === 'file-browser' ? prepared.collectionDisplay : undefined);
    return true;
  });
  if (!filePath) return select();

  const documentIdentity: ContentIdentity = { kind: 'external', path: filePath };
  const existing = findExistingWorkspaceContent(documentIdentity);
  if (!existing || (existing.host === 'browser-column' && existing.tabId === tabId)) {
    return select();
  }
  return activateExistingWorkspaceContentAsync(documentIdentity)
    .then((location) => location ? true : select());
}

export function openBrowserColumnMarkdown(filePath: string): Promise<BrowserColumnOpenResult | null> {
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

export function openBrowserColumnText(filePath: string, scopePath: string | null): Promise<BrowserColumnOpenResult | null> {
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
  }, 'open-in-column');
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

/** Move the currently displayed work-column target into the right browser column. */
export function openWorkColumnTargetInBrowserColumn(
  target: WorkColumnTarget,
): Promise<BrowserColumnOpenResult | null> {
  const browserTarget: BrowserColumnTarget | null = (() => {
    switch (target.kind) {
      case 'media':
        return {
          kind: 'media',
          filePath: target.filePath,
          notebookId: target.notebookId ?? '',
          notebookPath: target.notebookPath ?? '',
          resourceKind: target.resourceKind,
        };
      case 'collection':
        return { ...createFileBrowserTarget(target.filePath, target.notebookPath), notebookId: target.notebookId, collectionDisplay: target };
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

    // Flush the work-column editor before the BrowserColumn mounts its own
    // document surface. This action moves the document; it must not leave two
    // independently editable copies open in separate columns.
    if (target.kind !== 'agent-conversation') await flushWorkspaceDocument();
    if (!isStillCurrentTarget()) return null;

    const id = browserTarget.kind === 'agent_conversation'
        ? `agent:${browserTarget.instanceId}`
        : browserTarget.kind === 'web'
          ? `web:${canonicalUrl(browserTarget.url) ?? browserTarget.url}`
          : browserTarget.kind === 'file-browser' ? browserTarget.collectionDisplay ? browserTarget.collectionDisplay.displayId : browserTarget.activeFilePath ? fileLocatorKey(browserTarget.activeFilePath) : `file-browser:${browserTarget.folderPath}` : 'empty';
    const tabId = useBrowserColumnStore.getState().openTab({
      id,
      title: targetTabTitle(browserTarget),
      icon: targetTabIcon(browserTarget),
      target: browserTarget,
    });
    if (target.kind === 'agent-conversation') {
      closeAgentTarget();
    } else {
      await clearWorkspaceDocument();
    }
    return { host: 'browser-column', tabId, alreadyOpen: false };
  });
}

function restoreBrowserColumnTab(
  tab: BrowserColumnTab,
  originalIndex: number,
  originalActiveTabId: string | null,
): void {
  const store = useBrowserColumnStore.getState();
  if (!store.tabs.some((candidate) => candidate.id === tab.id)) {
    store.openTab(tab);
  }

  const restored = useBrowserColumnStore.getState();
  const currentIndex = restored.tabs.findIndex((candidate) => candidate.id === tab.id);
  if (currentIndex >= 0 && currentIndex !== originalIndex) {
    const beforeTabId = restored.tabs[originalIndex]?.id ?? null;
    restored.reorderTab(tab.id, beforeTabId === tab.id ? null : beforeTabId);
  }

  const activeTabStillExists = originalActiveTabId !== null
    && useBrowserColumnStore.getState().tabs.some((candidate) => candidate.id === originalActiveTabId);
  if (activeTabStillExists) {
    useBrowserColumnStore.getState().commitTab(originalActiveTabId);
  }
}

/** Move a BrowserColumn tab to the left work column. */
export function openBrowserColumnTabInWorkColumn(tabId: string): Promise<boolean | null> {
  return enqueueBrowserColumnNavigation(async () => {
    const before = useBrowserColumnStore.getState();
    const originalIndex = before.tabs.findIndex((tab) => tab.id === tabId);
    if (originalIndex < 0) return false;
    const tab = before.tabs[originalIndex];
    if (!canMoveBrowserColumnTargetToWorkColumn(tab.target)) return false;
    const originalActiveTabId = before.activeTabId;

    // Remove the tab before invoking the normal work-column navigation
    // facade. Its duplicate detection must see the target as no longer owned
    // by the BrowserColumn, otherwise it would simply reactivate this tab.
    useBrowserColumnStore.getState().closeTab(tabId);

    try {
      switch (tab.target.kind) {
        case 'file-browser':
          if (tab.target.collectionDisplay) {
            await openCollectionTarget(tab.target.collectionDisplay);
          } else if (tab.target.activeFilePath) {
            await openExternalTarget(tab.target.activeFilePath, {
              destination: 'main-third',
              scopePath: tab.target.scopePath,
              fileBrowser: tab.target,
            });
          }
          break;
        case 'media':
          await openMediaTarget({
            filePath: tab.target.filePath,
            notebookId: tab.target.notebookId,
            notebookPath: tab.target.notebookPath,
            resourceKind: tab.target.resourceKind,
          });
          break;
        case 'web':
          await openWebTarget(tab.target.url);
          break;
        case 'agent_conversation':
          await openAgentTarget(tab.target.instanceId);
          break;
      }
      useWorkspaceFocusStore.getState().focusHost('main-third');
      return true;
    } catch (error) {
      restoreBrowserColumnTab(tab, originalIndex, originalActiveTabId);
      throw error;
    }
  });
}

/** Remove path-owned Markdown tabs after their document buffers were flushed. */
export function removeBrowserColumnTabsByPath(path: string): string[] {
  const wanted = canonicalPath(path);
  const state = useBrowserColumnStore.getState();
  const matching = state.tabs.filter((tab) => {
    const tabPath = tab.target.kind === 'file-browser' ? tab.target.activeFilePath : null;
    return !!tabPath && canonicalPath(tabPath) === wanted;
  });
  for (const tab of matching) useBrowserColumnStore.getState().closeTab(tab.id);
  return matching.map((tab) => tab.id);
}

/** Resolve identity before a browser surface can mount. */
async function prepareCollectionBrowserTarget(target: BrowserColumnTarget): Promise<BrowserColumnTarget> {
  if (target.kind !== 'file-browser' || !target.activeFilePath || !/\.(table|lib)\.ya?ml$/i.test(target.activeFilePath)) return target;
  const registered = (await notebooks.getAll()).find((notebook) => target.notebookId ? notebook.id === target.notebookId : canonicalPath(target.activeFilePath!).startsWith(`${canonicalDirectoryPath(notebook.path)}/`));
  const root = registered ? canonicalDirectoryPath(registered.path) : null;
  if (!root) throw new Error('集合需要笔记本上下文');
  const notebookId = await collectionNotebookId(root, target.notebookId);
  const envelope = target.collectionDisplay ? null : parseCollectionEnvelope(await externalDocuments.read(target.activeFilePath, root));
  const collectionId = target.collectionDisplay?.collectionId ?? envelope!.collection.id;
  const item = await collections.resolve(notebookId, collectionId);
  if (item.identityConflict || item.parseState !== 'valid') throw new Error('集合身份冲突或格式暂不可用');
  const display = ensureCollectionDisplay({ notebookId, collectionId, viewId: target.collectionDisplay?.viewId ?? null }, target.collectionDisplay?.displayId);
  const path = `${root.replace(/\/$/, '')}/${item.relativePath}`;
  bindCollectionDisplayPath(display.displayId, path, item.indexSequence);
  return { ...target, notebookId, scopePath: root, activeFilePath: path, collectionDisplay: display, collectionUnavailableReason: undefined };
}
