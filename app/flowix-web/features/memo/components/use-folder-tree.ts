'use client';

import { subscribe } from '@platform/tauri/event-bus';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { files, type CollectionChangedEvent, type DocTreeItem } from '@platform/tauri/client';
import { canonicalDirectoryPath, canonicalPath } from '@/lib/path';
import { createLogger } from '@/lib/logger';
import { mergeNoteMetadata, noteMetadata } from '../services/note-metadata-service';

const logger = createLogger('folder-tree');
const REFRESH_DEDUP_WINDOW_MS = 350;
const WATCHER_REFRESH_DEBOUNCE_MS = 250;

function deleteCachedSubtree(nodes: Map<string, DocTreeItem>, path: string): void {
  const key = canonicalPath(path);
  const node = nodes.get(key);
  if (node?.type === 'folder') {
    for (const child of node.children ?? []) {
      deleteCachedSubtree(nodes, child.fullPath);
    }
  }
  nodes.delete(key);
}

function pruneExpandedSubtrees(expanded: Set<string>, removedFolderPaths: string[]): Set<string> {
  if (removedFolderPaths.length === 0) return expanded;
  const removedKeys = removedFolderPaths.map(canonicalDirectoryPath);
  let changed = false;
  const next = new Set<string>();
  for (const path of expanded) {
    const isRemoved = removedKeys.some((root) => path === root || path.startsWith(`${root}/`));
    if (isRemoved) changed = true;
    else next.add(path);
  }
  return changed ? next : expanded;
}

function isPathAtOrBelow(path: string, directoryPath: string): boolean {
  return path === directoryPath || path.startsWith(`${directoryPath}/`);
}

function rebasePathSet(paths: Set<string>, previousPath: string, nextPath: string): Set<string> {
  let changed = false;
  const next = new Set<string>();
  for (const path of paths) {
    if (isPathAtOrBelow(path, previousPath)) {
      next.add(`${nextPath}${path.slice(previousPath.length)}`);
      changed = true;
    } else {
      next.add(path);
    }
  }
  return changed ? next : paths;
}

function reconcileDirectoryChildren(
  previous: Map<string, DocTreeItem>,
  parentKey: string,
  children: DocTreeItem[],
): Map<string, DocTreeItem> {
  const next = new Map(previous);
  const parent = previous.get(parentKey);
  const nextChildKeys = new Set(children.map((child) => canonicalPath(child.fullPath)));

  for (const oldChild of parent?.children ?? []) {
    if (!nextChildKeys.has(canonicalPath(oldChild.fullPath))) {
      deleteCachedSubtree(next, oldChild.fullPath);
    }
  }

  const reconciledChildren = children.map((child) => {
    const childKey = canonicalPath(child.fullPath);
    const cached = previous.get(childKey);
    const reconciled = child.type === 'folder' && cached?.children
      ? { ...child, children: cached.children }
      : child;
    next.set(childKey, reconciled);
    return reconciled;
  });

  if (parent) {
    next.set(parentKey, { ...parent, children: reconciledChildren });
  } else {
    // The parent entry can be missing while its children are being fetched:
    // a fresh session only holds root-level nodes, and the pinned group may
    // expand a nested folder before the files tree ever loads its ancestors.
    // Without an entry, flattening stops at `nodes.get(parent)?.children` and
    // the expansion renders as an empty list even though the children above
    // were just fetched. Insert a minimal folder node carrying them.
    next.set(parentKey, {
      id: `folder:${parentKey}`,
      fullPath: parentKey,
      name: parentKey.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? parentKey,
      type: 'folder',
      parentId: null,
      children: reconciledChildren,
      sizeBytes: null,
      modifiedMs: 0,
      createdMs: null,
      memoCreatedMs: null,
    });
  }
  return next;
}

function reconcileRootChildren(
  previous: Map<string, DocTreeItem>,
  previousRootChildren: DocTreeItem[],
  children: DocTreeItem[],
): Map<string, DocTreeItem> {
  const next = new Map(previous);
  const nextChildKeys = new Set(children.map((child) => canonicalPath(child.fullPath)));
  for (const oldChild of previousRootChildren) {
    if (!nextChildKeys.has(canonicalPath(oldChild.fullPath))) {
      deleteCachedSubtree(next, oldChild.fullPath);
    }
  }
  for (const child of children) {
    const childKey = canonicalPath(child.fullPath);
    const cached = previous.get(childKey);
    next.set(
      childKey,
      child.type === 'folder' && cached?.children
        ? { ...child, children: cached.children }
        : child,
    );
  }
  return next;
}

/**
 * VSCode 风格文件树数据 hook ── 惰性单层加载。
 *
 * 后端 `get_file_tree` / `get_dir_children` 只列直接子项 (folder 的
 * children 是空占位), 这里维护两层状态:
 *   - nodes: path → DocTreeItem (扁平 node 表, 渲染时按 expanded 集合
 *     从根出发走 children 递归拍平)
 *   - expanded: 已展开的 folder path 集合 (Set<string>, canonical 化)
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
  const [rootChildren, setRootChildren] = useState<DocTreeItem[]>([]);
  const [nodes, setNodes] = useState<Map<string, DocTreeItem>>(() => new Map());
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [dirtyDirectories, setDirtyDirectories] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [loadedRootPath, setLoadedRootPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(() => new Set());
  const [directoryErrors, setDirectoryErrors] = useState<Set<string>>(() => new Set());
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
    for (const item of nodesRef.current.values()) {
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
  const lastRefreshAtRef = useRef(new Map<string, number>());
  const pendingWatcherDirectoriesRef = useRef(new Set<string>());
  const watcherRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRefreshRef = useRef<Promise<void> | null>(null);
  const rootRefreshSequenceRef = useRef(0);
  const rootChildrenRef = useRef(rootChildren);
  rootChildrenRef.current = rootChildren;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const pendingRenamesRef = useRef(0);
  const pendingRenameRefreshDirectoriesRef = useRef(new Set<string>());

  /** Keep path-keyed tree data and UI state attached to a renamed/moved path. */
  const rebasePath = useCallback((
    previousPath: string,
    nextPath: string,
  ) => {
    const previous = canonicalDirectoryPath(previousPath);
    const nextPathKey = canonicalDirectoryPath(nextPath);
    if (previous === nextPathKey || isPathAtOrBelow(nextPathKey, previous)) return;

    const oldParent = canonicalDirectoryPath(previous.slice(0, previous.lastIndexOf('/')) || '/');
    const newParent = canonicalDirectoryPath(nextPathKey.slice(0, nextPathKey.lastIndexOf('/')) || '/');
    const nextName = nextPathKey.slice(nextPathKey.lastIndexOf('/') + 1);
    const currentNodes = nodesRef.current;
    // Discard reads started before the path changed, including parent reads.
    rootRefreshSequenceRef.current += 1;
    for (const parent of new Set([oldParent, newParent])) {
      directoryRefreshSequenceRef.current.set(parent, (directoryRefreshSequenceRef.current.get(parent) ?? 0) + 1);
    }
    const source = currentNodes.get(previous)
      ?? rootChildrenRef.current.find((item) => canonicalPath(item.fullPath) === previous);
    const nextParentId = currentNodes.get(newParent)?.id ?? null;

    const mapPath = (path: string) => {
      const canonical = canonicalPath(path);
      return isPathAtOrBelow(canonical, previous)
        ? `${nextPathKey}${canonical.slice(previous.length)}`
        : canonical;
    };
    const mapItem = (item: DocTreeItem): DocTreeItem => {
      const canonical = canonicalPath(item.fullPath);
      const isRoot = canonical === previous;
      return {
        ...item,
        fullPath: mapPath(item.fullPath),
        ...(isRoot ? { name: nextName, ...(oldParent !== newParent ? { parentId: nextParentId } : {}) } : {}),
        ...(item.children ? { children: item.children.map(mapItem) } : {}),
      };
    };

    const rebasedNodes = new Map<string, DocTreeItem>();
    for (const [key, item] of currentNodes) {
      const rebasedItem = mapItem(item);
      rebasedNodes.set(mapPath(key), rebasedItem);
    }

    const rebasedSource = source ? mapItem(source) : undefined;
    if (oldParent === newParent && rebasedSource) {
      const parent = rebasedNodes.get(newParent);
      if (parent?.children) {
        rebasedNodes.set(newParent, {
          ...parent,
          children: [...parent.children.filter((child) => canonicalPath(child.fullPath) !== nextPathKey), rebasedSource],
        });
      }
    }
    if (oldParent !== newParent) {
      const oldParentNode = rebasedNodes.get(oldParent);
      if (oldParentNode?.children) {
        rebasedNodes.set(oldParent, {
          ...oldParentNode,
          children: oldParentNode.children.filter((child) => canonicalPath(child.fullPath) !== nextPathKey),
        });
      }
      const newParentNode = rebasedNodes.get(newParent);
      if (newParentNode?.children && rebasedSource) {
        rebasedNodes.set(newParent, {
          ...newParentNode,
          children: [
            ...newParentNode.children.filter((child) => canonicalPath(child.fullPath) !== nextPathKey),
            rebasedSource,
          ],
        });
      }
    }

    nodesRef.current = rebasedNodes;
    setNodes(rebasedNodes);
    const rebasedRootChildren = rootChildrenRef.current.map(mapItem);
    let nextRootChildren = rebasedRootChildren;
    if (oldParent === newParent && newParent === rootKey && rebasedSource) {
      nextRootChildren = [...nextRootChildren.filter((child) => canonicalPath(child.fullPath) !== nextPathKey), rebasedSource];
    }
    if (oldParent !== newParent) {
      if (oldParent === rootKey) {
        nextRootChildren = nextRootChildren.filter((child) => canonicalPath(child.fullPath) !== nextPathKey);
      }
      if (newParent === rootKey && rebasedSource) {
        nextRootChildren = [
          ...nextRootChildren.filter((child) => canonicalPath(child.fullPath) !== nextPathKey),
          rebasedSource,
        ];
      }
    }
    rootChildrenRef.current = nextRootChildren;
    setRootChildren(nextRootChildren);
    const rebasedExpanded = rebasePathSet(expandedRef.current, previous, nextPathKey);
    expandedRef.current = rebasedExpanded;
    setExpanded(rebasedExpanded);
    setDirtyDirectories((current) => rebasePathSet(current, previous, nextPathKey));
    setDirectoryErrors((current) => rebasePathSet(current, previous, nextPathKey));
    // Requests started under the old path must not repopulate stale cache entries.
    for (const key of directoryRefreshSequenceRef.current.keys()) {
      if (isPathAtOrBelow(key, previous)) {
        directoryRefreshSequenceRef.current.set(key, (directoryRefreshSequenceRef.current.get(key) ?? 0) + 1);
      }
    }
    setLoadingDirectories((current) => {
      const next = new Set(current);
      for (const key of current) {
        if (isPathAtOrBelow(key, previous)) next.delete(key);
      }
      return next.size === current.size ? current : next;
    });
    for (const [key, value] of lastRefreshAtRef.current) {
      if (!isPathAtOrBelow(key, previous)) continue;
      lastRefreshAtRef.current.delete(key);
      lastRefreshAtRef.current.set(`${nextPathKey}${key.slice(previous.length)}`, value);
    }
    pendingWatcherDirectoriesRef.current = rebasePathSet(
      pendingWatcherDirectoriesRef.current,
      previous,
      nextPathKey,
    );
    pendingRenameRefreshDirectoriesRef.current = rebasePathSet(
      pendingRenameRefreshDirectoriesRef.current,
      previous,
      nextPathKey,
    );
  }, [rootKey]);

  const mutationPathsRef = useRef(new Set<string>());
  const mutationDirectoriesRef = useRef(new Set<string>());
  const ignoreCollectionPathEvents = useCallback((paths: readonly string[] | undefined) => {
    if (!paths?.length) return false;
    const known = mutationPathsRef.current;
    const knownDirectories = mutationDirectoriesRef.current;
    if (!paths.every((path) => {
      const canonical = canonicalPath(path);
      return known.has(canonical)
        || [...knownDirectories].some((directory) => isPathAtOrBelow(canonical, directory))
        || /__collection_rename_/.test(path);
    })) return false;
    return true;
  }, []);
  useEffect(() => {
    const root = canonicalPath(folderPath).replace(/\/$/, '');
    const applied = new Map<string, number>();
    mutationPathsRef.current.clear();
    mutationDirectoriesRef.current.clear();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const stop = subscribe<CollectionChangedEvent>('collection-changed', (event) => {
      if (!event.notebookPath || !event.previousRelativePath || !event.relativePath) return;
      if (event.indexSequence < (applied.get(event.collectionId) ?? -1)) return;
      applied.set(event.collectionId, event.indexSequence);
      const previous = canonicalPath(`${event.notebookPath}/${event.directoryMove?.previousRelativePath ?? event.previousRelativePath}`);
      const nextPath = canonicalPath(`${event.notebookPath}/${event.directoryMove?.relativePath ?? event.relativePath}`);
      if (!previous.startsWith(`${root}/`) || !nextPath.startsWith(`${root}/`)) return;
      const known = mutationPathsRef.current;
      known.add(previous); known.add(nextPath);
      const previousDirectory = event.directoryMove ? previous : null;
      const nextDirectory = event.directoryMove ? nextPath : null;
      if (previousDirectory) mutationDirectoriesRef.current.add(previousDirectory);
      if (nextDirectory) mutationDirectoriesRef.current.add(nextDirectory);
      // Bound suppression to the immediately following filesystem notifications.
      const timer = setTimeout(() => {
        known.delete(previous); known.delete(nextPath);
        if (previousDirectory) mutationDirectoriesRef.current.delete(previousDirectory);
        if (nextDirectory) mutationDirectoriesRef.current.delete(nextDirectory);
        timers.delete(timer);
      }, 2000);
      timers.add(timer);
      if (previous === nextPath) return;
      rebasePath(previous, nextPath);
    });
    return () => { stop(); for (const timer of timers) clearTimeout(timer); };
  }, [folderPath, rebasePath]);
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

  const loadRoot = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoadedRootPath(null);
    setLoading(true);
    setError(null);
    setLoadingDirectories(new Set());
    setDirectoryErrors(new Set());
    try {
      const items = await readWithLatestMetadata(folderPath, () => files.getTree(folderPath));
      if (!mountedRef.current || generation !== generationRef.current) return;
      if (items === null) {
        setRootChildren([]);
        setNodes(new Map());
        setExpanded(new Set());
        setDirtyDirectories(new Set());
        setError('unreadable');
        return;
      }
      const next = new Map<string, DocTreeItem>();
      for (const item of items) next.set(canonicalPath(item.fullPath), item);
      setRootChildren(items);
      setNodes(next);
      setDirtyDirectories(new Set());
      // 根目录变了, 展开状态整体作废 (旧 path 不可能出现在新根下)。
      setExpanded(new Set());
    } catch (err) {
      logger.warn('load root failed', { folderPath, err });
      if (!mountedRef.current || generation !== generationRef.current) return;
      setError('unreadable');
    } finally {
      if (mountedRef.current && generation === generationRef.current) {
        setLoading(false);
        setLoadedRootPath(canonicalDirectoryPath(folderPath));
      }
    }
  }, [folderPath, readWithLatestMetadata]);

  const autoLoadKey = rootKey;
  const lastAutoLoadKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || lastAutoLoadKeyRef.current === autoLoadKey) return;
    lastAutoLoadKeyRef.current = autoLoadKey;
    void loadRoot();
  }, [autoLoadKey, enabled, loadRoot]);

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
    if (!silent) setLoadingDirectories((previous) => (
      previous.has(key) ? previous : new Set(previous).add(key)
    ));
    if (pending && !force) return pending;

    const requestSequence = (directoryRefreshSequenceRef.current.get(key) ?? 0) + 1;
    directoryRefreshSequenceRef.current.set(key, requestSequence);
    setDirectoryErrors((previous) => {
      if (!previous.has(key)) return previous;
      const next = new Set(previous);
      next.delete(key);
      return next;
    });

    const generation = generationRef.current;
    const request = readWithLatestMetadata(dirPath, () => files.getDirChildren(dirPath))
      .then((children) => {
        if (
          !mountedRef.current
          || pendingRenamesRef.current > 0
          || generation !== generationRef.current
          || directoryRefreshSequenceRef.current.get(key) !== requestSequence
        ) return;
        const previousChildren = nodesRef.current.get(key)?.children ?? [];
        const nextChildKeys = new Set(children.map((child) => canonicalPath(child.fullPath)));
        const removedFolders = previousChildren
          .filter((child) => child.type === 'folder' && !nextChildKeys.has(canonicalPath(child.fullPath)))
          .map((child) => child.fullPath);
        if (removedFolders.length > 0) {
          // Expansion state is path-based. Drop removed folder paths as well as
          // cached nodes so a later same-name import starts collapsed.
          setExpanded((previous) => pruneExpandedSubtrees(previous, removedFolders));
        }
        // Preserve loaded descendants that still exist, but remove deleted or
        // moved-away children (and their cached subtrees) from the flat node
        // table. Without pruning, long-running watcher refreshes retain stale
        // nodes that flattenLoadedTree continues to visit.
        setNodes((prev) => reconcileDirectoryChildren(prev, key, children));
        setDirectoryErrors((previous) => {
          if (!previous.has(key)) return previous;
          const next = new Set(previous);
          next.delete(key);
          return next;
        });
        setDirtyDirectories((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        lastRefreshAtRef.current.set(key, Date.now());
      })
      .catch((err) => {
        logger.warn('refresh directory failed', { dirPath, err });
        if (!mountedRef.current || generation !== generationRef.current
          || pendingRenamesRef.current > 0
          || directoryRefreshSequenceRef.current.get(key) !== requestSequence) return;
        setDirectoryErrors((previous) => new Set(previous).add(key));
      })
      .finally(() => {
        if (!mountedRef.current || generation !== generationRef.current) return;
        if (directoryRefreshSequenceRef.current.get(key) !== requestSequence) return;
        setLoadingDirectories((previous) => {
          if (!previous.has(key)) return previous;
          const next = new Set(previous);
          next.delete(key);
          return next;
        });
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
  }, [readWithLatestMetadata]);

  const retryDirectory = useCallback((dirPath: string) => {
    return refreshDirectory(dirPath, { force: true });
  }, [refreshDirectory]);

  /** 展开时惰性拉子级; 已有子级的 folder 只切展开态。 */
  const loadChildren = useCallback(async (dirPath: string) => {
    const key = canonicalDirectoryPath(dirPath);
    const existing = nodes.get(key);
    // children 非空 (或是首层已知的非空列表) 说明已加载过。root 的
    // children 为空数组且确实是空目录时, 每次展开都会重新请求一次,
    // 但空目录请求成本极低, 且能在外部新建文件后自动补上。
    if (!dirtyDirectories.has(key) && existing?.children && existing.children.length > 0) return;
    await refreshDirectory(dirPath);
  }, [dirtyDirectories, nodes, refreshDirectory]);

  const toggle = useCallback((dirPath: string) => {
    const key = canonicalDirectoryPath(dirPath);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
    void loadChildren(dirPath);
  }, [loadChildren]);

  /** 折叠所有已展开的 folder ── 清空 expanded 集合。 */
  const collapseAll = useCallback(() => {
    setExpanded(new Set());
  }, []);

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
    setExpanded((prev) => {
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
  }, [folderPath, loadChildren]);

  /** Watcher-only root refresh; unlike the manual reload it preserves expansion. */
  const refreshRootPreservingExpansion = useCallback((force = false) => {
    if (pendingRenamesRef.current > 0) return Promise.resolve();
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
          setRootChildren([]);
          setNodes(new Map());
          setExpanded(new Set());
          setDirtyDirectories(new Set());
          setError('unreadable');
          return;
        }
        const nextChildKeys = new Set(items.map((item) => canonicalPath(item.fullPath)));
        const removedFolders = rootChildrenRef.current
          .filter((item) => item.type === 'folder' && !nextChildKeys.has(canonicalPath(item.fullPath)))
          .map((item) => item.fullPath);
        if (removedFolders.length > 0) {
          setExpanded((previous) => pruneExpandedSubtrees(previous, removedFolders));
        }
        setRootChildren(items);
        setNodes((prev) => reconcileRootChildren(prev, rootChildrenRef.current, items));
        setError(null);
        setDirtyDirectories((prev) => {
          if (!prev.has(rootKey)) return prev;
          const next = new Set(prev);
          next.delete(rootKey);
          return next;
        });
        lastRefreshAtRef.current.set(rootKey, Date.now());
      })
      .catch((err) => {
        logger.warn('refresh root from watcher failed', { folderPath, err });
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
  }, [folderPath, rootKey, readWithLatestMetadata]);

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
   */
  const refreshDirectoriesNow = useCallback(async (dirPaths: string[]) => {
    const keys = [...new Set(dirPaths.map((path) => canonicalDirectoryPath(path)))];
    if (keys.length === 0) return;
    if (pendingRenamesRef.current > 0) {
      for (const key of keys) pendingWatcherDirectoriesRef.current.add(key);
      return;
    }

    const expandedSnapshot = expandedRef.current;
    const now = Date.now();
    const refreshNow = keys.filter((key) => (
      (key === rootKey || expandedSnapshot.has(key))
      && now - (lastRefreshAtRef.current.get(key) ?? 0) >= REFRESH_DEDUP_WINDOW_MS
    ));
    const defer = keys.filter((key) => key !== rootKey && !expandedSnapshot.has(key));
    const dirty = [...new Set([...refreshNow, ...defer])];
    if (dirty.length > 0) {
      setDirtyDirectories((prev) => {
        const next = new Set(prev);
        for (const key of dirty) next.add(key);
        return next;
      });
    }

    await Promise.all(refreshNow.map(async (key) => {
      if (key === rootKey) {
        await refreshRootPreservingExpansion();
        return;
      }

      await refreshDirectory(key, { silent: true });
    }));
  }, [refreshRootPreservingExpansion, rootKey]);

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
      renamedPath = await files.renameFolder(path, name, scopePath);
      rebasePath(path, renamedPath);
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
        const parents = [...pendingRenameRefreshDirectoriesRef.current];
        pendingRenameRefreshDirectoriesRef.current.clear();
        const watcherDirectories = [...pendingWatcherDirectoriesRef.current];
        pendingWatcherDirectoriesRef.current.clear();
        void Promise.all(parents.map((parent) => refresh(parent)))
          .then(() => {
            const refreshedParents = new Set(parents);
            return refreshDirectoriesNow(watcherDirectories.filter((directory) => !refreshedParents.has(directory)));
          })
          .catch((error) => {
            logger.warn('refresh after folder rename failed', { path, error });
          });
      }
    }
  }, [rebasePath, refresh, refreshDirectoriesNow]);

  /** Apply indexed note metadata without rereading a directory or requiring a list card. */
  const updateNoteMetadata = useCallback((path: string, memoMeta: NonNullable<DocTreeItem['memoMeta']>) => {
    const key = canonicalPath(path);
    if (!isPathAtOrBelow(key, rootKey)) return;
    noteMetadata.update(key, memoMeta);
    const patch = (item: DocTreeItem): DocTreeItem => {
      if (canonicalPath(item.fullPath) === key && item.type === 'document') return { ...item, memoMeta };
      if (!item.children?.some((child) => canonicalPath(child.fullPath) === key)) return item;
      return { ...item, children: item.children.map(patch) };
    };
    setRootChildren((items) => {
      const next = items.map(patch);
      return next.some((item, index) => item !== items[index]) ? next : items;
    });
    setNodes((previous) => {
      if (!previous.has(key)) return previous;
      const next = new Map(previous);
      for (const [nodeKey, item] of previous) {
        const updated = patch(item);
        if (updated !== item) next.set(nodeKey, updated);
      }
      return next;
    });
  }, [rootKey]);

  const state: FolderTreeState = useMemo(
    () => ({ rootChildren, nodes, expanded, loading, error, loadingDirectories, directoryErrors }),
    [rootChildren, nodes, expanded, loading, error, loadingDirectories, directoryErrors],
  );

  return useMemo(() => ({
    ...state,
    loadedRootPath,
    toggle,
    /** Load a directory's children into `nodes` without touching `expanded`. */
    loadDirectory: loadChildren,
    expandTo,
    collapseAll,
    refresh,
    refreshDirectories,
    reload: loadRoot,
    retryDirectory,
    rebasePath,
    renameFolder,
    ignoreCollectionPathEvents,
    updateNoteMetadata,
  }), [updateNoteMetadata,ignoreCollectionPathEvents, loadedRootPath, state, toggle, loadChildren, expandTo, collapseAll, refresh, refreshDirectories, loadRoot, retryDirectory, rebasePath, renameFolder]);
}

export type FolderTreeController = ReturnType<typeof useFolderTree>;

/** 渲染辅助 ── 从 rootChildren + nodes + expanded 拍平整棵可见树。 */
export interface VisibleTreeNode {
  item: DocTreeItem;
  depth: number;
}

/** Flatten all currently loaded items, including items in collapsed folders. */
export function flattenLoadedTree(
  state: Pick<FolderTreeState, 'rootChildren' | 'nodes'>,
): DocTreeItem[] {
  const out: DocTreeItem[] = [];
  const seen = new Set<string>();
  const walkItem = (candidate: DocTreeItem) => {
    const key = canonicalPath(candidate.fullPath);
    if (seen.has(key)) return;
    seen.add(key);

    // Root and parent child arrays contain single-level placeholders. Prefer
    // the node-table entry so a loaded folder contributes its real children.
    const item = state.nodes.get(key) ?? candidate;
    out.push(item);
    if (item.type === 'folder') {
      for (const child of item.children ?? []) walkItem(child);
    }
  };

  for (const item of state.rootChildren) walkItem(item);
  // Include any loaded nodes that are temporarily detached while concurrent
  // watcher refreshes reconcile their parents, without revisiting subtrees.
  for (const item of state.nodes.values()) walkItem(item);
  return out;
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
