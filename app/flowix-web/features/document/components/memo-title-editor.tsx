import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef } from 'react';

import { useI18n } from '@/lib/i18n';
import { useMemoTitleSession } from './memo-title-session';

interface MemoTitleEditorProps {
  memoId: string;
  filename: string;
  editable: boolean;
  autoFocus?: boolean;
  onMoveToBody: (request: MemoTitleBodyNavigation) => void;
}

export interface MemoTitleBodyNavigation {
  trailingContent?: string;
  insertEmptyLine: boolean;
}

export interface MemoTitleEditorHandle {
  focusEnd: () => void;
  appendBodyLine: (title: string) => void;
}

export const MemoTitleEditor = forwardRef<MemoTitleEditorHandle, MemoTitleEditorProps>(function MemoTitleEditor({
  memoId,
  filename,
  editable,
  autoFocus = false,
  onMoveToBody,
}: MemoTitleEditorProps, ref) {
  const { t } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const session = useMemoTitleSession(memoId, filename);
  const { snapshot } = session;

  const focusAt = useCallback((position: number) => {
    const element = textareaRef.current;
    if (!element) return;
    element.focus();
    const caret = Math.max(0, Math.min(position, element.value.length));
    element.setSelectionRange(caret, caret);
  }, []);

  const focusEnd = useCallback(() => {
    focusAt(textareaRef.current?.value.length ?? 0);
  }, [focusAt]);

  const appendBodyLine = useCallback((title: string) => {
    const currentTitle = textareaRef.current?.value ?? snapshot.draft;
    const caretPosition = currentTitle.length;
    session.setDraft(`${currentTitle}${title}`);
    void session.commit().then(() => {
      requestAnimationFrame(() => focusAt(caretPosition));
    });
  }, [focusAt, session, snapshot.draft]);

  useImperativeHandle(ref, () => ({
    focusEnd,
    appendBodyLine,
  }), [appendBodyLine, focusEnd]);

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
          if (!editable) return;
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            const value = event.currentTarget.value;
            const selectionStart = event.currentTarget.selectionStart ?? snapshot.draft.length;
            const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
            const nextTitle = value.slice(0, selectionStart);
            const trailingContent = value.slice(selectionEnd);
            session.setDraft(nextTitle);
            void session.commit().then(() => onMoveToBody({
              trailingContent,
              insertEmptyLine: true,
            }));
          } else if (
            event.key === 'ArrowDown'
            && !event.nativeEvent.isComposing
            && event.currentTarget.selectionStart === event.currentTarget.value.length
            && event.currentTarget.selectionEnd === event.currentTarget.value.length
          ) {
            event.preventDefault();
            void session.commit().then(() => onMoveToBody({ insertEmptyLine: false }));
          } else if (event.key === 'Escape') {
            session.cancel();
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
});
