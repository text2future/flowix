import { updateWorkColumnTargets } from '../store/session-mutations';
import { canonicalPath } from '@/lib/path';
import { findFileDisplayId, listFileDisplayIdentities, suspendFileDisplayReconciliation } from '@/lib/file-display-registry';
import { rebaseWorkspaceDocumentLinkSources, getWorkspaceDocumentState, getWorkspaceDocumentHistory, replaceWorkspaceDocumentHistoryPath } from '@features/document/public/workspace-api';
import { getWorkspaceMemoState, updateNoteLinksAfterMove } from '@features/memo/public/workspace-api';
import { getBrowserColumnEntries, useBrowserColumnStore } from '../store/browser-column-store';
import { useWorkColumnStore } from '../store/work-column-store';
import { useWorkspaceRestoreStore } from '../store/workspace-restore-store';
import { replaceExternalDocumentPath } from './workspace-navigation';
import { rebaseWorkspaceTargetPath } from '../model/path-move';

/** Apply only a confirmed filesystem rename pair, never a guessed path match. */
export async function applyNotebookPathMove(input: {
  notebookId: string;
  notebookPath: string;
  previousRelativePath: string;
  relativePath: string;
  directory: boolean;
}): Promise<void> {
  const root = canonicalPath(input.notebookPath).replace(/\/+$/, '');
  const previousRelative = canonicalPath(input.previousRelativePath).replace(/^\/+|\/+$/g, '');
  const nextRelative = canonicalPath(input.relativePath).replace(/^\/+|\/+$/g, '');
  if (!root || !previousRelative || !nextRelative || previousRelative === nextRelative
    || previousRelative.split('/').includes('..') || nextRelative.split('/').includes('..')) return;
  const previous = `${root}/${previousRelative}`;
  const next = `${root}/${nextRelative}`;
  const linkMove = updateNoteLinksAfterMove(previous, next, input.directory);
  if (linkMove) await rebaseWorkspaceDocumentLinkSources(previous, next, input.directory, linkMove);
  const movedPath = (candidate: string): string | null => {
    const path = canonicalPath(candidate);
    if (path === previous) return next;
    if (input.directory && path.startsWith(`${previous}/`)) return `${next}${path.slice(previous.length)}`;
    return null;
  };

  const document = getWorkspaceDocumentState().activeExternalSession;
  const navigation = useWorkColumnStore.getState().navigation;
  const desired = useWorkspaceRestoreStore.getState().desiredTarget;
  const candidates = [document?.fileIdentity.path, ...listFileDisplayIdentities().map((identity) => identity.path)];
  for (const entry of getWorkspaceDocumentHistory()) {
    if (entry.kind === 'external') candidates.push(entry.path);
    if (entry.kind === 'media') candidates.push(entry.filePath);
  }
  for (const target of [navigation.target, navigation.pendingTarget, navigation.previousTarget, desired]) {
    if (target?.kind === 'external') candidates.push(target.path);
  }
  for (const tab of getBrowserColumnEntries(useBrowserColumnStore.getState())) {
    if (tab.target.kind === 'file-browser') candidates.push(tab.target.activeFilePath ?? undefined);
  }
  const resume = suspendFileDisplayReconciliation();
  try {
    for (const path of new Set(candidates.filter((value): value is string => Boolean(value)))) {
      const replacement = movedPath(path);
      if (!replacement) continue;
      const displayId = findFileDisplayId(path);
      if (displayId) replaceExternalDocumentPath(displayId, path, replacement);
      replaceWorkspaceDocumentHistoryPath(path, replacement);
    }
    const workspace = useWorkColumnStore.getState();
    const navigation = workspace.navigation;
    const rebase = <T extends Parameters<typeof rebaseWorkspaceTargetPath>[0]>(target: T) =>
      rebaseWorkspaceTargetPath(target, previous, next, input.directory);
    const target = rebase(navigation.target);
    const pendingTarget = navigation.pendingTarget ? rebase(navigation.pendingTarget) : null;
    const previousTarget = navigation.previousTarget ? rebase(navigation.previousTarget) : null;
    if (target !== navigation.target || pendingTarget !== navigation.pendingTarget || previousTarget !== navigation.previousTarget) {
      updateWorkColumnTargets(rebase);
    }
    const browser = useBrowserColumnStore.getState();
    browser.updateEntries((tab) => {
      const target = rebase(tab.target);
      return target === tab.target ? tab : { ...tab, target };
    });
    const desired = useWorkspaceRestoreStore.getState().desiredTarget;
    if (desired) {
      const updated = rebase(desired);
      if (updated !== desired) useWorkspaceRestoreStore.getState().setDesiredTarget(updated);
    }
  } finally { resume(); }

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
