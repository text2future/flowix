import { useCallback, useEffect, useRef, useState } from 'react';
import { files } from '@platform/tauri/client';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { fileTreeCreateFailureKey } from './file-tree-failure';
import type { FolderTreeController } from './use-folder-tree';
import type { NotebookTreeDraftState } from './notebook-tree-render-rows';

export interface NotebookFolderCreateRequest {
  id: number;
  parentPath: string;
}

interface UseNotebookTreeDraftActionsOptions {
  createFolderRequest?: NotebookFolderCreateRequest | null;
  expandTo: FolderTreeController['expandTo'];
  refreshDirectory: FolderTreeController['refresh'];
}

/** Owns inline folder draft state and create/submit/cancel behavior. */
export function useNotebookTreeDraftActions({
  createFolderRequest,
  expandTo,
  refreshDirectory,
}: UseNotebookTreeDraftActionsOptions) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<NotebookTreeDraftState | null>(null);
  const handledRequestIdRef = useRef<number | null>(null);
  const cancelledRequestIdRef = useRef<number | null>(null);
  const submittingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!createFolderRequest || handledRequestIdRef.current === createFolderRequest.id) return;
    handledRequestIdRef.current = createFolderRequest.id;
    void expandTo(`${createFolderRequest.parentPath}/__new-folder__`);
    setDraft({
      requestId: createFolderRequest.id,
      parentPath: createFolderRequest.parentPath,
      value: '',
    });
  }, [createFolderRequest, expandTo]);

  const updateDraft = useCallback((requestId: number, value: string) => {
    setDraft((current) => current?.requestId === requestId ? { ...current, value } : current);
  }, []);

  const submitDraft = useCallback(async () => {
    if (!draft) return;
    if (cancelledRequestIdRef.current === draft.requestId) {
      cancelledRequestIdRef.current = null;
      return;
    }
    if (submittingRef.current) return;
    submittingRef.current = true;
    const { requestId, parentPath, value } = draft;
    const name = value.trim();
    if (!name) {
      setDraft(null);
      submittingRef.current = false;
      return;
    }
    try {
      await files.createFolder(parentPath, name);
      await refreshDirectory(parentPath);
      setDraft((current) => current?.requestId === requestId ? null : current);
    } catch (error) {
      toast.error(t(fileTreeCreateFailureKey(error)));
      if (draft.requestId === requestId) {
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    } finally {
      submittingRef.current = false;
    }
  }, [draft, refreshDirectory, t]);

  const cancelDraft = useCallback(() => {
    if (!draft) return;
    cancelledRequestIdRef.current = draft.requestId;
    setDraft(null);
  }, [draft]);

  const requestCreateFolderDraft = useCallback((parentPath: string) => {
    void expandTo(`${parentPath}/__new-folder__`);
    setDraft({ requestId: Date.now(), parentPath, value: '' });
  }, [expandTo]);

  return {
    draft,
    inputRef,
    updateDraft,
    submitDraft,
    cancelDraft,
    requestCreateFolderDraft,
  };
}
