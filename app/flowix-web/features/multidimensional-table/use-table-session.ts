import { useI18n } from '@/lib/i18n';
import { friendlyErrorMessage } from '@/lib/friendly-error-message';
import { createSaveBarrier } from '@/lib/save-barrier';
import { hydrateTablePresets } from './table-preset-bindings';
import { subscribePropertyPresets } from '@features/properties/public-api';
import { collectionSessionKey } from '@/lib/collection-session-key';
import { canonicalDirectoryPath } from '@/lib/path';
import { reuseCollectionValue } from '@features/collection/content-equality';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { externalDocuments, notes as notesClient, type NoteEntry } from '@platform/tauri/client';
import { subscribe } from '@platform/tauri/event-bus';
import { subscribeNotebookChanges, type NotebookChange } from '@platform/tauri/notebook-change-events';
import { toast } from '@/lib/toast';
import { findFileDisplayPath, type FileDisplayIdentity } from '@/lib/file-display-registry';
import { parseTableDocumentAsync } from './parse-table-document';
import { serializeTableDocument, parseTableDocument, validateTableDocument, type MultidimensionalTableDocument } from './model';
import { isLegacyCollectionSource, collectionSourceDomain, collectionWriteContent, type CollectionDomain } from '@features/collection/model';
import { bindTablePresetsFromSnapshot } from '@features/properties/property-preset-service';

interface TableSessionOptions {
  editable?: boolean;
  expectedCollectionId?: string | null;
  filePath: string;
  fileIdentity?: FileDisplayIdentity;
  notebookPath: string | null;
  notebookId: string | null;
}

/** Apply the same path/default normalization to loads, rename replies and events. */
function normalizeTableSessionDocument(document: MultidimensionalTableDocument): MultidimensionalTableDocument {
  return {
    ...document,
    dataset: { ...document.dataset, records: { ...document.dataset.records,
      include: document.dataset.records.include.map((record) => ({ ...record, note_path: record.note_path.replace(/\\/g, '/') })),
      exclude: document.dataset.records.exclude.map((record) => ({ ...record, note_path: record.note_path.replace(/\\/g, '/') })),
    } },
  };
}

export function useTableSession({ filePath, fileIdentity, notebookPath: rawNotebookPath, notebookId, expectedCollectionId, editable = true }: TableSessionOptions) {
  const { t } = useI18n();
  const editableRef = useRef(editable); editableRef.current = editable;
  const notebookPath = rawNotebookPath ? canonicalDirectoryPath(rawNotebookPath) : null;
  const displayId = fileIdentity?.displayId;
  const sessionKey = collectionSessionKey({ filePath, fileIdentity, notebookPath, notebookId, expectedCollectionId });
  const currentSessionKeyRef = useRef(sessionKey);
  currentSessionKeyRef.current = sessionKey;
  const getCurrentFilePath = useCallback(() => (
    displayId
      ? findFileDisplayPath(displayId) ?? filePath
      : filePath
  ), [displayId, filePath]);

  const [document, setDocument] = useState<MultidimensionalTableDocument | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSavingState] = useState(false);
  const [saveFailed, setSaveFailedState] = useState(false);
  const saveBarrier = useMemo(createSaveBarrier, [sessionKey]);
  const setSaveFailed = useCallback((failed: boolean) => {
    if (failed) saveBarrier.fail();
    else saveBarrier.resetFailure();
    setSaveFailedState(failed);
  }, [saveBarrier]);
  useEffect(() => () => saveBarrier.cancel(), [saveBarrier]);
  const flush = useCallback(async () => {
    const sequence = loadSequenceRef.current;
    const saved = await saveBarrier.flush();
    return saved && sequence === loadSequenceRef.current && currentSessionKeyRef.current === sessionKey;
  }, [saveBarrier, sessionKey]);
  const savingRef = useRef(false);
  const setSaving = useCallback((next: boolean) => {
    if (next && !savingRef.current) setSaveFailed(false);
    savingRef.current = next;
    saveBarrier.setSaving(next);
    setSavingState(next);
  }, [saveBarrier, setSaveFailed]);
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  useEffect(() => subscribePropertyPresets(() => {
    setDocument((current) => current ? hydrateTablePresets(current) : current);
  }), []);
  const [resolvedNotebookId, setResolvedNotebookId] = useState<string | null>(notebookId);
  const [notesLoadError, setNotesLoadError] = useState<string | null>(null);
  const [stateSessionKey, setStateSessionKey] = useState(sessionKey);
  const [loadGeneration, setLoadGeneration] = useState(0);
  const loadSequenceRef = useRef(0);
  const mountedRef = useRef(false);
  const sourceContentRef = useRef<{ sessionKey: string; content: string } | null>(null);
  const loadedSessionKeyRef = useRef<string | null>(null);
  const writeLocksRef = useRef(new Set<string>());
  // hybrid 集合文档（v3）里本表格所在的数据域；v1/v2 单类型文件为 null。
  const sourceDomainRef = useRef<CollectionDomain | null>(null);
  const pendingNotePropertiesRef = useRef(new Map<string, Set<string>>());
  const syncSequenceRef = useRef(0);
  const pendingTableSyncRef = useRef(false);

  const isCurrentSession = useCallback((sequence: number, key: string) => (
    sequence === loadSequenceRef.current && key === currentSessionKeyRef.current
  ), []);
  const isCurrentSessionForKey = useCallback((sequence: number) => (
    isCurrentSession(sequence, sessionKey)
  ), [isCurrentSession, sessionKey]);

  const reportSaveFailure = useCallback((sequence: number) => {
    if (isCurrentSession(sequence, sessionKey)) {
      setSaveFailed(true);
      pendingTableSyncRef.current = true;
    }
  }, [isCurrentSession, sessionKey, setSaveFailed]);

  const load = useCallback(async () => {
    syncSequenceRef.current += 1;
    pendingTableSyncRef.current = false;
    const sequence = ++loadSequenceRef.current;
    const key = sessionKey;
    setStateSessionKey(key);
    setLoadGeneration(sequence);
    setLoadError(null);
    setDocument(null);
    setSaveFailed(false);
    setSaving(false);
    setNotes([]);
    pendingNotePropertiesRef.current.clear();
    setResolvedNotebookId(notebookId);
    setNotesLoadError(null);
    sourceContentRef.current = null;
    loadedSessionKeyRef.current = null;

    try {
      const source = await externalDocuments.read(getCurrentFilePath(), notebookPath);
      if (!isCurrentSession(sequence, key)) return;
      sourceDomainRef.current = collectionSourceDomain(source, 'table');
      let next = await parseTableDocumentAsync(source);
      if (!isCurrentSession(sequence, key)) return;
      let sourceContent = source;
      if (editableRef.current && isLegacyCollectionSource(source)) {
        const migration = await externalDocuments.write({ filePath: getCurrentFilePath(), content: serializeTableDocument(next), expectedContent: source, scopePath: notebookPath });
        if (!isCurrentSession(sequence, key)) return;
        if (migration.status === 'saved') sourceContent = migration.content;
        else if (migration.status === 'conflict') {
          const latest = await parseTableDocumentAsync(migration.diskContent);
          if (latest.collection.id !== next.collection.id) throw new Error('表格身份已变化，无法迁移旧格式');
          next = latest;
          sourceContent = migration.diskContent;
        } else if (migration.status === 'error') throw new Error(migration.message);
      }

      const bound = await bindTablePresetsFromSnapshot(next);
      if (!isCurrentSession(sequence, key)) return;
      // DB definitions are a runtime projection. Persist it with the next explicit
      // table edit, rather than making opening a table depend on a rewrite.
      next = bound;

      let noteLoadError: string | null = null;
      let resolvedId = notebookId;
      if (!resolvedId) {
        try {
          resolvedId = (await notesClient.resolveLocation(getCurrentFilePath())).notebookId;
        } catch (error) {
          noteLoadError = friendlyErrorMessage(error, t, 'errors.friendly.notesLoad');
        }
      }
      if (!isCurrentSession(sequence, key)) return;

      let entries: NoteEntry[] = [];
      if (resolvedId) {
        try {
          entries = await notesClient.list(resolvedId);
        } catch (error) {
          noteLoadError = friendlyErrorMessage(error, t, 'errors.friendly.notesLoad');
        }
      } else if (!noteLoadError) {
        noteLoadError = t('errors.friendly.notesLoad');
      }
      if (!isCurrentSession(sequence, key)) return;

      // Keep unresolved paths in the table file so users can see and repair a
      // broken reference. A successful note-list read is not permission to
      // erase the path: the file may have moved or the index may be catching up.
      next = normalizeTableSessionDocument(next);

      sourceContentRef.current = { sessionKey: key, content: sourceContent };
      loadedSessionKeyRef.current = key;
      setDocument(next);
      setNotes(entries);
      setResolvedNotebookId(resolvedId);
      setNotesLoadError(noteLoadError);
    } catch (error) {
      if (isCurrentSession(sequence, key)) setLoadError(friendlyErrorMessage(error, t, 'errors.friendly.tableLoad'));
    }
  }, [getCurrentFilePath, isCurrentSession, notebookId, notebookPath, sessionKey, setSaveFailed, setSaving, t]);

  // A rename changes the path prop, not the live table session. Read the latest
  // loader when the file identity or notebook scope changes, while keeping the
  // current in-memory table mounted for path-only changes.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  useEffect(() => {
    mountedRef.current = true;
    void loadRef.current();
    return () => {
      // Invalidate reads and writes when this table surface changes or unmounts.
      mountedRef.current = false;
      loadSequenceRef.current += 1;
    };
  }, [sessionKey]);

  const syncNotes = useCallback(async (event: NotebookChange) => {
    const notebook = resolvedNotebookId;
    if (!notebook || event.notebookId !== notebook) return;
    const key = sessionKey;
    if (loadedSessionKeyRef.current !== key) return;
    if (savingRef.current) {
      pendingTableSyncRef.current = true;
      return;
    }
    const baselineAtStart = sourceContentRef.current?.content;
    const generation = loadSequenceRef.current;
    const syncSequence = ++syncSequenceRef.current;
    const isCurrent = () => isCurrentSession(generation, key) && syncSequence === syncSequenceRef.current;
    if ((event.kind !== 'query-invalidated' && event.kind !== 'resource-updated') || !event.relativePath) {
      pendingTableSyncRef.current = true;
    }
    let needsTableSync = pendingTableSyncRef.current;
    try {
      const singlePath = !needsTableSync && event.relativePath?.replace(/\\/g, '/');
      const singleEntry = event.kind === 'resource-updated'
        ? event.entry
        : singlePath ? await notesClient.getIndexed(notebook, singlePath) : null;
      if (singlePath && !singleEntry) {
        pendingTableSyncRef.current = true;
        needsTableSync = true;
      }
      const entries = needsTableSync ? await notesClient.list(notebook) : singleEntry ? [singleEntry] : [];
      if (!isCurrent()) return;
      if (savingRef.current) {
        pendingTableSyncRef.current = true;
        return;
      }
      const mergeEntries = (current: NoteEntry[]) => {
        const pending = pendingNotePropertiesRef.current;
        const currentByPath = new Map(current.map((note) => [note.relativePath.replace(/\\/g, '/'), note]));
        const merge = (note: NoteEntry) => {
          const path = note.relativePath.replace(/\\/g, '/');
          const previous = currentByPath.get(path);
          const pendingKeys = pending.get(path);
          if (previous && pendingKeys?.size) {
            const properties = { ...note.properties };
            for (const propertyKey of pendingKeys) {
              if (Object.prototype.hasOwnProperty.call(previous.properties, propertyKey)) {
                properties[propertyKey] = previous.properties[propertyKey];
              } else {
                delete properties[propertyKey];
              }
            }
            return { ...note, properties };
          }
          return previous && JSON.stringify(previous) === JSON.stringify(note) ? previous : note;
        };
        const next = needsTableSync ? entries.map(merge) : (() => {
          const entry = entries[0];
          if (!entry) return current;
          const path = entry.relativePath.replace(/\\/g, '/');
          const index = current.findIndex((note) => note.relativePath.replace(/\\/g, '/') === path);
          if (index < 0) return [...current, merge(entry)];
          const merged = merge(entry);
          if (merged === current[index]) return current;
          const updated = [...current];
          updated[index] = merged;
          return updated;
        })();
        return next.length === current.length && next.every((note, index) => note === current[index]) ? current : next;
      };
      if (!needsTableSync) {
        setNotes((current) => mergeEntries(current));
        setNotesLoadError(null);
        return;
      }
      if (savingRef.current) {
        pendingTableSyncRef.current = true;
        return;
      }
      const diskContent = await externalDocuments.read(getCurrentFilePath(), notebookPath);
      if (!isCurrent()) return;
      sourceDomainRef.current = collectionSourceDomain(diskContent, 'table');
      const next = normalizeTableSessionDocument(await parseTableDocumentAsync(diskContent));
      if (!isCurrent()) return;
      const baseline = diskContent;
      if (savingRef.current) {
        pendingTableSyncRef.current = true;
        return;
      }
      if (sourceContentRef.current?.content !== baselineAtStart) {
        pendingTableSyncRef.current = true;
        void syncNotes({ notebookId: notebook, kind: 'query-invalidated', relativePath: null });
        return;
      }
      const sourceChanged = sourceContentRef.current?.content !== baseline;
      sourceContentRef.current = { sessionKey: key, content: baseline };
      setNotes((current) => mergeEntries(current));
      setNotesLoadError(null);
      if (sourceChanged) setDocument((current) => current ? { ...next,
        dataset: reuseCollectionValue(current.dataset, next.dataset),
        views: reuseCollectionValue(current.views, next.views),
      } : next);
      pendingTableSyncRef.current = false;
    } catch (error) {
      if (isCurrent()) setNotesLoadError(friendlyErrorMessage(error, t, 'errors.friendly.notesLoad'));
    }
  }, [getCurrentFilePath, isCurrentSession, notebookPath, resolvedNotebookId, sessionKey, t]);

  useEffect(() => {
    if (!saving && !savingRef.current && pendingTableSyncRef.current && resolvedNotebookId) {
      void syncNotes({ notebookId: resolvedNotebookId, kind: 'query-invalidated', relativePath: null });
    }
  }, [resolvedNotebookId, saving, syncNotes]);

  useEffect(() => subscribeNotebookChanges(
    (event) => {
      if (event.relativePath && /\.(table|lib)\.ya?ml$/i.test(event.relativePath)) return;
      if (event.notebookId === resolvedNotebookId) void syncNotes(event);
    },
  ), [resolvedNotebookId, syncNotes]);

  const save = useCallback(async (
    next: MultidimensionalTableDocument,
    keepSaving = false,
    expectedSequence = loadSequenceRef.current,
  ): Promise<boolean> => {
    if (!editableRef.current) return false;
    const sequence = expectedSequence;
    const key = sessionKey;
    if (!isCurrentSession(sequence, key)) return false;
    const lockKey = `${sequence}:${key}`;
    if (writeLocksRef.current.has(lockKey)) {
      toast.error('表格正在保存，请稍后重试');
      return false;
    }
    const source = sourceContentRef.current;
    if (loadedSessionKeyRef.current !== key || source?.sessionKey !== key) {
      toast.error('表格尚未加载完成');
      return false;
    }

    writeLocksRef.current.add(lockKey);
    setSaving(true);
    try {
      validateTableDocument(next);
      // hybrid 文档按域合并写回（保留其它数据域）；v1/v2 走原 v2 序列化。
      const content = collectionWriteContent({
        source: source.content, domain: sourceDomainRef.current, document: next, serialize: serializeTableDocument,
      });
      const result = await externalDocuments.write({
        filePath: getCurrentFilePath(),
        content,
        expectedContent: source.content,
        scopePath: notebookPath,
      });
      if (result.status === 'saved') {
        if (!isCurrentSession(sequence, key)) {
          if (mountedRef.current && currentSessionKeyRef.current === key) void load();
          return true;
        }
        sourceContentRef.current = { sessionKey: key, content: result.content };
        setDocument(next);
        return true;
      }
      if (!isCurrentSession(sequence, key)) return false;
      setSaveFailed(true);
      if (result.status === 'conflict') {
        toast.error('表格文件已被其他操作修改，正在同步最新内容');
        pendingTableSyncRef.current = true;
        return false;
      }
      throw new Error(result.status === 'error' ? result.message : '表格文件已不存在');
    } catch (error) {
      if (!isCurrentSession(sequence, key)) return false;
      setSaveFailed(true);
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.tableSave'));
      pendingTableSyncRef.current = true;
      return false;
    } finally {
      writeLocksRef.current.delete(lockKey);
      if (!keepSaving && isCurrentSession(sequence, key)) setSaving(false);
    }
  }, [getCurrentFilePath, isCurrentSession, load, notebookPath, resolvedNotebookId, sessionKey, setSaveFailed, setSaving, syncNotes]);

  const acceptContent = useCallback((content: string) => {
    if (currentSessionKeyRef.current !== sessionKey) return false;
    const next = normalizeTableSessionDocument(parseTableDocument(content));
    const source = sourceContentRef.current;
    if (source?.sessionKey === sessionKey) {
      const current = parseTableDocument(source.content);
      if (current.collection.id !== next.collection.id || current.collection.revision > next.collection.revision) return false;
    }
    if (expectedCollectionId && next.collection.id !== expectedCollectionId) return false;
    sourceContentRef.current = { sessionKey, content };
    setDocument((current) => current ? { ...next,
      dataset: reuseCollectionValue(current.dataset, next.dataset),
      views: reuseCollectionValue(current.views, next.views),
    } : next);
    return true;
  }, [expectedCollectionId, sessionKey]);

  const collectionId = document?.collection.id;
  const pendingCollectionRefreshRef = useRef<{ key: string; path: string } | null>(null);
  const refreshCollection = useCallback((path: string) => {
    const sequence = loadSequenceRef.current;
    const key = sessionKey;
    void externalDocuments.read(path, notebookPath).then((content) => {
      if (!isCurrentSession(sequence, key)) return;
      if (savingRef.current) {
        pendingCollectionRefreshRef.current ??= { key, path };
        return;
      }
      acceptContent(content);
    }).catch(() => undefined);
  }, [acceptContent, isCurrentSession, notebookPath, sessionKey]);
  useEffect(() => subscribe<{ notebookId: string; collectionId: string; relativePath: string }>('collection-changed', (event) => {
    if (event.notebookId !== resolvedNotebookId || event.collectionId !== collectionId || !notebookPath) return;
    const path = `${canonicalDirectoryPath(notebookPath)}/${event.relativePath}`;
    if (savingRef.current) {
      pendingCollectionRefreshRef.current = { key: sessionKey, path };
      return;
    }
    refreshCollection(path);
  }), [collectionId, notebookPath, refreshCollection, resolvedNotebookId, sessionKey, t]);
  useEffect(() => {
    if (saving) return;
    const pending = pendingCollectionRefreshRef.current;
    pendingCollectionRefreshRef.current = null;
    if (pending?.key === sessionKey) refreshCollection(pending.path);
  }, [refreshCollection, saving, sessionKey]);

  const stateIsCurrent = stateSessionKey === sessionKey;
  return {
    document: stateIsCurrent ? document : null,
    loadError: stateIsCurrent ? loadError : null,
    saving: stateIsCurrent ? saving : false,
    saveFailed: stateIsCurrent ? saveFailed : false,
    setSaving,
    reportSaveFailure,
    notes: stateIsCurrent ? notes : [],
    setNotes,
    resolvedNotebookId: stateIsCurrent ? resolvedNotebookId : notebookId,
    notesLoadError: stateIsCurrent ? notesLoadError : null,
    load,
    save,
    flush,
    acceptContent,
    isCurrentSession: isCurrentSessionForKey,
    loadSequenceRef,
    loadGeneration,
    pendingNotePropertiesRef,
  };
}
