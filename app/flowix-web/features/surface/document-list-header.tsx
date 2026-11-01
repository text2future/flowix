'use client';

/**
 * 集合列表的标题行 / 操作区。三种形态分开写，但「统计 + 筛选 + 添加」这一组结构一致，
 * 只有文案与是否可写不同。
 *
 * 嵌入集合外壳时（传入 `actionsHost`）只把右侧操作区 portal 进外壳 nav 的操作槽——
 * tab 之下不允许再有第二行标题，集合名由外壳统一给。
 */
import { CollectionActionsPortal, type CollectionActionsHost } from '@shared/ui/collection-actions';
import { Folder, LoaderCircle } from 'lucide-react';
import { DotsThreeIcon, PlusIcon } from '@phosphor-icons/react';
import type { RefObject } from 'react';
import { useI18n } from '@/lib/i18n';
import { Button } from '@shared/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { NotebookTreeResourceIcon } from '@features/content/public/content-api';
import { CollectionTitle } from '@features/collection/public/title-api';
import type { DatasetFilterController } from './use-dataset-filter';

export type DocumentListMode = 'media' | 'work' | 'documents';

export interface DocumentListHeaderProps {
  mode: DocumentListMode;
  /** 普通文件夹模式下的标题（目录名）。 */
  folderTitle: string;
  libraryName: string;
  libraryFilePath?: string;
  visibleCount: number;
  hasMore: boolean;
  filter: DatasetFilterController;
  onOpenNoteFilter?: () => void;
  rename: {
    editing: boolean;
    draft: string;
    setDraft: (value: string) => void;
    inputRef: RefObject<HTMLInputElement | null>;
    captureCaret: (element: HTMLElement, clientX: number, clientY: number) => void;
    beginEdit: () => void;
    commit: (title: string) => Promise<void>;
    cancel: () => void;
    busy: boolean;
    disabled: boolean;
  };
  actions: {
    onAddMedia?: () => void;
    addingMedia: boolean;
    /** 保存中 / 只读：操作按钮禁用。 */
    disabled: boolean;
    onSwitchToTable?: () => void;
    onCreateNote?: () => void;
    canCreateNote: boolean;
  };
  /** 嵌入集合外壳：只把右侧操作区 portal 进 nav 的操作槽，不再渲染第二行。 */
  actionsHost?: CollectionActionsHost;
  headerRef: RefObject<HTMLDivElement | null>;
}

/** 筛选菜单的文案：图墙与列表各自的措辞（图墙沿用原样，列表走 i18n）。 */
const FILTER_LABELS = {
  media: { title: '资料筛选', set: '已设置', empty: '未设置' },
} as const;

export function DocumentListHeader({
  mode, folderTitle, libraryName, libraryFilePath, visibleCount, hasMore,
  filter, onOpenNoteFilter, rename, actions, actionsHost, headerRef,
}: DocumentListHeaderProps) {
  const { t } = useI18n();

  const titleEditor = mode === 'media' ? <div className="flex h-7 min-w-0 max-w-full flex-[0_1_auto] -translate-x-[2px] items-center gap-1.5" title={libraryName}>
    <NotebookTreeResourceIcon path={libraryFilePath ?? 'media-library.lib.yaml'} collectionType="media_library" className="h-5 w-5 shrink-0" />
    {rename.editing ? <input
      ref={rename.inputRef}
      aria-label={t('mediaLibrary.titleLabel')}
      value={rename.draft}
      disabled={rename.busy}
      onChange={(event) => rename.setDraft(event.currentTarget.value)}
      onBlur={(event) => { void rename.commit(event.currentTarget.value); }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          rename.cancel();
        }
      }}
      className="box-border h-[22px] min-w-[2em] max-w-full flex-[0_1_auto] rounded px-0.5 py-1 [field-sizing:content] border-0 bg-[var(--muted)] text-sm font-medium leading-none text-[var(--foreground)] outline-none"
    /> : <button
      type="button"
      onDoubleClick={(event) => { if (rename.disabled) return; event.preventDefault(); rename.captureCaret(event.currentTarget, event.clientX, event.clientY); rename.beginEdit(); }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === 'F2') {
          event.preventDefault();
          rename.beginEdit();
        }
      }}
      aria-label={`重命名媒体库：${libraryName}`}
      title={rename.disabled ? libraryName : `双击重命名：${libraryName}`}
      disabled={rename.disabled}
      className="inline-flex min-w-[2em] flex-[0_1_auto] items-center truncate rounded border-0 bg-transparent px-0.5 py-1 text-left text-sm font-medium leading-none text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] disabled:opacity-100"
    >{libraryName}</button>}
    {rename.busy && <span role="status" aria-label={t('memo.fileTree.renaming')} className="inline-flex shrink-0 items-center text-[var(--muted-foreground)]">
      <LoaderCircle className="h-3.5 w-3.5 flowix-spin" aria-hidden="true" />
    </span>}
  </div> : null;

  const headerLeft = mode === 'media' ? <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1">
    {titleEditor}
    {actions.onSwitchToTable && <>
      <span aria-hidden="true" className="h-[1em] w-px shrink-0 bg-[var(--border)]" />
      <Popover>
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="sm" aria-label="更多" title="更多"
            className="h-7 w-7 shrink-0 rounded-lg p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]">
            <DotsThreeIcon size={16} weight="bold" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" side="bottom" sideOffset={5} fitViewport className="w-[160px] rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
          <button type="button" disabled={actions.disabled} onClick={actions.onSwitchToTable}
            className="flex h-8 w-full items-center rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
            多维表格
          </button>
        </PopoverContent>
      </Popover>
    </>}
  </div> : mode === 'work' ? <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1">
    <CollectionTitle
      kind="work_documents"
      title={libraryName}
      inputLabel={t('workDocuments.titleLabel')}
      renameLabel={t('workDocuments.renameLabel')}
      renameHint={t('workDocuments.renameHint')}
      edit={{
        editing: rename.editing,
        draft: rename.draft,
        setDraft: rename.setDraft,
        inputRef: rename.inputRef,
        captureCaret: rename.captureCaret,
        beginEdit: rename.beginEdit,
        commit: rename.commit,
        cancel: rename.cancel,
        disabled: rename.disabled,
        busy: rename.busy,
      }}
    />
  </div> : <div className="flex items-center" role="group" aria-label={t('memo.documentList.viewType')}>
    <button
      type="button"
      aria-pressed="true"
      className="inline-flex h-8 items-center justify-start gap-1.5 rounded-lg px-0 text-sm font-medium text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
    ><Folder className="h-3.5 w-3.5" aria-hidden="true" /><span className="max-w-[500px] truncate">{folderTitle}</span></button>
  </div>;

  const headerRight = mode === 'media' ? <div className="flex shrink-0 items-center gap-2">
    {!actionsHost && <>
      <span className="text-sm text-[var(--muted-foreground)]">{t('mediaLibrary.itemCount', { count: visibleCount, more: hasMore ? '+' : '' })}</span>
      <span aria-hidden="true" className="h-[1em] w-px shrink-0 bg-[var(--border)]" />
    </>}
    <div className="flex shrink-0 items-center gap-0">
      {actions.onAddMedia && <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={t('mediaLibrary.addMedia')}
        title={t('mediaLibrary.addMedia')}
        disabled={actions.addingMedia || actions.disabled}
        onClick={actions.onAddMedia}
        className="h-7 w-7 rounded-lg p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
      ><PlusIcon size={14} weight="bold" aria-hidden="true" /></Button>}
      {filter.renderMenu({
        ...FILTER_LABELS.media,
        title: t('collection.filter.assets'),
        label: t('mediaLibrary.filterLabel'),
        disabled: actions.disabled,
        otherFilter: onOpenNoteFilter ? {
          label: t('collection.filter.notes'), onSelect: onOpenNoteFilter, disabled: actions.disabled,
        } : undefined,
      })}
    </div>
  </div> : mode === 'work' ? <div className="flex shrink-0 items-center gap-2">
    {!actionsHost && <>
      <span className="text-sm text-[var(--muted-foreground)]">{t('memo.documentList.workDocumentsCount', { count: visibleCount, more: hasMore ? '+' : '' })}</span>
      <span aria-hidden="true" className="h-[1em] w-px shrink-0 bg-[var(--border)]" />
    </>}
    {filter.renderMenu({
      title: t('collection.filter.assets'),
      set: t('mediaLibrary.conditionsSet'),
      empty: t('mediaLibrary.conditionsEmpty'),
      label: t('workDocuments.filterLabel'),
      disabled: actions.disabled || !filter.canEdit,
      otherFilter: onOpenNoteFilter ? {
        label: t('collection.filter.notes'), onSelect: onOpenNoteFilter, disabled: actions.disabled,
      } : undefined,
    })}
  </div> : <div className="flex items-center gap-2">
    <Button type="button" className="px-3" onClick={actions.onCreateNote} disabled={!actions.canCreateNote}>{t('memo.documentList.new')}</Button>
  </div>;

  // 嵌入：右侧操作区 portal 进外壳 nav 的操作槽，本组件不再渲染第二行。
  if (actionsHost) return <CollectionActionsPortal host={actionsHost}><div className="flex shrink-0 items-center gap-2">{headerRight}</div></CollectionActionsPortal>;
  if (mode !== 'documents') return <div ref={headerRef} className="multidimensional-table__view-nav -mx-5 flex min-w-0 shrink-0 items-center justify-between gap-1 px-4">{headerLeft}{headerRight}</div>;
  return <div ref={headerRef} className="-mx-5 flex flex-wrap items-center justify-between gap-2 px-5 pt-3">{headerLeft}{headerRight}</div>;
}
