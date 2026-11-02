import { useCallback, useRef, useState } from 'react';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import type { AssetDomain } from '@/lib/collection-tab-key';
import { addCollectionDomain, addCollectionNoteView, addCollectionView, ensureFolderCollection,
  renameCollectionView, removeCollectionView, type FolderCollectionSummary,
  reorderCollectionViews, type AddCollectionViewResult } from '@features/collection/public/folder-api';
import type { TableViewType } from '@features/multidimensional-table/public/create-api';

/** Serializes view commands; only the current collection may publish results or change selection. */
export function useCollectionViewCommands({ indexPath, notebookPath, currentFolderPath, folderName,
  editable, summary, onSummary }: {
  indexPath: string; notebookPath: string | null; currentFolderPath: string | null; folderName: string;
  editable: boolean; summary: FolderCollectionSummary | 'missing' | null;
  onSummary: (summary: FolderCollectionSummary) => void;
}) {
  const { t } = useI18n();
  const key = JSON.stringify([indexPath, notebookPath]);
  const currentKey = useRef(key); currentKey.current = key;
  const lock = useRef<{ key: string; token: symbol } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const run = useCallback(async <T extends FolderCollectionSummary | AddCollectionViewResult>(action: () => Promise<T>): Promise<T | null> => {
    if (!editable || !notebookPath || !indexPath || lock.current?.key === key) return null;
    const token = Symbol(); lock.current = { key, token }; setBusyKey(key);
    try {
      const result = await action();
      if (currentKey.current !== key) return null;
      onSummary('summary' in result ? result.summary : result);
      return result;
    } catch (error) {
      if (currentKey.current === key) toast.error(error instanceof Error ? error.message : t('collection.openFailed'));
      return null;
    } finally {
      if (lock.current?.token === token) { lock.current = null; setBusyKey(null); }
    }
  }, [editable, indexPath, key, notebookPath, onSummary, t]);
  const addAssetView = useCallback((domain: AssetDomain) => run(async () => {
    if (!notebookPath || !summary) throw new Error('集合尚未加载');
    if (summary === 'missing') {
      if (!currentFolderPath) throw new Error('集合文件不存在');
      const next = await ensureFolderCollection(currentFolderPath, notebookPath, folderName, domain);
      return { summary: next, viewId: next.defaultByDomain[domain]! };
    }
    if (!summary.domains.includes(domain)) {
      const next = await addCollectionDomain(indexPath, notebookPath, domain);
      return { summary: next, viewId: next.defaultByDomain[domain]! };
    }
    return addCollectionView(indexPath, notebookPath, domain);
  }), [currentFolderPath, folderName, indexPath, notebookPath, run, summary]);
  const addNoteView = useCallback((layout: TableViewType, fieldId?: string) => run(() =>
    addCollectionNoteView(indexPath, notebookPath!, layout, currentFolderPath, fieldId)),
  [currentFolderPath, indexPath, notebookPath, run]);
  const renameView = useCallback((id: string, name: string) => run(() =>
    renameCollectionView(indexPath, notebookPath!, id, name)), [indexPath, notebookPath, run]);
  const reorderViews = useCallback((ids: readonly string[]) => run(() =>
    reorderCollectionViews(indexPath, notebookPath!, ids)), [indexPath, notebookPath, run]);
  const removeView = useCallback((id: string) => run(() =>
    removeCollectionView(indexPath, notebookPath!, id)), [indexPath, notebookPath, run]);
  return { busy: busyKey === key, addAssetView, addNoteView, renameView, reorderViews, removeView };
}
