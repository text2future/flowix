import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { STORAGE_KEYS } from '../constants';

export type AppViewMode = 'ai' | 'write' | 'all';

export interface AppViewState {
  mode: AppViewMode;
  modeAll?: {
    w: number;
    h: number;
  };
}

export interface SettingsStore {
  reasoningCollapsed: boolean;
  appview: AppViewState;
  memoListVisible: boolean;
  agentPanelVisible: boolean;
  agentColWidth: number;
  setReasoningCollapsed: (collapsed: boolean) => void;
  toggleReasoningCollapsed: () => void;
  setAppViewMode: (mode: AppViewMode) => void;
  setAppViewModeAllSize: (size: { w: number; h: number }) => void;
  setMemoListVisible: (visible: boolean) => void;
  toggleMemoListVisible: () => void;
  setAgentPanelVisible: (visible: boolean) => void;
  toggleAgentPanelVisible: () => void;
  setAgentColWidth: (width: number) => void;
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      reasoningCollapsed: false,
      appview: {
        mode: 'all',
      },
      memoListVisible: true,
      agentPanelVisible: true,
      agentColWidth: 360,
      setReasoningCollapsed: (collapsed) => set({ reasoningCollapsed: collapsed }),
      toggleReasoningCollapsed: () =>
        set((state) => ({ reasoningCollapsed: !state.reasoningCollapsed })),
      setAppViewMode: (mode) => set((state) => ({
        appview: { ...state.appview, mode }
      })),
      setAppViewModeAllSize: (size) => set((state) => ({
        appview: { ...state.appview, modeAll: size }
      })),
      setMemoListVisible: (visible) => set({ memoListVisible: visible }),
      toggleMemoListVisible: () => set((state) => ({ memoListVisible: !state.memoListVisible })),
      setAgentPanelVisible: (visible) => set({ agentPanelVisible: visible }),
      toggleAgentPanelVisible: () => set((state) => ({ agentPanelVisible: !state.agentPanelVisible })),
      setAgentColWidth: (width) => set({ agentColWidth: width }),
    }),
    {
      name: STORAGE_KEYS.SETTINGS,
      partialize: (state) => ({
        reasoningCollapsed: state.reasoningCollapsed,
        appview: state.appview,
        memoListVisible: state.memoListVisible,
        agentPanelVisible: state.agentPanelVisible,
        agentColWidth: state.agentColWidth,
      }),
    }
  )
);
