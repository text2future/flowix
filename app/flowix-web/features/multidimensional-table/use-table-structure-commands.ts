import { useCallback } from 'react';
import type { MutableRefObject } from 'react';

import type { useViewAddWizard } from '@features/collection/public/view-menu-api';
import { reviseCollection } from '@features/collection/public/model-api';
import { toast } from '@/lib/toast';
import { friendlyErrorMessage } from '@/lib/friendly-error-message';
import type { I18nKey } from '@/lib/i18n';

import { NOTE_CALENDAR_DATE_FIELD_ID } from './builtin-fields';
import {
  addCalendarDateView,
  addKanbanView,
  addTableView,
  createUuidV7,
  type MultidimensionalTableDocument,
  type TableField,
} from './model';
import { cycleTableSort } from './table-sort-button';
import { toggleDatasetTableFieldVisibility } from './table-commands';
import type { useTableFieldEdits } from './use-table-field-edits';
import type { useTableSession } from './use-table-session';

type TableSession = ReturnType<typeof useTableSession>;
type ViewWizard = ReturnType<typeof useViewAddWizard>;

/**
 * 「改表结构」的一组命令：加视图 / 换视图的分组字段 / 切换字段显隐 / 切换列排序 /
 * 内联新建选项。它们的共同点是「先写一份新文档，再 save，再按 sequence 判断是否还落在
 * 当前会话上」，并且都不持有 UI 状态——所以从视图组件里搬出来，让两千行的 JSX 只负责接线。
 */
export function useTableStructureCommands({
  document,
  editable,
  saving,
  save,
  loadSequenceRef,
  isCurrentSession,
  activeViewId,
  latestDocumentRef,
  queueHeaderFieldEdits,
  viewWizard,
  pendingViewType,
  configuringViewId,
  activateView,
  setTablePage,
  t,
}: {
  document: MultidimensionalTableDocument | null;
  editable: boolean;
  saving: boolean;
  save: TableSession['save'];
  loadSequenceRef: TableSession['loadSequenceRef'];
  isCurrentSession: TableSession['isCurrentSession'];
  activeViewId: string | null;
  latestDocumentRef: MutableRefObject<MultidimensionalTableDocument | null>;
  queueHeaderFieldEdits: ReturnType<typeof useTableFieldEdits>['queueHeaderFieldEdits'];
  viewWizard: ViewWizard;
  pendingViewType: ViewWizard['pendingType'];
  configuringViewId: ViewWizard['configuringViewId'];
  activateView: (viewId: string) => void;
  setTablePage: (page: number) => void;
  t: (key: I18nKey) => string;
}) {
  const createViewForField = useCallback(async (field: TableField | string) => {
    if (!document || !pendingViewType || saving) return;
    const sequence = loadSequenceRef.current;
    const fieldId = typeof field === 'string' ? field : field.id;
    if ((pendingViewType === 'calendar' && typeof field !== 'string' && field.type !== 'Date')
      || (pendingViewType === 'kanban' && (typeof field === 'string' || field.type !== 'Select'))) return;
    try {
      const added = pendingViewType === 'calendar' && fieldId === NOTE_CALENDAR_DATE_FIELD_ID
        ? addCalendarDateView(document)
        : addTableView(document, pendingViewType, fieldId);
      if (await save(added.document, false, sequence) && isCurrentSession(sequence)) {
        activateView(added.view.id);
        viewWizard.close();
      }
    } catch (error) {
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.tableView'));
    }
  }, [document, isCurrentSession, loadSequenceRef, activateView, pendingViewType, save, saving, viewWizard, t]);

  const saveConfiguredViewField = useCallback(async (
    viewId: string,
    viewType: 'calendar' | 'kanban',
    fieldId: string,
    dataset = document?.dataset,
  ) => {
    if (!document || !dataset || saving) return false;
    const sequence = loadSequenceRef.current;
    const configKey = viewType === 'calendar' ? 'date_field' : 'group_by';
    const next: MultidimensionalTableDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      dataset,
      views: { ...document.views, items: document.views.items.map((view) => view.id === viewId
        ? { ...view, config: { ...view.config, [configKey]: fieldId } }
        : view) },
    };
    return await save(next, false, sequence) && isCurrentSession(sequence);
  }, [document, isCurrentSession, loadSequenceRef, save, saving]);

  const selectViewField = useCallback(async (field: TableField | string) => {
    if (!configuringViewId) return createViewForField(field);
    if (!document || !pendingViewType || saving) return;
    let fieldId = typeof field === 'string' ? field : field.id;
    let dataset = document.dataset;
    try {
      if (pendingViewType === 'calendar' && fieldId === NOTE_CALENDAR_DATE_FIELD_ID) {
        const added = addCalendarDateView(document);
        fieldId = added.view.config.date_field as string;
        dataset = added.document.dataset;
      }
      if (await saveConfiguredViewField(configuringViewId, pendingViewType, fieldId, dataset)) {
        viewWizard.close();
      }
    } catch (error) {
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.tableViewSave'));
    }
  }, [configuringViewId, createViewForField, document, pendingViewType, saveConfiguredViewField, saving, viewWizard, t]);

  const createKanbanViewForStatus = useCallback(async () => {
    if (!document || pendingViewType !== 'kanban' || saving) return;
    const sequence = loadSequenceRef.current;
    try {
      const added = addKanbanView(document);
      if (await save(added.document, false, sequence) && isCurrentSession(sequence)) {
        activateView(added.view.id);
        viewWizard.close();
      }
    } catch (error) {
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.tableView'));
    }
  }, [document, isCurrentSession, loadSequenceRef, activateView, pendingViewType, save, saving, viewWizard, t]);

  const chooseKanbanStatusField = useCallback(async () => {
    if (!configuringViewId) return createKanbanViewForStatus();
    if (!document || saving) return;
    try {
      const added = addKanbanView(document);
      if (await saveConfiguredViewField(configuringViewId, 'kanban', added.field.id, added.document.dataset)) {
        viewWizard.close();
      }
    } catch (error) {
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.tableViewSave'));
    }
  }, [configuringViewId, createKanbanViewForStatus, document, saveConfiguredViewField, saving, viewWizard, t]);

  const createGalleryView = useCallback(async () => {
    if (!document || saving) return;
    const sequence = loadSequenceRef.current;
    const added = addTableView(document, 'gallery');
    if (await save(added.document, false, sequence) && isCurrentSession(sequence)) {
      activateView(added.view.id);
      viewWizard.close();
    }
  }, [document, isCurrentSession, loadSequenceRef, activateView, save, saving, viewWizard]);

  const createDataTableView = useCallback(async () => {
    if (!document || saving) return;
    const sequence = loadSequenceRef.current;
    const added = addTableView(document, 'table');
    if (await save(added.document, false, sequence) && isCurrentSession(sequence)) {
      activateView(added.view.id);
      viewWizard.close();
    }
  }, [document, isCurrentSession, loadSequenceRef, activateView, save, saving, viewWizard]);

  const toggleTableFieldVisibility = useCallback(async (fieldId: string) => {
    if (!editable || !document || saving) return;
    const next = toggleDatasetTableFieldVisibility(document, fieldId);
    if (next !== document) await save(next);
  }, [document, editable, save, saving]);

  const hideTableField = useCallback(async (fieldId: string) => {
    const currentDocument = latestDocumentRef.current;
    if (!editable || !currentDocument || saving) return;
    const next = toggleDatasetTableFieldVisibility(currentDocument, fieldId);
    if (next !== currentDocument) await save(next);
  }, [editable, latestDocumentRef, save, saving]);

  const toggleColumnSort = useCallback(async (fieldId: string) => {
    if (!editable || !document || saving) return;
    const view = document.views.items.find((item) => item.id === activeViewId && item.layout === 'table');
    if (!view) return;
    const next: MultidimensionalTableDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      views: { ...document.views, items: document.views.items.map((item) => item.id === view.id
        ? { ...item, sort: cycleTableSort(item.sort, fieldId) } : item) },
    };
    if (await save(next)) setTablePage(0);
  }, [activeViewId, document, editable, save, saving, setTablePage]);

  const createTableFieldOption = useCallback(async (field: TableField, label: string): Promise<{ id: string; label: string } | null> => {
    const trimmed = label.trim();
    if (!trimmed || (field.type !== 'Select' && field.type !== 'MultiSelect')) return null;
    const existing = field.options?.find((option) => option.label === trimmed);
    if (existing) return existing;
    const option = { id: `opt_${createUuidV7()}`, label: trimmed };
    const saved = await queueHeaderFieldEdits(field, field.name ?? field.property_key ?? '', [...(field.options ?? []), option]);
    return saved ? option : null;
  }, [queueHeaderFieldEdits]);

  return {
    selectViewField,
    createKanbanViewForStatus,
    chooseKanbanStatusField,
    createGalleryView,
    createDataTableView,
    toggleTableFieldVisibility,
    hideTableField,
    toggleColumnSort,
    createTableFieldOption,
  };
}
