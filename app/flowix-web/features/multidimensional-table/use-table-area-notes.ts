import { useCallback, useMemo } from 'react';

import { dialogs, files, notes as notesClient, type NoteEntry } from '@platform/tauri/client';
import { canonicalDirectoryPath, canonicalPath, parentDirectoryPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import { friendlyErrorMessage } from '@/lib/friendly-error-message';
import { useI18n } from '@/lib/i18n';
import { resolveCollectionSaveDirectory, reviseCollection } from '@features/collection/public/folder-api';
import type { CollectionAreaMenuItem } from '@shared/ui/collection-area-menu';
import { noteAreaMenuItems } from '@shared/ui/collection-area-menu-items';
import { createUuidV7, type MultidimensionalTableDocument, type TableField, type TableRecord } from './model';
import type { useTableSession } from './use-table-session';

type TableSession = ReturnType<typeof useTableSession>;

export interface UseTableAreaNotesInput {
  session: Pick<TableSession,
    | 'document' | 'saving' | 'setSaving' | 'loadSequenceRef' | 'isCurrentSession'
    | 'resolvedNotebookId' | 'setNotes' | 'reportSaveFailure'>;
  /** 会话组件里带 editable 闸门的 save 包装。 */
  save: (next: MultidimensionalTableDocument, keepSaving?: boolean, sequence?: number) => Promise<boolean>;
  editable: boolean;
  saving: boolean;
  currentFilePath: string;
  notebookPath: string | null;
  noteField: TableField | undefined;
  datasetRecords: TableRecord[];
  noteForRecord: (record: TableRecord) => NoteEntry | undefined;
  /** 画廊「新建卡片」的落库实现（见 useTableNoteLinking）。 */
  createBlankGalleryNote: (nextNoteNumber: number) => Promise<void>;
}

/**
 * 笔记视图（表格 / 画廊 / 看板 / 日历）列表区域右键菜单的全部行为：
 * 「新建笔记」= 建一条笔记并作为记录挂进当前视图；「导入笔记 .md」= 复制进集合目录再补记录。
 * 视图组件只负责把 `CollectionAreaMenu` 摆到列表区域上。
 */
export function useTableAreaNotes(input: UseTableAreaNotesInput) {
  const {
    session, save, editable, saving, currentFilePath, notebookPath, noteField,
    datasetRecords, noteForRecord, createBlankGalleryNote: persistBlankNote,
  } = input;
  const { document, setSaving, loadSequenceRef, isCurrentSession, resolvedNotebookId, setNotes, reportSaveFailure } = session;
  const { t } = useI18n();

  /** 「新建笔记」── 沿用画廊新建卡片的编号规则，保证标题不撞名。 */
  const createBlankGalleryNote = useCallback(async () => {
    const nextNoteNumber = datasetRecords.reduce((max, record) => {
      const title = noteForRecord(record)?.title ?? '';
      const match = /^未命名笔记\s+(\d+)$/.exec(title.trim());
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0) + 1;
    await persistBlankNote(nextNoteNumber);
  }, [datasetRecords, noteForRecord, persistBlankNote]);

  /**
   * 「导入笔记 .md」── 把外部 Markdown 复制到集合的保存目录（与「新建笔记」同一个落点，
   * 保证落在数据集范围内），重读笔记列表后把它们补进显式记录：
   * 自动收集型的集合本来就会看到，手动挑选型的集合也不会导完却什么都不显示。
   */
  const importNotes = useCallback(async () => {
    if (!editable || !document || !notebookPath || !resolvedNotebookId || saving) return;
    const selected = await dialogs.selectFiles({ accept: 'markdown/*', multiple: true });
    if (!selected?.length) return;
    // 系统对话框没有 markdown 专用过滤器，这里只收 .md / .markdown，
    // 其它类型直接挡掉，避免把图片当笔记导进来。
    const markdownPaths = selected.filter((path) => /\.(md|markdown)$/i.test(path));
    if (!markdownPaths.length) {
      toast.error(t('collection.areaMenu.onlyMarkdown'));
      return;
    }
    let directory: string;
    try {
      directory = resolveCollectionSaveDirectory({
        filePath: currentFilePath,
        notebookPath,
        placement: document.collection.placement,
        source: document.dataset.source,
        filter: document.dataset.filter,
        defaultDirectory: parentDirectoryPath(currentFilePath, notebookPath),
      });
    } catch (error) {
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.tableSave'));
      return;
    }
    const root = canonicalDirectoryPath(notebookPath).replace(/\/$/, '');
    const rootPrefix = `${root}/`;
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      const importedPaths: string[] = [];
      let failed = 0;
      for (const sourcePath of markdownPaths) {
        try {
          const target = await files.importFile(sourcePath, directory, notebookPath);
          if (target?.startsWith(rootPrefix)) importedPaths.push(canonicalPath(target).slice(rootPrefix.length));
          else failed += 1;
        } catch (error) {
          failed += 1;
          console.warn('[table] importing markdown note failed', error);
        }
      }
      if (!isCurrentSession(sequence)) return;
      // 导入的笔记是新文件：重读笔记列表，数据集才能立即把记录算出来。
      setNotes(await notesClient.list(resolvedNotebookId));
      if (!isCurrentSession(sequence)) return;
      if (failed) toast.error(t('collection.areaMenu.importFilesFailed', { count: failed }));
      if (!importedPaths.length || !noteField) return;
      const linked = new Set(document.dataset.records.include.map((record) => record.note_path.replace(/\\/g, '/')));
      const additions = importedPaths
        .filter((path) => !linked.has(path))
        .map((path) => ({ id: `rec_${createUuidV7()}`, updated_at: new Date().toISOString(), note_path: path }));
      if (!additions.length) return;
      const saved = await save({
        ...document,
        collection: reviseCollection(document.collection),
        dataset: { ...document.dataset, records: { ...document.dataset.records, include: [...document.dataset.records.include, ...additions] } },
      }, true, sequence);
      if (!saved) reportSaveFailure(sequence);
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.tableSave'));
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [currentFilePath, document, editable, isCurrentSession, loadSequenceRef, noteField, notebookPath, reportSaveFailure, resolvedNotebookId, save, saving, setNotes, setSaving, t]);

  const areaMenuItems: CollectionAreaMenuItem[] = useMemo(() => noteAreaMenuItems({
    t,
    onCreateNote: editable && noteField && !saving ? () => { void createBlankGalleryNote(); } : undefined,
    onImportNotes: editable && noteField && !saving ? () => { void importNotes(); } : undefined,
  }), [createBlankGalleryNote, editable, importNotes, noteField, saving, t]);

  return { createBlankGalleryNote, importNotes, areaMenuItems };
}
