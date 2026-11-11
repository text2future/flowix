import { useCallback, useEffect, useRef, useState } from 'react';
import { system } from '@platform/tauri/client';
import { subscribeNotebookChanges } from '@platform/tauri/notebook-change-events';
import { createLogger } from '@/lib/logger';

const logger = createLogger('notebook-tree-sections');
export type NotebookTreeSection = 'agents' | 'pinned' | 'files' | 'repositories' | 'more';
export type NotebookTreeHiddenSection = NotebookTreeSection;
const sectionListeners = new Set<(notebookId: string, order: NotebookTreeSection[], hidden: NotebookTreeHiddenSection[]) => void>();
const pinnedFolderListeners = new Set<(notebookId: string, pinnedFolders: string[]) => void>();

const DEFAULT_TREE_SECTION_ORDER: NotebookTreeSection[] = ['agents', 'pinned', 'files', 'repositories', 'more'];

/**
 * Older builds stored a `views` section between `pinned` and `files`; collection
 * documents now live in the access-space tree and the pinned group, so the entry
 * is dropped here. Retired or unknown names never survive, and the surviving
 * order is completed with any section the stored list predates.
 */
function normalizeTreeSectionOrder(value: unknown): NotebookTreeSection[] {
  if (!Array.isArray(value)) return DEFAULT_TREE_SECTION_ORDER;
  const order = value.filter((item, index, items): item is NotebookTreeSection => (
    DEFAULT_TREE_SECTION_ORDER.includes(item as NotebookTreeSection)
    && items.indexOf(item) === index
  ));
  return [...order, ...DEFAULT_TREE_SECTION_ORDER.filter((item) => !order.includes(item))];
}

function normalizePinnedFolderPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const paths = value.flatMap((item) => {
    if (typeof item !== 'string') return [];
    const path = item.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!path || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..')) return [];
    return [path];
  });
  return [...new Set(paths)];
}

function rebasePinnedFolderPaths(paths: string[], previousPath: string, nextPath: string): string[] | null {
  const previous = normalizePinnedFolderPaths([previousPath])[0];
  const next = normalizePinnedFolderPaths([nextPath])[0];
  if (!previous || !next || previous === next || next.startsWith(`${previous}/`)) return null;
  const rebased = paths.map((path) => (
    path === previous || path.startsWith(`${previous}/`)
      ? `${next}${path.slice(previous.length)}`
      : path
  ));
  return rebased.every((path, index) => path === paths[index]) ? null : normalizePinnedFolderPaths(rebased);
}

export function useNotebookTreeSections(notebookId: string | null, isActive: boolean) {
  const [sectionOrder, setSectionOrder] = useState<NotebookTreeSection[]>(DEFAULT_TREE_SECTION_ORDER);
  const [hiddenSections, setHiddenSections] = useState<NotebookTreeHiddenSection[]>([]);
  const [pinnedFolders, setPinnedFolders] = useState<string[]>([]);
  const pinnedFoldersRef = useRef<string[]>([]);
  const pinnedSessionRef = useRef<{
    notebookId: string | null;
    cancelled: boolean;
    ready: Promise<void>;
    queue: Promise<void>;
  } | null>(null);
  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    const session = {
      notebookId,
      cancelled: false,
      ready: Promise.resolve(),
      queue: Promise.resolve(),
    };
    pinnedSessionRef.current = session;
    let sectionsUpdated = false;
    let pinnedFoldersUpdated = false;
    const receiveSections = (id: string, order: NotebookTreeSection[], hidden: NotebookTreeHiddenSection[]) => {
      if (id !== notebookId) return;
      sectionsUpdated = true;
      setSectionOrder(order);
      setHiddenSections(hidden);
    };
    const receivePinnedFolders = (id: string, paths: string[]) => {
      if (id !== notebookId) return;
      pinnedFoldersUpdated = true;
      pinnedFoldersRef.current = paths;
      setPinnedFolders(paths);
    };
    sectionListeners.add(receiveSections);
    pinnedFolderListeners.add(receivePinnedFolders);
    setSectionOrder(DEFAULT_TREE_SECTION_ORDER);
    setHiddenSections([]);
    pinnedFoldersRef.current = [];
    setPinnedFolders([]);
    if (!notebookId) return () => {
      cancelled = true;
      session.cancelled = true;
      sectionListeners.delete(receiveSections);
      pinnedFolderListeners.delete(receivePinnedFolders);
    };
    session.ready = system.getNotebookFileTreePreferences(notebookId).then((preferences) => {
      if (cancelled) return;
      if (!sectionsUpdated) {
        setSectionOrder(normalizeTreeSectionOrder(preferences.sectionOrder));
        setHiddenSections([...new Set((preferences.hiddenSections ?? []).flatMap((item): NotebookTreeHiddenSection[] => {
          if (item === 'skillMarket') return ['more'];
          return DEFAULT_TREE_SECTION_ORDER.includes(item as NotebookTreeSection) ? [item as NotebookTreeSection] : [];
        }))]);
      }
      if (!pinnedFoldersUpdated) {
        const paths = normalizePinnedFolderPaths(preferences.pinnedFolders);
        pinnedFoldersRef.current = paths;
        setPinnedFolders(paths);
      }
    });
    void session.ready.catch((error) => {
      logger.warn('failed to load notebook file tree preferences', { error, notebookId });
    });
    return () => {
      cancelled = true;
      session.cancelled = true;
      sectionListeners.delete(receiveSections);
      pinnedFolderListeners.delete(receivePinnedFolders);
    };
  }, [isActive, notebookId]);

  const updateSections = useCallback((order: NotebookTreeSection[], hidden: NotebookTreeHiddenSection[]) => {
    setSectionOrder(order);
    setHiddenSections(hidden);
    if (!notebookId) return;
    sectionListeners.forEach((listener) => listener(notebookId, order, hidden));
    void system.setNotebookFileTreeSectionOrder(notebookId, order, hidden).catch((error) => {
      logger.warn('failed to save notebook tree preferences', { error, notebookId });
    });
  }, [notebookId]);

  // Evaluate mutations only after loading, and serialize writes so pending
  // toggles and path moves always use the latest list for this notebook session.
  const updatePinnedFolders = useCallback((update: (paths: string[]) => string[] | null) => {
    const session = pinnedSessionRef.current;
    if (!notebookId || !session || session.notebookId !== notebookId || session.cancelled) {
      return Promise.resolve();
    }
    const request = session.queue.then(async () => {
      await session.ready;
      if (session.cancelled) return;
      const paths = update(pinnedFoldersRef.current);
      if (paths === null) return;
      const next = normalizePinnedFolderPaths(paths);
      await system.setNotebookPinnedFolders(notebookId, next);
      if (session.cancelled) return;
      pinnedFoldersRef.current = next;
      setPinnedFolders(next);
      pinnedFolderListeners.forEach((listener) => listener(notebookId, next));
    });
    session.queue = request.catch(() => undefined);
    return request.catch((error) => {
      logger.warn('failed to save notebook pinned folders', { error, notebookId });
      throw error;
    });
  }, [notebookId]);

  // One folder move per event would mean one preference-file write per event;
  // a bulk move or a sync pull publishes them back to back. Collect them and
  // rebase the whole batch in a single write, still in arrival order so that
  // chained moves (a → b → c) resolve to the final path.
  const pendingMovesRef = useRef<Array<{ previousRelativePath: string; relativePath: string }>>([]);
  const flushScheduledRef = useRef(false);
  const drainMovesRef = useRef<() => void>(() => {});
  drainMovesRef.current = () => {
    flushScheduledRef.current = false;
    if (pendingMovesRef.current.length === 0) return;
    const moves = pendingMovesRef.current;
    pendingMovesRef.current = [];
    const applyMoves = (paths: string[]): string[] | null => {
      let next = paths;
      for (const move of moves) {
        next = rebasePinnedFolderPaths(next, move.previousRelativePath, move.relativePath) ?? next;
      }
      return next === paths ? null : next;
    };
    void updatePinnedFolders(applyMoves).catch(() => undefined);
  };

  // A queued move must land before an explicit toggle, otherwise the toggle is
  // written against the pre-move list and the move rebase overwrites it.
  const enqueuePinnedFoldersUpdate = useCallback((update: (paths: string[]) => string[] | null) => {
    drainMovesRef.current();
    return updatePinnedFolders(update);
  }, [updatePinnedFolders]);

  useEffect(() => {
    if (!isActive || !notebookId) return;
    const unsubscribe = subscribeNotebookChanges((change) => {
      if (change.notebookId !== notebookId || change.kind !== 'path-moved' || !change.directory) return;
      pendingMovesRef.current.push({
        previousRelativePath: change.previousRelativePath,
        relativePath: change.relativePath,
      });
      if (flushScheduledRef.current) return;
      flushScheduledRef.current = true;
      queueMicrotask(() => drainMovesRef.current());
    });
    return () => {
      unsubscribe();
      pendingMovesRef.current = [];
      flushScheduledRef.current = false;
    };
  }, [isActive, notebookId]);

  return { sectionOrder, hiddenSections, pinnedFolders, updateSections, updatePinnedFolders: enqueuePinnedFoldersUpdate };
}
