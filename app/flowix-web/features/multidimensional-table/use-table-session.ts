import { canonicalDirectoryPath } from '@/lib/path';
import { reuseCollectionValue } from '@features/collection/content-equality';
import { useCallback, useEffect, useRef, useState } from 'react';
import { externalDocuments, notes as notesClient, type NoteEntry } from '@platform/tauri/client';
import { subscribe } from '@platform/tauri/event-bus';
import { toast } from '@/lib/toast';
import { findFileDisplayPath, type FileDisplayIdentity } from '@/lib/file-display-registry';
import { parseTableDocumentAsync } from './parse-table-document';
import { serializeTableDocument, parseTableDocument, validateTableDocument, type MultidimensionalTableDocument } from './model';

interface TableSessionOptions {
  filePath: string;
  fileIdentity?: FileDisplayIdentity;
  notebookPath: string | null;
  notebookId: string | null;
}

interface NoteChangeEvent {
  notebookId: string;
  relativePath?: string;
  previousRelativePath?: string;
  kind?: string;
  deleted?: boolean;
}

/** Apply the same path/default normalization to loads, rename replies and events. */
function normalizeTableSessionDocument(document: MultidimensionalTableDocument): MultidimensionalTableDocument {
  return {
    ...document,
    records: {
      ...document.records,
      data: document.records.data.map((record) => ({ ...record, note_path: record.note_path.replace(/\\/g, '/') })),
      auto_collect: document.records.auto_collect ? {
        ...document.records.auto_collect,
        excluded_note_paths: document.records.auto_collect.excluded_note_paths.map((path) => path.replace(/\\/g, '/')),
      } : null,
    },
  };
}

export function useTableSession({ filePath, fileIdentity, notebookPath: rawNotebookPath, notebookId }: TableSessionOptions) {
  const notebookPath = rawNotebookPath ? canonicalDirectoryPath(rawNotebookPath) : null;
  const displayId = fileIdentity?.displayId;
  const fileSessionId = displayId ?? filePath;
  const sessionKey = displayId ?? JSON.stringify([fileSessionId, notebookPath, notebookId]);
  const currentSessionKeyRef = useRef(sessionKey);
  currentSessionKeyRef.current = sessionKey;
  const getCurrentFilePath = useCallback(() => (
    displayId
      ? findFileDisplayPath(displayId) ?? filePath
      : filePath
  ), [displayId, filePath]);

  const [document, setDocument] = useState<MultidimensionalTableDocument | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  const [resolvedNotebookId, setResolvedNotebookId] = useState<string | null>(notebookId);
  const [notesLoadError, setNotesLoadError] = useState<string | null>(null);
  const [stateSessionKey, setStateSessionKey] = useState(sessionKey);
  const [loadGeneration, setLoadGeneration] = useState(0);
  const loadSequenceRef = useRef(0);
  const mountedRef = useRef(false);
  const sourceContentRef = useRef<{ sessionKey: string; content: string } | null>(null);
  const loadedSessionKeyRef = useRef<string | null>(null);
  const writeLocksRef = useRef(new Set<string>());
  const pendingNotePropertiesRef = useRef(new Map<string, Set<string>>());
  const syncSequenceRef = useRef(0);
  const pendingTableSyncRef = useRef(false);
  const savingRef = useRef(false);

  const isCurrentSession = useCallback((sequence: number, key: string) => (
    sequence === loadSequenceRef.current && key === currentSessionKeyRef.current
  ), []);
  const isCurrentSessionForKey = useCallback((sequence: number) => (
    isCurrentSession(sequence, sessionKey)
  ), [isCurrentSession, sessionKey]);

  const load = useCallback(async () => {
    syncSequenceRef.current += 1;
    pendingTableSyncRef.current = false;
    const sequence = ++loadSequenceRef.current;
    const key = sessionKey;
    setStateSessionKey(key);
    setLoadGeneration(sequence);
    setLoadError(null);
    setDocument(null);
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
      let next = await parseTableDocumentAsync(source);
      if (!isCurrentSession(sequence, key)) return;

      let noteLoadError: string | null = null;
      let resolvedId = notebookId;
      if (!resolvedId) {
        try {
          resolvedId = (await notesClient.resolveLocation(getCurrentFilePath())).notebookId;
        } catch (error) {
          noteLoadError = error instanceof Error ? error.message : String(error);
        }
      }
      if (!isCurrentSession(sequence, key)) return;

      let entries: NoteEntry[] = [];
      if (resolvedId) {
        try {
          entries = await notesClient.list(resolvedId);
        } catch (error) {
          noteLoadError = error instanceof Error ? error.message : String(error);
        }
      } else if (!noteLoadError) {
        noteLoadError = '无法确定此多维表格所属的笔记本。';
      }
      if (!isCurrentSession(sequence, key)) return;

      // Keep unresolved paths in the table file so users can see and repair a
      // broken reference. A successful note-list read is not permission to
      // erase the path: the file may have moved or the index may be catching up.
      const sourceContent = source;
      next = normalizeTableSessionDocument(next);

      sourceContentRef.current = { sessionKey: key, content: sourceContent };
      loadedSessionKeyRef.current = key;
      setDocument(next);
      setNotes(entries);
      setResolvedNotebookId(resolvedId);
      setNotesLoadError(noteLoadError);
    } catch (error) {
      if (isCurrentSession(sequence, key)) setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [getCurrentFilePath, isCurrentSession, notebookId, notebookPath, sessionKey]);

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

  const syncNotes = useCallback(async (event: NoteChangeEvent) => {
    const notebook = resolvedNotebookId;
    if (!notebook || event.notebookId !== notebook) return;
    const key = sessionKey;
    if (loadedSessionKeyRef.current !== key) return;
    const baselineAtStart = sourceContentRef.current?.content;
    const generation = loadSequenceRef.current;
    const syncSequence = ++syncSequenceRef.current;
    const isCurrent = () => isCurrentSession(generation, key) && syncSequence === syncSequenceRef.current;
    if (event.kind === 'path' || event.deleted || !event.relativePath) pendingTableSyncRef.current = true;
    let needsTableSync = pendingTableSyncRef.current;
    try {
      const singlePath = !needsTableSync && event.relativePath?.replace(/\\/g, '/');
      const singleEntry = singlePath ? await notesClient.getIndexed(notebook, singlePath) : null;
      if (singlePath && !singleEntry) {
        pendingTableSyncRef.current = true;
        needsTableSync = true;
      }
      const entries = needsTableSync ? await notesClient.list(notebook) : singleEntry ? [singleEntry] : [];
      if (!isCurrent()) return;
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
      const next = normalizeTableSessionDocument(await parseTableDocumentAsync(diskContent));
      if (!isCurrent()) return;
      const baseline = diskContent;
      if (savingRef.current) {
        pendingTableSyncRef.current = true;
        return;
      }
      if (sourceContentRef.current?.content !== baselineAtStart) {
        pendingTableSyncRef.current = true;
        void syncNotes({ notebookId: notebook, kind: 'path' });
        return;
      }
      const sourceChanged = sourceContentRef.current?.content !== baseline;
      sourceContentRef.current = { sessionKey: key, content: baseline };
      setNotes((current) => mergeEntries(current));
      setNotesLoadError(null);
      if (sourceChanged) setDocument((current) => current ? { ...next,
        table: reuseCollectionValue(current.table, next.table),
        records: reuseCollectionValue(current.records, next.records),
      } : next);
      pendingTableSyncRef.current = false;
    } catch (error) {
      if (isCurrent()) setNotesLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [getCurrentFilePath, isCurrentSession, notebookPath, resolvedNotebookId, sessionKey]);

  useEffect(() => subscribe<NoteChangeEvent>(
    'flowix:path-note-changed',
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
    savingRef.current = true;
    setSaving(true);
    try {
      validateTableDocument(next);
      const result = await externalDocuments.write({
        filePath: getCurrentFilePath(),
        content: serializeTableDocument(next),
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
        toast.success('保存完成');
        return true;
      }
      if (!isCurrentSession(sequence, key)) return false;
      if (result.status === 'conflict') {
        toast.error('表格文件已被其他操作修改，正在同步最新内容');
        pendingTableSyncRef.current = true;
        return false;
      }
      throw new Error(result.status === 'error' ? result.message : '表格文件已不存在');
    } catch (error) {
      if (!isCurrentSession(sequence, key)) return false;
      toast.error(error instanceof Error ? error.message : '保存表格失败');
      pendingTableSyncRef.current = true;
      return false;
    } finally {
      writeLocksRef.current.delete(lockKey);
      savingRef.current = false;
      if (pendingTableSyncRef.current && mountedRef.current && currentSessionKeyRef.current === key) {
        void syncNotes({ notebookId: resolvedNotebookId ?? '', kind: 'path' });
      }
      if (!keepSaving && isCurrentSession(sequence, key)) setSaving(false);
    }
  }, [getCurrentFilePath, isCurrentSession, load, notebookPath, resolvedNotebookId, sessionKey, syncNotes]);

  const acceptContent = useCallback((content: string) => {
    const next = normalizeTableSessionDocument(parseTableDocument(content));
    sourceContentRef.current = { sessionKey, content };
    setDocument((current) => current ? { ...next,
      table: reuseCollectionValue(current.table, next.table),
      records: reuseCollectionValue(current.records, next.records),
    } : next);
  }, [sessionKey]);

  const collectionId = document?.collection.id;
  useEffect(() => subscribe<{ notebookId: string; collectionId: string; relativePath: string }>('collection-changed', (event) => {
    if (event.notebookId !== resolvedNotebookId || event.collectionId !== collectionId || !notebookPath) return;
    const key = sessionKey;
    const sequence = loadSequenceRef.current;
    void externalDocuments.read(`${canonicalDirectoryPath(notebookPath)}/${event.relativePath}`, notebookPath).then((content) => {
      if (!isCurrentSession(sequence, key) || savingRef.current) return;
      const next = normalizeTableSessionDocument(parseTableDocument(content));
      if (next.collection.id !== collectionId) return;
      sourceContentRef.current = { sessionKey: key, content };
      setDocument((current) => current ? { ...next,
        table: reuseCollectionValue(current.table, next.table),
        records: reuseCollectionValue(current.records, next.records),
      } : next);
    }).catch(() => undefined);
  }), [collectionId, isCurrentSession, notebookPath, resolvedNotebookId, sessionKey]);

  const stateIsCurrent = stateSessionKey === sessionKey;
  return {
    document: stateIsCurrent ? document : null,
    loadError: stateIsCurrent ? loadError : null,
    saving: stateIsCurrent ? saving : false,
    setSaving,
    notes: stateIsCurrent ? notes : [],
    setNotes,
    resolvedNotebookId: stateIsCurrent ? resolvedNotebookId : notebookId,
    notesLoadError: stateIsCurrent ? notesLoadError : null,
    load,
    save,
    acceptContent,
    isCurrentSession: isCurrentSessionForKey,
    loadSequenceRef,
    loadGeneration,
    pendingNotePropertiesRef,
  };
}
