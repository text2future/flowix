import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  canMoveBrowserColumnTargetToWorkColumn,
  useBrowserColumnStore,
  type BrowserColumnTab,
} from '@features/workspace/store/browser-column-store';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';
import {
  activateBrowserColumnTab,
  discardActiveBrowserColumnDocument,
  enqueueBrowserColumnNavigation,
  registerBrowserColumnDocumentFlush,
} from '@features/workspace/use-cases/browser-column-coordinator';
import {
  openBrowserColumnMarkdown,
  openBrowserColumnTabInWorkColumn,
} from '@features/workspace/use-cases/browser-column-navigation';

export {
  canMoveBrowserColumnTargetToWorkColumn,
  type BrowserColumnTab,
};

export function useBrowserColumnViewModel() {
  return useBrowserColumnStore(useShallow((state) => {
    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
    const activeMemoId = activeTab?.target.kind === 'memo' ? activeTab.target.memoId : null;
    return {
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      activeTab,
      activeWebRuntime: state.activeTabId && activeTab?.target.kind === 'web'
        ? state.webRuntimes[state.activeTabId] ?? null
        : null,
      activeMemoHasDuplicateTab: activeMemoId !== null
        && state.tabs.filter(
          (tab) => tab.target.kind === 'memo' && tab.target.memoId === activeMemoId,
        ).length > 1,
    };
  }));
}

export function useBrowserColumnFocusViewModel() {
  const isFocused = useWorkspaceFocusStore(
    (state) => state.focusedHostId === 'browser-column',
  );
  const focusHost = useWorkspaceFocusStore((state) => state.focusHost);
  const focusBrowserColumn = useCallback(() => focusHost('browser-column'), [focusHost]);
  return { isFocused, focusBrowserColumn };
}

export const selectBrowserColumnTab = activateBrowserColumnTab;
export const registerBrowserColumnFlush = registerBrowserColumnDocumentFlush;
export const openBrowserColumnTabInMainWorkColumn = openBrowserColumnTabInWorkColumn;
export const openMarkdownInBrowserColumn = openBrowserColumnMarkdown;

export function hideBrowserColumn(): void {
  useBrowserColumnStore.getState().setVisible(false);
}

export function reorderBrowserColumnTab(tabId: string, beforeTabId: string | null): void {
  useBrowserColumnStore.getState().reorderTab(tabId, beforeTabId);
}

function browserColumnTabExists(tabId: string): boolean {
  return useBrowserColumnStore.getState().tabs.some((tab) => tab.id === tabId);
}

export function closeBrowserColumnTab(
  tabId: string,
  options?: { discardChanges?: boolean },
): Promise<boolean | null> {
  const closesActiveTab = useBrowserColumnStore.getState().activeTabId === tabId;
  if (options?.discardChanges && closesActiveTab) discardActiveBrowserColumnDocument();
  return enqueueBrowserColumnNavigation(() => {
    if (browserColumnTabExists(tabId)) useBrowserColumnStore.getState().closeTab(tabId);
    return true;
  }, {
    flush: closesActiveTab && !options?.discardChanges,
    silentFlush: true,
  });
}

export function closeOtherBrowserColumnTabs(
  tabId: string,
  options?: { discardChanges?: boolean },
): Promise<boolean | null> {
  const closesActiveTab = useBrowserColumnStore.getState().activeTabId !== tabId;
  if (options?.discardChanges && closesActiveTab) discardActiveBrowserColumnDocument();
  return enqueueBrowserColumnNavigation(() => {
    if (browserColumnTabExists(tabId)) useBrowserColumnStore.getState().closeOtherTabs(tabId);
    return true;
  }, {
    flush: closesActiveTab && !options?.discardChanges,
    silentFlush: true,
  });
}

export function closeBrowserColumnTabsToRight(
  tabId: string,
  options?: { discardChanges?: boolean },
): Promise<boolean | null> {
  const state = useBrowserColumnStore.getState();
  const targetIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  const activeIndex = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  const closesActiveTab = targetIndex >= 0 && activeIndex > targetIndex;
  if (options?.discardChanges && closesActiveTab) discardActiveBrowserColumnDocument();
  return enqueueBrowserColumnNavigation(() => {
    if (browserColumnTabExists(tabId)) useBrowserColumnStore.getState().closeTabsToRight(tabId);
    return true;
  }, {
    flush: closesActiveTab && !options?.discardChanges,
    silentFlush: true,
  });
}

export function closeAllBrowserColumnTabs(
  options?: { discardChanges?: boolean },
): Promise<boolean | null> {
  if (options?.discardChanges) discardActiveBrowserColumnDocument();
  return enqueueBrowserColumnNavigation(() => {
    useBrowserColumnStore.getState().closeAllTabs();
    return true;
  }, { flush: !options?.discardChanges, silentFlush: true });
}
