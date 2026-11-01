'use client';

/**
 * 集合「当前 tab」的本地偏好（每条集合一条）。
 *
 * tab 是**视图状态**，不是集合数据：写进 `.index.yaml` 会让每次点 tab 都产生一次
 * 文件写入与 revision 变更，和表格编辑互相打架。所以跟「显示标题」一样只落
 * localStorage，按 `collectionId` 记（改名/移目录后 id 不变，偏好跟着走）。
 *
 * 键的语法（`notes` = 表格视图自身，`files` = 文件树，`<域>:<视图id>` = 某个视图
 * 实例，旧版本的域级键 `media` / `work_documents` 仍可读）只在
 * `lib/collection-tab-key.ts` 定义一次；这里只负责读写与校验。
 */
import { isCollectionTabPreference, type CollectionTabPreference } from './collection-tab-key';

export type { CollectionTabPreference };

const STORAGE_PREFIX = 'flowix:collection:active-host-tab:';

function storageKey(collectionKey: string): string {
  return `${STORAGE_PREFIX}${collectionKey}`;
}

export function readCollectionHostTab(collectionKey: string): CollectionTabPreference | null {
  try {
    const value = window.localStorage.getItem(storageKey(collectionKey));
    return value !== null && isCollectionTabPreference(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeCollectionHostTab(collectionKey: string, tab: CollectionTabPreference): void {
  try {
    window.localStorage.setItem(storageKey(collectionKey), tab);
  } catch {
    // 本地存储不可用时只是不记忆，不影响切换。
  }
}
