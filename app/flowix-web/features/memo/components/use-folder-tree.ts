'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { files, type DocTreeItem } from '@platform/tauri/client';
import { subscribeNotebookChanges } from '@platform/tauri/notebook-change-events';
import { canonicalDirectoryPath, canonicalPath, joinNotebookMemoPath } from '@/lib/path';
import { createLogger } from '@/lib/logger';
import { perfCount, perfMark } from '@/lib/perf-probe';
import { useNoteStore } from '../store/note-store';
import { mergeNoteMetadata, noteMetadata } from '../services/note-metadata-service';
import {
  clearDirectoryTransients,
  emptySnapshot,
  isPathAtOrBelow,
  patchDirectoryState,
  pruneExpandedSubtrees,
  readDirectoryState,
  rebasePathSet,
  rebaseSnapshot,
  reconcileDirectoryChildren,
  reconcileRootChildren,
  type DirectoryState,
  type FolderTreeSnapshot,
} from './folder-tree-model';
import { useFolderCollectionEvents } from './use-folder-collection-events';

const logger = createLogger('folder-tree');
const REFRESH_DEDUP_WINDOW_MS = 350;
const WATCHER_REFRESH_DEBOUNCE_MS = 250;
/**
 * How long a root `path-moved` keeps the old root off-limits. The owning surface
 * re-roots on the same broadcast, so this only has to cover one event loop turn
 * plus a render; the bound exists so a move that nobody re-roots (the tree is
 * opened by a surface that does not follow path changes) cannot leave the root
 * refresh permanently disabled.
 */
const ROOT_MOVE_PENDING_MS = 5_000;
/** 需要走 `canonicalPath` 的路径：带反斜杠、重复斜杠或尾斜杠。 */
const NEEDS_CANONICAL = /\\|\/\/|\/$/;

/**
 * VSCode 风格文件树数据 hook ── 惰性单层加载。
 *
 * 后端 `get_file_tree` / `get_dir_children` 只列直接子项 (folder 的
 * children 是空占位)。可见数据全在一个快照里 (`FolderTreeSnapshot`:
 * nodes / rootChildren / expanded / directories), 对外仍以 `FolderTreeState`
 * 暴露; 渲染时按 expanded 集合从根出发走 children 递归拍平。
 *
 * 收成一个快照的唯一理由是改名: 路径键控的状态必须整体搬到新路径, 而搬运
 * 只有一处 ({@link rebaseSnapshot}) 能碰它们, 新增字段漏不掉。
 *
 * 展开一个 folder 时才对它调 `getDirChildren`, 结果 merge 进 nodes;
 * 收起再展开不重新拉 (VSCode 同款行为), 刷新走 `refresh(dirPath)`。
 *
 * 帧率保护: 同一目录的并发请求复用同一个 Promise, 组件卸载后迟到响应
 * 直接丢弃。
 */
export interface FolderTreeState {
  /** 根目录直接子项 (有序)。 */
  rootChildren: DocTreeItem[];
  /** path (canonical) → node。含根下所有已加载节点。 */
  nodes: Map<string, DocTreeItem>;
  /** 已展开的 folder path 集合。 */
  expanded: Set<string>;
  loading: boolean;
  loadingDirectories: Set<string>;
  directoryErrors: Set<string>;
  /** 根目录读取失败 (路径被删 / 无权限) 时为错误信息。 */
  error: string | null;
}

export interface FolderTreeOptions {
  /** Defer the first filesystem read until the folder surface is selected. */
  enabled?: boolean;
}

export function useFolderTree(folderPath: string, options?: FolderTreeOptions) {
  const enabled = options?.enabled !== false;
  const rootKey = canonicalDirectoryPath(folderPath);
  /**
   * Notebook this tree belongs to, resolved from the mounted folder (longest
   * match wins). `path-moved` carries notebook-relative paths while the cache is
   * keyed by absolute paths, so this is what makes the move self-describing
   * without threading a new prop through every mount point. The id matters too:
   * two notebooks can contain the same relative path, and a move in one must not
   * rebase a tree that belongs to the other.
   */
  const notebooks = useNoteStore((state) => state.notebooks);
  const [notebookId, notebookRoot] = useMemo(() => {
    let matched: string | null = null;
    let path = '';
    for (const candidate of notebooks) {
      const candidatePath = canonicalDirectoryPath(candidate.path);
      if (!isPathAtOrBelow(rootKey, candidatePath)) continue;
      if (matched === null || candidatePath.length > path.length) {
        matched = candidate.id;
        path = candidatePath;
      }
    }
    return [matched, path || null] as const;
  }, [notebooks, rootKey]);
  /**
   * A `path-moved` for this tree's own root. The mounting surface re-roots in
   * response, and the root change that follows must be treated as a rename
   * (rebase + revalidate in place) instead of navigation to unrelated content.
   * Recorded here because the surface re-roots *after* the broadcast, and
   * "the parent directory matches" cannot tell a rename from a sibling switch.
   */
  const pendingRootMoveRef = useRef<{ from: string; to: string; at: number } | null>(null);
  /**
   * Whether this tree is currently waiting for its surface to re-root away from
   * `root`. Self-expiring: if nothing re-roots within {@link ROOT_MOVE_PENDING_MS}
   * the mark is dropped, because a stale mark would silently disable every later
   * watcher refresh of the root (the branch below returns before reading).
   */
  const isRootMidMove = useCallback((root: string) => {
    const move = pendingRootMoveRef.current;
    if (!move || move.from !== root) return false;
    if (Date.now() - move.at > ROOT_MOVE_PENDING_MS) {
      pendingRootMoveRef.current = null;
      return false;
    }
    return true;
  }, []);
  const [snapshot, setSnapshot] = useState<FolderTreeSnapshot>(emptySnapshot);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const { nodes, rootChildren, expanded, directories } = snapshot;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Rebasing moves the data; this counts how many times React had to redraw it.
  // Together with `tree.rebase` it answers "did that rename stall the tree?".
  useEffect(() => {
    perfCount('tree.render');
  });
  /**
   * The only write path into the snapshot. Every path-keyed field the tree shows
   * lives in one atom, so a rename migrates all of it in one function
   * (`rebaseSnapshot`) and a future field cannot be forgotten by one setter.
   */
  const commit = useCallback((next: FolderTreeSnapshot) => {
    if (next === snapshotRef.current) return;
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);
  const patchSnapshot = useCallback((recipe: (current: FolderTreeSnapshot) => FolderTreeSnapshot) => {
    commit(recipe(snapshotRef.current));
  }, [commit]);
  const setExpandedPaths = useCallback((recipe: (expanded: Set<string>) => Set<string>) => {
    patchSnapshot((current) => {
      const expanded = recipe(current.expanded);
      return expanded === current.expanded ? current : { ...current, expanded };
    });
  }, [patchSnapshot]);
  const setDirectoryState = useCallback((path: string, patch: Partial<DirectoryState>) => {
    patchSnapshot((current) => patchDirectoryState(current, path, patch));
  }, [patchSnapshot]);
  // 请求代际: 每次 folderPath 变化 / 手动刷新自增, 迟到响应按代丢弃。
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const readWithLatestMetadata = useCallback(async <T extends DocTreeItem[] | null>(directory: string, read: () => Promise<T>): Promise<T> => {
    const checkpoint = noteMetadata.checkpoint();
    const generation = generationRef.current;
    const items = await read();
    if (!items || !mountedRef.current || generation !== generationRef.current) return items;
    const listed = new Set(items.map((item) => canonicalPath(item.fullPath)));
    const parent = canonicalDirectoryPath(directory);
    for (const item of snapshotRef.current.nodes.values()) {
      const path = canonicalPath(item.fullPath);
      if (path.slice(0, path.lastIndexOf('/')) === parent && !listed.has(path)
        && noteMetadata.get(path).revision <= checkpoint) noteMetadata.deletePrefix(path);
    }
    return items.map((item) => item.type === 'document'
      ? { ...item, memoMeta: mergeNoteMetadata(item.fullPath, item.memoMeta, checkpoint) }
      : item) as T;
  }, []);
  const directoryRefreshesRef = useRef(new Map<string, Promise<void>>());
  const directoryRefreshSequenceRef = useRef(new Map<string, number>());
  const pendingWatcherDirectoriesRef = useRef(new Set<string>());
  const watcherRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRefreshRef = useRef<Promise<void> | null>(null);
  const rootRefreshSequenceRef = useRef(0);
  const pendingRenamesRef = useRef(0);
  const pendingRenameRefreshDirectoriesRef = useRef(new Set<string>());

  /**
   * Keep path-keyed tree data and UI state attached to a renamed/moved path.
   *
   * All of it — nodes, root rows, expansion, per-directory flags — moves in one
   * pure transition (`rebaseSnapshot`). Nothing here enumerates individual
   * fields, so adding one to the snapshot cannot leave a stale path behind.
   */
  const rebasePath = useCallback((previousPath: string, nextPath: string) => {
    const previous = canonicalDirectoryPath(previousPath);
    const nextPathKey = canonicalDirectoryPath(nextPath);
    const startedAt = performance.now();
    const next = rebaseSnapshot(snapshotRef.current, previous, nextPathKey, rootKey);
    if (!next) {
      // A duplicate delivery (the command receipt and the broadcast carry the
      // same change) or a move outside this tree. Touching state here would
      // rebuild the whole node map and re-render every row for nothing.
      perfCount('tree.rebase.duplicate');
      return;
    }
    // Requests started under the old path must not repopulate stale entries.
    // The parent reads are included: they still list the row under its old name.
    rootRefreshSequenceRef.current += 1;
    const oldParent = canonicalDirectoryPath(previous.slice(0, previous.lastIndexOf('/')) || '/');
    const newParent = canonicalDirectoryPath(nextPathKey.slice(0, nextPathKey.lastIndexOf('/')) || '/');
    for (const parent of new Set([oldParent, newParent])) {
      directoryRefreshSequenceRef.current.set(parent, (directoryRefreshSequenceRef.current.get(parent) ?? 0) + 1);
    }
    for (const key of directoryRefreshSequenceRef.current.keys()) {
      if (isPathAtOrBelow(key, previous)) {
        directoryRefreshSequenceRef.current.set(key, (directoryRefreshSequenceRef.current.get(key) ?? 0) + 1);
      }
    }
    commit(next);
    // Pending reads are request bookkeeping, not rendered state, so they stay
    // out of the snapshot and move here — next to the state they belong to.
    pendingWatcherDirectoriesRef.current = rebasePathSet(pendingWatcherDirectoriesRef.current, previous, nextPathKey);
    pendingRenameRefreshDirectoriesRef.current = rebasePathSet(
      pendingRenameRefreshDirectoriesRef.current,
      previous,
      nextPathKey,
    );
    perfMark('tree.rebase', performance.now() - startedAt, {
      nodes: next.nodes.size,
      expanded: next.expanded.size,
      directories: next.directories.size,
      sameParent: oldParent === newParent,
    });
  }, [commit, rootKey]);

  const ignoreCollectionPathEvents = useFolderCollectionEvents(rootKey, rebasePath);

  /**
   * `path-moved` is the only notification a plain folder rename produces —
   * `collection-changed` requires a collection below the moved directory, so a
   * folder without one never reaches the subscription above. Driving the rebase
   * from the broadcast instead of from whoever issued the rename keeps every
   * entry point (tree row, title bar, external tool, another window) on one
   * channel, so a new caller cannot forget it.
   */
  useEffect(() => {
    if (!notebookId || !notebookRoot) return;
    return subscribeNotebookChanges((change) => {
      if (change.kind !== 'path-moved' || change.notebookId !== notebookId) return;
      const previous = joinNotebookMemoPath(notebookRoot, change.previousRelativePath);
      const next = joinNotebookMemoPath(notebookRoot, change.relativePath);
      if (!previous || !next) return;
      const previousKey = canonicalPath(previous);
      const nextKey = canonicalPath(next);
      // Moves outside this subtree belong to another tree.
      if (!isPathAtOrBelow(previousKey, rootKey)) return;
      if (previousKey === rootKey) {
        // This tree's own root moved. Rebasing here would repoint the cache at a
        // path the `folderPath` prop no longer names; the owning surface decides
        // where to point next, and the effect below applies the move to the data
        // once that root change arrives.
        pendingRootMoveRef.current = { from: previousKey, to: nextKey, at: Date.now() };
        return;
      }
      rebasePath(previousKey, nextKey);
    });
  }, [notebookId, notebookRoot, rebasePath, rootKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (watcherRefreshTimerRef.current) {
        clearTimeout(watcherRefreshTimerRef.current);
        watcherRefreshTimerRef.current = null;
      }
      pendingWatcherDirectoriesRef.current.clear();
    };
  }, [folderPath]);

  /**
   * `silent` keeps the current rows visible until the new listing arrives. It is
   * used when a rename moves the root: the content is identical, so a skeleton
   * would be a flash of nothing for a mutation the user just confirmed.
   * Switching to an unrelated folder still shows the skeleton, because keeping
   * another directory's rows on screen would be misleading.
   */
  const loadRoot = useCallback(async (options?: { silent?: boolean }) => {
    const generation = ++generationRef.current;
    const silent = options?.silent === true;
    if (!silent) {
      setLoading(true);
      setError(null);
      patchSnapshot(clearDirectoryTransients);
    }
    try {
      const items = await readWithLatestMetadata(folderPath, () => files.getTree(folderPath));
      if (!mountedRef.current || generation !== generationRef.current) return;
      if (items === null) {
        commit(emptySnapshot());
        setError('unreadable');
        return;
      }
      if (silent) {
        // Same-parent rename: the caller already rebased the cache onto the new
        // root, so this read only calibrates the top level and must not throw
        // away the expanded subtrees it just moved.
        patchSnapshot((current) => ({
          ...current,
          rootChildren: items,
          nodes: reconcileRootChildren(current.nodes, current.rootChildren, items),
        }));
        setError(null);
        return;
      }
      const next = new Map<string, DocTreeItem>();
      for (const item of items) next.set(canonicalPath(item.fullPath), item);
      // A new root invalidates everything path-keyed under the old one: rows,
      // expansion, and the per-directory flags that describe them.
      commit({ nodes: next, rootChildren: items, expanded: new Set(), directories: new Map() });
    } catch (err) {
      logger.warn('load root failed', { folderPath, err });
      if (!mountedRef.current || generation !== generationRef.current) return;
      setError('unreadable');
    } finally {
      if (mountedRef.current && generation === generationRef.current) {
        setLoading(false);
      }
    }
  }, [commit, folderPath, patchSnapshot, readWithLatestMetadata]);

  const autoLoadKey = rootKey;
  const lastAutoLoadKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || lastAutoLoadKeyRef.current === autoLoadKey) return;
    const previousRoot = lastAutoLoadKeyRef.current;
    lastAutoLoadKeyRef.current = autoLoadKey;
    // A root rename is a same-content move: rebase the loaded tree onto the new
    // root and revalidate in place, so renaming from the title bar neither
    // remounts the rows nor collapses what the user expanded. Only a move this
    // tree was actually told about counts — two sibling folders share a parent,
    // and switching between them is navigation, not a rename.
    const rootMove = pendingRootMoveRef.current;
    pendingRootMoveRef.current = null;
    const isRename = previousRoot !== null
      && rootMove?.from === previousRoot
      && rootMove.to === autoLoadKey
      && Date.now() - rootMove.at <= ROOT_MOVE_PENDING_MS;
    if (isRename) rebasePath(previousRoot, autoLoadKey);
    void loadRoot({ silent: isRename });
  }, [autoLoadKey, enabled, loadRoot, rebasePath]);

  /** Coalesce concurrent reads of the same directory (manual action + watcher). */
  const refreshDirectory = useCallback((dirPath: string, {
    force = false,
    silent = false,
  }: { force?: boolean; silent?: boolean } = {}) => {
    if (pendingRenamesRef.current > 0) return Promise.resolve();
    const key = canonicalDirectoryPath(dirPath);
    const pending = directoryRefreshesRef.current.get(key);
    // Watcher reconciliation keeps existing children visible without a spinner.
    // An explicit expand can still show feedback when joining that same read.
    if (!silent) setDirectoryState(key, { loading: true });
    if (pending && !force) return pending;

    const requestSequence = (directoryRefreshSequenceRef.current.get(key) ?? 0) + 1;
    directoryRefreshSequenceRef.current.set(key, requestSequence);
    setDirectoryState(key, { error: false });

    const generation = generationRef.current;
    const request = readWithLatestMetadata(dirPath, () => files.getDirChildren(dirPath))
      .then((children) => {
        if (
          !mountedRef.current
          || pendingRenamesRef.current > 0
          || generation !== generationRef.current
          || directoryRefreshSequenceRef.current.get(key) !== requestSequence
        ) return;
        const previousChildren = snapshotRef.current.nodes.get(key)?.children ?? [];
        const nextChildKeys = new Set(children.map((child) => canonicalPath(child.fullPath)));
        const removedFolders = previousChildren
          .filter((child) => child.type === 'folder' && !nextChildKeys.has(canonicalPath(child.fullPath)))
          .map((child) => child.fullPath);
        patchSnapshot((current) => {
          // Expansion state is path-based, so drop removed folder paths (and
          // their cached nodes) before the reconciled listing replaces them; a
          // later same-name import must start collapsed.
          const expanded = pruneExpandedSubtrees(current.expanded, removedFolders);
          // Preserve loaded descendants that still exist, but remove deleted or
          // moved-away children from the flat node table. Without pruning,
          // long-running watcher refreshes retain stale nodes that
          // flattenLoadedTree continues to visit.
          const nodes = reconcileDirectoryChildren(current.nodes, key, children);
          return patchDirectoryState(
            { ...current, expanded, nodes },
            key,
            { error: false, dirty: false, refreshedAt: Date.now() },
          );
        });
      })
      .catch((err) => {
        logger.warn('refresh directory failed', { dirPath, err });
        if (!mountedRef.current || generation !== generationRef.current
          || pendingRenamesRef.current > 0
          || directoryRefreshSequenceRef.current.get(key) !== requestSequence) return;
        setDirectoryState(key, { error: true });
      })
      .finally(() => {
        if (!mountedRef.current || generation !== generationRef.current) return;
        if (directoryRefreshSequenceRef.current.get(key) !== requestSequence) return;
        setDirectoryState(key, { loading: false });
      });
    directoryRefreshesRef.current.set(key, request);
    void request.then(
      () => {
        if (directoryRefreshesRef.current.get(key) === request) {
          directoryRefreshesRef.current.delete(key);
        }
      },
      () => {
        if (directoryRefreshesRef.current.get(key) === request) {
          directoryRefreshesRef.current.delete(key);
        }
      },
    );
    return request;
  }, [patchSnapshot, readWithLatestMetadata, setDirectoryState]);

  const retryDirectory = useCallback((dirPath: string) => {
    return refreshDirectory(dirPath, { force: true });
  }, [refreshDirectory]);

  /** 展开时惰性拉子级; 已有子级的 folder 只切展开态。 */
  const loadChildren = useCallback(async (dirPath: string) => {
    const key = canonicalDirectoryPath(dirPath);
    const current = snapshotRef.current;
    const existing = current.nodes.get(key);
    // children 非空 (或是首层已知的非空列表) 说明已加载过。root 的
    // children 为空数组且确实是空目录时, 每次展开都会重新请求一次,
    // 但空目录请求成本极低, 且能在外部新建文件后自动补上。
    if (!readDirectoryState(current, key).dirty && existing?.children && existing.children.length > 0) return;
    await refreshDirectory(dirPath);
  }, [refreshDirectory]);

  const toggle = useCallback((dirPath: string) => {
    const key = canonicalDirectoryPath(dirPath);
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
    void loadChildren(dirPath);
  }, [loadChildren, setExpandedPaths]);

  /** 折叠所有已展开的 folder ── 清空 expanded 集合。 */
  const collapseAll = useCallback(() => {
    setExpandedPaths(() => new Set());
  }, [setExpandedPaths]);

  /** 展开到指定 path (打开文件后定位用, 逐级展开父链)。 */
  const expandTo = useCallback(async (targetPath: string) => {
    const canonicalTarget = canonicalPath(targetPath);
    const canonicalRoot = canonicalPath(folderPath).replace(/\/+$/, '');
    const rootPrefix = canonicalRoot.endsWith('/') ? canonicalRoot : `${canonicalRoot}/`;
    if (!canonicalTarget.startsWith(rootPrefix)) return;
    const sepIndex = canonicalTarget.lastIndexOf('/');
    if (sepIndex <= canonicalRoot.length) return;
    const ancestors: string[] = [];
    let cursor = canonicalTarget.slice(0, sepIndex);
    while (cursor.length > canonicalRoot.length && cursor.startsWith(rootPrefix)) {
      ancestors.push(cursor);
      const next = cursor.slice(0, cursor.lastIndexOf('/'));
      cursor = next;
    }
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      for (const p of ancestors) next.add(p);
      return next;
    });
    // Restore nested files as visible rows as well as selected rows. Loading
    // parents from outermost to innermost keeps lazy tree data available after
    // a full app refresh.
    for (const ancestor of ancestors.reverse()) {
      await loadChildren(ancestor);
    }
  }, [folderPath, loadChildren, setExpandedPaths]);

  /** Watcher-only root refresh; unlike the manual reload it preserves expansion. */
  const refreshRootPreservingExpansion = useCallback((force = false, reportError = false) => {
    if (pendingRenamesRef.current > 0) return Promise.resolve();
    // This root is being renamed right now. Reading the old path can only fail,
    // and the surface is about to re-root anyway.
    if (isRootMidMove(rootKey)) return Promise.resolve();
    if (rootRefreshRef.current && !force) return rootRefreshRef.current;
    const requestSequence = rootRefreshSequenceRef.current + 1;
    rootRefreshSequenceRef.current = requestSequence;
    const generation = generationRef.current;
    const request = readWithLatestMetadata(folderPath, () => files.getTree(folderPath))
      .then((items) => {
        if (
          !mountedRef.current
          || pendingRenamesRef.current > 0
          || generation !== generationRef.current
          || rootRefreshSequenceRef.current !== requestSequence
        ) return;
        if (items === null) {
          // A read that started before the rename was announced can still land
          // after it: the old path no longer resolves, but the rows are about to
          // be rebased onto the new root. Wiping here would take the expansion
          // state with it, so this one revalidation is not authoritative.
          if (isRootMidMove(rootKey)) {
            logger.warn('watcher refresh skipped: root is mid-move', { folderPath });
            return;
          }
          commit(emptySnapshot());
          setError('unreadable');
          return;
        }
        const nextChildKeys = new Set(items.map((item) => canonicalPath(item.fullPath)));
        patchSnapshot((current) => {
          const removedFolders = current.rootChildren
            .filter((item) => item.type === 'folder' && !nextChildKeys.has(canonicalPath(item.fullPath)))
            .map((item) => item.fullPath);
          const expanded = pruneExpandedSubtrees(current.expanded, removedFolders);
          const nodes = reconcileRootChildren(current.nodes, current.rootChildren, items);
          return patchDirectoryState(
            { ...current, rootChildren: items, nodes, expanded },
            rootKey,
            { dirty: false, refreshedAt: Date.now() },
          );
        });
        setError(null);
      })
      .catch((err) => {
        logger.warn('refresh root from watcher failed', { folderPath, err });
        if (reportError && mountedRef.current && generation === generationRef.current
          && rootRefreshSequenceRef.current === requestSequence) setError('unreadable');
      });
    rootRefreshRef.current = request;
    void request.then(
      () => {
        if (rootRefreshRef.current === request) rootRefreshRef.current = null;
      },
      () => {
        if (rootRefreshRef.current === request) rootRefreshRef.current = null;
      },
    );
    return request;
  }, [commit, folderPath, isRootMidMove, patchSnapshot, rootKey, readWithLatestMetadata]);

  /** 局部刷新某个目录的子级 (新建/删除/重命名后调用)。 */
  const refresh = useCallback(async (dirPath?: string) => {
    if (pendingRenamesRef.current > 0) {
      pendingRenameRefreshDirectoriesRef.current.add(canonicalDirectoryPath(dirPath ?? rootKey));
      return;
    }
    try {
      if (dirPath && canonicalDirectoryPath(dirPath) !== rootKey) {
        await refreshDirectory(dirPath, { force: true });
        return;
      }
      // Mutations at the notebook root should not collapse the user's tree.
      // A full reload remains available through `reload` for path changes and
      // explicit recovery, while routine create/move/delete reconciles data.
      await refreshRootPreservingExpansion(true);
    } catch (err) {
      logger.warn('refresh failed', { dirPath, err });
    }
  }, [refreshDirectory, refreshRootPreservingExpansion, rootKey]);

  /**
   * Reconcile native watcher notifications without throwing away expansion
   * state. Expanded directories are refreshed; collapsed ones are marked dirty
   * and reread on their next expand.
   *
   * `force` skips the dedup window for callers that know the listing is stale
   * rather than merely suspecting it — a renamed folder whose child read was
   * discarded by the rebase would otherwise keep an empty row until collapsed
   * and expanded again. It still reads silently, so no row spins.
   */
  const refreshDirectoriesNow = useCallback(async (dirPaths: string[], options?: { force?: boolean }) => {
    const force = options?.force === true;
    const keys = [...new Set(dirPaths.map((path) => canonicalDirectoryPath(path)))];
    if (keys.length === 0) return;
    if (pendingRenamesRef.current > 0) {
      for (const key of keys) pendingWatcherDirectoriesRef.current.add(key);
      return;
    }

    const current = snapshotRef.current;
    const now = Date.now();
    const refreshNow = keys.filter((key) => (
      (key === rootKey || current.expanded.has(key))
      && (force || now - readDirectoryState(current, key).refreshedAt >= REFRESH_DEDUP_WINDOW_MS)
    ));
    const defer = keys.filter((key) => key !== rootKey && !current.expanded.has(key));
    for (const key of new Set([...refreshNow, ...defer])) {
      patchSnapshot((snapshot) => patchDirectoryState(snapshot, key, { dirty: true }));
    }

    await Promise.all(refreshNow.map(async (key) => {
      if (key === rootKey) {
        await refreshRootPreservingExpansion(force);
        return;
      }

      await refreshDirectory(key, { silent: true, force });
    }));
  }, [patchSnapshot, refreshDirectory, refreshRootPreservingExpansion, rootKey]);

  /** Revalidate parents before children so removed folders cannot restore stale cache. */
  const refreshTree = useCallback(async () => {
    await refreshRootPreservingExpansion(true, true);
    let level = snapshotRef.current.rootChildren.filter((item) => item.type === 'folder');
    while (level.length > 0) {
      await refreshDirectoriesNow(level.map((item) => item.fullPath), { force: true });
      const current = snapshotRef.current;
      level = level.flatMap((item) => {
        const key = canonicalDirectoryPath(item.fullPath);
        return (current.nodes.get(key)?.children ?? []).filter((child) => child.type === 'folder');
      });
    }
  }, [refreshDirectoriesNow, refreshRootPreservingExpansion]);

  /** Merge a burst of native watcher events and refresh after it settles. */
  const refreshDirectories = useCallback((dirPaths: string[]) => {
    for (const path of dirPaths) {
      pendingWatcherDirectoriesRef.current.add(canonicalDirectoryPath(path));
    }
    if (watcherRefreshTimerRef.current) clearTimeout(watcherRefreshTimerRef.current);
    watcherRefreshTimerRef.current = setTimeout(() => {
      watcherRefreshTimerRef.current = null;
      const pending = [...pendingWatcherDirectoriesRef.current];
      pendingWatcherDirectoriesRef.current.clear();
      void refreshDirectoriesNow(pending);
    }, WATCHER_REFRESH_DEBOUNCE_MS);
  }, [refreshDirectoriesNow]);

  /** Keep watcher refreshes from publishing the gap between disk rename and index completion. */
  const renameFolder = useCallback(async (path: string, name: string, scopePath: string) => {
    pendingRenamesRef.current += 1;
    const sourcePath = canonicalDirectoryPath(path);
    let renamedPath: string | null = null;
    try {
      // The command receipt (`acceptPathMutationResult`) publishes `path-moved`
      // before this promise resolves, so the subscription above has already
      // rebased the tree by the time we get here. Rebasing again here would make
      // this entry point the only correct one and leave every other caller
      // (title bar, external tool, second window) to its own device.
      renamedPath = await files.renameFolder(path, name, scopePath);
      return renamedPath;
    } finally {
      const sourceParent = sourcePath.slice(0, sourcePath.lastIndexOf('/')) || '/';
      pendingRenameRefreshDirectoriesRef.current.add(sourceParent);
      if (renamedPath) {
        const nextPath = canonicalDirectoryPath(renamedPath);
        pendingRenameRefreshDirectoriesRef.current.add(nextPath.slice(0, nextPath.lastIndexOf('/')) || '/');
      }
      pendingRenamesRef.current -= 1;
      if (pendingRenamesRef.current === 0) {
        if (watcherRefreshTimerRef.current) {
          clearTimeout(watcherRefreshTimerRef.current);
          watcherRefreshTimerRef.current = null;
        }
        // The rebase above already published the new path into `nodes` and
        // `rootChildren`, so this read only reconciles siblings the watcher
        // missed. Route it through the watcher path instead of `refresh`: that
        // path is silent, shares the dedup window, and defers collapsed
        // directories to their next expand, so the row never shows a spinner
        // for a rename the user just confirmed.
        const followUps = [
          ...pendingRenameRefreshDirectoriesRef.current,
          ...pendingWatcherDirectoriesRef.current,
        ];
        pendingRenameRefreshDirectoriesRef.current.clear();
        pendingWatcherDirectoriesRef.current.clear();
        const startedAt = performance.now();
        void refreshDirectoriesNow(followUps).finally(() => {
          perfMark('tree.rename.flush', performance.now() - startedAt, { directories: followUps.length });
        });
      }
    }
  }, [refreshDirectoriesNow]);

  /** The public shape stays two path sets, derived from the flags they mirror. */
  const state: FolderTreeState = useMemo(() => {
    const loadingDirectories = new Set<string>();
    const directoryErrors = new Set<string>();
    for (const [path, value] of directories) {
      if (value.loading) loadingDirectories.add(path);
      if (value.error) directoryErrors.add(path);
    }
    return { rootChildren, nodes, expanded, loading, error, loadingDirectories, directoryErrors };
  }, [rootChildren, nodes, expanded, loading, error, directories]);

  return useMemo(() => ({
    ...state,
    toggle,
    /** Load a directory's children into `nodes` without touching `expanded`. */
    loadDirectory: loadChildren,
    expandTo,
    collapseAll,
    refresh,
    refreshTree,
    refreshDirectories,
    /** Same reconciliation without the watcher debounce (rename follow-ups). */
    refreshDirectoriesNow,
    reload: loadRoot,
    retryDirectory,
    rebasePath,
    renameFolder,
    ignoreCollectionPathEvents,
  }), [ignoreCollectionPathEvents, state, toggle, loadChildren, expandTo, collapseAll, refresh, refreshTree, refreshDirectories, refreshDirectoriesNow, loadRoot, retryDirectory, rebasePath, renameFolder]);
}

export type FolderTreeController = ReturnType<typeof useFolderTree>;

/** 渲染辅助 ── 从 rootChildren + nodes + expanded 拍平整棵可见树。 */
export interface VisibleTreeNode {
  item: DocTreeItem;
  depth: number;
}

/**
 * 访问空间要的路径索引：canonical path → node，以及其中的文件夹路径集合。
 *
 * 这一遍遍历不能省：`flattenVisibleTree` 下钻用的是「父节点的 children」，
 * 而不是「子项自己在 `nodes` 里」，所以凡是能被渲染出来的行都必须能查到——
 * 包括上级 reconcile 还没把子项单独登记的瞬间（拖拽移动、外部改名之后）。
 * 少索引这类行，症状是行看得见但删不掉、拖不动、改不了名。
 *
 * 原来这一遍还顺手产出 `items`（全部已加载项，含收起目录里的），唯一消费方
 * 是置顶区——它拿到数组后做的正是 `new Map(items.map(...))`，与 `itemByPath`
 * 逐键等价。消费方改吃 `itemByPath` 后 `items` 已删除，`seen` 集合也并入
 * `itemByPath.has`：遍历里每个节点只做一次去重判断，不再维护第二套键集。
 */
export interface NotebookTreeItemIndex {
  itemByPath: ReadonlyMap<string, DocTreeItem>;
  folderPaths: ReadonlySet<string>;
}

export function buildLoadedTreeIndex(
  state: { rootChildren: readonly DocTreeItem[]; nodes: ReadonlyMap<string, DocTreeItem> },
): NotebookTreeItemIndex {
  const itemByPath = new Map<string, DocTreeItem>();
  const folderPaths = new Set<string>();

  const walk = (candidate: DocTreeItem) => {
    // 落盘路径几乎总是已归一化；只有真带反斜杠/重斜杠/尾斜杠时才走 canonicalPath，
    // 免掉每个节点两次正则替换。
    const key = NEEDS_CANONICAL.test(candidate.fullPath)
      ? canonicalPath(candidate.fullPath)
      : candidate.fullPath;
    if (itemByPath.has(key)) return;

    // 根与父节点的 children 只是单层占位，真子节点在 nodes 里。
    const item = state.nodes.get(key) ?? candidate;
    itemByPath.set(key, item);
    if (item.type !== 'folder') return;
    folderPaths.add(key);
    for (const child of item.children ?? []) walk(child);
  };

  for (const item of state.rootChildren) walk(item);
  for (const item of state.nodes.values()) walk(item);
  return { itemByPath, folderPaths };
}

export type FolderTreeSort = 'createdAt' | 'updatedAt' | 'filenameAsc' | 'filenameDesc';

/** 目录名取自 fullPath 末段, 避免 name 字段在不同来源下夹带路径。 */
function folderNameOf(item: DocTreeItem): string {
  return item.fullPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? item.name;
}

/** 隐藏文件夹 = 名称以 `.` 开头 (`.trash` / `.plugin-output`)。`.`、`..` 不是真实条目。 */
function isHiddenFolderName(name: string): boolean {
  return name.startsWith('.') && name !== '.' && name !== '..';
}

function compareTreeItems(
  sort: FolderTreeSort,
  a: DocTreeItem,
  b: DocTreeItem,
  pinnedFolderOrder: ReadonlyMap<string, number>,
): number {
  // Keep directories grouped before documents for every selected sort.
  if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;

  if (a.type === 'folder' && b.type === 'folder') {
    const aOrder = pinnedFolderOrder.get(canonicalDirectoryPath(a.fullPath));
    const bOrder = pinnedFolderOrder.get(canonicalDirectoryPath(b.fullPath));
    if (aOrder !== undefined && bOrder === undefined) return -1;
    if (aOrder === undefined && bOrder !== undefined) return 1;
    if (aOrder !== undefined && bOrder !== undefined && aOrder !== bOrder) return aOrder - bOrder;
    // 手工置顶之后, 隐藏文件夹恒定聚在普通文件夹之前 ── 不受排序规则
    // 与升/降序影响; 隐藏文件夹之间仍按同一排序规则排。
    const aHidden = isHiddenFolderName(folderNameOf(a));
    const bHidden = isHiddenFolderName(folderNameOf(b));
    if (aHidden !== bHidden) return aHidden ? -1 : 1;
  }

  if (sort === 'filenameAsc' || sort === 'filenameDesc') {
    const order = a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase())
      || a.name.localeCompare(b.name)
      || a.fullPath.localeCompare(b.fullPath);
    return sort === 'filenameDesc' ? -order : order;
  }

  // Notebook notes have an indexed creation timestamp that survives atomic
  // file replacement. Prefer it over filesystem birth time for created sorting.
  const aTime = sort === 'updatedAt' ? a.modifiedMs : (a.memoCreatedMs ?? a.createdMs);
  const bTime = sort === 'updatedAt' ? b.modifiedMs : (b.memoCreatedMs ?? b.createdMs);
  if (aTime === null && bTime !== null) return 1;
  if (aTime !== null && bTime === null) return -1;
  if (aTime !== null && bTime !== null && aTime !== bTime) return bTime - aTime;
  return a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase())
    || a.name.localeCompare(b.name)
    || a.fullPath.localeCompare(b.fullPath);
}

export function flattenVisibleTree(
  state: Pick<FolderTreeState, 'rootChildren' | 'nodes' | 'expanded'>,
  sort: FolderTreeSort = 'filenameAsc',
): VisibleTreeNode[] {
  return flattenFolderSubtrees(state, state.rootChildren, state.expanded, sort);
}

/**
 * Flatten the subtrees rooted at `roots`. The pinned section reuses this to show
 * the same folder nodes a second time outside the filesystem listing, so it goes
 * through the one sort comparator and the same expand semantics, while passing
 * its own expand set (per-surface UI state over the shared node cache). Only
 * the pinned group asks for `pinnedFolderPaths`; 访问空间 keeps the plain sort
 * order. `ownRootKeys` names folders that render as a root of their own: their
 * nested occurrence is skipped so each pinned folder shows exactly once, at top
 * level.
 */
export function flattenFolderSubtrees(
  state: { nodes: ReadonlyMap<string, DocTreeItem> },
  roots: readonly DocTreeItem[],
  expanded: ReadonlySet<string>,
  sort: FolderTreeSort = 'filenameAsc',
  pinnedFolderPaths: readonly string[] = [],
  ownRootKeys: ReadonlySet<string> = new Set<string>(),
): VisibleTreeNode[] {
  const out: VisibleTreeNode[] = [];
  const pinnedFolderOrder = new Map<string, number>(
    pinnedFolderPaths.map((path, index): [string, number] => [canonicalDirectoryPath(path), index]),
  );
  const walk = (items: readonly DocTreeItem[], depth: number) => {
    for (const item of [...items].sort((a, b) => compareTreeItems(sort, a, b, pinnedFolderOrder))) {
      if (item.type === 'folder' && depth > 0 && ownRootKeys.has(canonicalPath(item.fullPath))) continue;
      out.push({ item, depth });
      if (item.type !== 'folder') continue;
      const key = canonicalPath(item.fullPath);
      if (!expanded.has(key)) continue;
      const node = state.nodes.get(key);
      const children = node?.children;
      if (children && children.length > 0) {
        walk(children, depth + 1);
      }
    }
  };
  walk(roots, 0);
  return out;
}
