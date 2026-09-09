import { captureFileBrowserContext } from './file-browser-context';
import type { FileBrowserTarget } from '../store/file-browser-target';
import { canonicalPath } from '@/lib/path';
import { displayTitleFromFilename } from '@/lib/utils';
import { joinNotebookMemoPath } from '@/lib/path';
import { canonicalUrl, contentIdentityKey } from '@features/workspace/store/workspace-content-identity';
import type { MemoItem, Notebook } from '@features/memo';
import { memos as memosClient } from '@platform/tauri/client';
import {
  getPluginNoteInfo,
  type PluginArtifactRendererId,
} from '@features/plugin/plugin-note';
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
} from './workspace-content-activation';
import {
  enqueueBrowserColumnNavigation,
  flushActiveBrowserColumnDocument,
} from './browser-column-coordinator';
import {
  openAgentTarget,
  openArtifactTarget,
  openExternalTarget,
  openMemoTarget,
  openWebTarget,
  closeAgentTarget,
} from './workspace-navigation';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';

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
    case 'memo':
      return displayTitleFromFilename(filenameFromPath(target.filePath));
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
    case 'artifact':
      return '插件产物';
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
  const id = target.kind === 'memo'
    ? `memo:${target.memoId}`
    : target.kind === 'agent_conversation'
      ? `agent:${target.instanceId}`
      : target.kind === 'web'
        ? `web:${canonicalUrl(target.url) ?? target.url}`
        : target.kind === 'file-browser'
          ? target.activeFilePath ? `file:${canonicalPath(target.activeFilePath)}` : `file-browser:${target.folderPath}`
        : target.kind === 'artifact'
          ? `artifact:${target.pointerMemoId}`
          : 'empty';

  return enqueueBrowserColumnNavigation(async () => {
    if (disposition === 'focus-existing') {
      const existing = findExistingWorkspaceContent(browserColumnTargetIdentity(target));
      if (existing?.host === 'main-third') {
        activateExistingWorkspaceContent(browserColumnTargetIdentity(target));
        return openResult(existing);
      }
      if (existing?.host === 'browser-column') {
        const store = useBrowserColumnStore.getState();
        if (target.kind === 'file-browser') {
          const existingTab = store.tabs.find((candidate) => candidate.id === existing.tabId);
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
              store.selectFileBrowserFile(existing.tabId, target.activeFilePath);
            }
          }
        }
        store.commitTab(existing.tabId);
        return { host: 'browser-column', tabId: existing.tabId, alreadyOpen: true };
      }
    }

    if (disposition === 'open-in-column') {
      const store = useBrowserColumnStore.getState();
      const key = contentIdentityKey(browserColumnTargetIdentity(target));
      const existing = store.tabs.find((tab) => contentIdentityKey(browserColumnTargetIdentity(tab.target)) === key);
      if (existing) {
        store.commitTab(existing.id);
        return { host: 'browser-column', tabId: existing.id, alreadyOpen: true };
      }
    }
    // Directory opens reuse their browsing tab after file-identity lookup.
    // Independent file opens keep their own stable tabs.
    if (target.kind === 'file-browser' && target.folderPath && disposition !== 'replace-active') {
      const store = useBrowserColumnStore.getState();
      const folderTab = store.tabs.find((tab) => tab.target.kind === 'file-browser'
        && tab.target.folderPath && canonicalPath(tab.target.folderPath) === canonicalPath(target.folderPath!)
        && tab.target.notebookId === target.notebookId);
      if (folderTab) {
        if (target.activeFilePath) store.selectFileBrowserFile(folderTab.id, target.activeFilePath);
        store.commitTab(folderTab.id);
        return { host: 'browser-column', tabId: folderTab.id, alreadyOpen: true };
      }
    }
    const tabId = useBrowserColumnStore.getState().openTab({
      id,
      title: targetTabTitle(target),
      icon: targetTabIcon(target),
      target,
    }, disposition);
    return { host: 'browser-column', tabId, alreadyOpen: false };
  });
}

export function openBrowserColumnMemo(
  memo: MemoItem,
  notebook: Notebook | null,
  disposition: BrowserColumnOpenDisposition = 'open-in-column',
): Promise<BrowserColumnOpenResult | null> {
  const pluginNote = getPluginNoteInfo(memo);
  if (pluginNote) {
    return openBrowserColumnTarget({
      kind: 'artifact',
      pointerMemoId: memo.id,
      renderer: pluginNote.renderer,
    }, disposition);
  }

  const filePath = notebook?.path
    ? joinNotebookMemoPath(notebook.path, memo.relativePath || memo.filename) ?? (memo.relativePath || memo.filename)
    : memo.relativePath || memo.filename;

  return openBrowserColumnTarget({
    kind: 'memo',
    memoId: memo.id,
    notebookId: notebook?.id ?? '',
    notebookPath: notebook?.path ?? '',
    filePath,
  }, disposition);
}

export async function openBrowserColumnMemoById(memoId: string): Promise<BrowserColumnOpenResult> {
  const identity = { kind: 'memo' as const, memoId };
  const existing = await activateExistingWorkspaceContentAsync(identity);
  if (!existing && findExistingWorkspaceContent(identity)) {
    throw new Error(`Memo tab activation was cancelled: ${memoId}`);
  }
  const result = openResult(existing);
  if (result) return result;

  // `MemoItem` deliberately has no notebook field. Resolving the path from
  // the selected notebook would open a background-created memo in the wrong
  // notebook, so use the backend's authoritative memo session response.
  const session = await memosClient.openMemoSession(memoId);
  if (!session) throw new Error(`Memo is unavailable: ${memoId}`);

  const pluginNote = getPluginNoteInfo(session.memo);
  const opened = await openBrowserColumnTarget(pluginNote
    ? {
        kind: 'artifact',
        pointerMemoId: session.memo.id,
        renderer: pluginNote.renderer,
      }
    : {
        kind: 'memo',
        memoId: session.memo.id,
        notebookId: session.notebookId,
        notebookPath: session.notebookPath,
        filePath: session.path,
      });
  if (!opened) throw new Error(`Memo tab activation was cancelled: ${memoId}`);
  return opened;
}

export function createFileBrowserTarget(activeFilePath: string | null, scopePath: string | null = null, folderPath: string | null = null): FileBrowserTarget {
  return { kind: 'file-browser', activeFilePath, ...captureFileBrowserContext(activeFilePath, scopePath, folderPath) };
}

/** All file changes in an existing tab share the save-before-switch barrier. */
export function selectBrowserColumnFile(tabId: string, filePath: string | null, folderPath?: string): Promise<boolean | null> {
  return enqueueBrowserColumnNavigation(() => {
    const state = useBrowserColumnStore.getState();
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab || tab.target.kind !== 'file-browser') return false;
    const existing = filePath ? state.tabs.find((candidate) => candidate.id !== tabId
      && candidate.target.kind === 'file-browser' && candidate.target.activeFilePath
      && canonicalPath(candidate.target.activeFilePath) === canonicalPath(filePath)) : null;
    if (existing) { state.commitTab(existing.id); return true; }
    if (folderPath !== undefined) state.switchFileBrowserFolder(tabId, folderPath);
    state.selectFileBrowserFile(tabId, filePath);
    return true;
  });
}

export function openBrowserColumnMarkdown(filePath: string): Promise<BrowserColumnOpenResult | null> {
  return openBrowserColumnTarget(createFileBrowserTarget(filePath));
}

export function openBrowserColumnArtifact(
  pointerMemoId: string,
  renderer: PluginArtifactRendererId | null,
): Promise<BrowserColumnOpenResult | null> {
  return openBrowserColumnTarget({ kind: 'artifact', pointerMemoId, renderer });
}

export function openBrowserColumnText(filePath: string, scopePath: string): Promise<BrowserColumnOpenResult | null> {
  return openBrowserColumnTarget(createFileBrowserTarget(filePath, scopePath));
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

/** Open the currently displayed work-column target in the right browser column.
 *
 * This intentionally bypasses the normal cross-host duplicate check: the
 * action is explicitly a split view, so the same target may stay open in the
 * work column while also being opened as a browser-column tab.
 */
export function openWorkColumnTargetInBrowserColumn(
  target: WorkColumnTarget,
): Promise<BrowserColumnOpenResult | null> {
  const browserTarget: BrowserColumnTarget | null = (() => {
    switch (target.kind) {
      case 'memo':
        return {
          kind: 'memo',
          memoId: target.memoId,
          notebookId: target.notebookId ?? '',
          notebookPath: target.notebookPath ?? '',
          filePath: target.path,
        };
      case 'external':
        return { ...createFileBrowserTarget(target.path, target.scopePath), ...target.fileBrowser };
      case 'artifact':
        return {
          kind: 'artifact',
          pointerMemoId: target.pointerMemoId,
          renderer: target.renderer,
        };
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
    const id = browserTarget.kind === 'memo'
      ? `memo:${browserTarget.memoId}`
      : browserTarget.kind === 'agent_conversation'
        ? `agent:${browserTarget.instanceId}`
        : browserTarget.kind === 'web'
          ? `web:${canonicalUrl(browserTarget.url) ?? browserTarget.url}`
          : browserTarget.kind === 'artifact'
            ? `artifact:${browserTarget.pointerMemoId}`
            : browserTarget.kind === 'file-browser' ? browserTarget.activeFilePath ? `file:${canonicalPath(browserTarget.activeFilePath)}` : `file-browser:${browserTarget.folderPath}` : 'empty';
    const tabId = useBrowserColumnStore.getState().openTab({
      id,
      title: targetTabTitle(browserTarget),
      icon: targetTabIcon(browserTarget),
      target: browserTarget,
    });
    if (target.kind === 'agent-conversation') {
      closeAgentTarget();
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
        case 'memo':
          await openMemoTarget({
            memoId: tab.target.memoId,
            path: tab.target.filePath,
            notebookId: tab.target.notebookId || null,
            notebookPath: tab.target.notebookPath || null,
          });
          break;
        case 'file-browser':
          if (tab.target.activeFilePath) {
            await openExternalTarget(tab.target.activeFilePath, {
              destination: 'main-third',
              scopePath: tab.target.scopePath,
              fileBrowser: tab.target,
            });
          }
          break;
        case 'web':
          await openWebTarget(tab.target.url);
          break;
        case 'artifact':
          await openArtifactTarget({
            pointerMemoId: tab.target.pointerMemoId,
            renderer: tab.target.renderer,
          });
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

/** Keep durable BrowserColumn memo targets aligned with backend renames. */
export function replaceBrowserColumnMemoPath(memoId: string, path: string): void {
  useBrowserColumnStore.getState().replaceMemoPath(memoId, path);
}

/** Remove both a memo tab and any artifact tab pointing at that memo. */
export function removeBrowserColumnTabsByMemoId(memoId: string): string[] {
  return useBrowserColumnStore.getState().removeTabsByMemoId(memoId);
}

/** Flush only when the memo being deleted owns the active BrowserColumn tab. */
export function flushBrowserColumnMemo(memoId: string): Promise<boolean | null> {
  return enqueueBrowserColumnNavigation(async () => {
    const active = useBrowserColumnStore.getState().tabs.find(
      (tab) => tab.id === useBrowserColumnStore.getState().activeTabId,
    );
    const ownsMemo = active?.target.kind === 'memo'
      ? active.target.memoId === memoId
      : active?.target.kind === 'artifact'
        ? active.target.pointerMemoId === memoId
        : false;
    return !ownsMemo || await flushActiveBrowserColumnDocument();
  }, { flush: false });
}
