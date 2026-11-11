'use client';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ArrowDownUp, Check, Loader2, SquarePen } from 'lucide-react';
import type { NoteTemplate } from '@platform/tauri/client';
import { Button } from '@shared/ui/button';
import { POPUP_SEPARATOR_CLASS } from '@shared/ui/popup-separator';
import { Tooltip } from '@shared/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { MemoNavigationDropdown, MemoNavigationSubmenu } from '../memo-navigation-dropdown';
import { MemoCreateMenu, type MemoCreateMenuProps } from '../memo-create-menu';
import { useNoteStore } from '@features/memo/store/note-store';
import type { TableViewType } from '@features/multidimensional-table/public/create-api';

type NoteStoreState = ReturnType<typeof useNoteStore.getState>;
type MemoListFilter = NoteStoreState['activeFilter'];
type MemoListSort = NoteStoreState['activeSort'];

export interface MemoListHeaderProps {
  state: {
    folderMode: boolean;
    folderViewVisible: boolean;
    title: string;
    hasActiveFilter: boolean;
    hasDataCondition: boolean;
    activeFilter: MemoListFilter;
    activeSort: MemoListSort;
    notebookPath?: string;
    hasNotebook: boolean;
    notebookMissing: boolean;
    defaultCreateFolder: string | null;
    notebookDropdownOpen: boolean;
    sortSubmenuOpen: boolean;
    createTypeMenuOpen: boolean;
    isCreatingMemo: boolean;
    createTemplates: readonly NoteTemplate[];
    conversationOptions: MemoCreateMenuProps['conversationOptions'];
    createViewsExpanded: boolean;
  };
  actions: {
    onNotebookDropdownOpenChange: (open: boolean) => void;
    onSortSubmenuOpenChange: (open: boolean) => void;
    onCreateTypeMenuOpenChange: (open: boolean) => void;
    onClearFilter: () => void;
    onSaveDefaultCreateFolder: (path: string | null) => Promise<boolean>;
    onSelectPeriod: (filter: MemoListFilter) => void;
    onSelectSort: (sort: MemoListSort) => void;
    onToggleCreateViewsExpanded: () => void;
    onCreateMemo: () => void;
    onCreateFromTemplate: MemoCreateMenuProps['onCreateFromTemplate'];
    onCreateAgentConversation: MemoCreateMenuProps['onCreateAgentConversation'];
    onOpenDocumentCreate: (
      kind: 'table' | 'media-library' | 'work-documents',
      viewType?: TableViewType,
    ) => void;
  };
}

export function MemoListHeader({ state, actions }: MemoListHeaderProps) {
  const { t } = useI18n();
  const sortValueAdornment = state.activeSort === 'updatedAt'
    ? t('memo.list.sortUpdated')
    : state.activeSort === 'filenameAsc'
      ? t('memo.list.sortFilenameAsc')
      : state.activeSort === 'filenameDesc'
        ? t('memo.list.sortFilenameDesc')
        : t('memo.list.sortCreated');

  const createMenu = (
    <MemoCreateMenu
      disabled={!state.hasNotebook}
      disabledForMissingNotebook={!state.hasNotebook || state.notebookMissing}
      showViewOptions={state.folderMode}
      templates={state.createTemplates}
      conversationOptions={state.conversationOptions}
      viewsExpanded={state.createViewsExpanded}
      onToggleViewsExpanded={actions.onToggleCreateViewsExpanded}
      onCreateMemo={actions.onCreateMemo}
      onCreateFromTemplate={actions.onCreateFromTemplate}
      onCreateAgentConversation={actions.onCreateAgentConversation}
      onOpenDocumentCreate={actions.onOpenDocumentCreate}
    />
  );

  return (
    <div
      className="flex min-w-0 items-center gap-2 pb-2 pr-3"
      style={{ paddingLeft: 'calc(var(--memo-list-tabs-width, 60px) + 20px)' }}
    >
      <div className="min-w-0 flex-1">
        {!state.folderViewVisible && (
          <MemoNavigationDropdown
            title={state.title}
            titleTooltip={state.hasActiveFilter ? state.title : undefined}
            ariaLabel={t('memo.navigation.menuTitle')}
            open={state.notebookDropdownOpen}
            onOpenChange={actions.onNotebookDropdownOpenChange}
            showClear={state.hasActiveFilter || state.activeFilter !== 'all' || state.hasDataCondition}
            onClear={actions.onClearFilter}
            notebookPath={state.notebookPath}
            defaultCreateFolder={state.defaultCreateFolder}
            onSavePath={actions.onSaveDefaultCreateFolder}
          >
            <div className="space-y-0.5">
              <MemoNavigationSubmenu
                label={t('memo.list.sortLabel')}
                icon={<ArrowDownUp className="h-4 w-4 shrink-0" aria-hidden="true" />}
                open={state.sortSubmenuOpen}
                hideHeader
                emptyText=""
                loadingText=""
                valueAdornment={(
                  <span className="max-w-[100px] truncate text-xs text-[var(--muted-foreground)]">
                    {sortValueAdornment}
                  </span>
                )}
                submenuContent={(
                  <div className="flex flex-col space-y-0.5">
                    <button
                      type="button"
                      onClick={() => actions.onSelectPeriod('thisWeek')}
                      onMouseDown={(event) => event.preventDefault()}
                      className={cn(
                        'memo-navigation-submenu-item memo-navigation-submenu-item--neutral-hover mention-note-item cursor-pointer hover:bg-[var(--hover-bg)] focus-visible:bg-[var(--hover-bg)] focus-visible:outline-none',
                        state.activeFilter === 'thisWeek' && 'is-selected',
                      )}
                    >
                      <span className="mention-note-title">{t('memo.list.filterThisWeek')}</span>
                      {state.activeFilter === 'thisWeek' && <Check className="h-4 w-4 text-[var(--brand)]" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => actions.onSelectPeriod('thisMonth')}
                      onMouseDown={(event) => event.preventDefault()}
                      className={cn(
                        'memo-navigation-submenu-item memo-navigation-submenu-item--neutral-hover mention-note-item cursor-pointer hover:bg-[var(--hover-bg)] focus-visible:bg-[var(--hover-bg)] focus-visible:outline-none',
                        state.activeFilter === 'thisMonth' && 'is-selected',
                      )}
                    >
                      <span className="mention-note-title">{t('memo.list.filterThisMonth')}</span>
                      {state.activeFilter === 'thisMonth' && <Check className="h-4 w-4 text-[var(--brand)]" />}
                    </button>
                    <div role="separator" aria-hidden="true" className={POPUP_SEPARATOR_CLASS} />
                    {([
                      ['createdAt', 'memo.list.sortCreated'],
                      ['updatedAt', 'memo.list.sortUpdated'],
                      ['filenameAsc', 'memo.list.sortFilenameAsc'],
                      ['filenameDesc', 'memo.list.sortFilenameDesc'],
                    ] as const).map(([sort, label]) => (
                      <button
                        key={sort}
                        type="button"
                        onClick={() => actions.onSelectSort(sort)}
                        onMouseDown={(event) => event.preventDefault()}
                        className={cn(
                          'memo-navigation-submenu-item memo-navigation-submenu-item--neutral-hover mention-note-item cursor-pointer hover:bg-[var(--hover-bg)] focus-visible:bg-[var(--hover-bg)] focus-visible:outline-none',
                          state.activeSort === sort && 'is-selected',
                        )}
                      >
                        <span className="mention-note-title">{t(label)}</span>
                        {state.activeSort === sort && <Check className="h-4 w-4 text-[var(--brand)]" />}
                      </button>
                    ))}
                  </div>
                )}
                onOpenChange={actions.onSortSubmenuOpenChange}
                onCloseMenu={() => actions.onNotebookDropdownOpenChange(false)}
              />
            </div>
          </MemoNavigationDropdown>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <DropdownMenu open={state.createTypeMenuOpen} onOpenChange={actions.onCreateTypeMenuOpenChange}>
          <Tooltip content={t('memo.create.chooseType')} shortcut="memo.create">
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                disabled={state.isCreatingMemo || (state.folderMode && !state.hasNotebook)}
                aria-busy={state.isCreatingMemo}
                aria-label={t('memo.create.chooseType')}
                aria-haspopup={state.folderMode ? 'menu' : undefined}
                className="h-[30px] w-[30px] justify-center rounded-xl border border-transparent bg-[var(--primary)] p-0 text-[var(--primary-foreground)] hover:opacity-90"
              >
                {state.isCreatingMemo
                  ? <Loader2 className="h-4 w-4 flowix-spin" aria-hidden="true" />
                  : <SquarePen className="h-4 w-4" aria-hidden="true" />}
              </Button>
            </DropdownMenuTrigger>
          </Tooltip>
          {createMenu}
        </DropdownMenu>
      </div>
    </div>
  );
}
