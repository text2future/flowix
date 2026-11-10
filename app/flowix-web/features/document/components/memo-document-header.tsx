import { useCallback, type RefObject } from 'react';
import { useAppLanguage } from '@features/preferences/public/runtime-api';
import { useI18n, translate } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';

const logger = createLogger('memo-document-header');
import { NotebookNoteIcon, useNotebookNoteIcon } from '@features/memo/public/shell-api';
import { setDocumentProperties } from '@features/document/public/path-properties';
import { IconValueInput } from '../properties/icon-value-input';

import {
  MemoTitleEditor,
  type MemoTitleBodyNavigation,
  type MemoTitleEditorHandle,
} from './memo-title-editor';
import type { RenameDocumentTitle } from './memo-title-session';
import type { ClipboardSnapshot } from '@features/editor/extensions/paste-rules/clipboard';
import type { WorkspaceColumnId } from '@features/workspace/public/host-api';

interface MemoDocumentHeaderProps {
  displayId: string;
  filename: string;
  /** Absolute note path; drives the note icon shown above the title. */
  filePath?: string;
  renameTitle: RenameDocumentTitle;
  updatedAt: Date | null;
  editable: boolean;
  propertyActionsEnabled?: boolean;
  workspaceHost?: WorkspaceColumnId;
  onActivateProperties?: () => void;
  autoFocus?: boolean;
  sourceMode?: boolean;
  useDocumentSelection?: boolean;
  showPropertiesToggle?: boolean;
  propertyAreaHovered?: boolean;
  allowReadOnlyBoundaryNavigation?: boolean;
  onMoveToBody: (request: MemoTitleBodyNavigation) => void;
  onPasteToBody?: (snapshot: ClipboardSnapshot) => void;
  titleRef?: RefObject<MemoTitleEditorHandle | null>;
}

function formatDocumentDateTime(date: Date, language: 'zh-CN' | 'en-US'): string {
  if (language === 'en-US') {
    const datePart = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(date);
    const timePart = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date);
    return `${datePart} ${timePart}`;
  }

  return translate(language, 'editor.dateTime.fullFormat', {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours().toString().padStart(2, '0'),
    minute: date.getMinutes().toString().padStart(2, '0'),
  });
}

export function MemoDocumentHeader({
  displayId,
  filename,
  filePath,
  renameTitle,
  updatedAt,
  editable,
  propertyActionsEnabled,
  workspaceHost,
  onActivateProperties,
  autoFocus = false,
  sourceMode = false,
  useDocumentSelection = false,
  showPropertiesToggle = true,
  propertyAreaHovered = false,
  allowReadOnlyBoundaryNavigation = true,
  onMoveToBody,
  onPasteToBody,
  titleRef,
}: MemoDocumentHeaderProps) {
  const language = useAppLanguage();
  const { t } = useI18n();
  // 未设置 flowix_icon 时为 null，标题上方不渲染图标行。
  const noteIcon = useNotebookNoteIcon(filePath ?? null);
  // 与标题属性操作按钮同一可用性口径：只读文档禁止切换图标。
  const iconEditingEnabled = propertyActionsEnabled ?? editable;
  const changeNoteIcon = useCallback((next: string) => {
    if (!filePath) return;
    setDocumentProperties(filePath, { flowix_icon: next }).then((saved) => {
      if (!saved) toast.error(t('media.properties.saveFailed'));
    }).catch((error) => {
      logger.error('设置笔记图标失败', { error });
      toast.error(t('media.properties.saveFailed'));
    });
  }, [filePath, t]);
  const titleIcon = noteIcon ? (
    <div className="memo-title-icon-row">
      <IconValueInput
        value={noteIcon}
        disabled={!iconEditingEnabled}
        onChange={changeNoteIcon}
        trigger={(
          <button
            type="button"
            className="memo-title-note-icon-trigger"
            aria-label={t('document.properties.category.icon')}
          >
            <NotebookNoteIcon icon={noteIcon} className="memo-title-note-icon" />
          </button>
        )}
      />
    </div>
  ) : null;
  const dateLine = (
    <div className="memo-date-line">
      {updatedAt ? formatDocumentDateTime(updatedAt, language) : null}
    </div>
  );
  const titleEditor = (
    <MemoTitleEditor
      ref={titleRef}
      displayId={displayId}
      filename={filename}
      filePath={filePath}
      renameTitle={renameTitle}
      editable={editable}
      propertyActionsEnabled={propertyActionsEnabled}
      workspaceHost={workspaceHost}
      onActivateProperties={onActivateProperties}
      autoFocus={autoFocus}
      useDocumentSelection={useDocumentSelection}
      showPropertiesToggle={showPropertiesToggle && !sourceMode}
      propertyAreaHovered={propertyAreaHovered}
      allowReadOnlyBoundaryNavigation={allowReadOnlyBoundaryNavigation}
      onMoveToBody={onMoveToBody}
      onPasteToBody={onPasteToBody}
    />
  );

  if (sourceMode) {
    return (
      <>
        <div className="source-document-date-row">{dateLine}</div>
        <div className="source-document-title-row">
          <div className="memo-document-header">
            {titleIcon}
            {titleEditor}
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="memo-document-header">
      {dateLine}
      {titleIcon}
      {titleEditor}
    </div>
  );
}
