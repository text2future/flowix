import type { NotebookImportStatus } from '@platform/tauri/client';

export type NotebookCreationState =
  | { status: 'idle' }
  | { status: 'creating' }
  | { status: 'importing'; notebookId: string }
  | { status: 'ready'; notebookId: string }
  | { status: 'failed'; message: string };

export interface NotebookImportStatusEffect {
  creationState: NotebookCreationState;
  reloadMemoList: boolean;
  stopMemoListLoading: boolean;
  errorMessage: string | null;
}

export function resolveNotebookImportStatusEffect(
  selectedNotebookId: string | null | undefined,
  importStatus: NotebookImportStatus,
  fallbackErrorMessage: string,
): NotebookImportStatusEffect | null {
  const notebookId = importStatus.notebookId;
  if (selectedNotebookId !== notebookId) return null;

  if (importStatus.status === 'started') {
    return {
      creationState: { status: 'importing', notebookId },
      reloadMemoList: false,
      stopMemoListLoading: false,
      errorMessage: null,
    };
  }

  if (importStatus.status === 'completed') {
    return {
      creationState: { status: 'ready', notebookId },
      reloadMemoList: true,
      stopMemoListLoading: false,
      errorMessage: null,
    };
  }

  if (importStatus.status === 'failed') {
    const message = importStatus.message ?? fallbackErrorMessage;
    return {
      creationState: { status: 'failed', message },
      reloadMemoList: false,
      stopMemoListLoading: true,
      errorMessage: message,
    };
  }

  return {
    creationState: { status: 'ready', notebookId },
    reloadMemoList: false,
    stopMemoListLoading: true,
    errorMessage: null,
  };
}
