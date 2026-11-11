'use client';

import { flushSync } from 'react-dom';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import { joinNotebookMemoPath, samePath } from '@/lib/path';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useColumnNavigation } from '@features/workspace/public/column-navigation-api';
import { useActiveFilePath } from '@features/workspace/public/active-file-path-api';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { MemoCard } from '@features/memo/components/memo-card';
import { openPathNoteSession } from '@features/memo/use-cases/open-memo-session';
import { middleColumnSelectionKey } from '@features/memo/components/memo-list-selection';
import { useNoteStore, type Notebook } from '@features/memo/store/note-store';
import { findRunningAgentTypeForMemo, useRunningAgentTypeIndex } from '@features/agent/public/running-agents-api';
import type { useMemoInsertAnimation } from '@features/memo/hooks/use-memo-insert-animation';
import { noteListItemKey, type NoteListItem } from '@/types/note-item';
import { DROPDOWN_DIVIDER_SKIN } from '@shared/ui/dropdown-divider';
import { MemoListViewport } from './memo-list-viewport';
import { useMemoListPagination } from './use-memo-list-pagination';
import { useMemoListItemActions } from './use-memo-list-item-actions';
import type { MemoRowKeepAliveChange } from './memo-list-rows';

const logger = createLogger('memo-list');
const EMPTY_MEMO_LIST: NoteListItem[] = [];

interface MemoListCardsState {
  queryKey: string;
  error: { kind: 'initial' | 'refresh' | 'more' } | null;
  hasData: boolean;
  indexFailed: boolean;
  loading: boolean;
  skipInitialLoading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
}

interface MemoListCardsActions {
  onRetry: () => void;
  onRetryMore: () => void;
  onLoadMore: () => void;
}

interface MemoListCardsContentProps {
  active: boolean;
  paginationActive: boolean;
  showScrollTopHint: boolean;
  notebook: Notebook | null;
  tagMap: Record<string, string>;
  state: MemoListCardsState;
  actions: MemoListCardsActions;
  revealKey: string | null;
  onRevealed: () => void;
  registerCard: ReturnType<typeof useMemoInsertAnimation>['registerCard'];
  onListRendered: ReturnType<typeof useMemoInsertAnimation>['onListRendered'];
}

/** Owns the card tab's note subscription, viewport, paging and row presentation. */
export function MemoListCardsContent({
  active,
  paginationActive,
  showScrollTopHint,
  notebook,
  tagMap,
  state,
  actions,
  revealKey,
  onRevealed,
  registerCard,
  onListRendered,
}: MemoListCardsContentProps) {
  const listContainerRef = useRef<HTMLDivElement>(null);
  const [listScrollElement, setListScrollElement] = useState<HTMLDivElement | null>(null);
  const [showScrollTopHintState, setShowScrollTopHintState] = useState(false);
  const notes = useNoteStore((store) => active ? store.notes : EMPTY_MEMO_LIST);
  const notebooksExist = useNoteStore((store) => store.notebooks.length > 0);
  const triggerMemoListRefresh = useNoteStore((store) => store.triggerMemoListRefresh);

  const attachListScroller = useCallback((element: HTMLDivElement | null) => {
    listContainerRef.current = element;
    setListScrollElement(element);
  }, []);
  const scrollListToTop = useCallback(() => {
    listContainerRef.current?.scrollTo({ top: 0 });
  }, []);
  const { onScroll: handleMemoListScroll } = useMemoListPagination({
    itemCount: notes.length,
    loading: state.loading,
    hasMorePages: state.hasMore,
    loadingMorePages: state.loadingMore,
    loadMorePages: actions.onLoadMore,
    scrollerRef: listContainerRef,
    isActive: paginationActive,
  });
  const { handleFavoriteToggleAction, handleColorsChangeAction } = useMemoListItemActions({
    triggerMemoListRefresh,
    scrollListToTop,
  });

  const pendingDocumentPath = useColumnNavigation(0, (navigation) => {
    const { phase, pendingTarget } = navigation.transaction;
    return phase === 'loading' && pendingTarget?.kind === 'external' ? pendingTarget.path : null;
  });
  const pendingListItem = pendingDocumentPath && notebook?.path
    ? notes.find((note) => samePath(
        joinNotebookMemoPath(notebook.path, note.relativePath) ?? '',
        pendingDocumentPath,
      ))
    : undefined;
  const middleColumnFilePath = useActiveFilePath();
  const middleColumnListItemKey = middleColumnSelectionKey({
    middleColumnFilePath,
    notebook,
    notes,
  });
  const selectedListItemKey = pendingDocumentPath
    ? pendingListItem ? noteListItemKey(pendingListItem) : undefined
    : middleColumnListItemKey;

  const handleSelectMemo = useCallback((memo: NoteListItem) => {
    flushSync(() => {
      void openPathNoteSession(memo, useNoteStore.getState().selectedNotebook);
    });
  }, []);
  const handleOpenMemoWindow = useCallback((memo: NoteListItem) => {
    const currentNotebook = useNoteStore.getState().selectedNotebook;
    if (!currentNotebook?.path) return;
    const path = joinNotebookMemoPath(currentNotebook.path, memo.relativePath) ?? memo.relativePath;
    void openWorkspaceSurface({
      index: 1,
      target: { kind: 'external', path, scopePath: currentNotebook.path, transitionId: null },
    }).catch((error) => {
      logger.warn('open memo in browser column failed', { error, path: memo.relativePath });
      toast.error(error instanceof Error ? error.message : String(error));
    });
  }, []);
  const handleRequestDeleteMemo = useCallback((memo: NoteListItem) => {
    window.dispatchEvent(new CustomEvent<NoteListItem>('flowix:request-delete-memo', { detail: memo }));
  }, []);
  const runningAgentTypeIndex = useRunningAgentTypeIndex();
  const getRunningAgentTypeForMemo = useCallback(
    (memo: NoteListItem) => findRunningAgentTypeForMemo(runningAgentTypeIndex, memo),
    [runningAgentTypeIndex],
  );

  const cardRefCacheRef = useRef(new Map<string, (element: HTMLDivElement | null) => void>());
  const registerCardRef = useRef(registerCard);
  registerCardRef.current = registerCard;
  const getMemoCardRef = (key: string) => {
    const cached = cardRefCacheRef.current.get(key);
    if (cached) return cached;
    const ref = (element: HTMLDivElement | null) => {
      registerCardRef.current(key)(element);
      if (!element) cardRefCacheRef.current.delete(key);
    };
    cardRefCacheRef.current.set(key, ref);
    return ref;
  };

  useLayoutEffect(() => {
    onListRendered(listContainerRef.current);
  }, [notes, onListRendered]);

  return (
    <MemoListViewport
      active={active}
      items={notes}
      notebooksExist={notebooksExist}
      scrollElement={listScrollElement}
      scrollerRef={attachListScroller}
      onScroll={(event) => {
        setShowScrollTopHintState(event.currentTarget.scrollTop > 0);
        handleMemoListScroll(event);
      }}
      showScrollTopHint={showScrollTopHint && showScrollTopHintState}
      queryKey={state.queryKey}
      error={state.error}
      hasData={state.hasData}
      indexFailed={state.indexFailed}
      loading={state.loading}
      skipInitialLoading={state.skipInitialLoading}
      loadingMore={state.loadingMore}
      revealKey={revealKey}
      onRevealed={onRevealed}
      renderRow={(memo: NoteListItem, onKeepAliveChange: MemoRowKeepAliveChange) => {
        const itemKey = noteListItemKey(memo);
        return (
          <div key={itemKey} ref={getMemoCardRef(itemKey)} className="min-w-0 w-full">
            <div data-insert-anim className="min-w-0 w-full">
              <MemoCard
                memo={memo}
                tagMap={tagMap}
                isSelected={selectedListItemKey === itemKey}
                runningAgentType={getRunningAgentTypeForMemo(memo) ?? undefined}
                onSelect={handleSelectMemo}
                onOpenInWindow={handleOpenMemoWindow}
                onFavoriteToggle={handleFavoriteToggleAction}
                onDelete={handleRequestDeleteMemo}
                onColorsChange={handleColorsChangeAction}
                onKeepAliveChange={onKeepAliveChange}
              />
              <hr className={cn('mx-3', DROPDOWN_DIVIDER_SKIN)} />
            </div>
          </div>
        );
      }}
      onRetry={actions.onRetry}
      onRetryMore={actions.onRetryMore}
    />
  );
}
