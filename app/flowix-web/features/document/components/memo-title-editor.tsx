import { useCallback, useLayoutEffect, useRef } from 'react';

import { useI18n } from '@/lib/i18n';
import { useMemoTitleSession } from './memo-title-session';

interface MemoTitleEditorProps {
  memoId: string;
  filename: string;
  editable: boolean;
  autoFocus?: boolean;
  onMoveToBody: () => void;
}

export function MemoTitleEditor({
  memoId,
  filename,
  editable,
  autoFocus = false,
  onMoveToBody,
}: MemoTitleEditorProps) {
  const { t } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const session = useMemoTitleSession(memoId, filename);
  const { snapshot } = session;

  const resizeTextarea = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = '0px';
    element.style.height = `${element.scrollHeight}px`;
  }, []);

  useLayoutEffect(() => {
    resizeTextarea();
  }, [resizeTextarea, snapshot.draft]);

  useLayoutEffect(() => {
    const element = textareaRef.current;
    const widthRoot = element?.parentElement;
    if (!element || !widthRoot) return;

    let frame: number | null = null;
    const scheduleResize = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        resizeTextarea();
      });
    };

    // A narrower document column can wrap the same title onto additional
    // lines without changing the title draft. Observe the title shell so the
    // textarea is remeasured after the new width has been laid out.
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleResize);
    observer?.observe(widthRoot);
    window.addEventListener('resize', scheduleResize);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', scheduleResize);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [resizeTextarea]);

  useLayoutEffect(() => {
    if (!autoFocus || !editable) return;
    const element = textareaRef.current;
    if (!element) return;
    element.focus();
    element.select();
  }, [autoFocus, editable, memoId]);

  return (
    <div className="memo-title-shell">
      <textarea
        ref={textareaRef}
        rows={1}
        value={snapshot.draft}
        readOnly={!editable}
        aria-label={t('memo.untitled')}
        placeholder={t('memo.untitled')}
        data-saving={snapshot.saving || undefined}
        className="memo-title-editor"
        onChange={(event) => session.setDraft(event.target.value.replace(/[\r\n]+/g, ' '))}
        onBlur={() => void session.commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void session.commit().then(onMoveToBody);
          } else if (event.key === 'Escape') {
            session.cancel();
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}
