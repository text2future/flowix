import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { attachments, dialogs, files, mediaResources, type DocumentPageItem } from '@platform/tauri/client';
import { resourceKindFromPath } from '@features/editor/public/code-file';
import { canonicalDirectoryPath, canonicalPath, joinNotebookMemoPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import type { useI18n } from '@/lib/i18n';
import { parseMediaLibrary, type MediaLibraryDocument, createMediaLibraryRecord } from './model';

type PersistMutation = (
  mutate: (current: MediaLibraryDocument) => MediaLibraryDocument,
  targetPath?: string,
  lockAlreadyHeld?: boolean,
  initialDocument?: MediaLibraryDocument,
) => Promise<boolean>;

interface MediaLibraryActionsOptions {
  document: MediaLibraryDocument | null;
  setDocument: Dispatch<SetStateAction<MediaLibraryDocument | null>>;
  notebookPath: string | null;
  notebookId: string | null;
  currentFilePath: string;
  saving: boolean;
  setSaving: Dispatch<SetStateAction<boolean>>;
  sourceContentRef: MutableRefObject<string | null>;
  saveInFlightRef: MutableRefObject<boolean>;
  persistMutation: PersistMutation;
  t: ReturnType<typeof useI18n>['t'];
}

export function useMediaLibraryActions({
  document, setDocument, notebookPath, notebookId, currentFilePath, saving, setSaving,
  sourceContentRef, saveInFlightRef, persistMutation, t,
}: MediaLibraryActionsOptions) {
  const addMedia = useCallback(async (): Promise<boolean> => {
    if (!document || !notebookPath || !notebookId || saving || saveInFlightRef.current) return false;
    const selectedPaths = await dialogs.selectFiles({ accept: 'image/*', multiple: true });
    if (!selectedPaths?.length) return false;
    if (saveInFlightRef.current) {
      toast.error(t('mediaLibrary.addMediaWaitForSave'));
      return false;
    }
    const latestDocument = sourceContentRef.current ? parseMediaLibrary(sourceContentRef.current) : document;
    const validPaths = selectedPaths.filter((path) => {
      const kind = resourceKindFromPath(path);
      return kind === 'image';
    });
    if (!validPaths.length) {
      toast.error(t('mediaLibrary.addMediaNoSupported'));
      return false;
    }
    const rejected = selectedPaths.length - validPaths.length;
    const pathFilter = latestDocument.view.condition.file_condition?.path_contains?.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const root = canonicalDirectoryPath(notebookPath);
    const recordsToAppend = [] as ReturnType<typeof createMediaLibraryRecord>[];
    const attachmentPathsToRollback: string[] = [];
    const completed: string[] = [];
    let failed = 0;
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      for (const sourcePath of validPaths) {
        let importedPath: string | null = null;
        const targetDirectory = pathFilter ? joinNotebookMemoPath(notebookPath, pathFilter) : null;
        if (pathFilter) {
          if (targetDirectory) {
            try {
              importedPath = await files.importFile(sourcePath, targetDirectory, notebookPath);
              const imported = canonicalPath(importedPath);
              if (!imported.startsWith(`${root}/`)) throw new Error('导入媒体路径不在当前笔记本');
              const relativePath = imported.slice(root.length + 1).replace(/\\/g, '/');
              recordsToAppend.push(createMediaLibraryRecord(relativePath));
            } catch {
              importedPath = null;
            }
          }
        }
        if (!importedPath) {
          try {
            const savedPath = await attachments.saveFromPath(sourcePath, notebookId);
            if (!savedPath) throw new Error('媒体附件保存失败');
            const saved = canonicalPath(savedPath);
            if (!saved.startsWith(`${root}/attachments/`)) throw new Error('附件保存路径不在当前笔记本');
            const relativePath = saved.slice(root.length + 1).replace(/\\/g, '/');
            recordsToAppend.push(createMediaLibraryRecord(relativePath));
            attachmentPathsToRollback.push(saved);
            importedPath = savedPath;
          } catch (error) {
            console.error('[MediaLibrary] Failed to save image attachment:', error);
            failed += 1;
            continue;
          }
        }
        completed.push(importedPath);
        // Ensure the media index knows about each copied image immediately.
        await mediaResources.get(importedPath, notebookPath).catch(() => undefined);
      }
      if (recordsToAppend.length) {
        const saved = await persistMutation((current) => {
          const linked = new Set(current.records.data.map((record) => canonicalPath(record.note_path).toLocaleLowerCase()));
          const additions = recordsToAppend.filter((record) => {
            const key = canonicalPath(record.note_path).toLocaleLowerCase();
            if (linked.has(key)) return false;
            linked.add(key);
            return true;
          });
          return {
            ...current,
            collection: { ...current.collection, revision: current.collection.revision + 1, updated_at: new Date().toISOString() },
            records: { data: [...current.records.data, ...additions] },
          };
        }, currentFilePath, true, latestDocument);
        if (!saved) {
          // A conflicting external update may already have linked one of these
          // unique attachment paths. Keep any such file and only roll back
          // attachments that remain unreferenced in the latest document.
          let latestRecords = latestDocument.records.data;
          try {
            if (sourceContentRef.current) latestRecords = parseMediaLibrary(sourceContentRef.current).records.data;
          } catch { /* Fall back to the document snapshot captured before import. */ }
          const linkedPaths = new Set(latestRecords.flatMap((record) => {
            const path = joinNotebookMemoPath(notebookPath, record.note_path);
            return path ? [canonicalPath(path).toLocaleLowerCase()] : [];
          }));
          const attachmentPathKeys = new Set(attachmentPathsToRollback.map((path) => canonicalPath(path).toLocaleLowerCase()));
          const rollbackPaths = attachmentPathsToRollback.filter((path) => !linkedPaths.has(canonicalPath(path).toLocaleLowerCase()));
          const rollbackResults = await Promise.all(rollbackPaths.map(async (path) => {
            try { return await mediaResources.delete(path, notebookPath); } catch { return false; }
          }));
          const rollbackFailedCount = rollbackResults.filter((deleted) => !deleted).length;
          // Directory imports remain successful; attachment imports count as
          // successful only if a record references them after the failed save.
          completed.splice(0, completed.length, ...completed.filter((path) => {
            const key = canonicalPath(path).toLocaleLowerCase();
            return !attachmentPathKeys.has(key) || linkedPaths.has(key);
          }));
          toast.error(rollbackFailedCount
            ? t('mediaLibrary.addMediaCleanupFailed', { count: rollbackFailedCount })
            : t('mediaLibrary.addMediaRecordFailed'));
        }
      }
      if (rejected) toast.error(t('mediaLibrary.addMediaSkipped', { count: rejected }));
      if (failed) toast.error(t('mediaLibrary.addMediaImportFailed', { count: failed }));
      if (completed.length) toast.success(t('mediaLibrary.addMediaSuccess', { count: completed.length }));
      if (!completed.length && !failed) toast.error(t('mediaLibrary.addMediaFailed'));
      return completed.length > 0;
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }, [currentFilePath, document, notebookId, notebookPath, persistMutation, saving, t]);

  const deleteManualMedia = useCallback(async (item: DocumentPageItem): Promise<boolean> => {
    if (!document || !notebookPath || saving || saveInFlightRef.current) return false;
    const root = canonicalDirectoryPath(notebookPath);
    const filePath = canonicalPath(item.fullPath);
    if (!filePath.startsWith(`${root}/`)) return false;
    const relativePath = filePath.slice(root.length + 1).replace(/\\/g, '/');
    const latestDocument = sourceContentRef.current ? parseMediaLibrary(sourceContentRef.current) : document;
    if (!latestDocument.records.data.some((record) => record.note_path.toLocaleLowerCase() === relativePath.toLocaleLowerCase())) return false;

    saveInFlightRef.current = true;
    setSaving(true);
    try {
      const deleted = await mediaResources.delete(filePath, notebookPath);
      if (!deleted) {
        toast.error(t('media.fileTree.deleteFailed'));
        return false;
      }
      const removeRecord = (current: MediaLibraryDocument): MediaLibraryDocument => ({
        ...current,
        collection: { ...current.collection, revision: current.collection.revision + 1, updated_at: new Date().toISOString() },
        records: {
          data: current.records.data.filter((record) => record.note_path.toLocaleLowerCase() !== relativePath.toLocaleLowerCase()),
        },
      });
      const saved = await persistMutation(removeRecord, currentFilePath, true, latestDocument);
      if (!saved) {
        const latest = sourceContentRef.current ? parseMediaLibrary(sourceContentRef.current) : latestDocument;
        setDocument(removeRecord(latest));
      }
      toast.success(t('media.fileTree.deleted', { name: item.name }));
      return true;
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : t('media.fileTree.deleteFailed'));
      return false;
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }, [currentFilePath, document, notebookPath, persistMutation, saving, t]);

  return { addMedia, deleteManualMedia };
}
