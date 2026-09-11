import { useEffect, useRef } from 'react';
import { getCurrentWindow } from '@platform/tauri/window';

import {
  documentIdentityKey,
  hasDocumentUnsavedChanges,
  subscribeDocumentBufferChanges,
  type DocumentIdentity,
} from '@features/document';
import { translate } from '@/lib/i18n';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { toast } from '@/lib/toast';
import { registerMemoEventHandler } from '@/lib/memo-dispatcher';
import type { MemoEvent, MemoChangeSource } from '@/types/memo';
import type { MemoContentCommit } from '@/types/memo';
import {
  markMemoCommitApplied,
  newerPendingMemoCommit,
  shouldApplyMemoCommit,
} from '@features/document/store/memo-content-revision';

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

/**
 * `tags_deleted` 事件的 reload 判定 ── 与 tags_renamed 同形, 但语义
 * 是 "tag token 被移除, 需要重新加载去掉这些 token 后的 body"。
 */
export function shouldReloadDocumentForTagsDeleted(
  event: Extract<MemoEvent, { kind: 'tags_deleted' }>,
  identity: DocumentIdentity,
  isDirty: boolean,
): boolean {
  if (identity.kind !== 'memo') return false;
  if (!event.affectedMemoIds.includes(identity.id)) return false;
  if (isDirty) return false;
  return true;
}

export type UpdatedMemoDocumentAction = 'ignore' | 'defer' | 'reload';

export function classifyUpdatedMemoDocumentAction(
  event: MemoEvent,
  identity: DocumentIdentity,
  isDirty: boolean,
  currentWindowLabel?: string,
): UpdatedMemoDocumentAction {
  if (identity.kind !== 'memo') return 'ignore';
  if (event.kind !== 'updated' || !event.path) return 'ignore';
  if (event.source === 'user_edit' && !event.originWindowLabel) return 'ignore';
  if (event.originWindowLabel && event.originWindowLabel === currentWindowLabel) return 'ignore';
  if (event.id !== identity.id) return 'ignore';
  if (!shouldApplyMemoCommit(event.id, event)) return 'ignore';
  return isDirty ? 'defer' : 'reload';
}

export function useMemoDocumentChangeWatch({
  filePath,
  identity,
  clearSaveTimer,
  reloadDocument,
}: Options) {
  const lastConflictWarningAtRef = useRef(0);
  type PendingMemoReload = MemoContentCommit & { id: string; path: string };
  const pendingExternalReloadRef = useRef<PendingMemoReload | null>(null);

  useEffect(() => {
    if (!filePath || identity.kind !== 'memo') return;
    let disposed = false;
    const currentWindowLabel = getCurrentWindow().label;

    const reloadLatestExternalContent = async (
      event: PendingMemoReload,
    ) => {
      pendingExternalReloadRef.current = null;
      clearSaveTimer();
      await reloadDocument(event.path, { preservePending: false, showLoading: false });
      markMemoCommitApplied(event.id, event);
    };

    const deferExternalReloadUntilClean = (
      event: PendingMemoReload,
    ) => {
      pendingExternalReloadRef.current = newerPendingMemoCommit(
        pendingExternalReloadRef.current,
        event,
      );
    };

    const unsubscribeBufferChanges = subscribeDocumentBufferChanges((changedIdentity) => {
      const pending = pendingExternalReloadRef.current;
      if (disposed || !pending) return;
      if (documentIdentityKey(changedIdentity) !== documentIdentityKey(identity)) return;
      if (hasDocumentUnsavedChanges(identity)) return;
      if (!shouldApplyMemoCommit(pending.id, pending)) {
        pendingExternalReloadRef.current = null;
        return;
      }
      void reloadLatestExternalContent(pending);
    });
    const warnAboutConflict = (source?: MemoChangeSource) => {
      if (!hasDocumentUnsavedChanges(identity)) return;
      if (Date.now() - lastConflictWarningAtRef.current < CONFLICT_WARNING_COOLDOWN_MS) return;
      lastConflictWarningAtRef.current = Date.now();
      const language = getCurrentAppLanguage();
      const messageKey = source === 'cloud_sync'
        ? 'document.cloud.updateAvailable'
        : 'document.external.changeWarning';
      toast.warning(translate(language, messageKey), { duration: 5000 });
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
        // tags_deleted: delete_memo_tag 一次性清理 YAML 与正文来源。当前
        // 打开的 memo 如果在 affectedMemoIds 里，需要 reload 最新内容。
        if (event.kind === 'tags_deleted') {
          const isDirty = hasDocumentUnsavedChanges(identity);
          if (!shouldReloadDocumentForTagsDeleted(event, identity, isDirty)) {
            if (isDirty) warnAboutConflict();
            return;
          }
          clearSaveTimer();
          await reloadDocument(filePath, { preservePending: false, showLoading: false });
          return;
        }
        if (event.kind !== 'updated') return;
        const action = classifyUpdatedMemoDocumentAction(
          event,
          identity,
          hasDocumentUnsavedChanges(identity),
          currentWindowLabel,
        );
        if (action === 'ignore') return;
        if (action === 'defer') {
          warnAboutConflict(event.source);
          deferExternalReloadUntilClean(event);
          return;
        }
        await reloadLatestExternalContent(event);
      },
      (event) =>
        // tags_renamed / tags_deleted: 接收 ── 但内部按 affectedMemoIds 收窄。
        // All updated events share one channel. The handler excludes only the
        // originating window by originWindowLabel.
        event.kind === 'tags_renamed'
        || event.kind === 'tags_deleted'
        || event.kind === 'updated',
    );

    return () => {
      disposed = true;
      pendingExternalReloadRef.current = null;
      unsubscribeBufferChanges();
      unsubscribeMemoEvents();
    };
  }, [filePath, identity, clearSaveTimer, reloadDocument]);
}
