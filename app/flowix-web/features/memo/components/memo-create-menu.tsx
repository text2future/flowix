import {
  ChevronDown,
  ChevronUp,
  GalleryHorizontalEnd,
  SquarePen,
  SwatchBook,
  Table2,
} from 'lucide-react';

import { useI18n } from '@/lib/i18n';
import { AgentConversationTypeMenuItems } from '@features/agent/public/conversation-menu-api';
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel } from '@shared/ui/dropdown-menu';
import type { TableViewType } from '@features/multidimensional-table/public/create-api';
import type { AgentType, AgentTypeKey } from '@/types/agent';

import { MEMO_CREATE_VIEW_OPTIONS } from './memo-create-view-options';

const LABEL_CLASS = 'px-[0.375rem] pb-[0.35rem] pt-[0.35rem] text-xs font-normal leading-[1.2] text-[var(--muted-foreground)]';
const ITEM_CLASS = 'group h-7 items-center gap-2 rounded-lg px-2 py-0 hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]';
const ITEM_HINT_CLASS = 'ml-auto shrink-0 text-xs text-[var(--muted-foreground)] opacity-50 group-hover:text-[var(--primary-foreground)] group-focus-visible:text-[var(--primary-foreground)] group-data-[highlighted]:text-[var(--primary-foreground)]';

export interface MemoCreateMenuProps {
  disabled: boolean;
  disabledForMissingNotebook: boolean;
  showViewOptions: boolean;
  templates: readonly { id: string; name: string }[];
  conversationOptions: readonly AgentType[];
  viewsExpanded: boolean;
  onToggleViewsExpanded: () => void;
  onCreateMemo: () => void;
  onCreateFromTemplate: (templateId: string) => void | Promise<void>;
  onCreateAgentConversation: (typeKey: AgentTypeKey) => void;
  onOpenDocumentCreate: (
    kind: 'table' | 'media-library' | 'work-documents',
    viewType?: TableViewType,
  ) => void;
}

/**
 * 列表头部「新建」菜单的完整内容：文档 / 模板 / 对话 / 视图四段。
 * 原先内联在 memo-list 里，抽出来是为了把这份纯展示结构从千行列表组件里分离。
 */
export function MemoCreateMenu({
  disabled,
  disabledForMissingNotebook,
  showViewOptions,
  templates,
  conversationOptions,
  viewsExpanded,
  onToggleViewsExpanded,
  onCreateMemo,
  onCreateFromTemplate,
  onCreateAgentConversation,
  onOpenDocumentCreate,
}: MemoCreateMenuProps) {
  const { t } = useI18n();
  const visibleViewOptions = viewsExpanded
    ? MEMO_CREATE_VIEW_OPTIONS
    : MEMO_CREATE_VIEW_OPTIONS.slice(0, 1);

  return (
    <DropdownMenuContent align="end" className="w-[200px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
      <DropdownMenuLabel className={LABEL_CLASS}>
        {t('memo.create.documents')}
      </DropdownMenuLabel>
      <DropdownMenuItem
        disabled={disabled}
        onClick={onCreateMemo}
        className={ITEM_CLASS}
      >
        <SquarePen className="h-4 w-4" aria-hidden="true" />
        {t('memo.create.note')}
      </DropdownMenuItem>
      {templates.map((template) => (
        <DropdownMenuItem
          key={template.id}
          disabled={disabled}
          onClick={() => {
            void onCreateFromTemplate(template.id);
          }}
          className={ITEM_CLASS}
        >
          <SwatchBook className="h-4 w-4" aria-hidden="true" />
          <span className="min-w-0 truncate">{template.name}</span>
        </DropdownMenuItem>
      ))}
      {showViewOptions && conversationOptions.length > 0 && (
        <>
          <DropdownMenuLabel className={LABEL_CLASS}>
            {t('memo.create.conversations')}
          </DropdownMenuLabel>
          <AgentConversationTypeMenuItems
            options={conversationOptions}
            disabled={disabled}
            onSelect={onCreateAgentConversation}
          />
        </>
      )}
      {showViewOptions && (
        <>
          <DropdownMenuLabel className={LABEL_CLASS}>
            {t('memo.create.newView')}
          </DropdownMenuLabel>
          {visibleViewOptions.map(({ type, labelKey }) => (
            <DropdownMenuItem
              key={type}
              disabled={disabled}
              onClick={() => onOpenDocumentCreate('table', type)}
              className={ITEM_CLASS}
            >
              {type === 'table'
                ? <Table2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                : <span className="h-4 w-4 shrink-0" aria-hidden="true" />}
              <span className="min-w-0 flex-1 truncate text-left">{t(labelKey)}</span>
              <span className={ITEM_HINT_CLASS}>{t('memo.create.note')}</span>
            </DropdownMenuItem>
          ))}
          {viewsExpanded && (
            <>
              <DropdownMenuItem
                disabled={disabled}
                onClick={() => onOpenDocumentCreate('media-library')}
                className={ITEM_CLASS}
              >
                <GalleryHorizontalEnd className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-left">{t('memo.create.mediaLibraryMenuLabel')}</span>
                <span className={ITEM_HINT_CLASS}>{t('memo.create.assetShort')}</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={disabledForMissingNotebook}
                onClick={() => onOpenDocumentCreate('work-documents')}
                className={ITEM_CLASS}
              >
                <span className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-left">{t('memo.create.workDocumentsMenuLabel')}</span>
                <span className={ITEM_HINT_CLASS}>{t('memo.create.assetShort')}</span>
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuItem
            keepOpenOnClick
            onClick={onToggleViewsExpanded}
            title={t(viewsExpanded ? 'memo.create.collapseViews' : 'memo.create.expandViews')}
            className="group h-5 justify-center rounded-lg px-2 py-0 text-[var(--muted-foreground)] hover:text-[color-mix(in_oklch,var(--brand)_65%,white)]"
          >
            {viewsExpanded
              ? <ChevronUp className="h-4 w-4" aria-hidden="true" />
              : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
            <span className="sr-only">{t(viewsExpanded ? 'memo.create.collapseViews' : 'memo.create.expandViews')}</span>
          </DropdownMenuItem>
        </>
      )}
    </DropdownMenuContent>
  );
}
