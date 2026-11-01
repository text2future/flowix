import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { dialogs, externalDocuments, mediaResources, type DocumentPageItem } from '@platform/tauri/client';
import { resourceKindFromPath } from '@features/editor/public/code-file';
import { canonicalDirectoryPath, canonicalPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import type { useI18n } from '@/lib/i18n';
import { parseMediaLibrary, type MediaLibraryDocument } from './model';
import { importMediaLibraryFiles } from './media-import';

type PersistMutation = (
  mutate: (current: MediaLibraryDocument) => MediaLibraryDocument,
  options?: { baseline?: MediaLibraryDocument; lockAlreadyHeld?: boolean },
) => Promise<boolean>;

interface MediaLibraryActionsOptions {
  document: MediaLibraryDocument | null;
  setDocument: Dispatch<SetStateAction<MediaLibraryDocument | null>>;
  notebookPath: string | null;
  notebookId: string | null;
  currentFilePath: string;
  saving: boolean;
  editable?: boolean;
  setSaving: Dispatch<SetStateAction<boolean>>;
  sourceContentRef: MutableRefObject<string | null>;
  saveInFlightRef: MutableRefObject<boolean>;
  persistMutation: PersistMutation;
  reportSaveFailure?: () => void;
  t: ReturnType<typeof useI18n>['t'];
}

export function useMediaLibraryActions({
  document, setDocument, notebookPath, notebookId, currentFilePath, saving, editable = true, setSaving,
  sourceContentRef, saveInFlightRef, persistMutation, reportSaveFailure, t,
}: MediaLibraryActionsOptions) {
  const addMedia = useCallback(async (): Promise<boolean> => {
    if (!editable || !document || !notebookPath || !notebookId || saving || saveInFlightRef.current) return false;
    const selectedPaths = await dialogs.selectFiles({ accept: 'media/*', multiple: true });
    if (!selectedPaths?.length) return false;
    if (saveInFlightRef.current) {
      toast.error(t('mediaLibrary.addMediaWaitForSave'));
      return false;
    }
    const latestDocument = sourceContentRef.current ? parseMediaLibrary(sourceContentRef.current) : document;
    const validPaths = selectedPaths.filter((path) => {
      const kind = resourceKindFromPath(path);
      return kind === 'image' || kind === 'video';
    });
    if (!validPaths.length) {
      toast.error(t('mediaLibrary.addMediaNoSupported'));
      return false;
    }
    const rejected = selectedPaths.length - validPaths.length;
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      const result = await importMediaLibraryFiles({
        paths: validPaths, notebookId, notebookPath, filePath: currentFilePath, document: latestDocument,
        persist: (mutate) => persistMutation(mutate, { baseline: latestDocument, lockAlreadyHeld: true }),
        readLatest: async () => parseMediaLibrary(await externalDocuments.read(currentFilePath, notebookPath)),
      });
      if (result.recordSaveFailed) toast.error(result.cleanupFailed
        ? t('mediaLibrary.addMediaCleanupFailed', { count: result.cleanupFailed })
        : t('mediaLibrary.addMediaRecordFailed'));
      if (rejected) toast.error(t('mediaLibrary.addMediaSkipped', { count: rejected }));
      if (result.failed) toast.error(t('mediaLibrary.addMediaImportFailed', { count: result.failed }));
      if (result.completed.length) toast.success(t('mediaLibrary.addMediaSuccess', { count: result.completed.length }));
      return result.completed.length > 0;
    } catch (reason) {
      reportSaveFailure?.();
      toast.error(reason instanceof Error ? reason.message : t('mediaLibrary.addMediaFailed'));
      return false;
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }, [currentFilePath, document, notebookId, notebookPath, persistMutation, reportSaveFailure, saveInFlightRef, saving, setSaving, sourceContentRef, t, editable]);

  const deleteMedia = useCallback(async (item: DocumentPageItem): Promise<boolean> => {
    if (!editable || !document || !notebookPath || saving || saveInFlightRef.current) return false;
    const root = canonicalDirectoryPath(notebookPath);
    const filePath = canonicalPath(item.fullPath);
    const rootPrefix = root === '/' ? '/' : `${root}/`;
    if (!filePath.startsWith(rootPrefix)) return false;
    const relativePath = filePath.slice(rootPrefix.length).replace(/\\/g, '/');
    const latestDocument = sourceContentRef.current ? parseMediaLibrary(sourceContentRef.current) : document;
    const hasLibraryRecord = latestDocument.dataset.records.include.some((record) => record.relative_path.toLocaleLowerCase() === relativePath.toLocaleLowerCase());

    saveInFlightRef.current = true;
    setSaving(true);
    try {
      const deleted = await mediaResources.delete(filePath, notebookPath);
      if (!deleted) {
        toast.error(t('media.fileTree.deleteFailed'));
        return false;
      }
      if (hasLibraryRecord) {
        const removeRecord = (current: MediaLibraryDocument): MediaLibraryDocument => ({
          ...current,
          collection: { ...current.collection, revision: current.collection.revision + 1, updated_at: new Date().toISOString() },
          dataset: { ...current.dataset, records: { ...current.dataset.records,
            include: current.dataset.records.include.filter((record) => record.relative_path.toLocaleLowerCase() !== relativePath.toLocaleLowerCase()),
          } },
        });
        const saved = await persistMutation(removeRecord, { baseline: latestDocument, lockAlreadyHeld: true });
        if (!saved) {
          const latest = sourceContentRef.current ? parseMediaLibrary(sourceContentRef.current) : latestDocument;
          setDocument(removeRecord(latest));
        }
      }
      toast.success(t('status.deleteCompleted'));
      return true;
    } catch (reason) {
      reportSaveFailure?.();
      toast.error(reason instanceof Error ? reason.message : t('media.fileTree.deleteFailed'));
      return false;
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }, [document, notebookPath, persistMutation, reportSaveFailure, saveInFlightRef, saving, setDocument, setSaving, sourceContentRef, t, editable]);

  return { addMedia, deleteMedia };
}
