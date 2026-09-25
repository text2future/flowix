import { useCallback, useEffect, useRef } from 'react';

import { externalDocuments, memos as memosClient } from '@platform/tauri/client';
import {
  getDocumentDraft,
  applyLoadedDocumentContent,
  discardDocumentDraft,
  getDocumentBuffer,
  hasDocumentUnsavedChanges,
  recordDocumentEdit,
  protectDocumentDraft,
  saveDocumentContent,
} from '@features/document/store/document-session-service';
import type { DocumentIdentity } from '@features/document/store/document-identity';
import { translate } from '@/lib/i18n';
import { syncMemoPathAfterLocalWrite } from '@features/document/use-cases/sync-memo-path-after-local-write';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { toast } from '@/lib/toast';
import { formatDateTime } from '@/lib/utils';
import {
  countTextUnits,
  extractBodyContent,
} from '@features/document/components/session/document-utils';
import type { DocumentContainerState } from '@features/document/components/session/types';

const DERIVED_STATS_DEBOUNCE_MS = 200;
const RECOVERY_DRAFT_DEBOUNCE_MS = 300;
const DOCUMENT_FLUSH_WAIT_MS = 5_000;

function waitForSave(promise: Promise<boolean>): Promise<boolean | 'timeout'> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve('timeout'), DOCUMENT_FLUSH_WAIT_MS);
    void promise.then(
      (saved) => {
        window.clearTimeout(timer);
        resolve(saved);
      },
      () => {
        window.clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

interface UseDocumentAutosaveOptions {
  filePath: string;
  identity: DocumentIdentity;
  /**
   * 内部 memo 文档的 memoId, 走 `key+channel='internal'` 走 key 反查;
   * 外部文本文件传 null, 走 `channel='external'` 走 path 寻址。
   */
  memoId: string | null;
  isExternalDocument: boolean;
  externalScopePath: string | null;
  setState: React.Dispatch<React.SetStateAction<DocumentContainerState>>;
  reloadDocument: (path: string, options?: { preservePending?: boolean; showLoading?: boolean }) => Promise<void>;
  flushPendingContent?: () => string | null;
  isolatedSession?: boolean;
}

export function useDocumentAutosave({
  filePath,
  identity,
  memoId,
  isExternalDocument,
  externalScopePath,
  setState,
  reloadDocument,
  flushPendingContent,
  isolatedSession = false,
}: UseDocumentAutosaveOptions) {
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const derivedStatsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveryDraftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const derivedStatsVersionRef = useRef(0);
  const isMountedRef = useRef(true);

  const clearSaveTimer = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  const clearDerivedStatsTimer = useCallback(() => {
    if (derivedStatsTimerRef.current) {
      clearTimeout(derivedStatsTimerRef.current);
      derivedStatsTimerRef.current = null;
    }
  }, []);

  const clearRecoveryDraftTimer = useCallback(() => {
    if (recoveryDraftTimerRef.current) {
      clearTimeout(recoveryDraftTimerRef.current);
      recoveryDraftTimerRef.current = null;
    }
  }, []);

  const scheduleDerivedStatsUpdate = useCallback((content: string) => {
    clearDerivedStatsTimer();
    const version = derivedStatsVersionRef.current + 1;
    derivedStatsVersionRef.current = version;
    derivedStatsTimerRef.current = setTimeout(() => {
      derivedStatsTimerRef.current = null;
      const body = extractBodyContent(content);
      const textUnits = countTextUnits(body);
      if (!isMountedRef.current || version !== derivedStatsVersionRef.current) return;
      setState(prev => {
        if (prev.fullContent !== content) return prev;
        return {
          ...prev,
          charCount: textUnits,
          tokenCount: Math.ceil(textUnits / 4),
        };
      });
    }, DERIVED_STATS_DEBOUNCE_MS);
  }, [clearDerivedStatsTimer, setState]);

  const saveDoc = useCallback(async (
    content: string,
    path: string,
    options?: { force?: boolean; silent?: boolean },
  ): Promise<boolean> => {
    if (!path) return false;
    let casRefused = false;
    const buf = getDocumentBuffer(identity);
    // Another surface may have edited since this save was scheduled.
    content = buf.content;

    const saved = await saveDocumentContent({
      path,
      identity,
      content,
      channel: isExternalDocument ? 'external' : 'internal',
      key: isExternalDocument ? null : memoId,
      scopePath: externalScopePath,
      force: options?.force,
      callbacks: {
        onSaved: (writtenPath, writtenContent) => {
          const now = Date.now();
          if (isMountedRef.current) {
            setState(prev => ({
              ...prev,
              updatedAt: formatDateTime(now, getCurrentAppLanguage()),
              updatedAtDate: new Date(now),
              error: null,
            }));
          }
          // Internal memo writes normally preserve the filename. Keep the path
          // reconciliation as a defensive fallback for an external rename that
          // races this content save.
          if (writtenPath !== path) {
            applyLoadedDocumentContent(identity, writtenPath, writtenContent, { preservePending: true });
            if (!isExternalDocument && memoId) {
              syncMemoPathAfterLocalWrite(memoId, writtenPath);
            }
            // 旧 path buf 已在 buffer-registry 的 Map 里残留 ── 不删, 等
            // GC。后续 use-external-document-change-watch 看到旧 path
            // 找不到文件, 自然走 ignore 路径。
          }
          // 写盘后派生同步由后端 `write_document` 单点保证；标题改名走
          // 独立的 `rename_memo_title` IPC，不再由正文首行隐式触发。
          void writtenContent;
        },
        onCasRefused: (writtenContent) => {
          // 后端已经吸收 Tiptap/frontmatter 的轻量语义差异; 走到这里
          // 就按真实外部修改处理。
          console.warn('[writeDocument] CAS refused — diagnostic dump:', {
            path,
            bufLen: buf.content.length,
            callerLen: writtenContent.length,
            lastSavedLen: buf.lastSavedContent.length,
            bufHead: buf.content.slice(0, 200),
            callerHead: writtenContent.slice(0, 200),
            lastSavedHead: buf.lastSavedContent.slice(0, 200),
          });
          casRefused = true;
          void writtenContent;
        },
        onError: (_writtenContent, _revision, err) => {
          console.error('[DocumentContainer] Failed to save memo:', err);
          const language = getCurrentAppLanguage();
          const message = err instanceof Error ? err.message : String(err);
          if (!options?.silent) {
            toast.error(translate(language, 'document.save.failed', { message }), {
              duration: 5000,
            });
          }
          if (isMountedRef.current) {
            // 错误展示在 document-container 里的 state.error (ghost 兜底视图);
            // 此处承载 save 失败语义 ── 用 document.save.failed + 实际 error
            // 拼接, 跟 toast 文案保持一致。
            setState(prev => ({ ...prev, error: translate(language, 'document.save.failed', { message }) }));
          }
        },
      },
    });
    if (saved || !casRefused || !isMountedRef.current) return saved;

    // A deleted source and a genuine CAS conflict both arrive as a refused
    // internal write. Resolve that ambiguity before showing a conflict toast.
    let onDisk: string | null;
    try {
      onDisk = isExternalDocument
        ? await externalDocuments.read(path, externalScopePath)
        : await memosClient.readDocument(path);
    } catch {
      const language = getCurrentAppLanguage();
      if (!options?.silent) {
        toast.error(translate(language, 'document.save.casRefused'), { duration: 5000 });
      }
      return false;
    }
    if (!isMountedRef.current) return false;
    if (onDisk === null) {
      return false;
    }
    buf.lastSavedContent = onDisk;
    const language = getCurrentAppLanguage();
    if (!options?.silent) {
      toast.error(translate(language, 'document.save.casRefused'), { duration: 5000 });
    }
    return false;
  }, [
    isExternalDocument,
    externalScopePath,
    identity,
    isolatedSession,
    memoId,
    setState,
  ]);

  /** Flush an isolated browser tab before React unmounts its editor. */
  const flushDocument = useCallback(async (
    options?: { silent?: boolean },
  ): Promise<boolean> => {
    const flushedContent = flushPendingContent?.() ?? null;
    const draft = getDocumentDraft(identity, filePath);
    const content = flushedContent ?? draft?.content;
    const path = draft?.path ?? filePath;
    clearSaveTimer();
    if (content == null || !path || !hasDocumentUnsavedChanges(identity)) return true;
    const result = await waitForSave(saveDoc(content, path, options));
    if (result === true) return true;

    // The canonical request may still be running after a timeout. Do not
    // start a competing write; protect the captured revision separately and
    // let the per-document save queue keep its ordering.
    return protectDocumentDraft(
      identity,
      path,
      result === 'timeout' ? 'save-timeout' : 'save-error',
    );
  }, [clearSaveTimer, filePath, flushPendingContent, identity, saveDoc]);

  const discardDocument = useCallback(() => {
    clearSaveTimer();
    discardDocumentDraft(identity);
  }, [clearSaveTimer, identity]);
  // visibilitychange 强保存的 disk-aware 版本 ── 设计动机见 hook 顶部注释。
  // 触发点是 "切走前", 因为内部要引用 saveDoc, 所以定义在 saveDoc 之后。
  const maybeSaveOrReloadOnHide = useCallback(async (content: string, path: string) => {
    if (!path) return;
    // 1. 拉磁盘看是否变了
    let onDisk: string | null = null;
    try {
      onDisk = isExternalDocument
        ? await externalDocuments.read(path, externalScopePath)
        : await memosClient.readDocument(path);
    } catch {
      // IPC 失败: 保守走 saveDoc, 让原 onCasRefused 兜底 (弹 toast + 刷新 CAS 基线)
      void saveDoc(content, path);
      return;
    }
    if (onDisk === null) {
      void saveDoc(content, path);
      return;
    }
    const buf = getDocumentBuffer(identity);
    // 2. 磁盘跟 lastSavedContent 一致 ── 没人改过盘, 走 saveDoc
    if (onDisk === buf.lastSavedContent) {
      void saveDoc(content, path);
      return;
    }
    // 3. 磁盘变了 ── 放弃 save, 直接把磁盘内容覆盖到 buf + 编辑器
    // (跟 watcher 走 reloadDocument 等价, 但在切走时主动做, 不依赖
    // fs_watcher emit 时序)
    if (!isMountedRef.current) return;
    if (hasDocumentUnsavedChanges(identity)) {
      // 用户有本地未保存改动 + 磁盘被外部改 ── 提示冲突, 不覆盖
      const language = getCurrentAppLanguage();
      toast.warning(translate(language, 'document.save.externalChanged'), { duration: 5000 });
      return;
    }
    // 磁盘变了 + 无本地未保存 ── 走 reloadDocument 拉新 (跟 watcher
    // 走 reloadDocument 等价, 主动做不依赖 fs_watcher emit 时序)。
    // reloadDocument 内部 applyLoadedContent 会把 buf 跟 React state
    // 一起对齐到磁盘, 这里不用手动改 buf。
    void reloadDocument(path, { preservePending: false, showLoading: false });
  }, [identity, isExternalDocument, externalScopePath, saveDoc, reloadDocument]);



  const handleChange = useCallback((content: string) => {
    if (!filePath) return;
    const edit = recordDocumentEdit(identity, content);
    if (!edit.changed) {
      clearSaveTimer();
      setState(prev => (
        prev.fullContent === content
          ? prev
          : { ...prev, fullContent: content }
      ));
      scheduleDerivedStatsUpdate(content);
      return;
    }

    setState(prev => ({
      ...prev,
      fullContent: content,
    }));
    scheduleDerivedStatsUpdate(content);

    clearRecoveryDraftTimer();
    const recoveryPath = filePath;
    recoveryDraftTimerRef.current = setTimeout(() => {
      recoveryDraftTimerRef.current = null;
      void protectDocumentDraft(identity, recoveryPath, 'autosave');
    }, RECOVERY_DRAFT_DEBOUNCE_MS);

    clearSaveTimer();
    const pathAtSchedule = filePath;
    saveTimerRef.current = setTimeout(() => {
      void saveDoc(content, pathAtSchedule);
    }, 1000);
  }, [
    filePath,
    identity,
    clearSaveTimer,
    clearRecoveryDraftTimer,
    scheduleDerivedStatsUpdate,
    saveDoc,
    setState,
  ]);

  useEffect(() => {
    isMountedRef.current = true;

    // 切走 (document.hidden=true) 时的强保存 ── 跟 1s debounce 抢跑。
    // 先 disk-check: 磁盘已被外部改 (vscode / Agent) 时, saveDoc 必 CAS
    // 拒绝弹 "已被外部修改" 但用户其实没敲字, toast 无意义; 不如直接放弃
    // save, 让 watcher 后续 emit 走 reloadDocument 拉新 ── 用户切回时
    // 看到的编辑器是磁盘最新内容, 不会撞 CAS。
    //
    // 注: 这里 readDocument 是唯一一次主动 re-read, 正常 flow (用户没切
    // 走) 不走这条路径, 不会浪费 IPC。
    const handleVisibilityChange = () => {
      if (!document.hidden) return;
      const flushedContent = flushPendingContent?.() ?? null;
      const draft = getDocumentDraft(identity, filePath);
      const content = flushedContent ?? draft?.content;
      const path = draft?.path ?? filePath;
      if (content == null || !path) return;
      clearSaveTimer();
      void maybeSaveOrReloadOnHide(content, path);
    };

    const handleBeforeUnload = () => {
      const flushedContent = flushPendingContent?.() ?? null;
      const draft = getDocumentDraft(identity, filePath);
      const content = flushedContent ?? draft?.content;
      const path = draft?.path ?? filePath;
      if (content == null || !path) return;
      clearSaveTimer();
      clearRecoveryDraftTimer();
      void protectDocumentDraft(identity, path, 'shutdown');
      void saveDoc(content, path);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      // An isolated editor can be removed because its browser tab is closed,
      // the host is hidden, or the surface is replaced outside the tab header.
      // The header normally flushes before those transitions, but keeping a
      // final best-effort flush here closes the lifecycle gap for programmatic
      // unmounts and React error/recovery paths.
      if (isolatedSession) {
        void flushDocument();
      }
      isMountedRef.current = false;
      clearSaveTimer();
      clearDerivedStatsTimer();
      clearRecoveryDraftTimer();
    };
  }, [filePath, flushDocument, flushPendingContent, saveDoc, clearSaveTimer, clearDerivedStatsTimer, clearRecoveryDraftTimer, maybeSaveOrReloadOnHide, identity, isolatedSession]);

  return {
    clearSaveTimer,
    flushDocument,
    discardDocument,
    handleChange,
    maybeSaveOrReloadOnHide,
    saveDoc,
  };
}
