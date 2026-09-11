import type { MemoEvent, MemoDerivedRefresh } from '@/types/memo';
import { useMemoStore } from '@features/memo/store/memo-store';
import { useTagStore } from '@features/memo/store/tag-store';
import { useTodoCountStore } from '@features/memo/store/todo-count-store';
import { rebaseSelectedTagId } from '@features/memo/services/memo-list-metadata-service';
export {
  mountOpenTargetListener,
  unmountOpenTargetListener,
} from '@features/memo/use-cases/open-target-listener';
export {
  initializeMemoLibrary,
} from '@features/memo/use-cases/initialize-memo-library';
export { restorePersistedMemoSession } from '@features/memo/use-cases/open-memo-session';

export function getAppSelectedNotebookId(): string | null {
  return useMemoStore.getState().selectedNotebook?.id ?? null;
}

export function applyAppMemoCreated(memo: Parameters<ReturnType<typeof useMemoStore.getState>['handleMemoCreated']>[0]): void {
  useMemoStore.getState().handleMemoCreated(memo);
}

export function applyAppMemoUpdated(memo: Parameters<ReturnType<typeof useMemoStore.getState>['handleMemoUpdated']>[0]): void {
  useMemoStore.getState().handleMemoUpdated(memo);
}

export function applyAppMemoDeleted(memoId: string): void {
  useMemoStore.getState().handleMemoDeleted(memoId);
}

export function refreshAppTodoCount(notebookId: string): void {
  void useTodoCountStore.getState().loadTodoCount(notebookId);
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
  if (!event.affectedMemoIds.length || !event.renamedTags.length) return;
  const ids = new Set(event.affectedMemoIds);
  let dirty = false;
  const memos = useMemoStore.getState().memos.map((memo) => {
    if (!ids.has(memo.id)) return memo;
    const tags = memo.tags.map((tag) => event.renamedTags.reduce(
      (current, [oldPrefix, newPrefix]) => rebaseSelectedTagId(current, oldPrefix, newPrefix) ?? current,
      tag,
    ));
    if (tags.every((tag, index) => tag === memo.tags[index])) return memo;
    dirty = true;
    return { ...memo, tags };
  });
  if (dirty) useMemoStore.setState({ memos });
}

export function applyAppTagsDeleted(event: Extract<MemoEvent, { kind: 'tags_deleted' }>): void {
  refreshTags(event.notebookId);
  if (!event.affectedMemoIds.length || !event.deletedTags.length) return;
  const ids = new Set(event.affectedMemoIds);
  let dirty = false;
  const memos = useMemoStore.getState().memos.map((memo) => {
    if (!ids.has(memo.id)) return memo;
    const tags = memo.tags.filter((tag) => !event.deletedTags.some(
      (deleted) => tag === deleted || tag.startsWith(`${deleted}/`),
    ));
    if (tags.length === memo.tags.length) return memo;
    dirty = true;
    return { ...memo, tags };
  });
  if (dirty) useMemoStore.setState({ memos });
}
