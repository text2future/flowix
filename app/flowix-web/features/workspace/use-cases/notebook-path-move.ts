import { canonicalPath } from '@/lib/path';
import { findFileDisplayId } from '@/lib/file-display-registry';
import { getWorkspaceDocumentState } from '@features/document/public/workspace-api';
import { getWorkspaceMemoState } from '@features/memo/public/workspace-api';
import { useBrowserColumnStore } from '../store/browser-column-store';
import { useWorkColumnStore } from '../store/work-column-store';
import { useWorkspaceRestoreStore } from '../store/workspace-restore-store';
import { replaceExternalDocumentPath } from './workspace-navigation';

/** Apply only a confirmed filesystem rename pair, never a guessed path match. */
export function applyNotebookPathMove(input: {
  notebookId: string;
  notebookPath: string;
  previousRelativePath: string;
  relativePath: string;
  directory: boolean;
}): void {
  const root = canonicalPath(input.notebookPath).replace(/\/+$/, '');
  const previousRelative = canonicalPath(input.previousRelativePath).replace(/^\/+|\/+$/g, '');
  const nextRelative = canonicalPath(input.relativePath).replace(/^\/+|\/+$/g, '');
  if (!root || !previousRelative || !nextRelative || previousRelative === nextRelative
    || previousRelative.split('/').includes('..') || nextRelative.split('/').includes('..')) return;
  const previous = `${root}/${previousRelative}`;
  const next = `${root}/${nextRelative}`;
  const movedPath = (candidate: string): string | null => {
    const path = canonicalPath(candidate);
    if (path === previous) return next;
    if (input.directory && path.startsWith(`${previous}/`)) return `${next}${path.slice(previous.length)}`;
    return null;
  };

  const document = getWorkspaceDocumentState().activeExternalSession;
  const navigation = useWorkColumnStore.getState().navigation;
  const desired = useWorkspaceRestoreStore.getState().desiredTarget;
  const candidates = [document?.fileIdentity.path];
  for (const target of [navigation.target, navigation.pendingTarget, navigation.previousTarget, desired]) {
    if (target?.kind === 'external') candidates.push(target.path);
  }
  for (const tab of useBrowserColumnStore.getState().tabs) {
    if (tab.target.kind === 'file-browser') candidates.push(tab.target.activeFilePath ?? undefined);
  }
  for (const path of new Set(candidates.filter((value): value is string => Boolean(value)))) {
    const replacement = movedPath(path);
    const displayId = findFileDisplayId(path);
    if (replacement && displayId) replaceExternalDocumentPath(displayId, path, replacement);
  }

  const memo = getWorkspaceMemoState();
  const selected = memo.selectedNote;
  if (selected?.notebookId === input.notebookId) {
    const selectedPath = `${root}/${selected.relativePath}`;
    const replacement = movedPath(selectedPath);
    if (replacement) memo.setSelectedNote({
      notebookId: selected.notebookId,
      relativePath: replacement.slice(root.length + 1),
    });
  }
}
