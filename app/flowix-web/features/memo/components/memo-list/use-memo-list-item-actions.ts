import { useCallback } from 'react';

import { joinNotebookMemoPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import type { NoteColor, NoteListItem } from '@/types/note-item';
import { noteListItemRelativePath } from '@/types/note-item';
import { refreshIndexedMemo } from '@features/memo/services/memo-list-refresh-service';
import { noteRepository } from '@features/memo/services/note-repository';
import { useNoteStore } from '@features/memo/store/note-store';
import { useI18n } from '@/lib/i18n';

interface UseMemoListItemActionsOptions {
  triggerMemoListRefresh: () => void;
  scrollListToTop: () => void;
}

/** Owns persistence and refresh behavior for memo card pin and color actions. */
export function useMemoListItemActions({
  triggerMemoListRefresh,
  scrollListToTop,
}: UseMemoListItemActionsOptions) {
  const { t } = useI18n();

  const handleFavoriteToggleAction = useCallback((memo: NoteListItem) => {
    void (async () => {
      const queryKey = useNoteStore.getState().memoListQueryKey;
      const path = joinNotebookMemoPath(
        useNoteStore.getState().selectedNotebook?.path ?? '',
        noteListItemRelativePath(memo),
      ) ?? '';
      try {
        const outcome = await (memo.favorited
          ? noteRepository.unfavorite(path)
          : noteRepository.favorite(path));
        if (outcome === 'notSaved') {
          toast.error(t(memo.favorited ? 'document.command.unpinFailed' : 'document.command.pinFailed'));
          return;
        }
        if (outcome === 'missingCleaned') {
          useNoteStore.getState().applyNoteListChange(memo.notebookId, memo.relativePath, null);
          toast.success(t('memo.favorite.missingCleaned'));
          return;
        }
        await refreshIndexedMemo(memo.notebookId, memo.relativePath);
        const state = useNoteStore.getState();
        // Refresh ordering only if the user is still viewing the same query.
        if (state.selectedNotebook?.id === memo.notebookId && state.memoListQueryKey === queryKey) {
          const loaded = await state.loadNotes({ source: 'memo-pin-toggle' });
          if (loaded && useNoteStore.getState().memoListQueryKey === queryKey) scrollListToTop();
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [scrollListToTop, t]);

  const handleColorsChangeAction = useCallback((memo: NoteListItem, colors: NoteColor[]) => {
    void (async () => {
      const path = joinNotebookMemoPath(
        useNoteStore.getState().selectedNotebook?.path ?? '',
        noteListItemRelativePath(memo),
      ) ?? '';
      const saved = await noteRepository.setColors(path, colors);
      if (!saved) {
        triggerMemoListRefresh();
        return;
      }
      await refreshIndexedMemo(memo.notebookId, memo.relativePath);
    })();
  }, [triggerMemoListRefresh]);

  return { handleFavoriteToggleAction, handleColorsChangeAction };
}
