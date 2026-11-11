import { useCallback, useEffect, useState } from 'react';
import { initializeMainWindowStartup } from '@app/main-window-startup';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { useI18n } from '@/lib/i18n';
import type { NoteFilterCondition } from '@features/collection/public/note-filter-api';
import { getMemoListQueryKey, shouldShowMemoListLoading } from '@features/memo/components/memo-list-loading-state';
import {
  type ColorFilterValue,
  type ExtendedFilterType,
  type NoteLibraryStartupPhase,
  type NoteLibraryStore,
  useNoteStore,
} from '@features/memo/store/note-store';
import { useNotebookBackgroundStore } from '@features/memo/store/notebook-background-store';
import { useTagStore } from '@features/memo/store/tag-store';
import type { SortType } from '@features/memo/services';

const logger = createLogger('memo-list');

type MemoListLoadError = {
  queryKey: string;
  kind: 'initial' | 'refresh' | 'more';
};

function getCurrentStoreQueryKey(): string {
  const state = useNoteStore.getState();
  return getMemoListQueryKey(
    state.selectedNotebook?.id,
    state.activeFilter,
    state.activeSort,
    state.activeFilter === 'tagged' ? useTagStore.getState().selectedTagId : null,
    state.colorFilter,
    state.activePluginId,
    state.activeCustomFilterId,
    state.dataConditionsByNotebook?.[state.selectedNotebook?.id ?? ''],
  );
}

interface UseMemoListLoadControllerOptions {
  selectedNotebookId?: string;
  startupPhase: NoteLibraryStartupPhase;
  activeFilter: ExtendedFilterType;
  activeSort: SortType;
  activeTagId: string | null;
  colorFilter: ColorFilterValue;
  activePluginId?: string | null;
  activeCustomFilterId?: string | null;
  dataCondition?: NoteFilterCondition | null;
  memoListQueryKey: string | null;
  loadMoreMemos: NoteLibraryStore['loadMoreMemos'];
  triggerMemoListRefresh: NoteLibraryStore['triggerMemoListRefresh'];
}

/** Coordinates list loading feedback without owning the query request itself. */
export function useMemoListLoadController({
  selectedNotebookId,
  startupPhase,
  activeFilter,
  activeSort,
  activeTagId,
  colorFilter,
  activePluginId,
  activeCustomFilterId,
  dataCondition,
  memoListQueryKey,
  loadMoreMemos,
  triggerMemoListRefresh,
}: UseMemoListLoadControllerOptions) {
  const { t } = useI18n();
  const [isMemoListLoading, setIsMemoListLoading] = useState(false);
  const [loadedMemoListQueryKey, setLoadedMemoListQueryKey] = useState<string | null>(null);
  const [memoListError, setMemoListError] = useState<MemoListLoadError | null>(null);
  const [notebookLoadContext, setNotebookLoadContext] = useState({
    notebookId: selectedNotebookId,
    skipInitialLoading: false,
    notesSettled: false,
  });

  const isCurrentNotebookEntry = notebookLoadContext.notebookId === selectedNotebookId;
  const skipInitialNotebookLoading = isCurrentNotebookEntry
    ? notebookLoadContext.skipInitialLoading
    : Boolean(notebookLoadContext.notebookId);
  const skipMemoListLoading = skipInitialNotebookLoading
    && (!isCurrentNotebookEntry || !notebookLoadContext.notesSettled);

  useEffect(() => {
    if (!selectedNotebookId) return;
    setNotebookLoadContext((previous) => previous.notebookId === selectedNotebookId
      ? previous
      : {
        notebookId: selectedNotebookId,
        skipInitialLoading: Boolean(previous.notebookId),
        notesSettled: false,
      });
  }, [selectedNotebookId]);

  const currentMemoListQueryKey = getMemoListQueryKey(
    selectedNotebookId,
    activeFilter,
    activeSort,
    activeTagId,
    colorFilter,
    activePluginId,
    activeCustomFilterId,
    dataCondition,
  );
  const currentMemoListError = memoListError?.queryKey === currentMemoListQueryKey
    ? memoListError
    : null;
  const hasCurrentMemoListData = loadedMemoListQueryKey === currentMemoListQueryKey
    || memoListQueryKey === currentMemoListQueryKey;
  const backgroundIndex = useNotebookBackgroundStore((state) => (
    selectedNotebookId ? state.statuses[selectedNotebookId] : undefined
  ));
  const indexPreparing = backgroundIndex?.state === 'queued' || backgroundIndex?.state === 'running';
  const indexFailed = backgroundIndex?.state === 'failed';

  useEffect(() => {
    if (!hasCurrentMemoListData && !currentMemoListError && !indexFailed) return;
    setNotebookLoadContext((previous) => (
      previous.notebookId === selectedNotebookId && !previous.notesSettled
        ? { ...previous, notesSettled: true }
        : previous
    ));
  }, [selectedNotebookId, hasCurrentMemoListData, currentMemoListError, indexFailed]);

  useEffect(() => {
    if (backgroundIndex?.state === 'ready') setMemoListError(null);
  }, [backgroundIndex?.state, backgroundIndex?.revision, selectedNotebookId]);

  const handleRetryStartup = useCallback(() => {
    void initializeMainWindowStartup().catch((error) => {
      logger.warn('retry memo library initialization failed', { error });
      toast.error(t('memo.list.loadFailed'));
    });
  }, [t]);

  const handleMemoListLoadError = useCallback((error: unknown, requestedKind?: 'initial' | 'more') => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('NOTE_INDEX_PENDING')) {
      const id = useNoteStore.getState().selectedNotebook?.id;
      if (id) useNotebookBackgroundStore.getState().pending(id);
      setMemoListError(null);
      return;
    }

    logger.warn('load memos failed', { error });
    const state = useNoteStore.getState();
    const queryKey = getCurrentStoreQueryKey();
    const kind = requestedKind
      ?? (state.memoListQueryKey === queryKey ? 'refresh' : 'initial');
    setMemoListError({ queryKey, kind });
  }, []);

  const handleMemoListLoadStart = useCallback((queryKey: string) => {
    setMemoListError((current) => current?.queryKey === queryKey ? null : current);
  }, []);
  const handleMemoListLoadSuccess = useCallback((queryKey: string) => {
    setMemoListError((current) => current?.queryKey === queryKey ? null : current);
  }, []);

  const handleLoadMoreMemos = useCallback(() => {
    const queryKey = getCurrentStoreQueryKey();
    if (memoListError?.queryKey === queryKey && memoListError.kind === 'more') return;
    void loadMoreMemos().catch((error) => handleMemoListLoadError(error, 'more'));
  }, [handleMemoListLoadError, loadMoreMemos, memoListError]);

  const handleRetryMemoList = useCallback(() => {
    setMemoListError(null);
    triggerMemoListRefresh();
  }, [triggerMemoListRefresh]);

  const handleRetryMemoListMore = useCallback(() => {
    setMemoListError(null);
    void loadMoreMemos().catch((error) => handleMemoListLoadError(error, 'more'));
  }, [handleMemoListLoadError, loadMoreMemos]);

  const retryIndexOrList = useCallback(() => {
    if (!selectedNotebookId || !indexFailed) {
      handleRetryMemoList();
      return;
    }
    const id = selectedNotebookId;
    useNotebookBackgroundStore.getState().pending(id, true);
    void import('@platform/tauri/client/memos').then(({ notebooks }) => notebooks.refreshIndex(id)).catch((error) => {
      const current = useNotebookBackgroundStore.getState().statuses[id];
      if (current) useNotebookBackgroundStore.getState().apply({ ...current, state: 'failed', message: String(error) });
    });
  }, [handleRetryMemoList, indexFailed, selectedNotebookId]);

  const showMemoListLoading = indexPreparing || startupPhase === 'loading' || shouldShowMemoListLoading({
    selectedNotebookId,
    isMemoListLoading,
    currentMemoListQueryKey,
    loadedMemoListQueryKey,
  });

  return {
    currentMemoListQueryKey,
    currentMemoListError,
    hasCurrentMemoListData,
    indexFailed,
    setIsMemoListLoading,
    setLoadedMemoListQueryKey,
    showMemoListLoading,
    skipInitialNotebookLoading,
    skipMemoListLoading,
    handleRetryStartup,
    handleMemoListLoadError,
    handleMemoListLoadStart,
    handleMemoListLoadSuccess,
    handleLoadMoreMemos,
    handleRetryMemoListMore,
    retryIndexOrList,
  };
}
