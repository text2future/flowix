import { useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

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
import {
  handleSiblingWindowContentUpdate,
  type MemoContentUpdatedEvent,
} from './sibling-window-document-sync';

interface Options {
  filePath: string;
  identity: DocumentIdentity;
  clearSaveTimer: () => void;
  reloadDocument: (path: string, options?: { preservePending?: boolean; showLoading?: boolean }) => Promise<void>;
}

const CONFLICT_WARNING_COOLDOWN_MS = 5000;

/**
 * `tags_renamed` 事件的 reload 判定 ── 抽成纯函数以便单测。
 *
 * `true` 表示应当把当前打开的 memo 文档 reload 到磁盘最新内容 (含新
 * `#tag` token); `false` 表示不该动 (无关 memo / dirty 草稿 / 不是
 * memo 文档)。
 */
export function shouldReloadDocumentForTagsRenamed(
  event: Extract<MemoEvent, { kind: 'tags_renamed' }>,
  identity: DocumentIdentity,
  isDirty: boolean,
): boolean {
  if (identity.kind !== 'memo') return false;
  if (!event.affectedMemoIds.includes(identity.id)) return false;
  if (isDirty) return false;
  return true;
}

export function useMemoDocumentChangeWatch({
  filePath,
  identity,
  clearSaveTimer,
  reloadDocument,
}: Options) {
  const lastConflictWarningAtRef = useRef(0);

  useEffect(() => {
    if (!filePath || identity.kind !== 'memo') return;
    const warnAboutConflict = () => {
      if (!hasDocumentUnsavedChanges(identity)) return;
      if (Date.now() - lastConflictWarningAtRef.current < CONFLICT_WARNING_COOLDOWN_MS) return;
      lastConflictWarningAtRef.current = Date.now();
      const language = useUserSettingsStore.getState().settings.language;
      toast.warning(translate(language, 'document.external.changeWarning'), { duration: 5000 });
    };

    const unsubscribeMemoEvents = registerMemoEventHandler(
      async (event: MemoEvent) => {
        // tags_renamed: move_memo_tag 批量改写 .md body 完成后的一次性事件。
        // 当前打开的 memo 如果在被改写的 affectedMemoIds 列表里, 需要
        // reloadDocument 把磁盘最新内容 (含新 tag token) 拉进来, 否则
        // 编辑器还显示旧 #tag, 跟列表卡片不一致。
        if (event.kind === 'tags_renamed') {
          const isDirty = hasDocumentUnsavedChanges(identity);
          if (!shouldReloadDocumentForTagsRenamed(event, identity, isDirty)) {
            if (isDirty) warnAboutConflict();
            return;
          }
          clearSaveTimer();
          await reloadDocument(filePath, { preservePending: false, showLoading: false });
          return;
        }
        if (event.kind !== 'updated' || event.source === 'user_edit' || !event.path) return;
        const updatedPath = canonicalPath(event.path);
        if (updatedPath !== canonicalPath(filePath)) return;
        if (isRecentSelfDocumentWrite(event.id, updatedPath)) return;
        if (hasDocumentUnsavedChanges(identity)) {
          warnAboutConflict();
          return;
        }
        clearSaveTimer();
        await reloadDocument(filePath, { preservePending: false, showLoading: false });
      },
      (event) =>
        // tags_renamed: 接收 ── 但内部会按 affectedMemoIds 收窄。
        // updated: 走 user_edit 排除分支 (与原行为一致)。
        event.kind === 'tags_renamed'
        || (event.kind === 'updated' && event.source !== 'user_edit'),
    );

    let disposed = false;
    let unsubscribeContentUpdates: (() => void) | null = null;
    void getCurrentWindow().listen<MemoContentUpdatedEvent>(
      'memo-content-updated',
      async ({ payload: event }) => {
        if (disposed) return;
        await handleSiblingWindowContentUpdate({
          event,
          identity,
          isDirty: hasDocumentUnsavedChanges(identity),
          onConflict: warnAboutConflict,
          clearSaveTimer,
          reloadDocument,
        });
      },
    ).then((unlisten) => {
      if (disposed) unlisten();
      else unsubscribeContentUpdates = unlisten;
    }).catch((error) => {
      console.warn('[memo-content-updated] listen failed:', error);
    });

    return () => {
      disposed = true;
      unsubscribeMemoEvents();
      unsubscribeContentUpdates?.();
    };
  }, [filePath, identity, clearSaveTimer, reloadDocument]);
}
