'use client';

import { subscribe } from '@platform/tauri/event-bus';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { files, type DocTreeItem } from '@platform/tauri/client';
import { canonicalDirectoryPath, canonicalPath } from '@/lib/path';
import { createLogger } from '@/lib/logger';

const logger = createLogger('folder-tree');
const REFRESH_DEDUP_WINDOW_MS = 350;

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

  if (parent) next.set(parentKey, { ...parent, children: reconciledChildren });
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
  const [rootChildren, setRootChildren] = useState<DocTreeItem[]>([]);
  const [nodes, setNodes] = useState<Map<string, DocTreeItem>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [dirtyDirectories, setDirtyDirectories] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(() => new Set());
  const [directoryErrors, setDirectoryErrors] = useState<Set<string>>(() => new Set());
  // 请求代际: 每次 folderPath 变化 / 手动刷新自增, 迟到响应按代丢弃。
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const directoryRefreshesRef = useRef(new Map<string, Promise<void>>());
  const directoryRefreshSequenceRef = useRef(new Map<string, number>());
  const lastRefreshAtRef = useRef(new Map<string, number>());
  const rootRefreshRef = useRef<Promise<void> | null>(null);
  const rootRefreshSequenceRef = useRef(0);
  const rootChildrenRef = useRef(rootChildren);
  rootChildrenRef.current = rootChildren;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const mutationPathsRef = useRef(new Set<string>());
  const ignoreCollectionPathEvents = useCallback((paths: readonly string[] | undefined) => {
    if (!paths?.length) return false;
    const known = mutationPathsRef.current;
    if (!paths.every((path) => known.has(canonicalPath(path)) || /__collection_rename_/.test(path))) return false;
    return true;
  }, []);
  useEffect(() => {
    const root = canonicalPath(folderPath).replace(/\/$/, '');
    const applied = new Map<string, number>();
    mutationPathsRef.current.clear();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const stop = subscribe<{ notebookPath: string; collectionId: string; previousRelativePath: string; relativePath: string; indexSequence: number }>('collection-changed', (event) => {
      if (!event.notebookPath || !event.previousRelativePath || !event.relativePath) return;
      if (event.indexSequence < (applied.get(event.collectionId) ?? -1)) return;
      applied.set(event.collectionId, event.indexSequence);
      const previous = canonicalPath(`${event.notebookPath}/${event.previousRelativePath}`);
      const nextPath = canonicalPath(`${event.notebookPath}/${event.relativePath}`);
      if (!previous.startsWith(`${root}/`) || !nextPath.startsWith(`${root}/`)) return;
      const known = mutationPathsRef.current;
      known.add(previous); known.add(nextPath);
      // Bound suppression to the immediately following filesystem notifications.
      const timer = setTimeout(() => { known.delete(previous); known.delete(nextPath); timers.delete(timer); }, 2000);
      timers.add(timer);
      if (previous === nextPath) return;
      const oldParent = previous.slice(0, previous.lastIndexOf('/'));
      const newParent = nextPath.slice(0, nextPath.lastIndexOf('/'));
      const source = nodesRef.current.get(previous);
      const name = nextPath.split('/').pop()!;
      const rename = (item: DocTreeItem): DocTreeItem => canonicalPath(item.fullPath) === previous ? { ...item, fullPath: nextPath, name, parentId: nodesRef.current.get(newParent)?.id ?? null } : item;
      setNodes((current) => {
        const cached = current.get(previous);
        if (!cached) return current;
        const result = new Map(current);
        result.delete(previous);
        result.set(nextPath, rename(cached));
        for (const [path, item] of current) {
          if (!item.children) continue;
          if (oldParent === newParent && path === oldParent) result.set(path, { ...item, children: item.children.map(rename) });
          else if (path === oldParent) result.set(path, { ...item, children: item.children.filter((child) => canonicalPath(child.fullPath) !== previous) });
          else if (path === newParent) result.set(path, { ...item, children: [...item.children.filter((child) => canonicalPath(child.fullPath) !== nextPath), rename(cached)] });
        }
        return result;
      });
      setRootChildren((items) => {
        if (oldParent === root && newParent === root) return items.some((item) => canonicalPath(item.fullPath) === previous) ? items.map(rename) : items;
        if (oldParent === root) return items.filter((item) => canonicalPath(item.fullPath) !== previous);
        if (newParent === root && source) return [...items.filter((item) => canonicalPath(item.fullPath) !== nextPath), rename(source)];
        return items;
      });
    });
    return () => { stop(); for (const timer of timers) clearTimeout(timer); };
  }, [folderPath]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadRoot = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    setLoadingDirectories(new Set());
    setDirectoryErrors(new Set());
    try {
      const items = await files.getTree(folderPath);
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
      }
    }
  }, [folderPath]);

  const rootKey = canonicalDirectoryPath(folderPath);
  const autoLoadKey = rootKey;
  const lastAutoLoadKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || lastAutoLoadKeyRef.current === autoLoadKey) return;
    lastAutoLoadKeyRef.current = autoLoadKey;
    void loadRoot();
  }, [autoLoadKey, enabled, loadRoot]);

  /** Coalesce concurrent reads of the same directory (manual action + watcher). */
  const refreshDirectory = useCallback((dirPath: string, force = false) => {
    const key = canonicalDirectoryPath(dirPath);
    const pending = directoryRefreshesRef.current.get(key);
    if (pending && !force) return pending;

    const requestSequence = (directoryRefreshSequenceRef.current.get(key) ?? 0) + 1;
    directoryRefreshSequenceRef.current.set(key, requestSequence);
    setLoadingDirectories((previous) => new Set(previous).add(key));
    setDirectoryErrors((previous) => {
      if (!previous.has(key)) return previous;
      const next = new Set(previous);
      next.delete(key);
      return next;
    });

    const generation = generationRef.current;
    const request = files.getDirChildren(dirPath)
      .then((children) => {
        if (
          !mountedRef.current
          || generation !== generationRef.current
          || directoryRefreshSequenceRef.current.get(key) !== requestSequence
        ) return;
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
        if (!mountedRef.current || generation !== generationRef.current) return;
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
  }, []);

  const retryDirectory = useCallback((dirPath: string) => {
    return refreshDirectory(dirPath, true);
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
    if (rootRefreshRef.current && !force) return rootRefreshRef.current;
    const requestSequence = rootRefreshSequenceRef.current + 1;
    rootRefreshSequenceRef.current = requestSequence;
    const generation = generationRef.current;
    const request = files.getTree(folderPath)
      .then((items) => {
        if (
          !mountedRef.current
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
  }, [folderPath, rootKey]);

  /** 局部刷新某个目录的子级 (新建/删除/重命名后调用)。 */
  const refresh = useCallback(async (dirPath?: string) => {
    try {
      if (dirPath && canonicalDirectoryPath(dirPath) !== rootKey) {
        await refreshDirectory(dirPath, true);
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
   * state. Expanded directories are refreshed immediately; collapsed ones are
   * marked dirty and reread on their next expand.
   */
  const refreshDirectories = useCallback(async (dirPaths: string[]) => {
    const keys = [...new Set(dirPaths.map((path) => canonicalDirectoryPath(path)))];
    if (keys.length === 0) return;

    const expandedSnapshot = expanded;
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

      await refreshDirectory(key);
    }));
  }, [expanded, refresh, refreshRootPreservingExpansion, rootKey]);

  const state: FolderTreeState = useMemo(
    () => ({ rootChildren, nodes, expanded, loading, error, loadingDirectories, directoryErrors }),
    [rootChildren, nodes, expanded, loading, error, loadingDirectories, directoryErrors],
  );

  return useMemo(() => ({
    ...state,
    toggle,
    expandTo,
    collapseAll,
    refresh,
    refreshDirectories,
    reload: loadRoot,
    retryDirectory,
    ignoreCollectionPathEvents,
  }), [ignoreCollectionPathEvents, state, toggle, expandTo, collapseAll, refresh, refreshDirectories, loadRoot, retryDirectory]);
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

function compareTreeItems(sort: FolderTreeSort, a: DocTreeItem, b: DocTreeItem): number {
  // Keep directories grouped before documents for every selected sort.
  if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;

  if (sort === 'filenameAsc' || sort === 'filenameDesc') {
    const order = a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase())
      || a.name.localeCompare(b.name)
      || a.fullPath.localeCompare(b.fullPath);
    return sort === 'filenameDesc' ? -order : order;
  }

  const aTime = sort === 'updatedAt' ? a.modifiedMs : a.createdMs;
  const bTime = sort === 'updatedAt' ? b.modifiedMs : b.createdMs;
  if (aTime === null && bTime !== null) return 1;
  if (aTime !== null && bTime === null) return -1;
  if (aTime !== null && bTime !== null && aTime !== bTime) return bTime - aTime;
  return a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase())
    || a.name.localeCompare(b.name)
    || a.fullPath.localeCompare(b.fullPath);
}

export function flattenVisibleTree(state: FolderTreeState, sort: FolderTreeSort = 'createdAt'): VisibleTreeNode[] {
  const out: VisibleTreeNode[] = [];
  const walk = (items: DocTreeItem[], depth: number) => {
    for (const item of [...items].sort((a, b) => compareTreeItems(sort, a, b))) {
      out.push({ item, depth });
      if (item.type !== 'folder') continue;
      const key = canonicalPath(item.fullPath);
      if (!state.expanded.has(key)) continue;
      const node = state.nodes.get(key);
      const children = node?.children;
      if (children && children.length > 0) {
        walk(children, depth + 1);
      }
    }
  };
  walk(state.rootChildren, 0);
  return out;
}
