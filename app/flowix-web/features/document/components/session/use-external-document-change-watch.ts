import { useEffect, useRef } from 'react';

import {
  hasDocumentUnsavedChanges,
  isRecentSelfDocumentWrite,
  type DocumentIdentity,
} from '@features/document';
import { translate } from '@features/i18n';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import { toast } from '@/lib/toast';
import { canonicalPath } from '@/lib/path';
import { registerMemoEventHandler } from '@/lib/memo-dispatcher';
import type { MemoEvent } from '@/types/memo';

interface UseExternalDocumentChangeWatchOptions {
  filePath: string;
  identity: DocumentIdentity;
  clearSaveTimer: () => void;
  reloadDocument: (path: string, options?: { preservePending?: boolean; showLoading?: boolean }) => Promise<void>;
}

// fs_watcher 单次外部写入可能发多次事件 (FSEvents 双触发 + 编辑器
// debounce save), cooldown 收敛冲突警告避免 toast 风暴。
const CONFLICT_WARNING_COOLDOWN_MS = 5000;

export function useExternalDocumentChangeWatch({
  filePath,
  identity,
  clearSaveTimer,
  reloadDocument,
}: UseExternalDocumentChangeWatchOptions) {
  const lastConflictWarningAtRef = useRef(0);

  const maybeWarnAboutConflict = () => {
    if (!hasDocumentUnsavedChanges(identity)) return;
    if (Date.now() - lastConflictWarningAtRef.current < CONFLICT_WARNING_COOLDOWN_MS) return;
    lastConflictWarningAtRef.current = Date.now();
    const language = useUserSettingsStore.getState().settings.language;
    toast.warning(translate(language, 'document.external.changeWarning'), { duration: 5000 });
  };

  useEffect(() => {
    if (!filePath) return;

    // 后端 fs_watcher 是"磁盘已变"的唯一信号源。3s self-write window
    // (useDocumentAutosave) + 后端 2s mark_self_write_for TTL + 150ms
    // 防抖三道闸, 漏过的事件即为真外部变更, 不需要再 readDocument 验证。
    //
    // 走 `registerMemoEventHandler` (应用层 dispatcher) 而非直接
    // event-bus.subscribe — 跟 useMemoEvents 走同一份 memoDispatcher
    // 实例, 自动共享 dedup middleware (Phase 2) + 跨订阅者一致 filter
    // 语义。 此前直接 listen 'memo-event' 是 "双订阅绕过中央路由" 反
    // 模式, 已统一。
    const unsubscribe = registerMemoEventHandler(
      async (event: MemoEvent) => {
        if (!filePath) return;
        if (event.kind !== 'updated') return;
        if (!event.path) return;

        if (event.source === 'user_edit') return;

        // 匹配 emit path 跟当前 filePath ── 不一致说明物理 rename 了
        // (emit 用 memo index 新 path, filePath 是 React 状态可能未跟上)。
        // 这种情况由 useMemoEvents 内的 syncActiveDocumentPathIfRenamed
        // 全权处理 (切 active path + 同步 buffer), 本 hook 不再 reload,
        // 避免重复 IPC + 重复 applyLoadedContent。
        const updatedPath = canonicalPath(event.path);
        const currentPath = canonicalPath(filePath);
        if (updatedPath !== currentPath) {
          // eslint-disable-next-line no-console
          console.log('[ext-watch] skip (path mismatch)', {
            at: new Date().toISOString(),
            source: event.source,
            id: event.id,
            eventPath: updatedPath,
            currentPath,
          });
          return;
        }

        if (isRecentSelfDocumentWrite(event.id, updatedPath)) {
          // The backend watcher can still surface our own successful write as
          // a non-user_edit event. Treat matching recent writes as self-noise,
          // otherwise first-line title editing trips the external-change UI.
          return;
        }

        if (hasDocumentUnsavedChanges(identity)) {
          // 用户在敲字, 外部并发改盘 ── 提示冲突但不覆盖 (避免丢字符),
          // 让用户决定下一步 (继续编辑 / 手动复制 / 切走再切回)。
          // eslint-disable-next-line no-console
          console.log('[ext-watch] conflict (local dirty) -> toast', {
            at: new Date().toISOString(),
            source: event.source,
            id: event.id,
            path: currentPath,
          });
          maybeWarnAboutConflict();
          return;
        }

        // eslint-disable-next-line no-console
        console.log('[ext-watch] reload from disk', {
          at: new Date().toISOString(),
          source: event.source,
          id: event.id,
          path: currentPath,
        });
        // 无本地脏字符, 拉磁盘新内容覆盖编辑器。event.path 此时
        // 等于 currentPath (上面已匹配), 用哪个都行 ── 用 filePath 跟原
        // 行为一致。
        clearSaveTimer();
        await reloadDocument(filePath, { preservePending: false, showLoading: false });
      },
      // filter 只声明 kind + source, path 比对放在 handler 内 (依赖 React 状态)。
      (event) => event.kind === 'updated' && event.source !== 'user_edit',
    );

    return unsubscribe;
  }, [
    filePath,
    identity,
    reloadDocument,
    clearSaveTimer,
    ]);
}
