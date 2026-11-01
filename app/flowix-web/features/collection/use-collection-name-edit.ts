'use client';

/**
 * 集合名称的内联重命名（大标题头用）。
 *
 * 名字就是路径：重命名会**改文件夹名**（`.index.yaml` 文件夹集合，目录随之移动）
 * 或改集合文件名，落盘走 `renameCollectionAtPath`（与表格 nav 小标题同一个入口），
 * 所以两处重命名产生的结果完全一致，包括 `file_tree`、数据域、view 都不变。
 *
 * 交互约定（与 `EditableCollectionName` 一起构成整套）：双击进入编辑、
 * Enter / 失焦保存、Esc 退出不保存、保存中显示 spinner 且不可再次进入。
 */
import { useCallback, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { friendlyErrorMessage } from '@/lib/friendly-error-message';
import { useTitleEditCaret } from '@shared/hooks/use-title-edit-caret';
import { renameCollectionAtPath } from './mutations';
import type { CollectionNameEditControls } from './editable-collection-name';

export function useCollectionNameEdit({
  filePath,
  notebookPath,
  notebookId,
  expectedCollectionId,
  currentName,
  editable = true,
  onRenamed,
}: {
  filePath: string;
  notebookPath: string | null;
  notebookId: string | null;
  /** 集合身份：给了就不再靠路径认集合（路径可能被复用）。 */
  expectedCollectionId?: string | null;
  currentName: string;
  editable?: boolean;
  onRenamed?: (nextFilePath: string) => void;
}): CollectionNameEditControls {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const { inputRef, captureCaret } = useTitleEditCaret(editing);
  const unavailable = !editable || busy || !notebookPath || !filePath;

  const beginEdit = useCallback(() => {
    if (unavailable) return;
    setDraft(currentName);
    setEditing(true);
  }, [currentName, unavailable]);

  const commit = useCallback(async (raw: string) => {
    setEditing(false);
    const name = raw.trim();
    if (unavailable || !notebookPath || !name || name === currentName) return;
    if (/[\\/]/.test(name)) {
      toast.error('文件名不能包含路径分隔符');
      return;
    }
    setBusy(true);
    try {
      const result = await renameCollectionAtPath(filePath, notebookPath, name, notebookId, expectedCollectionId ?? undefined);
      onRenamed?.(result.filePath);
    } catch (error) {
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.tableRename'));
    } finally {
      setBusy(false);
    }
  }, [currentName, expectedCollectionId, filePath, notebookId, notebookPath, onRenamed, t, unavailable]);

  const cancel = useCallback(() => {
    setEditing(false);
    setDraft(currentName);
  }, [currentName]);

  return { editing, draft, setDraft, inputRef, captureCaret, beginEdit, commit, cancel, disabled: !editable, busy };
}
