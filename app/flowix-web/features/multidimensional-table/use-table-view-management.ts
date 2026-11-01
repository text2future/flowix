import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { reviseCollection } from '@features/collection/model';
import { hostTabKeyFromEditId, isHostTabEditId, useTabInlineEdit } from '@features/collection/public/tab-api';
import type { MultidimensionalTableDocument, TableView } from './model';
import type { useTableSession } from './use-table-session';
import { removeTableView, resolveTableView } from './view-selection';

interface Options {
  session: Pick<ReturnType<typeof useTableSession>, 'document' | 'saving' | 'loadSequenceRef' | 'isCurrentSession'>;
  save: ReturnType<typeof useTableSession>['save'];
  editable: boolean;
  canDeleteViews: boolean;
  activeViewId: string | null;
  activateView: (id: string) => void;
  /** 「管理视图」弹窗里宿主 tab 行的改名落点（走外壳，不经过表格保存）。 */
  renameHostTab?: (key: string, name: string) => void;
}

/** 「管理视图」里可改名的行：表格视图，或带 `host:` 伪 id 的宿主 tab。 */
type ManageableView = Pick<TableView, 'id' | 'name'>;

/**
 * 表格视图 tab 的改名 / 删除 / 就地编辑。
 *
 * 宿主 tab（文件树 / 图墙 / 列表）的改名与删除不在这里——它们落在外壳上，
 * 见 `@features/collection/public/tab-api` 的 `useHostTabActions`。
 * 两者共用一条 tab 条上的就地输入框，所以这里把 `tabEdit` 交给调用方，
 * 由它转给宿主 tab 的渲染；一条 strip 只能有一个输入框，实例必须唯一。
 *
 * 「管理视图」弹窗是唯一同时列出两类 tab 的地方，因此按 `host:` 前缀分流这一步留在这里。
 */
export function useTableViewManagement({ session, save, editable, canDeleteViews, activeViewId, activateView, renameHostTab }: Options) {
  const { t } = useI18n();
  const { document, saving, loadSequenceRef, isCurrentSession } = session;
  const tabEdit = useTabInlineEdit();
  const { begin: beginInlineEdit, end: endInlineEdit } = tabEdit;
  const [managingViewId, setManagingViewId] = useState<string | null>(null);
  const [managingViewName, setManagingViewName] = useState('');
  const [viewPendingDelete, setViewPendingDelete] = useState<TableView | null>(null);
  const managingViewRef = useRef<ManageableView | null>(null);
  const deletingViewRef = useRef(false);

  const beginRenameView = useCallback((view: TableView, tabWidth?: number) => {
    beginInlineEdit(view.id, view.name, tabWidth);
  }, [beginInlineEdit]);

  const renameView = useCallback(async (view: TableView, rawName: string) => {
    endInlineEdit();
    if (!document || saving) return;
    const trimmedName = rawName.trim();
    if (!trimmedName) {
      toast.error(t('multidimensionalTable.view.nameRequired'));
      return;
    }
    if (trimmedName === view.name) return;
    if (document.views.items.some((item) => item.id !== view.id && item.name === trimmedName)) {
      toast.error(t('multidimensionalTable.view.nameExists'));
      return;
    }
    const next: MultidimensionalTableDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      views: { ...document.views, items: document.views.items.map((item) => item.id === view.id ? { ...item, name: trimmedName } : item) },
    };
    await save(next, false, loadSequenceRef.current);
  }, [document, endInlineEdit, loadSequenceRef, save, saving, t]);

  const manageViewRenameInputRef = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => {
    if (!managingViewId) return;
    manageViewRenameInputRef.current?.focus();
    manageViewRenameInputRef.current?.select();
  }, [managingViewId]);

  const beginManageViewRename = useCallback((view: ManageableView) => {
    managingViewRef.current = view;
    setManagingViewName(view.name);
    setManagingViewId(view.id);
  }, []);

  const cancelManageViewRename = useCallback(() => {
    managingViewRef.current = null;
    setManagingViewId(null);
    setManagingViewName('');
  }, []);

  const finishManageViewRename = useCallback((view: ManageableView, rawName: string) => {
    // Consume the edit before awaiting a save so a subsequent blur cannot submit it again.
    if (managingViewRef.current?.id !== view.id) return;
    cancelManageViewRename();
    // 宿主 tab：改名落在外壳（hybrid 视图），不经过表格文档保存。
    if (isHostTabEditId(view.id)) {
      renameHostTab?.(hostTabKeyFromEditId(view.id), rawName);
      return;
    }
    return renameView(view as TableView, rawName);
  }, [cancelManageViewRename, renameHostTab, renameView]);

  const closeViewManagement = useCallback(() => {
    const view = managingViewRef.current;
    if (view) return finishManageViewRename(view, manageViewRenameInputRef.current?.value ?? managingViewName);
    cancelManageViewRename();
  }, [cancelManageViewRename, finishManageViewRename, managingViewName]);

  const deleteView = useCallback(async (view: TableView) => {
    if (!editable || !canDeleteViews || !document || saving || document.views.items.length <= 1 || deletingViewRef.current) return;
    deletingViewRef.current = true;
    try {
      const sequence = loadSequenceRef.current;
      const next = removeTableView(document, view.id);
      if (next === document) return;
      if (await save(next, false, sequence) && isCurrentSession(sequence) && activeViewId === view.id) {
        const fallback = resolveTableView(next);
        if (fallback) activateView(fallback.id);
      }
    } finally {
      deletingViewRef.current = false;
    }
  }, [activeViewId, activateView, canDeleteViews, document, editable, isCurrentSession, loadSequenceRef, save, saving]);

  const requestDeleteView = useCallback((view: TableView) => {
    if (!editable || !canDeleteViews || !document || saving || document.views.items.length <= 1 || deletingViewRef.current) return;
    setViewPendingDelete(view);
  }, [canDeleteViews, document, editable, saving]);

  const cancelDeleteView = useCallback(() => setViewPendingDelete(null), []);

  const confirmDeleteView = useCallback(() => {
    if (!viewPendingDelete || deletingViewRef.current) return;
    const view = viewPendingDelete;
    setViewPendingDelete(null);
    void deleteView(view);
  }, [deleteView, viewPendingDelete]);

  return {
    /** 就地改名输入框（表格视图 tab 自己用；宿主 tab 也要用它，见文件头注释）。 */
    tabEdit,
    managingViewId, cancelManageViewRename,
    managingViewName, setManagingViewName, manageViewRenameInputRef, closeViewManagement,
    viewPendingDelete, cancelDeleteView, beginRenameView, renameView,
    beginManageViewRename, finishManageViewRename, requestDeleteView, confirmDeleteView,
  };
}
