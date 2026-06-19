import { useCallback, useEffect, useRef } from 'react';

import { memos as memosClient } from '../../../../lib/tauri/client';
import {
  getActiveDocumentDraft,
  applyLoadedDocumentContent,
  getDocumentBuffer,
  markSelfDocumentPathUpdate,
  markSelfDocumentWrite,
  hasDocumentUnsavedChanges,
  recordDocumentEdit,
  saveDocumentContent,
  useDocumentStore,
  type DocumentIdentity,
} from '../../../../lib/store';
import { toast } from '../../../../lib/toast';
import { formatDateTime } from '../../../../lib/utils';
import {
  countTextUnits,
  extractBodyContent,
} from './document-utils';

interface UseDocumentAutosaveOptions {
  filePath: string;
  identity: DocumentIdentity;
  /**
   * 内部 memo 文档的 memoId, 走 `key+channel='internal'` 走 key 反查;
   * 外部 .md 文件传 null, 走 `channel='external'` 走 path 寻址。
   */
  memoId: string | null;
  isExternalDocument: boolean;
  setState: React.Dispatch<React.SetStateAction<{
    fullContent: string;
    isLoading: boolean;
    error: string | null;
    isScrolled: boolean;
    isNewlyCreated: boolean;
    charCount: number;
    tokenCount: number;
    createdAt: string;
    updatedAt: string;
    updatedAtDate: Date | null;
    isFavorited: boolean;
    frontmatterMeta: Record<string, unknown>;
  }>>;
  reloadDocument: (path: string, options?: { preservePending?: boolean; showLoading?: boolean }) => Promise<void>;
}

export function useDocumentAutosave({
  filePath,
  identity,
  memoId,
  isExternalDocument,
  setState,
  reloadDocument,
}: UseDocumentAutosaveOptions) {
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const replaceActiveMemoPath = useDocumentStore((store) => store.replaceActiveMemoPath);

  const clearSaveTimer = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  const saveDoc = useCallback(async (content: string, path: string) => {
    if (!path) return;
    const buf = getDocumentBuffer(identity);

    await saveDocumentContent({
      path,
      identity,
      content,
      channel: isExternalDocument ? 'external' : 'internal',
      key: isExternalDocument ? null : memoId,
      callbacks: {
        onSaved: (writtenPath, writtenContent) => {
          const now = Date.now();
          if (isMountedRef.current) {
            setState(prev => ({
              ...prev,
              updatedAt: formatDateTime(now),
              updatedAtDate: new Date(now),
              error: null,
            }));
          }
          // 内部 memo 走 `key` 反查时, 后端在 first-line change 场景下
          // 会物理 rename, writtenPath 跟 closure 持有的 path 可能不同 ──
          // 此时切 buf 到新 path (applyLoadedContent 内部用 setCurrentPath
          // + 重用或新建 buffer, 保留 buf 内容)。
          if (!isExternalDocument && memoId) {
            markSelfDocumentWrite(memoId, writtenPath);
          }
          if (writtenPath !== path) {
            applyLoadedDocumentContent(identity, writtenPath, writtenContent, { preservePending: true });
            if (!isExternalDocument && memoId) {
              markSelfDocumentPathUpdate(memoId, writtenPath);
              replaceActiveMemoPath(memoId, writtenPath);
            }
            // 旧 path buf 已在 buffer-registry 的 Map 里残留 ── 不删, 等
            // GC。后续 use-external-document-change-watch 看到旧 path
            // 找不到文件, 自然走 ignore 路径。
          }
          // 写盘后派生同步由后端 `write_document` 单点保证 (含
          // `write_memo_renaming_on_title_change` 派生 title 改名),
          // 前端不再需要二次同步 IPC。
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
          // 简化策略: 不做前端语义自愈, 不覆盖用户当前编辑内容。
          // 只主动读一次磁盘刷新 CAS 基线, 然后提示冲突。
          if (!isMountedRef.current) {
            return;
          }
          buf.pendingContent = null;
          void (async () => {
            const onDisk = await memosClient.readDocument(path).catch(() => null);
            if (!isMountedRef.current) return;
            if (onDisk !== null) {
              buf.lastSavedContent = onDisk;
            }
            toast.error('保存失败：文档已被外部修改', { duration: 5000 });
          })();
          void writtenContent;
        },
        onError: (_writtenContent, err) => {
          console.error('[DocumentContainer] Failed to save memo:', err);
          toast.error(`保存失败：${err instanceof Error ? err.message : String(err)}`, {
            duration: 5000,
          });
          if (isMountedRef.current) {
            setState(prev => ({ ...prev, error: '保存失败' }));
          }
        },
      },
    });
  }, [
    isExternalDocument,
    identity,
    memoId,
    replaceActiveMemoPath,
    setState,
  ]);
  // visibilitychange 强保存的 disk-aware 版本 ── 设计动机见 hook 顶部注释。
  // 触发点是 "切走前", 因为内部要引用 saveDoc, 所以定义在 saveDoc 之后。
  const maybeSaveOrReloadOnHide = useCallback(async (content: string, path: string) => {
    if (!path) return;
    // 1. 拉磁盘看是否变了
    let onDisk: string | null = null;
    try {
      onDisk = await memosClient.readDocument(path);
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
      toast.warning('文档已被外部修改', { duration: 5000 });
      return;
    }
    // 磁盘变了 + 无本地未保存 ── 走 reloadDocument 拉新 (跟 watcher
    // 走 reloadDocument 等价, 主动做不依赖 fs_watcher emit 时序)。
    // reloadDocument 内部 applyLoadedContent 会把 buf 跟 React state
    // 一起对齐到磁盘, 这里不用手动改 buf。
    void reloadDocument(path, { preservePending: false, showLoading: false });
  }, [identity, saveDoc, reloadDocument]);



  const handleChange = useCallback((content: string) => {
    if (!filePath) return;
    const edit = recordDocumentEdit(identity, content);
    if (!edit.changed) return;

    const body = extractBodyContent(content);
    const textUnits = countTextUnits(body);
    setState(prev => ({
      ...prev,
      fullContent: content,
      charCount: textUnits,
      tokenCount: Math.ceil(textUnits / 4),
    }));

    clearSaveTimer();
    const pathAtSchedule = filePath;
    saveTimerRef.current = setTimeout(() => {
      void saveDoc(content, pathAtSchedule);
    }, 1000);
  }, [
    filePath,
    identity,
    clearSaveTimer,
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
      const draft = getActiveDocumentDraft();
      if (!(document.hidden && draft)) return;
      clearSaveTimer();
      void maybeSaveOrReloadOnHide(draft.content, draft.path);
    };

    const handleBeforeUnload = () => {
      const draft = getActiveDocumentDraft();
      if (draft) {
        void saveDoc(draft.content, draft.path);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      isMountedRef.current = false;
      clearSaveTimer();
    };
  }, [saveDoc, clearSaveTimer, maybeSaveOrReloadOnHide]);

  return {
    clearSaveTimer,
    handleChange,
    maybeSaveOrReloadOnHide,
    saveDoc,
  };
}
