'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { clearWorkspaceDocument } from '@features/workspace/public/note-navigation-api';
import { resolveSelectedTagId } from '@features/memo/services/memo-list-metadata-service';
import { useMemoLibraryMetadataStore } from '@features/memo/store/memo-library-metadata-store';
import { useNoteStore } from '@features/memo/store/note-store';
import { useTagStore } from '@features/memo/store/tag-store';

const logger = createLogger('memo-list');

interface UseMemoListNotebookMetadataOptions {
  isActive: boolean;
  startupPhase: string;
  refreshTrigger: number;
  selectedNotebookId?: string;
  setIsMemoListLoading: (loading: boolean) => void;
  setLoadedMemoListQueryKey: (queryKey: string | null) => void;
}

/** Owns notebook tag metadata loading and persisted tag selection validation. */
export function useMemoListNotebookMetadata({
  isActive,
  startupPhase,
  refreshTrigger,
  selectedNotebookId,
  setIsMemoListLoading,
  setLoadedMemoListQueryKey,
}: UseMemoListNotebookMetadataOptions) {
  const { t } = useI18n();
  const [tagMap, setTagMap] = useState<Record<string, string>>({});
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  const loadLibraryMetadata = useMemoLibraryMetadataStore((state) => state.loadMetadata);
  const tagMetadataRefreshVersion = useTagStore((state) => state.metadataRefreshVersion);
  const setSelectedTagId = useTagStore((state) => state.setSelectedTagId);
  const setSelectedNotebook = useNoteStore((state) => state.setSelectedNotebook);

  const loadData = useCallback(async () => {
    if (!isActiveRef.current || startupPhase !== 'ready') return;

    const currentNotebook = useNoteStore.getState().selectedNotebook;
    if (!currentNotebook) {
      if (!isActiveRef.current) return;
      setSelectedNotebook(null);
      void clearWorkspaceDocument();
      setSelectedTagId(null);
      setLoadedMemoListQueryKey(null);
      setIsMemoListLoading(false);
      return;
    }

    const libraryMetadata = await loadLibraryMetadata(currentNotebook, tagMetadataRefreshVersion);
    if (!isActiveRef.current || useNoteStore.getState().startupPhase !== 'ready') return;
    if (!libraryMetadata) return;
    if (useNoteStore.getState().selectedNotebook?.id !== currentNotebook.id) return;

    setTagMap(libraryMetadata.tagMap);

    // Read after the metadata request because a concurrent rename can update the
    // selected path while IPC is in flight.
    const latestSelectedTagId = useTagStore.getState().selectedTagId;
    const resolvedSelectedTagId = resolveSelectedTagId(latestSelectedTagId, libraryMetadata.tagOptions);
    if (resolvedSelectedTagId !== latestSelectedTagId) setSelectedTagId(resolvedSelectedTagId);
  }, [
    loadLibraryMetadata,
    setIsMemoListLoading,
    setLoadedMemoListQueryKey,
    setSelectedNotebook,
    setSelectedTagId,
    startupPhase,
    tagMetadataRefreshVersion,
  ]);

  useEffect(() => {
    void loadData().catch((error) => {
      if (!isActiveRef.current) return;
      logger.warn('load list metadata failed', { error });
      if (!String(error).includes('NOTE_INDEX_PENDING')) toast.error(t('memo.list.loadFailed'));
    });
  }, [isActive, loadData, refreshTrigger, selectedNotebookId, t]);

  return tagMap;
}
