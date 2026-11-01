import { useCallback, useEffect, useRef, useState } from 'react';
import { collections, files, type CollectionChangedEvent, type CollectionIndexItem, type FileBrowserDirectoriesChangedEvent, type MediaLibraryListItem, type TableDocumentListItem } from '@platform/tauri/client';
import { subscribe } from '@platform/tauri/event-bus';
import { canonicalPath } from '@/lib/path';
import { createLogger } from '@/lib/logger';

const logger = createLogger('notebook-view-data');

interface NotebookViewDataOptions {
  notebookId: string | null;
  notebookPath: string;
  isActive: boolean;
  refreshTrigger: number;
  ignoreCollectionPathEvents: (paths: readonly string[] | undefined) => boolean;
}

/** Owns collection catalogs and their snapshot and event updates for the notebook tree. */
export function useNotebookViewData({
  notebookId,
  notebookPath,
  isActive,
  refreshTrigger,
  ignoreCollectionPathEvents,
}: NotebookViewDataOptions) {
  const [tableDocuments, setTableDocuments] = useState<TableDocumentListItem[]>([]);
  const [mediaLibraries, setMediaLibraries] = useState<MediaLibraryListItem[]>([]);
  const [workDocumentCollections, setWorkDocumentCollections] = useState<CollectionIndexItem[]>([]);
  const tableRequestSequence = useRef(0);
  const mediaRequestSequence = useRef(0);
  const workDocumentsRequestSequence = useRef(0);
  const scopeRef = useRef({ notebookId, isActive });
  scopeRef.current = { notebookId, isActive };

  const refreshTables = useCallback(async () => {
    if (!notebookId || !isActive) return;
    const requestSequence = ++tableRequestSequence.current;
    const documents = await files.listTableDocuments(notebookId);
    if (
      requestSequence === tableRequestSequence.current
      && scopeRef.current.notebookId === notebookId
      && scopeRef.current.isActive
    ) setTableDocuments(documents);
  }, [isActive, notebookId]);
  const refreshMediaLibraries = useCallback(async () => {
    if (!notebookId || !isActive) return;
    const requestSequence = ++mediaRequestSequence.current;
    const libraries = await files.listMediaLibraries(notebookId);
    if (
      requestSequence === mediaRequestSequence.current
      && scopeRef.current.notebookId === notebookId
      && scopeRef.current.isActive
    ) setMediaLibraries(libraries);
  }, [isActive, notebookId]);
  const refreshWorkDocumentCollections = useCallback(async () => {
    if (!notebookId || !isActive) return;
    const requestSequence = ++workDocumentsRequestSequence.current;
    const items = await collections.list(notebookId, 'work_documents');
    if (
      requestSequence === workDocumentsRequestSequence.current
      && scopeRef.current.notebookId === notebookId
      && scopeRef.current.isActive
    ) setWorkDocumentCollections(items);
  }, [isActive, notebookId]);

  useEffect(() => {
    if (!isActive || !notebookId) {
      tableRequestSequence.current += 1;
      setTableDocuments([]);
      workDocumentsRequestSequence.current += 1;
      setWorkDocumentCollections([]);
      return;
    }
    void refreshTables().catch((error) => {
      logger.warn('failed to load table documents', { error, notebookId });
    });
    void refreshWorkDocumentCollections().catch((error) => {
      logger.warn('failed to load work document collections', { error, notebookId });
    });
    return () => {
      tableRequestSequence.current += 1;
      workDocumentsRequestSequence.current += 1;
    };
  }, [isActive, notebookId, refreshTrigger, refreshTables, refreshWorkDocumentCollections]);
  useEffect(() => {
    if (!isActive || !notebookId) {
      mediaRequestSequence.current += 1;
      setMediaLibraries([]);
      return;
    }
    void refreshMediaLibraries().catch((error) => {
      logger.warn('failed to load media libraries', { error, notebookId });
    });
    return () => { mediaRequestSequence.current += 1; };
  }, [isActive, notebookId, refreshMediaLibraries, refreshTrigger]);
  useEffect(() => {
    const applied = new Map<string, number>();
    return subscribe<CollectionChangedEvent>('collection-changed', (event) => {
      if (!isActive || event.notebookId !== notebookId || event.indexSequence < (applied.get(event.collectionId) ?? -1)) return;
      applied.set(event.collectionId, event.indexSequence);
      if (event.directoryMove) {
        void refreshTables().catch((error) => logger.warn('failed to refresh table documents after collection directory move', { error, notebookId }));
        void refreshMediaLibraries().catch((error) => logger.warn('failed to refresh media libraries after collection directory move', { error, notebookId }));
        void refreshWorkDocumentCollections().catch((error) => logger.warn('failed to refresh work document collections after collection directory move', { error, notebookId }));
        return;
      }
      tableRequestSequence.current += 1;
      mediaRequestSequence.current += 1;
      setTableDocuments((items) => items.map((item) => item.collectionId === event.collectionId ? { ...item, relativePath: event.relativePath, name: event.name, fileRevision: event.revision } : item));
      setMediaLibraries((items) => items.map((item) => item.collectionId === event.collectionId ? { ...item, relativePath: event.relativePath, name: event.name } : item));
      void refreshWorkDocumentCollections().catch((error) => logger.warn('failed to refresh work document collections after collection change', { error, notebookId }));
    });
  }, [isActive, notebookId, refreshTables, refreshMediaLibraries, refreshWorkDocumentCollections]);
  useEffect(() => subscribe<{ notebookId: string; operationId?: string }>('file-management-changed', (event) => {
    if (!isActive || event.notebookId !== notebookId || !notebookId || event.operationId) return;
    void refreshTables().catch((error) => {
      logger.warn('failed to refresh table documents', { error, notebookId });
    });
    void refreshMediaLibraries().catch((error) => {
      logger.warn('failed to refresh media libraries', { error, notebookId });
    });
    void refreshWorkDocumentCollections().catch((error) => {
      logger.warn('failed to refresh work document collections', { error, notebookId });
    });
  }), [isActive, notebookId, refreshTables, refreshMediaLibraries, refreshWorkDocumentCollections]);

  useEffect(() => subscribe<FileBrowserDirectoriesChangedEvent>(
    'file-browser-directories-changed',
    (event) => {
      if (!isActive || !notebookId || canonicalPath(event.rootPath) !== canonicalPath(notebookPath)) return;
      if (ignoreCollectionPathEvents(event.paths)) return;
      void refreshTables().catch((error) => {
        logger.warn('failed to refresh table documents after file change', { error, notebookId });
      });
      void refreshMediaLibraries().catch((error) => {
        logger.warn('failed to refresh media libraries after file change', { error, notebookId });
      });
      void refreshWorkDocumentCollections().catch((error) => {
        logger.warn('failed to refresh work document collections after file change', { error, notebookId });
      });
    },
  ), [isActive, notebookId, notebookPath, ignoreCollectionPathEvents, refreshTables, refreshMediaLibraries, refreshWorkDocumentCollections]);

  const updateTableIdentity = useCallback((relativePath: string, collectionId: string) => {
    setTableDocuments((current) => current.map((table) => table.relativePath === relativePath
      ? { ...table, collectionId, identityConflict: false }
      : table));
  }, []);
  const updateMediaLibraryIdentity = useCallback((relativePath: string, collectionId: string) => {
    setMediaLibraries((current) => current.map((library) => library.relativePath === relativePath
      ? { ...library, collectionId, identityConflict: false }
      : library));
  }, []);

  return {
    tableDocuments,
    mediaLibraries,
    workDocumentCollections,
    refreshTables,
    refreshMediaLibraries,
    refreshWorkDocumentCollections,
    updateTableIdentity,
    updateMediaLibraryIdentity,
  };
}
