'use client';

/**
 * 集合文件的**唯一一套读写会话** ── 一个集合类型只要给出「怎么解析 / 怎么序列化 /
 * 本域在 hybrid 文档里的位置」，就读写、迁移、冲突处理、保存闸全套复用。
 *
 * 覆盖的动作（原来三个消费方各写一遍，语义还互不相同）：
 *   读盘      `files.read` → 空文件报缺失 → 解析 → 集合身份校验
 *   迁移      v1/v2 单类型文件按 `codec.migrate` 就地升级（冲突时以磁盘版为准）
 *   写回      按数据域合并（hybrid 保留其它域），v1/v2 走 `codec.serialize`
 *   冲突      可选「拿磁盘版重放一次 mutate」（幂等变更）或直接放弃
 *   保存闸    `setSaving` / `reportSaveFailure` / `flush`（surface 生命周期收尾用）
 *   刷新      外部变更就地读回（保存中挂起，保存结束后补一次）；失败给错误条 + 重试
 *
 * 差异全部收进 `codec` 与选项，**不在这里统一**（统一会抹掉真实语义差）：
 *   - `conflictPolicy`：筛选/属性这类幂等变更可重放；表格的整表写入重放会覆盖别人
 *     刚写的内容，所以表格暂不走本 hook（保留 `useTableSession` 的 resync 语义）。
 *   - `codec.migrate`：列表（work_documents）是新增域，不存在 v1/v2 旧格式，不传。
 *   - `codec.reuse`：表格/图墙刷新时就地替换 dataset/views 以保住滚动与选择。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { friendlyErrorMessage } from '@/lib/friendly-error-message';
import { createSaveBarrier } from '@/lib/save-barrier';
import { collectionSessionKey } from '@/lib/collection-session-key';
import { findFileDisplayPath, type FileDisplayIdentity } from '@/lib/file-display-registry';
import { canonicalDirectoryPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import { externalDocuments, files } from '@platform/tauri/client';
import { collectionWriteContent, isLegacyCollectionSource, type CollectionDomain } from './model';
import { publishCollectionContent } from './content-events';

/** 一种集合文件类型的格式能力。 */
export interface CollectionDocumentCodec<T> {
  parse(content: string): T;
  /** v1/v2 单类型文件的序列化；hybrid 由本 hook 走按域合并写回。 */
  serialize(document: T): string;
  collectionId(document: T): string;
  revision(document: T): number;
  /** hybrid 文档里本域的位置；null = v1/v2 单类型文件。 */
  sourceDomain(content: string): CollectionDomain | null;
  /** 旧格式（v1/v2 单类型文件）的就地升级内容；不实现 = 本类型没有旧格式。 */
  migrate?(document: T): string;
  /** 就地刷新时保留未变部分的引用（保住子组件状态与滚动）。 */
  reuse?(current: T, next: T): T;
}

export interface CollectionDocumentSessionOptions<T> {
  filePath: string;
  editable?: boolean;
  fileIdentity?: FileDisplayIdentity;
  notebookPath: string | null;
  notebookId: string | null;
  expectedCollectionId?: string | null;
  codec: CollectionDocumentCodec<T>;
  /**
   * 写冲突的处理方式：
   *   - `retry-once`（默认）：拿磁盘版重放一次 mutate（筛选/属性变更幂等，用户无感）；
   *   - `give-up`：直接报冲突并重读，适合「整块内容重写」的类型。
   */
  conflictPolicy?: 'retry-once' | 'give-up';
  /** 读盘失败的文案 key（各集合类型自己的措辞）。 */
  loadErrorKey: I18nKey;
  /** 写盘失败的文案 key。 */
  saveErrorKey: I18nKey;
  /** 没有 notebook 作用域时的提示。 */
  missingScopeMessage: string;
  /** 文件读不到时的提示。 */
  missingFileMessage: string;
  /** 打开时按显示身份兜底认集合（媒体库读 display registry）。 */
  identityCollectionId?: () => string | null;
}

export interface PersistMutationOptions<T> {
  /** 变更基线：默认用 `document`；批量导入等场景传「刚从磁盘读到的最新版」。 */
  baseline?: T;
  /**
   * 调用方**已持有**保存锁（自己置了 `saveInFlightRef` + `setSaving(true)`）：
   * 这里不再抢锁、也不再在结束时释放，避免把调用方的锁提前打开。
   */
  lockAlreadyHeld?: boolean;
}

export interface CollectionDocumentSession<T> {
  sessionKey: string;
  displayId: string | undefined;
  /** 生效路径：显示身份登记的最新路径 → 本次改名结果 → 传入路径。 */
  currentFilePath: string;
  renamedFilePath: string | null;
  setRenamedFilePath: (filePath: string | null) => void;
  document: T | null;
  setDocument: (next: SetStateAction<T | null>) => void;
  loading: boolean;
  error: string | null;
  /** 重试打开（重新走一遍读盘 + 迁移）。 */
  retryLoad: () => void;
  saving: boolean;
  setSaving: (action: SetStateAction<boolean>) => void;
  /** 是否有写在飞行中（并发闸：非 mutate 的写操作共用）。 */
  saveInFlightRef: React.MutableRefObject<boolean>;
  /** 最近一次读到的磁盘内容：写回的 `expectedContent` 基线。 */
  sourceContentRef: React.MutableRefObject<string | null>;
  reportSaveFailure: () => void;
  /** 等这一次保存事务收尾（surface 切换 / 关闭前调用）。 */
  flush: () => Promise<boolean>;
  /** 用保存锁包住一次非 mutate 的写（重命名 / 批量导入），失败也要走 reportSaveFailure。 */
  runSaveLocked: (task: () => Promise<boolean>) => Promise<boolean>;
  /** 就地接受一份新内容（外部变更 / 改名回包）；身份或版本不成立时返回 false。 */
  acceptContent: (content: string) => boolean;
  /** 改名回包：接受内容 + 记住新路径。 */
  applyRename: (result: { content: string; filePath: string }) => boolean;
  /** 变更并写回（自动处理 hybrid 按域合并、冲突重放）。 */
  persistMutation: (mutate: (current: T) => T, options?: PersistMutationOptions<T>) => Promise<boolean>;
  /** 外部变更就地刷新（保存中自动挂起，保存结束补一次）。 */
  refreshContent: (path: string) => void;
  refreshError: string | null;
  retryRefresh: () => void;
}

export function useCollectionDocumentSession<T>({
  filePath,
  editable = true,
  fileIdentity,
  notebookPath: rawNotebookPath,
  notebookId,
  expectedCollectionId,
  codec,
  conflictPolicy = 'retry-once',
  loadErrorKey,
  saveErrorKey,
  missingScopeMessage,
  missingFileMessage,
  identityCollectionId,
}: CollectionDocumentSessionOptions<T>): CollectionDocumentSession<T> {
  const { t } = useI18n();
  const notebookPath = rawNotebookPath ? canonicalDirectoryPath(rawNotebookPath) : null;
  const sessionKey = collectionSessionKey({ filePath, fileIdentity, notebookPath, notebookId, expectedCollectionId });
  const displayId = fileIdentity?.displayId;

  // codec 每次渲染都是新对象：放 ref 里，避免把读盘/写回回调变成不稳定的。
  const editableRef = useRef(editable); editableRef.current = editable;
  const codecRef = useRef(codec);
  codecRef.current = codec;
  const policyRef = useRef(conflictPolicy);
  policyRef.current = conflictPolicy;
  const identityCollectionIdRef = useRef(identityCollectionId);
  identityCollectionIdRef.current = identityCollectionId;
  /** 换语言不该触发重新读盘：错误文案在渲染/写盘那一刻再取。 */
  const tRef = useRef(t);
  tRef.current = t;

  const [renamedFilePath, setRenamedFilePath] = useState<string | null>(null);
  const currentFilePath = (displayId ? findFileDisplayPath(displayId) : null) ?? renamedFilePath ?? filePath;

  const [document, setDocument] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const loadedRef = useRef<{ sessionKey: string; notebookPath: string; loadAttempt: number } | null>(null);
  const [saving, setSavingState] = useState(false);
  const savingRef = useRef(false);
  const saveBarrier = useMemo(createSaveBarrier, [sessionKey]);
  const sourceContentRef = useRef<string | null>(null);
  const saveInFlightRef = useRef(false);
  const currentSessionKeyRef = useRef(sessionKey);
  currentSessionKeyRef.current = sessionKey;

  const setSaving = useCallback((action: SetStateAction<boolean>) => {
    const next = typeof action === 'function' ? (action as (previous: boolean) => boolean)(savingRef.current) : action;
    saveBarrier.setSaving(next);
    savingRef.current = next;
    setSavingState(next);
  }, [saveBarrier]);
  const reportSaveFailure = useCallback(() => saveBarrier.fail(), [saveBarrier]);
  const retryLoad = useCallback(() => setLoadAttempt((attempt) => attempt + 1), []);

  useEffect(() => () => saveBarrier.cancel(), [saveBarrier]);
  // 换文件（路径）就丢掉上一次的改名结果。
  useEffect(() => setRenamedFilePath(null), [filePath]);

  const acceptContent = useCallback((content: string): boolean => {
    if (currentSessionKeyRef.current !== sessionKey) return false;
    const active = codecRef.current;
    const next = active.parse(content);
    const expectedId = expectedCollectionId ?? identityCollectionIdRef.current?.() ?? null;
    if (expectedId && active.collectionId(next) !== expectedId) return false;
    const current = sourceContentRef.current ? active.parse(sourceContentRef.current) : null;
    if (current && (active.collectionId(current) !== active.collectionId(next)
      || active.revision(current) > active.revision(next))) return false;
    sourceContentRef.current = content;
    setDocument((previous) => (previous && active.reuse ? active.reuse(previous, next) : next));
    return true;
  }, [expectedCollectionId, sessionKey]);

  const applyRename = useCallback((result: { content: string; filePath: string }): boolean => {
    if (!acceptContent(result.content)) return false;
    setRenamedFilePath(result.filePath);
    return true;
  }, [acceptContent]);

  /** 读盘：解析 + 身份校验 + v1/v2 就地迁移。 */
  useEffect(() => {
    // A path-only rename keeps this identity and its mounted content. The
    // refresh effect below revalidates the new address without a loading screen.
    if (loadedRef.current?.sessionKey === sessionKey && loadedRef.current.notebookPath === notebookPath
      && loadedRef.current.loadAttempt === loadAttempt) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    if (saveInFlightRef.current) {
      setLoading(false);
      return;
    }
    if (!notebookPath) {
      setError(missingScopeMessage);
      setLoading(false);
      return;
    }
    sourceContentRef.current = null;
    const active = codecRef.current;
    void files.read(currentFilePath, notebookPath).then(async (source) => {
      if (cancelled) return;
      if (!source) throw new Error(missingFileMessage);
      let parsed = active.parse(source);
      const expectedId = expectedCollectionId ?? identityCollectionIdRef.current?.() ?? null;
      if (expectedId && active.collectionId(parsed) !== expectedId) throw new Error('集合身份已变化，不能打开路径中的替代文件');
      let currentSource = source;
      if (editableRef.current && active.migrate && isLegacyCollectionSource(source)) {
        const migration = await externalDocuments.write({
          filePath: currentFilePath,
          content: active.migrate(parsed),
          expectedContent: source,
          scopePath: notebookPath,
        });
        if (cancelled) return;
        if (migration.status === 'saved') {
          currentSource = migration.content;
          publishCollectionContent({ indexPath: currentFilePath, notebookPath, content: migration.content });
        }
        else if (migration.status === 'conflict') {
          const latest = active.parse(migration.diskContent);
          if (active.collectionId(latest) !== active.collectionId(parsed)) throw new Error('集合身份已变化，无法迁移旧格式');
          parsed = latest;
          currentSource = migration.diskContent;
        } else if (migration.status === 'error') throw new Error(migration.message);
      }
      if (cancelled) return;
      sourceContentRef.current = currentSource;
      loadedRef.current = { sessionKey, notebookPath, loadAttempt };
      setDocument(parsed);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(friendlyErrorMessage(reason, tRef.current, loadErrorKey));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [currentFilePath, expectedCollectionId, loadAttempt, loadErrorKey, missingFileMessage, missingScopeMessage, notebookPath, sessionKey]);

  /**
   * 变更并写回。hybrid 文档按域合并（保留其它数据域），v1/v2 走类型自己的序列化。
   * `retry-once`：冲突时拿磁盘版重放一次 mutate —— 筛选 / 属性这类变更重放是幂等的，
   * 用户不需要知道中间撞过一次；第二次仍冲突才载入最新版并提示。
   */
  const persistMutation = useCallback(async (
    mutate: (current: T) => T,
    options?: PersistMutationOptions<T>,
  ): Promise<boolean> => {
    const active = codecRef.current;
    const lockAlreadyHeld = options?.lockAlreadyHeld === true;
    if (!editableRef.current || !document || !notebookPath || !sourceContentRef.current) return false;
    if (!lockAlreadyHeld) {
      if (saveInFlightRef.current) return false;
      saveInFlightRef.current = true;
      setSaving(true);
    }
    try {
      const originalId = active.collectionId(options?.baseline ?? document);
      let baseline: T = options?.baseline ?? (document as T);
      let expectedContent = sourceContentRef.current;
      const maxAttempts = policyRef.current === 'retry-once' ? 2 : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (active.collectionId(baseline) !== originalId) throw new Error('集合身份已变化，已取消保存');
        const next = mutate(baseline);
        const writeDomain = active.sourceDomain(expectedContent);
        const result = await externalDocuments.write({
          filePath: currentFilePath,
          // codec 产出的就是「本域投影出的单类型文档」：v2 走 serialize，hybrid 按域合并。
          content: collectionWriteContent({ source: expectedContent, domain: writeDomain, document: next, serialize: active.serialize }),
          expectedContent,
          scopePath: notebookPath,
        });
        if (result.status === 'saved') {
          sourceContentRef.current = result.content;
          setDocument(next);
          publishCollectionContent({ indexPath: currentFilePath, notebookPath, content: result.content });
          return true;
        }
        if (result.status === 'conflict') {
          const latest = active.parse(result.diskContent);
          if (active.collectionId(latest) !== originalId) throw new Error('集合身份已变化，已取消保存');
          expectedContent = result.diskContent;
          sourceContentRef.current = result.diskContent;
          if (attempt === 0 && policyRef.current === 'retry-once') {
            baseline = latest;
            continue;
          }
          setDocument(latest);
          reportSaveFailure();
          toast.error(t('collection.save.conflictReloaded'));
          return false;
        }
        throw new Error(result.status === 'error' ? result.message : '集合文件已不存在');
      }
      reportSaveFailure();
      return false;
    } catch (reason) {
      reportSaveFailure();
      toast.error(friendlyErrorMessage(reason, t, saveErrorKey));
      return false;
    } finally {
      if (!lockAlreadyHeld) {
        saveInFlightRef.current = false;
        setSaving(false);
      }
    }
  }, [currentFilePath, document, notebookPath, reportSaveFailure, saveErrorKey, setSaving, t]);

  const runSaveLocked = useCallback(async (task: () => Promise<boolean>): Promise<boolean> => {
    if (!editableRef.current || saveInFlightRef.current) return false;
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      return await task();
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }, [setSaving]);

  const flush = useCallback(async () => {
    const saved = await saveBarrier.flush();
    return saved && currentSessionKeyRef.current === sessionKey;
  }, [saveBarrier, sessionKey]);

  /**
   * 外部变更就地刷新：保存中先挂起（写盘期间读到的可能是自己刚写的半成品），
   * 保存结束后补一次。失败保留错误条 + 重试入口，不打断当前内容。
   */
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refreshRequestRef = useRef(0);
  const pendingRefreshRef = useRef<{ sessionKey: string; path: string } | null>(null);
  const refreshContent = useCallback((path: string) => {
    const requestId = ++refreshRequestRef.current;
    if (saveInFlightRef.current) {
      pendingRefreshRef.current = { sessionKey, path };
      return;
    }
    void externalDocuments.read(path, notebookPath).then((content) => {
      if (currentSessionKeyRef.current !== sessionKey || refreshRequestRef.current !== requestId) return;
      if (saveInFlightRef.current) {
        pendingRefreshRef.current = { sessionKey, path };
        return;
      }
      if (!content) throw new Error(missingFileMessage);
      if (!acceptContent(content)) throw new Error('集合身份或版本已变化，未采用磁盘内容');
      setRefreshError(null);
    }).catch((reason: unknown) => {
      if (currentSessionKeyRef.current !== sessionKey || refreshRequestRef.current !== requestId) return;
      setRefreshError(friendlyErrorMessage(reason, tRef.current, loadErrorKey));
    });
  }, [acceptContent, loadErrorKey, missingFileMessage, notebookPath, sessionKey]);
  const retryRefresh = useCallback(() => refreshContent(currentFilePath), [currentFilePath, refreshContent]);
  const previousAddressRef = useRef({ sessionKey, path: currentFilePath, notebookPath });
  useEffect(() => {
    const previous = previousAddressRef.current;
    previousAddressRef.current = { sessionKey, path: currentFilePath, notebookPath };
    if (previous.sessionKey === sessionKey && previous.notebookPath === notebookPath
      && previous.path !== currentFilePath && loadedRef.current?.sessionKey === sessionKey) {
      refreshContent(currentFilePath);
    }
  }, [currentFilePath, notebookPath, refreshContent, sessionKey]);

  useEffect(() => {
    setRefreshError(null);
    refreshRequestRef.current += 1;
    if (pendingRefreshRef.current?.sessionKey !== sessionKey) pendingRefreshRef.current = null;
  }, [sessionKey]);
  useEffect(() => () => { refreshRequestRef.current += 1; }, []);
  useEffect(() => {
    if (saving) return;
    const pending = pendingRefreshRef.current;
    pendingRefreshRef.current = null;
    if (pending?.sessionKey === sessionKey) refreshContent(pending.path);
  }, [refreshContent, saving, sessionKey]);

  return {
    sessionKey, displayId, currentFilePath, renamedFilePath, setRenamedFilePath,
    document, setDocument, loading, error, retryLoad,
    saving, setSaving, saveInFlightRef, sourceContentRef,
    reportSaveFailure, flush, runSaveLocked,
    acceptContent, applyRename, persistMutation,
    refreshContent, refreshError, retryRefresh,
  };
}
