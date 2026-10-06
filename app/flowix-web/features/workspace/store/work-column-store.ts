import { create } from 'zustand';
import { canonicalPath } from '@/lib/path';

import {
  EMPTY_WORK_COLUMN_TARGET,
  type WorkColumnNavigationState,
  type WorkColumnTarget,
} from './work-column-target';

/**
 * Runtime state owned by the workColumn.
 *
 * This store owns target intent and navigation transactions only. Document
 * data and editable sessions remain in DocumentStore; list and notebook
 * selection remain in NoteLibraryStore.
 */
export interface WorkColumnStore {
  navigation: WorkColumnNavigationState;
  notebookSwitchesInFlight: number;
  beginNavigation: (
    pendingTarget: WorkColumnTarget,
    retryToken: string | null,
    preservePreviousTarget?: boolean,
    showWorkColumnLoading?: boolean,
  ) => number;
  commitNavigation: (requestId: number, target: WorkColumnTarget) => boolean;
  failNavigation: (requestId: number, error: unknown) => boolean;
  dismissNavigationFailure: () => string | null;
  isCurrentNavigation: (requestId: number) => boolean;
  beginNotebookSwitch: () => void;
  endNotebookSwitch: () => void;
  replaceExternalPath: (previousPath: string, path: string) => void;
}

export const useWorkColumnStore = create<WorkColumnStore>()((set, get) => ({
  notebookSwitchesInFlight: 0,
  navigation: {
    phase: 'idle',
    showWorkColumnLoading: false,
    requestId: 0,
    target: EMPTY_WORK_COLUMN_TARGET,
    pendingTarget: null,
    previousTarget: null,
    failure: null,
    retryToken: null,
  },
  beginNavigation: (
    pendingTarget,
    retryToken,
    preservePreviousTarget = false,
    showWorkColumnLoading = true,
  ) => {
    const requestId = get().navigation.requestId + 1;
    set((state) => ({
      navigation: {
        phase: 'loading',
        showWorkColumnLoading,
        requestId,
        target: state.navigation.target,
        pendingTarget,
        previousTarget: preservePreviousTarget
          ? state.navigation.previousTarget
          : state.navigation.target,
        failure: null,
        retryToken,
      },
    }));
    return requestId;
  },
  commitNavigation: (requestId, target) => {
    if (get().navigation.requestId !== requestId) return false;
    set({
      navigation: target.kind === 'empty'
        ? {
            phase: 'idle',
            showWorkColumnLoading: false,
            requestId,
            target,
            pendingTarget: null,
            previousTarget: get().navigation.previousTarget,
            failure: null,
            retryToken: null,
          }
        : {
            phase: 'committed',
            showWorkColumnLoading: false,
            requestId,
            target,
            pendingTarget: null,
            previousTarget: get().navigation.previousTarget,
            failure: null,
            retryToken: null,
          },
    });
    return true;
  },
  failNavigation: (requestId, error) => {
    if (get().navigation.requestId !== requestId) return false;
    set((state) => ({
      navigation: {
        phase: 'failed',
        showWorkColumnLoading: false,
        requestId,
        target: state.navigation.target,
        pendingTarget: state.navigation.pendingTarget,
        previousTarget: state.navigation.previousTarget,
        failure: {
          code: 'navigation-failed',
          message: error instanceof Error ? error.message : String(error),
          requestId,
          retryToken: state.navigation.retryToken,
        },
        retryToken: state.navigation.retryToken,
      },
    }));
    return true;
  },
  dismissNavigationFailure: () => {
    const navigation = get().navigation;
    if (navigation.phase !== 'failed') return null;
    set({
      navigation: {
        phase: navigation.target.kind === 'empty' ? 'idle' : 'committed',
        showWorkColumnLoading: false,
        requestId: navigation.requestId,
        target: navigation.target,
        pendingTarget: null,
        previousTarget: navigation.previousTarget,
        failure: null,
        retryToken: null,
      },
    });
    return navigation.retryToken;
  },
  beginNotebookSwitch: () => set((state) => ({
    notebookSwitchesInFlight: state.notebookSwitchesInFlight + 1,
  })),
  endNotebookSwitch: () => set((state) => ({
    notebookSwitchesInFlight: Math.max(0, state.notebookSwitchesInFlight - 1),
  })),
  replaceExternalPath: (previousPath, path) => set((state) => {
    const replace = (target: WorkColumnTarget): WorkColumnTarget => (
      target.kind === 'external' && canonicalPath(target.path) === canonicalPath(previousPath)
        ? { ...target, path }
        : target.kind === 'table' && canonicalPath(target.filePath) === canonicalPath(previousPath)
          ? { ...target, filePath: path }
          : target.kind === 'media-library' && canonicalPath(target.filePath) === canonicalPath(previousPath)
            ? { ...target, filePath: path }
          : target
    );
    const navigation = state.navigation;
    return {
      navigation: {
        ...navigation,
        target: replace(navigation.target),
        pendingTarget: navigation.pendingTarget ? replace(navigation.pendingTarget) : null,
        previousTarget: navigation.previousTarget ? replace(navigation.previousTarget) : null,
      },
    };
  }),
  isCurrentNavigation: (requestId) => get().navigation.requestId === requestId,
}));
