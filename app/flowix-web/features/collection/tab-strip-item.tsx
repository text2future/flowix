'use client';

import type { RefObject } from 'react';
import { useI18n } from '@/lib/i18n';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@shared/ui/context-menu';
import { collectionTabClassName } from '@shared/ui/collection-tab-bar';
import type { TabInlineEdit } from './use-tab-inline-edit';

/**
 * tab 条里的一个可改名 tab —— **唯一实现**。
 *
 * 集合的 tab 条上同时有两类 tab：表格自己的视图（表格、画廊、看板、日历）和外壳带来的
 * 宿主 tab（文件树、图墙、列表）。两者的交互完全一样（单击切换、双击 / 右键就地改名、
 * 右键删除），只有「改了往哪写」「什么条件下能删」不同，所以这里只收敛**外观与交互**，
 * 差异全部走回调与 `deleteDisabled`。
 *
 * 输入框与右键高亮态由调用方传入（`edit` / `menuActive`），因为一条 tab 条同一时刻
 * 只允许一个输入框——共享实例放在 `useTabInlineEdit`。
 */
export function TabStripItem({ label, editId, active, menuActive, editable, saving, disabled = false,
  edit, onMenuOpenChange, widthRef, onSelect, onBeginRename, onCommitRename, onCancelRename,
  onRequestDelete, deleteDisabled }: {
  label: string;
  /** 就地改名的 id：表格视图用 view.id，宿主 tab 用 `host:${key}`。 */
  editId: string;
  active: boolean;
  /** 右键菜单打开中：给 tab 上背景提示（菜单存续期间才亮）。 */
  menuActive: boolean;
  editable: boolean;
  saving: boolean;
  /** 整体禁用点击（表格视图在保存中不切换）。 */
  disabled?: boolean;
  edit: TabInlineEdit;
  onMenuOpenChange: (open: boolean) => void;
  /** 最近一次右键的 tab 宽度：右键 → 重命名时输入框与原 tab 同宽。 */
  widthRef: RefObject<number>;
  onSelect: () => void;
  onBeginRename: (width?: number) => void;
  /** 输入框失焦 / 回车提交。 */
  onCommitRename: (name: string) => void;
  /** Escape 的处理；不传表示按 Escape 不做事。 */
  onCancelRename?: () => void;
  onRequestDelete: () => void;
  deleteDisabled: boolean;
}) {
  const { t } = useI18n();
  return <ContextMenu onOpenChange={onMenuOpenChange}>
    {edit.editingId === editId ? (
      <input
        ref={edit.inputRef}
        aria-label={t('multidimensionalTable.view.name')}
        value={edit.name}
        disabled={!editable || saving}
        onChange={(event) => edit.setName(event.currentTarget.value)}
        onBlur={(event) => onCommitRename(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === 'Escape' && onCancelRename) {
            event.preventDefault();
            onCancelRename();
          }
        }}
        style={{ width: `${edit.width}px` }}
        className={`h-7 shrink-0 whitespace-nowrap rounded-md border border-[var(--border)] bg-[var(--background)] px-2.5 text-sm text-[var(--foreground)] outline-none ${active ? 'font-medium' : ''}`}
      />
    ) : (
      <ContextMenuTrigger asChild>
        <button type="button" disabled={disabled} onClick={onSelect} aria-current={active ? 'page' : undefined}
          onDoubleClick={(event) => onBeginRename(event.currentTarget.getBoundingClientRect().width)}
          onContextMenu={(event) => { widthRef.current = event.currentTarget.getBoundingClientRect().width; }}
          className={collectionTabClassName(active, menuActive ? 'bg-[var(--muted)] text-[var(--foreground)]' : '')}>
          {label}
        </button>
      </ContextMenuTrigger>
    )}
    <ContextMenuContent className="w-[160px] space-y-0.5 rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
      <ContextMenuItem disabled={!editable || saving} onSelect={() => onBeginRename(widthRef.current)}>{t('multidimensionalTable.view.rename')}</ContextMenuItem>
      <ContextMenuItem disabled={deleteDisabled} className="text-[var(--destructive)]" onSelect={onRequestDelete}>{t('multidimensionalTable.view.delete')}</ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>;
}
