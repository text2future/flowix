import type { RefObject } from 'react';
import { useAppLanguage } from '@features/preferences/public/runtime-api';
import { translate } from '@/lib/i18n';

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
          <div className="memo-document-header">{titleEditor}</div>
        </div>
      </>
    );
  }

  return (
    <div className="memo-document-header">
      {dateLine}
      {titleEditor}
    </div>
  );
}
