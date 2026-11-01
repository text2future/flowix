import { STORAGE_KEYS } from '@/lib/constants';

/**
 * 读「当前笔记本」（主窗口里选中的那本）的 id。
 *
 * 偏好设置是独立窗口、独立 React 树，拿不到主窗口内存里的 store；两个窗口共享
 * 同源 localStorage，而 `features/memo/store/note-store` 的 persist 会把
 * `selectedNotebookId` 写进 `STORAGE_KEYS.NOTE`，所以这里读持久化快照。
 *
 * 刻意不 import memo 的 public API：memo 已经依赖 preferences 的 runtime-api，
 * 反向引用会形成 memo<->preferences 环，被 check:arch 拦下。
 * 代价是 note-store 的 `partialize` 字段名是本文件的隐式契约——那边改名要同步这里。
 */
export function readSelectedNotebookId(): string | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.NOTE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: { selectedNotebookId?: unknown } };
    const id = parsed.state?.selectedNotebookId;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}
