'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { files, type DocTreeItem } from '@platform/tauri/client';
import { canonicalPath } from '@/lib/path';
import { createLogger } from '@/lib/logger';

const logger = createLogger('folder-tree');
const REFRESH_DEDUP_WINDOW_MS = 350;

function canonicalDirectoryPath(path: string): string {
  const canonical = canonicalPath(path);
  const trimmed = canonical.replace(/\/+$/, '');
  return trimmed || (canonical.startsWith('/') ? '/' : canonical);
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
  /** 根目录读取失败 (路径被删 / 无权限) 时为错误信息。 */
  error: string | null;
}

export function useFolderTree(folderPath: string) {
  const [rootChildren, setRootChildren] = useState<DocTreeItem[]>([]);
  const [nodes, setNodes] = useState<Map<string, DocTreeItem>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [dirtyDirectories, setDirtyDirectories] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 请求代际: 每次 folderPath 变化 / 手动刷新自增, 迟到响应按代丢弃。
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const directoryRefreshesRef = useRef(new Map<string, Promise<void>>());
  const directoryRefreshSequenceRef = useRef(new Map<string, number>());
  const lastRefreshAtRef = useRef(new Map<string, number>());
  const rootRefreshRef = useRef<Promise<void> | null>(null);
  const rootRefreshSequenceRef = useRef(0);

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

  useEffect(() => {
    void loadRoot();
  }, [loadRoot]);

  /** Coalesce concurrent reads of the same directory (manual action + watcher). */
  const refreshDirectory = useCallback((dirPath: string, force = false) => {
    const key = canonicalDirectoryPath(dirPath);
    const pending = directoryRefreshesRef.current.get(key);
    if (pending && !force) return pending;

    const requestSequence = (directoryRefreshSequenceRef.current.get(key) ?? 0) + 1;
    directoryRefreshSequenceRef.current.set(key, requestSequence);

    const generation = generationRef.current;
    const request = files.getDirChildren(dirPath)
      .then((children) => {
        if (
          !mountedRef.current
          || generation !== generationRef.current
          || directoryRefreshSequenceRef.current.get(key) !== requestSequence
        ) return;
        setNodes((prev) => {
          const next = new Map(prev);
          for (const child of children) {
            const childKey = canonicalPath(child.fullPath);
            const cached = prev.get(childKey);
            // Single-level directory reads return folders with `children: []`
            // placeholders. Preserve an already-loaded subtree when its parent
            // refreshes, otherwise expanded sibling folders appear empty until
            // they are collapsed and expanded again.
            next.set(
              childKey,
              child.type === 'folder' && cached?.children
                ? { ...child, children: cached.children }
                : child,
            );
          }
          // 回写父节点 children 占位 (flattenVisibleTree 按它递归拍平)。
          const parent = next.get(key);
          if (parent) next.set(key, { ...parent, children });
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
        setNodes((prev) => {
          const next = new Map(prev);
          for (const item of items) {
            const itemKey = canonicalPath(item.fullPath);
            const old = prev.get(itemKey);
            next.set(itemKey, old?.children ? { ...item, children: old.children } : item);
          }
          return next;
        });
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
    () => ({ rootChildren, nodes, expanded, loading, error }),
    [rootChildren, nodes, expanded, loading, error],
  );

  return {
    ...state,
    toggle,
    expandTo,
    collapseAll,
    refresh,
    refreshDirectories,
    reload: loadRoot,
  };
}

export type FolderTreeController = ReturnType<typeof useFolderTree>;

/** 渲染辅助 ── 从 rootChildren + nodes + expanded 拍平整棵可见树。 */
export interface VisibleTreeNode {
  item: DocTreeItem;
  depth: number;
}

export function flattenVisibleTree(state: FolderTreeState): VisibleTreeNode[] {
  const out: VisibleTreeNode[] = [];
  const walk = (items: DocTreeItem[], depth: number) => {
    for (const item of items) {
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
