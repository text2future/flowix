import { useCallback, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { createLogger } from '@/lib/logger';
import { displayTitleFromFilename } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { setDocumentProperties } from '@features/document/public/path-properties';
import { useCustomFilterStore, type CustomFilter } from '@features/memo/store/custom-filter-store';
import {
  getVisibleCreateFilter,
  type ExtendedFilterType,
  type Notebook,
  useNoteStore,
} from '@features/memo/store/note-store';
import { noteRepository } from '@features/memo/services/note-repository';
import { openNotebookNote } from '@features/memo/use-cases/open-notebook-note';
import { files } from '@platform/tauri/client';
import { notebookRelativeDirectoryPath } from '@/lib/path';

const logger = createLogger('memo-list');

async function nextUntitledNoteTitle(parentPath: string, baseTitle: string): Promise<string> {
  const children = await files.getDirChildren(parentPath);
  const existingTitles = new Set(children
    .filter((item) => item.type === 'document' && /\.(md|markdown)$/i.test(item.name))
    .map((item) => displayTitleFromFilename(item.name).trim().toLowerCase()));
  const normalizedBaseTitle = baseTitle.trim();
  if (!existingTitles.has(normalizedBaseTitle.toLowerCase())) return normalizedBaseTitle;
  let number = 1;
  while (existingTitles.has(`${normalizedBaseTitle} ${number}`.toLowerCase())) number += 1;
  return `${normalizedBaseTitle} ${number}`;
}

interface UseMemoListCreationActionsOptions {
  notebook: Notebook | null;
  activeFilter: ExtendedFilterType;
  activeTagId: string | null;
  activeCustomFilterId: string | null;
  activeCustomFilter: CustomFilter | null;
  folderMode: boolean;
  workTargetParentPath: string | null;
  loadNotebookFilters: (notebookId: string) => Promise<void>;
  setActiveFilter: (filter: ExtendedFilterType) => void;
  setSelectedTagId: (tagId: string | null) => void;
  prepareForInsert: (key: string) => void;
}

/** Owns note creation policy and its list reveal feedback. */
export function useMemoListCreationActions({
  notebook,
  activeFilter,
  activeTagId,
  activeCustomFilterId,
  activeCustomFilter,
  folderMode,
  workTargetParentPath,
  loadNotebookFilters,
  setActiveFilter,
  setSelectedTagId,
  prepareForInsert,
}: UseMemoListCreationActionsOptions) {
  const { t } = useI18n();
  const [isCreatingMemo, setIsCreatingMemo] = useState(false);
  const [createdCardRevealKey, setCreatedCardRevealKey] = useState<string | null>(null);
  const handleCreatedCardRevealed = useCallback(() => setCreatedCardRevealKey(null), []);

  const handleCreateMemo = useCallback(async (
    parentRelativePathOverride?: string,
    titleOverride?: string,
  ) => {
    if (!notebook) return;
    setIsCreatingMemo(true);
    try {
      let customFilterForCreation = activeCustomFilter;
      if (activeFilter === 'custom' && activeCustomFilterId && !customFilterForCreation) {
        await loadNotebookFilters(notebook.id);
        customFilterForCreation = useCustomFilterStore.getState().filtersByNotebook[notebook.id]
          ?.find((filter) => filter.id === activeCustomFilterId) ?? null;
      }
      const shouldCreateIntoCustomFilter = activeFilter === 'custom'
        && customFilterForCreation?.documentType === 'note';
      const createFilter = shouldCreateIntoCustomFilter ? 'custom' : getVisibleCreateFilter(activeFilter);
      if (createFilter !== activeFilter) {
        setSelectedTagId(null);
        setActiveFilter(createFilter);
      }

      const workTargetParentRelativePath = !folderMode || workTargetParentPath === null
        ? null
        : notebookRelativeDirectoryPath(notebook.path, workTargetParentPath);
      const parentRelativePath = parentRelativePathOverride
        ?? workTargetParentRelativePath
        ?? (await files.getNotebookViewPreferences(notebook.path)).defaultCreateFolder
        ?? '';
      const notebookRoot = notebook.path.replace(/[\\/]+$/, '');
      const namingParentPath = parentRelativePath
        ? `${notebookRoot}/${parentRelativePath}`
        : notebookRoot;
      const title = titleOverride?.trim()
        || await nextUntitledNoteTitle(namingParentPath, t('memo.untitled'));
      const result = await noteRepository.create(
        activeTagId ?? undefined,
        notebook.id,
        parentRelativePath,
        title,
      );
      if (shouldCreateIntoCustomFilter && customFilterForCreation) {
        const saved = await setDocumentProperties(result.path, {
          [customFilterForCreation.key]: customFilterForCreation.value,
        });
        if (!saved) throw new Error('Failed to apply the active custom view to the new note');
      }
      const shouldSelectNewMemo = createFilter === 'all'
        || (createFilter === 'tagged' && Boolean(activeTagId))
        || createFilter === 'thisWeek'
        || createFilter === 'thisMonth'
        || (createFilter === 'custom' && shouldCreateIntoCustomFilter);
      if (shouldSelectNewMemo) {
        const cardKey = `path:${notebook.id}:${result.relativePath}`;
        setCreatedCardRevealKey(cardKey);
        prepareForInsert(cardKey);
      }

      // The list query subscriber refreshes this projection after the write.
      useNoteStore.getState().upsertCreatedNote(result);
      const opening = shouldSelectNewMemo
        ? openNotebookNote(result.path, notebook, { initialFocus: 'title', treeReveal: 'created-note' })
        : null;
      if (opening) await opening;
    } catch (error) {
      logger.warn('create memo failed', { error, notebookId: notebook.id });
      toast.error(t('memo.list.createFailed'));
    } finally {
      setIsCreatingMemo(false);
    }
  }, [
    activeFilter,
    activeTagId,
    activeCustomFilter,
    activeCustomFilterId,
    loadNotebookFilters,
    folderMode,
    prepareForInsert,
    workTargetParentPath,
    notebook,
    setActiveFilter,
    setSelectedTagId,
    t,
  ]);

  const handleCreateNoteInFolder = useCallback(async (parentPath?: string, title?: string) => {
    if (!notebook) return;
    if (parentPath === undefined) return handleCreateMemo(undefined, title);
    const root = notebook.path.replace(/\/+$/, '');
    const parent = parentPath.replace(/\/+$/, '');
    if (parent !== root && !parent.startsWith(`${root}/`)) return;
    const relative = parent === root ? '' : parent.slice(root.length + 1);
    return handleCreateMemo(relative, title);
  }, [handleCreateMemo, notebook]);

  return {
    isCreatingMemo,
    createdCardRevealKey,
    handleCreatedCardRevealed,
    handleCreateMemo,
    handleCreateNoteInFolder,
  };
}
