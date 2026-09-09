import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import { translate } from '@/lib/i18n';

import { MemoTitleEditor } from './memo-title-editor';

interface MemoDocumentHeaderProps {
  memoId: string;
  filename: string;
  updatedAt: Date | null;
  editable: boolean;
  autoFocus?: boolean;
  onMoveToBody: () => void;
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
  memoId,
  filename,
  updatedAt,
  editable,
  autoFocus = false,
  onMoveToBody,
}: MemoDocumentHeaderProps) {
  const language = useUserSettingsStore((state) => state.settings.language);

  return (
    <div className="memo-document-header">
      {updatedAt && (
        <div className="memo-date-line">
          {formatDocumentDateTime(updatedAt, language)}
        </div>
      )}
      <MemoTitleEditor
        memoId={memoId}
        filename={filename}
        editable={editable}
        autoFocus={autoFocus}
        onMoveToBody={onMoveToBody}
      />
    </div>
  );
}
