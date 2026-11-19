import { canonicalDirectoryPath, canonicalPath } from '@/lib/path';
import type { DocTreeItem } from '@platform/tauri/client';

/**
 * 文件树的纯数据变换：缓存子树裁剪、展开集合与前缀 rebase、目录/根级对账。
 *
 * 抽出来是为了让 `use-folder-tree` 只剩状态机与 IPC 编排，并且这些函数可以
 * 脱离 React 单独复用与推理。
 */

/**
 * 与路径绑定的全部可见状态，**一个对象**。
 *
 * 为什么值得合并：改名/移动时每一份 path-keyed 状态都要跟着搬到新路径，散成
 * 七个 `useState` / ref 时，新增一份就必须记得在 `rebasePath` 里再加一段——
 * 漏了不报错，只是某个角落悄悄指着旧路径。合并成一个快照后，搬运只有一条路
 * （{@link rebaseSnapshot}），新增字段时它就在同一个函数里，漏不掉。
 *
 * 不在这里的两类：
 *   - 根级 `loading` / `error`：不按路径索引，改名与它们无关；
 *   - 在途请求的记账（promise、sequence、待刷新队列）：它们不参与渲染，
 *     进快照只会让 watcher 事件无意义地触发重渲染。
 */
export interface DirectoryState {
  /** A read is in flight for this directory (drives the row spinner). */
  loading: boolean;
  /** The last read failed; the row offers retry. */
  error: boolean;
  /** Collapsed and stale: reread on next expand. */
  dirty: boolean;
  /** Last successful read, used for the dedup window. 0 = never. */
  refreshedAt: number;
}

const IDLE_DIRECTORY: DirectoryState = { loading: false, error: false, dirty: false, refreshedAt: 0 };

export interface FolderTreeSnapshot {
  /** path (canonical) → node. Contains every loaded node below the root. */
  nodes: Map<string, DocTreeItem>;
  /** Direct children of the root, in listing order. */
  rootChildren: DocTreeItem[];
  /** Expanded folder paths. */
  expanded: Set<string>;
  /** Per-directory reconciliation flags. Absent = idle. */
  directories: Map<string, DirectoryState>;
}

export function emptySnapshot(): FolderTreeSnapshot {
  return { nodes: new Map(), rootChildren: [], expanded: new Set(), directories: new Map() };
}

export function readDirectoryState(snapshot: FolderTreeSnapshot, path: string): DirectoryState {
  return snapshot.directories.get(path) ?? IDLE_DIRECTORY;
}

/**
 * Write one directory's flags, keeping the rest. Returns the same snapshot when
 * nothing actually changes, so a no-op patch never re-renders the tree. An entry
 * that returns to the idle shape is dropped instead of stored, which keeps the
 * map proportional to what is currently loading / failing / stale.
 */
export function patchDirectoryState(
  snapshot: FolderTreeSnapshot,
  path: string,
  patch: Partial<DirectoryState>,
): FolderTreeSnapshot {
  const current = snapshot.directories.get(path) ?? IDLE_DIRECTORY;
  const next: DirectoryState = { ...current, ...patch };
  if (next.loading === current.loading && next.error === current.error
    && next.dirty === current.dirty && next.refreshedAt === current.refreshedAt) {
    return snapshot;
  }
  const directories = new Map(snapshot.directories);
  if (!next.loading && !next.error && !next.dirty && next.refreshedAt === 0) directories.delete(path);
  else directories.set(path, next);
  return { ...snapshot, directories };
}

/** Drop loading/error marks for every directory, keep staleness and read times. */
export function clearDirectoryTransients(snapshot: FolderTreeSnapshot): FolderTreeSnapshot {
  let changed = false;
  const directories = new Map<string, DirectoryState>();
  for (const [path, value] of snapshot.directories) {
    const next = { ...value, loading: false, error: false };
    if (next.loading !== value.loading || next.error !== value.error) changed = true;
    if (next.dirty || next.refreshedAt > 0) directories.set(path, next);
  }
  return changed ? { ...snapshot, directories } : snapshot;
}

/**
 * Move every path-keyed piece of the tree from `previousPath` onto `nextPath`.
 *
 * This is the **only** migration point for a rename/move. Returns `null` when
 * there is nothing to move (a duplicate delivery, or a move that does not touch
 * this tree), which the caller treats as "no state change at all".
 *
 * `rootPath` is the tree's own root: it decides whether the moved row enters or
 * leaves the top-level list, and the snapshot deliberately does not store it
 * (the root is a prop, not state).
 */
export function rebaseSnapshot(
  snapshot: FolderTreeSnapshot,
  previousPath: string,
  nextPath: string,
  rootPath: string,
): FolderTreeSnapshot | null {
  const previous = canonicalDirectoryPath(previousPath);
  const nextPathKey = canonicalDirectoryPath(nextPath);
  const rootPathKey = canonicalDirectoryPath(rootPath);
  if (previous === nextPathKey || isPathAtOrBelow(nextPathKey, previous)) return null;

  const source = snapshot.nodes.get(previous)
    ?? snapshot.rootChildren.find((item) => canonicalPath(item.fullPath) === previous);
  // Idempotent by construction: a second delivery of the same move finds
  // neither the node nor any descendant under the old path.
  if (!source && !hasPathBelow(snapshot.nodes, previous)) return null;

  const oldParent = canonicalDirectoryPath(previous.slice(0, previous.lastIndexOf('/')) || '/');
  const newParent = canonicalDirectoryPath(nextPathKey.slice(0, nextPathKey.lastIndexOf('/')) || '/');
  const nextName = nextPathKey.slice(nextPathKey.lastIndexOf('/') + 1);
  const nextParentId = snapshot.nodes.get(newParent)?.id ?? null;

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

  const nodes = new Map<string, DocTreeItem>();
  for (const [key, item] of snapshot.nodes) {
    nodes.set(mapPath(key), mapItem(item));
  }

  const rebasedSource = source ? mapItem(source) : undefined;
  /**
   * Put the moved row under one parent: drop the copy `mapItem` left behind
   * (it is still listed where the row used to be) and append the rebased one.
   * `undefined` means "detach only" — the row left this parent. Order is not
   * preserved on purpose: every level is re-sorted by `flattenVisibleTree`.
   */
  const placeChild = (parentKey: string, replacement: DocTreeItem | undefined) => {
    const parent = nodes.get(parentKey);
    if (!parent?.children) return;
    const kept = parent.children.filter((child) => canonicalPath(child.fullPath) !== nextPathKey);
    if (!replacement && kept.length === parent.children.length) return;
    nodes.set(parentKey, { ...parent, children: replacement ? [...kept, replacement] : kept });
  };
  placeChild(oldParent, oldParent === newParent ? rebasedSource : undefined);
  if (oldParent !== newParent) placeChild(newParent, rebasedSource);

  // The root list is the same rule against a parent that is not a node: the
  // tree's own root is a prop, so it has no entry in `nodes`.
  let rootChildren = snapshot.rootChildren.map(mapItem);
  const placeRootChild = (replacement: DocTreeItem | undefined) => {
    const kept = rootChildren.filter((child) => canonicalPath(child.fullPath) !== nextPathKey);
    rootChildren = replacement
      ? [...kept, replacement]
      : kept.length === rootChildren.length ? rootChildren : kept;
  };
  if (newParent === rootPathKey) placeRootChild(rebasedSource);
  else if (oldParent === rootPathKey) placeRootChild(undefined);

  return {
    nodes,
    rootChildren,
    expanded: rebasePathSet(snapshot.expanded, previous, nextPathKey),
    directories: rebaseDirectories(snapshot.directories, previous, nextPathKey),
  };
}

/**
 * Move directory flags across a rename. Loading markers are **dropped**, not
 * carried: reads started under the old path are discarded by the caller's
 * sequence bump, so a stale spinner would never be cleared; errors and read
 * times stay meaningful under the new path.
 */
function rebaseDirectories(
  directories: Map<string, DirectoryState>,
  previous: string,
  nextPathKey: string,
): Map<string, DirectoryState> {
  let moved: Map<string, DirectoryState> | null = null;
  for (const [path, value] of directories) {
    if (!isPathAtOrBelow(path, previous)) continue;
    moved ??= new Map(directories);
    moved.delete(path);
    moved.set(`${nextPathKey}${path.slice(previous.length)}`, { ...value, loading: false });
  }
  return moved ?? directories;
}

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

export function pruneExpandedSubtrees(expanded: Set<string>, removedFolderPaths: string[]): Set<string> {
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

export function isPathAtOrBelow(path: string, directoryPath: string): boolean {
  return path === directoryPath || path.startsWith(`${directoryPath}/`);
}

/** Any cached key strictly below `directoryPath`. Early-exits without allocating. */
function hasPathBelow(nodes: Map<string, DocTreeItem>, directoryPath: string): boolean {
  const prefix = `${directoryPath}/`;
  for (const key of nodes.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

export function rebasePathSet(paths: Set<string>, previousPath: string, nextPath: string): Set<string> {
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

export function reconcileDirectoryChildren(
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

export function reconcileRootChildren(
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
