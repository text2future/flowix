import { useCallback, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { hostTabEditId, type CollectionHostTab } from './collection-host-tab';
import type { TabInlineEdit } from './use-tab-inline-edit';

/**
 * 宿主 tab（文件树 / 图墙 / 列表）的改名与删除。
 *
 * 这两个动作的落点都在**外壳**（hybrid 视图，或外壳自身固定 tab），不经过表格文档
 * 保存——所以它们不该由表格的视图管理来承担。表格只把 `hostTabEditId` 那套前缀
 * 约定用在「管理视图」弹窗的路由上。
 *
 * 「先确认再删」的对话框由调用方渲染（表格里与表格视图共用同一个 Dialog），
 * 这里只给出的待删对象与确认/取消。
 */
interface Options {
  /** 与表格视图 tab 共用的就地改名输入框。 */
  edit: TabInlineEdit;
  /** 改名提交：外壳按 `域名:视图id` 定位 hybrid 视图。 */
  renameHostTab?: (key: string, name: string) => void;
  /** 删除：所在域的最后一个视图会连同域一起移除。 */
  removeHostTab?: (key: string) => void;
  editable: boolean;
  saving: boolean;
}

export interface HostTabPendingDelete {
  key: string;
  label: string;
}

export function useHostTabActions({ edit, renameHostTab, removeHostTab, editable, saving }: Options) {
  const { t } = useI18n();

  const beginRenameHostTab = useCallback((tab: CollectionHostTab, tabWidth?: number) => {
    if (!editable || saving) return;
    edit.begin(hostTabEditId(tab.key), tab.label, tabWidth);
  }, [edit, editable, saving]);

  const commitHostTabRename = useCallback((key: string, rawName: string) => {
    edit.end();
    if (!editable || saving) return;
    const trimmedName = rawName.trim();
    if (!trimmedName) {
      toast.error(t('multidimensionalTable.view.nameRequired'));
      return;
    }
    renameHostTab?.(key, trimmedName);
  }, [edit, renameHostTab, t, editable, saving]);

  const [hostTabPendingDelete, setHostTabPendingDelete] = useState<HostTabPendingDelete | null>(null);

  const requestDeleteHostTab = useCallback((tab: HostTabPendingDelete) => {
    if (!editable || saving) return;
    setHostTabPendingDelete(tab);
  }, [editable, saving]);

  const cancelDeleteHostTab = useCallback(() => setHostTabPendingDelete(null), []);

  const confirmDeleteHostTab = useCallback(() => {
    const tab = hostTabPendingDelete;
    setHostTabPendingDelete(null);
    if (tab && editable && !saving) removeHostTab?.(tab.key);
  }, [hostTabPendingDelete, removeHostTab, editable, saving]);

  return {
    beginRenameHostTab, commitHostTabRename,
    hostTabPendingDelete, requestDeleteHostTab, cancelDeleteHostTab, confirmDeleteHostTab,
  };
}
