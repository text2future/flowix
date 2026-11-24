'use client';

/**
 * 文件夹外观（图标 / 头图 / 副标题）的前端缓存。
 *
 * 这些属性原来住在每个目录的 `.index.yaml` 里，读一次要一次磁盘 IPC；现在住在
 * 笔记本的 notebook_settings.json 中，所以**整本一次拉取**，
 * 文件树的每一行、面包屑和标题旁的图标共用同一份数据。
 *
 * 键是笔记本相对路径（`''` = 根目录）。目录改名 / 移动后后端会重定位表里的
 * 行，这里同时要重定位缓存里的键：`path-moved` 到达时把 `old` 与 `old/...`
 * 整棵子树搬到新路径，否则移动后的文件夹会瞬间退回默认图标。
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { notebookRelativeDirectoryPath } from '@/lib/path';
import { subscribe } from '@platform/tauri/event-bus';
import { subscribeNotebookChanges } from '@platform/tauri/notebook-change-events';
import { folderIndex, type FolderIndexEntry } from '@platform/tauri/client';
import type { CollectionProperty } from './model';

export type FolderAppearanceProperties = Record<string, CollectionProperty>;
type FolderEntryMap = ReadonlyMap<string, FolderAppearanceProperties>;
const EMPTY: FolderEntryMap = new Map();

interface FolderIndexChangedEvent {
  notebookId: string;
  notebookPath?: string;
  relativePath: string;
  properties: FolderAppearanceProperties;
}

interface FolderStoreState {
  ready: boolean;
  entries: FolderEntryMap;
}

interface FolderStore {
  state: FolderStoreState;
  listeners: Set<() => void>;
  stop?: () => void;
  loading: boolean;
  reloadPending: boolean;
}

/** 按 `notebookId` 缓存：事件用 id 标识笔记本，路径只用来算表键。 */
const stores = new Map<string, FolderStore>();

function storeFor(notebookId: string): FolderStore {
  const existing = stores.get(notebookId);
  if (existing) return existing;
  const store: FolderStore = {
    state: { ready: false, entries: EMPTY },
    listeners: new Set(),
    loading: false,
    reloadPending: false,
  };
  stores.set(notebookId, store);
  return store;
}

function publish(store: FolderStore, entries: FolderEntryMap): void {
  store.state = { ready: true, entries };
  for (const listener of store.listeners) listener();
}

function withEntry(entries: FolderEntryMap, relativePath: string, properties: FolderAppearanceProperties): FolderEntryMap {
  const next = new Map(entries);
  if (Object.keys(properties).length === 0) next.delete(relativePath);
  else next.set(relativePath, properties);
  return next;
}

/**
 * 平台层只描述「属性是一个 type/value 记录」；`CollectionProperty.type` 是字面量
 * 联合。两者结构一致，窄化只在 features 边界做一次，避免让 platform 反向依赖
 * 集合模型。
 */
function toProperties(raw: FolderIndexEntry['properties']): FolderAppearanceProperties {
  return raw as unknown as FolderAppearanceProperties;
}

/** 目录移动：把 `previous` 与它整棵子树的外观搬到 `next` 下。 */
export function rebaseFolderAppearance(notebookId: string, previous: string, next: string): void {
  const store = stores.get(notebookId);
  if (!store || previous === next) return;
  const moved: Array<[string, FolderAppearanceProperties]> = [];
  for (const [key, properties] of store.state.entries) {
    if (key === previous || key.startsWith(`${previous}/`)) moved.push([`${next}${key.slice(previous.length)}`, properties]);
  }
  if (moved.length === 0) return;
  const remaining = new Map(store.state.entries);
  for (const key of [...remaining.keys()]) {
    if (key === previous || key.startsWith(`${previous}/`)) remaining.delete(key);
  }
  for (const [key, properties] of moved) remaining.set(key, properties);
  publish(store, remaining);
}

async function load(notebookId: string, notebookPath: string): Promise<void> {
  const store = storeFor(notebookId);
  if (store.state.ready || store.loading) return;
  store.loading = true;
  try {
    const entries = new Map<string, FolderAppearanceProperties>();
    for (const entry of await folderIndex.list(notebookPath)) entries.set(entry.relativePath, toProperties(entry.properties));
    publish(store, entries);
  } catch {
    // 读不到就按「全部默认外观」处理，下一次挂载会重试。
    publish(store, store.state.entries);
  } finally {
    store.loading = false;
    if (store.reloadPending) {
      store.reloadPending = false;
      store.state = { ...store.state, ready: false };
      void load(notebookId, notebookPath);
    }
  }
}

function attach(notebookId: string, notebookPath: string, store: FolderStore): void {
  const stopChanged = subscribe<FolderIndexChangedEvent>('folder-index-changed', (event) => {
    if (event.notebookId !== notebookId) return;
    const current = storeFor(notebookId);
    publish(current, withEntry(current.state.entries, event.relativePath, toProperties(event.properties)));
  });
  const stopInvalidated = subscribe<{ notebookId: string }>('folder-index-invalidated', (event) => {
    if (event.notebookId !== notebookId) return;
    if (store.loading) { store.reloadPending = true; return; }
    store.state = { ...store.state, ready: false };
    void load(notebookId, notebookPath);
  });
  const stopChanges = subscribeNotebookChanges((event) => {
    if (event.notebookId !== notebookId || event.kind !== 'path-moved') return;
    rebaseFolderAppearance(notebookId, event.previousRelativePath, event.relativePath);
  });
  store.stop = () => {
    stopChanged();
    stopInvalidated();
    stopChanges();
  };
  if (store.loading) store.reloadPending = true;
  else {
    store.state = { ...store.state, ready: false };
    void load(notebookId, notebookPath);
  }
}

/** 保存一组外观变更（`null` 删除该键），返回写入后的完整属性。 */
export async function saveFolderAppearance(
  notebookPath: string,
  relativePath: string,
  patch: Record<string, CollectionProperty | null>,
): Promise<FolderAppearanceProperties> {
  const entry = await folderIndex.set(notebookPath, relativePath, patch);
  return toProperties(entry.properties);
}

/** 文件夹绝对路径 → 笔记本相对路径（`''` = 根）；不属于该笔记本时返回 null。 */
export function folderAppearanceKey(notebookPath: string | null, folderPath: string | null): string | null {
  if (!notebookPath || !folderPath) return null;
  return notebookRelativeDirectoryPath(notebookPath, folderPath);
}

function subscribeStore(notebookId: string | null, notebookPath: string | null, listener: () => void): () => void {
  if (!notebookId || !notebookPath) return () => undefined;
  const store = storeFor(notebookId);
  store.listeners.add(listener);
  if (store.listeners.size === 1) attach(notebookId, notebookPath, store);
  return () => {
    store.listeners.delete(listener);
    if (store.listeners.size === 0) {
      store.stop?.();
      store.stop = undefined;
    }
  };
}

/** 整本笔记本的文件夹外观表。挂载时按需加载，之后由事件维护。 */
export function useFolderAppearanceIndex(
  notebookId: string | null,
  notebookPath: string | null,
): FolderEntryMap {
  const subscribeForNotebook = useCallback(
    (listener: () => void) => subscribeStore(notebookId, notebookPath, listener),
    [notebookId, notebookPath],
  );
  const snapshot = useCallback(
    () => (notebookId ? stores.get(notebookId)?.state.entries ?? EMPTY : EMPTY),
    [notebookId],
  );
  return useSyncExternalStore(subscribeForNotebook, snapshot, snapshot);
}

/** 单个文件夹的属性（未配置时返回 undefined = 全部默认外观）。 */
export function useFolderAppearance(
  notebookPath: string | null,
  folderPath: string | null,
  notebookId: string | null,
): FolderAppearanceProperties | undefined {
  const entries = useFolderAppearanceIndex(notebookId, notebookPath);
  const key = folderAppearanceKey(notebookPath, folderPath);
  return useMemo(() => (key === null ? undefined : entries.get(key)), [entries, key]);
}

/** 测试用：清空模块级缓存。 */
export function resetFolderAppearanceCacheForTests(): void {
  for (const store of stores.values()) store.stop?.();
  stores.clear();
}
