import type { MemoEvent, MemoDerivedRefresh } from '@/types/memo';
import { useNoteStore } from '@features/memo/store/note-store';
import { useTagStore } from '@features/memo/store/tag-store';
import { useTodoCountStore } from '@features/memo/store/todo-count-store';
export { resumePendingNoteLinkUpdates } from '@features/memo/services/note-link-rewriter';
export {
  mountOpenTargetListener,
  unmountOpenTargetListener,
} from '@features/memo/use-cases/open-target-listener';
export {
  initializeNoteLibrary,
  initializeNotebookContext,
} from '@features/memo/use-cases/initialize-note-library';

export function markMemoLibraryStartupError(error: unknown): void {
  useNoteStore.getState().setStartupPhase(
    'error',
    error instanceof Error ? error.message : String(error),
  );
}

export function getAppSelectedNotebookId(): string | null {
  return useNoteStore.getState().selectedNotebook?.id ?? null;
}

export async function getAppNotebookPath(notebookId: string): Promise<string | null> {
  let notebook = useNoteStore.getState().notebooks.find((item) => item.id === notebookId);
  if (!notebook) {
    await useNoteStore.getState().loadNotebooks();
    notebook = useNoteStore.getState().notebooks.find((item) => item.id === notebookId);
  }
  return notebook?.path ?? null;
}

export function applyAppMemoCreated(_memo: unknown): void {
  useNoteStore.getState().handleMemoEvent();
}

export function applyAppMemoUpdated(_memo: unknown): void {
  useNoteStore.getState().handleMemoEvent();
}

export function applyAppMemoDeleted(): void {
  useNoteStore.getState().handleMemoEvent();
}

export function refreshAppTodoCount(notebookId: string): void {
  void useTodoCountStore.getState().loadTodoCount(notebookId);
}

/** Refresh derived data after a filesystem path changes without a memo ID event. */
export function refreshAppPathNoteMetadata(notebookId: string): void {
  if (getAppSelectedNotebookId() === notebookId) {
    void useTagStore.getState().loadTags(notebookId);
    useTagStore.getState().triggerMetadataRefresh();
  }
  refreshAppTodoCount(notebookId);
}

export function refreshAppDerivedMetadata(event: MemoDerivedRefresh): void {
  const { notebookId, derivedChanged } = event;
  if (derivedChanged.tags || derivedChanged.agents || derivedChanged.todos) {
    void useTagStore.getState().loadTags(notebookId);
    useTagStore.getState().triggerMetadataRefresh();
  }
  if (derivedChanged.todos) refreshAppTodoCount(notebookId);
}

function refreshTags(notebookId: string): void {
  void useTagStore.getState().loadTags(notebookId);
  useTagStore.getState().triggerMetadataRefresh();
}

export function applyAppTagsRenamed(event: Extract<MemoEvent, { kind: 'tags_renamed' }>): void {
  refreshTags(event.notebookId);
  if (getAppSelectedNotebookId() === event.notebookId
    && event.affectedRelativePaths.length
    && event.renamedTags.length) {
    useNoteStore.getState().triggerRefresh();
  }
}

export function applyAppTagsDeleted(event: Extract<MemoEvent, { kind: 'tags_deleted' }>): void {
  refreshTags(event.notebookId);
  if (getAppSelectedNotebookId() === event.notebookId
    && event.affectedRelativePaths.length
    && event.deletedTags.length) {
    useNoteStore.getState().triggerRefresh();
  }
}
