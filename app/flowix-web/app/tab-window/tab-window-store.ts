import { create } from 'zustand';
import type { WindowTab } from '@platform/tauri/client';

interface TabWindowState {
  tabs: WindowTab[];
  activeTabId: string | null;
  requestedTabId: string | null;
  hydrate: (tabs: WindowTab[]) => void;
  add: (tab: WindowTab) => void;
  request: (tabId: string) => void;
  commit: (tabId: string, preserveNewerRequest?: boolean) => void;
  rollbackRequest: () => void;
  update: (tabId: string, patch: Partial<Pick<WindowTab, 'title' | 'icon' | 'target'>>) => void;
  reorder: (tabId: string, beforeTabId: string | null) => void;
  remove: (tabId: string) => void;
  removeAndSelect: (tabId: string, selectedTabId: string) => void;
  reset: () => void;
}

export function adjacentTabId(tabs: WindowTab[], closingTabId: string): string | null {
  const index = tabs.findIndex((tab) => tab.id === closingTabId);
  if (index < 0) return null;
  return tabs[index - 1]?.id ?? tabs[index + 1]?.id ?? null;
}

export const useTabWindowStore = create<TabWindowState>((set) => ({
  tabs: [],
  activeTabId: null,
  requestedTabId: null,
  hydrate: (incoming) => set((state) => {
    const byId = new Map(state.tabs.map((tab) => [tab.id, tab]));
    for (const tab of incoming) byId.set(tab.id, { ...byId.get(tab.id), ...tab });
    const ids = [...new Set([...incoming.map((tab) => tab.id), ...state.tabs.map((tab) => tab.id)])];
    const tabs = ids.map((id) => byId.get(id)!);
    return {
      tabs,
      requestedTabId: state.requestedTabId ?? incoming[incoming.length - 1]?.id ?? null,
    };
  }),
  add: (tab) => set((state) => ({
    tabs: state.tabs.some((candidate) => candidate.id === tab.id)
      ? state.tabs.map((candidate) => candidate.id === tab.id ? { ...candidate, ...tab } : candidate)
      : [...state.tabs, tab],
  })),
  request: (tabId) => set((state) => state.tabs.some((tab) => tab.id === tabId)
    ? { requestedTabId: tabId }
    : state),
  commit: (tabId, preserveNewerRequest = false) => set((state) => ({
    activeTabId: tabId,
    // A newer request may have arrived while this tab was loading. Keep that
    // selection visible while the latest-wins worker advances to it.
    requestedTabId: preserveNewerRequest ? state.requestedTabId : tabId,
  })),
  rollbackRequest: () => set((state) => ({ requestedTabId: state.activeTabId })),
  update: (tabId, patch) => set((state) => ({
    tabs: state.tabs.map((tab) => tab.id === tabId ? { ...tab, ...patch } : tab),
  })),
  reorder: (tabId, beforeTabId) => set((state) => {
    const sourceIndex = state.tabs.findIndex((tab) => tab.id === tabId);
    if (sourceIndex < 0 || beforeTabId === tabId) return state;
    const tabs = [...state.tabs];
    const [tab] = tabs.splice(sourceIndex, 1);
    const targetIndex = beforeTabId
      ? tabs.findIndex((candidate) => candidate.id === beforeTabId)
      : tabs.length;
    tabs.splice(targetIndex < 0 ? tabs.length : targetIndex, 0, tab);
    return { tabs };
  }),
  remove: (tabId) => set((state) => {
    const tabs = state.tabs.filter((tab) => tab.id !== tabId);
    const activeTabId = state.activeTabId === tabId ? null : state.activeTabId;
    const requestedTabId = state.requestedTabId === tabId ? activeTabId : state.requestedTabId;
    return { tabs, activeTabId, requestedTabId };
  }),
  removeAndSelect: (tabId, selectedTabId) => set((state) => {
    const tabs = state.tabs.filter((tab) => tab.id !== tabId);
    const selection = tabs.some((tab) => tab.id === selectedTabId) ? selectedTabId : null;
    return { tabs, activeTabId: selection, requestedTabId: selection };
  }),
  reset: () => set({ tabs: [], activeTabId: null, requestedTabId: null }),
}));
