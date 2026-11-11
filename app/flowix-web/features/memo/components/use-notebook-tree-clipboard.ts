import { useCallback, useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';
import { create } from 'zustand';
import { NATIVE_CLIPBOARD_ACTION_EVENT, type NativeClipboardAction } from '@shared/clipboard/native-clipboard-action';
import { canonicalPath, parentDirectoryPath, samePath } from '@/lib/path';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { useI18n } from '@/lib/i18n';
import { files, type DocTreeItem } from '@platform/tauri/client';
import { saveWorkspaceTransferSources } from '@features/document/public/workspace-api';
import { useNoteStore } from '../store/note-store';
import type { FolderTreeController } from './use-folder-tree';
import type { NotebookMoveResult, NotebookMoveSource } from './use-notebook-tree-drag-controller';

type TreeClipboardItem = Pick<DocTreeItem, 'fullPath' | 'type' | 'resourceKind'>;

interface TreeClipboard {
  id: symbol;
  mode: 'copy' | 'cut';
  scopePath: string;
  sources: NotebookMoveSource[];
}
const useTreeClipboard = create<{ clipboard: TreeClipboard | null; busy: boolean }>(() => ({ clipboard: null, busy: false }));
const log = createLogger('notebook-tree-clipboard');

/** Read existing selection only. Right-clicking an unselected row acts on that row. */
export function treeTransferSources(item: TreeClipboardItem | undefined, selectedPaths: readonly string[], items: ReadonlyMap<string, DocTreeItem>): NotebookMoveSource[] {
  const paths = item && !selectedPaths.some(path => samePath(path, item.fullPath)) ? [item.fullPath]
      : selectedPaths.length ? selectedPaths : item ? [item.fullPath] : [];
  return paths.map(path => {
    const node = item && samePath(item.fullPath, path) ? item : items.get(canonicalPath(path));
    return { path, isFolder: node?.type === 'folder', resourceKind: node?.resourceKind };
  });
}

export function treePasteDirectory(item: TreeClipboardItem | undefined, root: string): string {
  return item?.type === 'folder' ? item.fullPath : item ? parentDirectoryPath(item.fullPath, root) : root;
}

export interface TreeClipboardActions {
  canCapture: boolean;
  canPaste: boolean;
  copy: () => void;
  cut: () => void;
  paste: () => void;
}

export function useNotebookTreeClipboard({ notebookPath, selectedFilePaths, selectedFolderPath, activeFilePath, getSelectionAnchorPath, items, tree, onMoveNote, rootRef, isActive = true }: {
  notebookPath: string;
  rootRef: RefObject<HTMLDivElement | null>;
  isActive?: boolean;
  selectedFilePaths: readonly string[];
  selectedFolderPath: string | null;
  activeFilePath: string | null;
  getSelectionAnchorPath: () => string | null;
  items: ReadonlyMap<string, DocTreeItem>;
  tree: FolderTreeController;
  onMoveNote: (sources: NotebookMoveSource[], targetDirectoryPath: string) => Promise<NotebookMoveResult>;
}) {
  const { t } = useI18n();
  const { clipboard, busy } = useTreeClipboard();
  const isCut = useCallback((path: string) => (
    clipboard?.mode === 'cut' && clipboard.sources.some((source) => samePath(source.path, path))
  ), [clipboard]);
  const pointerContext = useRef<{ path: string | null } | null>(null);
  const contextPath = getSelectionAnchorPath() ?? selectedFolderPath ?? activeFilePath;
  const defaultItem: TreeClipboardItem | undefined = contextPath
    ? items.get(canonicalPath(contextPath)) ?? { fullPath: contextPath, type: selectedFolderPath ? 'folder' : 'document' }
    : undefined;

  const capture = (mode: 'copy' | 'cut', item = defaultItem) => {
    const sources = treeTransferSources(item, selectedFilePaths, items);
    if (!sources.length || useTreeClipboard.getState().busy) return;
    useTreeClipboard.setState({ clipboard: { id: Symbol('tree-clipboard'), mode, scopePath: notebookPath, sources } });
  };

  const paste = async (item = defaultItem) => {
    const snapshot = useTreeClipboard.getState();
    if (!snapshot.clipboard || snapshot.busy) return;
    // Draft saves may rename a file. Work on independent operation descriptors,
    // leaving the selection and the store's existing snapshot untouched.
    const captured = { ...snapshot.clipboard, sources: snapshot.clipboard.sources.map(source => ({ ...source })) };
    const directory = treePasteDirectory(item, notebookPath);
    // Existing move use-cases preserve notebook links and open document paths.
    // They accept one notebook scope; never silently turn a cross-scope cut into an import.
    if (captured.mode === 'cut' && !samePath(captured.scopePath, notebookPath)) {
      toast.error(t('memo.fileTree.cutScopeMismatch'));
      return;
    }
    if (captured.sources.some(source => source.isFolder && (samePath(directory, source.path)
      || canonicalPath(directory).startsWith(`${canonicalPath(source.path)}/`)))) {
      toast.error(t('memo.fileTree.pasteIntoSelf'));
      return;
    }
    useTreeClipboard.setState({ busy: true });
    const succeeded = new Set<string>();
    let failures = 0;
    try {
      if (!await saveWorkspaceTransferSources(captured.sources, captured.scopePath)) {
        throw new Error('Could not save transfer sources');
      }
      if (captured.mode === 'cut') {
        const unchanged = captured.sources.filter(source => samePath(parentDirectoryPath(source.path, captured.scopePath), directory));
        unchanged.forEach(source => succeeded.add(canonicalPath(source.path)));
        const moving = captured.sources.filter(source => !succeeded.has(canonicalPath(source.path)));
        if (moving.length) {
          const result = await onMoveNote(moving, directory);
          const failed = new Set(result.failedPaths.map(canonicalPath));
          moving.forEach(source => { if (!failed.has(canonicalPath(source.path))) succeeded.add(canonicalPath(source.path)); });
          failures = result.failedPaths.length;
        }
      } else {
        for (const source of captured.sources) {
          try {
            await files.copyPath(source.path, directory, captured.scopePath, notebookPath, t('memo.fileTree.copySuffix'));
            succeeded.add(canonicalPath(source.path));
          } catch (error) {
            failures += 1;
            log.warn('copy failed', { error, path: source.path, directory });
          }
        }
      }
    } catch (error) {
      failures = captured.sources.length - succeeded.size;
      log.warn('paste failed', { error, directory });
    } finally {
      if (useTreeClipboard.getState().clipboard?.id === captured.id) {
        const remaining = captured.mode === 'cut'
          ? captured.sources.filter(source => !succeeded.has(canonicalPath(source.path)))
          : captured.sources;
        useTreeClipboard.setState({ clipboard: remaining.length ? { ...captured, sources: remaining } : null });
      }
      useTreeClipboard.setState({ busy: false });
    }
    if (succeeded.size) {
      useNoteStore.getState().triggerRefresh();
      const parents = [directory, ...(captured.mode === 'cut' ? captured.sources.map(source => parentDirectoryPath(source.path, captured.scopePath)) : [])];
      // Refresh failure cannot change the outcome of a durable filesystem operation.
      await Promise.all([...new Set(parents.map(canonicalPath))].map(path => tree.refresh(path).catch(error => log.warn('refresh after paste failed', { error, path }))));
    }
    if (failures) toast.error(t('memo.fileTree.pasteResult', { succeeded: succeeded.size, failed: failures }));
    else toast.success(t('memo.fileTree.pasteCompleted', { count: succeeded.size }));
  };

  const actionsFor = (item = defaultItem): TreeClipboardActions => {
    const current = useTreeClipboard.getState();
    return {
      canCapture: !current.busy && treeTransferSources(item, selectedFilePaths, items).length > 0,
      canPaste: !current.busy && Boolean(current.clipboard?.sources.length),
      copy: () => capture('copy', item),
      cut: () => capture('cut', item),
      paste: () => { void paste(item); },
    };
  };

  // macOS edit-menu accelerators do not produce a DOM keydown. The native
  // bridge offers the command to the focused surface before using WebKit's
  // normal text/image clipboard responder.
  useEffect(() => {
    const isEditable = (target: Element | null) => Boolean(target?.closest('input, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'));
    const pointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      const target = event.target instanceof Element ? event.target : null;
      if (!isActive || !root || !target || !root.contains(target) || isEditable(target)) {
        pointerContext.current = null;
        return;
      }
      const row = target.closest<HTMLElement>('[data-notebook-tree-path]');
      if (!row && !target.closest('[data-notebook-files-section]')) {
        pointerContext.current = null;
        return;
      }
      pointerContext.current = { path: row?.dataset.notebookTreePath ?? null };
      // Safari may keep focus in the previous editor after clicking a div.
      // Move keyboard focus only; selection remains owned by the interaction hook.
      if (!target.closest('button, a, [role="button"]')) (row ?? root).focus({ preventScroll: true });
    };
    const execute = (event: Event, action: NativeClipboardAction) => {
      if (!isActive || event.defaultPrevented) return;
      const root = rootRef.current;
      const focused = document.activeElement;
      if (!root || isEditable(focused)) return;
      const focusedInTree = focused instanceof Element && root.contains(focused);
      const row = focusedInTree ? focused.closest<HTMLElement>('[data-notebook-tree-path]') : null;
      const insideFiles = focusedInTree && (focused === root || row || focused.closest('[data-notebook-files-section]'));
      if (!insideFiles && !(focused === document.body && pointerContext.current)) return;
      const path = row?.dataset.notebookTreePath ?? pointerContext.current?.path;
      const item = path ? items.get(canonicalPath(path)) : defaultItem;
      const actions = actionsFor(item);
      if (action === 'paste' ? !actions.canPaste : !actions.canCapture) return;
      event.preventDefault();
      actions[action]();
    };
    const nativeCommand = (event: Event) => {
      const action: unknown = (event as CustomEvent<unknown>).detail;
      if (action === 'cut' || action === 'copy' || action === 'paste') execute(event, action);
    };
    const clipboardEvent = (event: Event) => execute(event, event.type as NativeClipboardAction);
    document.addEventListener('pointerdown', pointerDown, true);
    document.addEventListener(NATIVE_CLIPBOARD_ACTION_EVENT, nativeCommand);
    for (const action of ['cut', 'copy', 'paste']) document.addEventListener(action, clipboardEvent, true);
    return () => {
      document.removeEventListener('pointerdown', pointerDown, true);
      document.removeEventListener(NATIVE_CLIPBOARD_ACTION_EVENT, nativeCommand);
      for (const action of ['cut', 'copy', 'paste']) document.removeEventListener(action, clipboardEvent, true);
    };
  });

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isActive || event.defaultPrevented || event.nativeEvent.isComposing) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input, textarea, [contenteditable="true"], [role="textbox"]')) return;
    if (event.key === 'Escape' && clipboard?.mode === 'cut' && !busy) {
      useTreeClipboard.setState({ clipboard: null });
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    const row = target?.closest<HTMLElement>('[data-notebook-tree-path]');
    if (!row && !target?.closest('[data-notebook-files-section]') && target !== event.currentTarget) return;
    const path = row?.dataset.notebookTreePath;
    const item = path ? items.get(canonicalPath(path)) : defaultItem;
    const actions = actionsFor(item);
    const key = event.key.toLowerCase();
    if (key === 'c' || key === 'x') {
      if (!actions.canCapture) return;
      event.preventDefault(); event.stopPropagation();
      if (key === 'c') actions.copy(); else actions.cut();
    } else if (key === 'v' && actions.canPaste) {
      event.preventDefault(); event.stopPropagation(); actions.paste();
    }
  };

  return {
    actionsFor, handleKeyDown,
    isCut,
  };
}
