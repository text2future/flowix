import type { Editor } from '@tiptap/core';
import { useCallback, useRef, type MutableRefObject } from 'react';
import { createLogger } from '@/lib/logger';
import { perfMark } from '@/lib/perf-probe';

const persistenceLog = createLogger('document:editor');

/** Quiet period before a full-document serialization is attempted. */
export const SERIALIZE_DEBOUNCE_MS = 200;
/** Fallback for `requestIdleCallback` on a busy main thread. */
export const SERIALIZE_IDLE_TIMEOUT_MS = 500;
const SLOW_SERIALIZATION_MS = 50;

export interface DeferredSerializationOptions {
  editorRef: MutableRefObject<Editor | null>;
  /** Last content handed to the document buffer; updated after each flush. */
  contentRef: MutableRefObject<string>;
  isComposingRef: MutableRefObject<boolean>;
  onChangeRef: MutableRefObject<((markdown: string) => void) | undefined>;
  /** Present when the host persists through its own dirty clock instead. */
  onDirtyRef: MutableRefObject<(() => void) | undefined>;
}

export interface DeferredSerialization {
  /** True while edits exist that no flush has captured yet. */
  pendingDirtyRef: MutableRefObject<boolean>;
  clearTimer: () => void;
  /**
   * Serialize the document if it is dirty and not composing. Returns the new
   * markdown, or null when nothing was written.
   */
  flush: (options?: { force?: boolean }) => string | null;
  /** Mark the document dirty and schedule a debounced flush. */
  schedule: () => void;
}

type IdleWindow = Window & {
  requestIdleCallback?: (
    callback: (deadline: IdleDeadline) => void,
    options?: { timeout: number },
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/**
 * Serialization policy for `MarkdownEditor`, kept out of the component.
 *
 * The rules are easy to get wrong and were each added for a reported bug:
 * - typing only marks the document dirty, so continuous input never starts a
 *   full serialization (only the latest content is observable downstream);
 * - the flush waits for a quiet period and then for an idle frame, with a
 *   timeout so a busy main thread still persists;
 * - IME composition suppresses the flush, because the document mid-composition
 *   is not valid Markdown;
 * - the flush is skipped when the serialized text already equals the buffer
 *   content, which happens after external updates and image uploads.
 */
export function useDeferredMarkdownSerialization({
  editorRef,
  contentRef,
  isComposingRef,
  onChangeRef,
  onDirtyRef,
}: DeferredSerializationOptions): DeferredSerialization {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleCallbackRef = useRef<number | null>(null);
  const pendingDirtyRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (idleCallbackRef.current !== null) {
      (window as IdleWindow).cancelIdleCallback?.(idleCallbackRef.current);
      idleCallbackRef.current = null;
    }
  }, []);

  const flush = useCallback((options?: { force?: boolean }): string | null => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed || !pendingDirtyRef.current) {
      return null;
    }

    const viewState = editor.view as typeof editor.view & { composing?: boolean };
    if (!options?.force && (isComposingRef.current || viewState.composing)) {
      return null;
    }

    clearTimer();
    pendingDirtyRef.current = false;

    const serializationStarted = performance.now();
    const markdown = editor.getMarkdown();
    const serializationMs = performance.now() - serializationStarted;
    if (serializationMs > SLOW_SERIALIZATION_MS) {
      persistenceLog.info('slow serialization', {
        elapsedMs: serializationMs,
        characters: markdown.length,
      });
    }
    perfMark('editor-serialize-ms', serializationMs, { chars: markdown.length });
    if (markdown === contentRef.current) {
      return null;
    }

    contentRef.current = markdown;
    onChangeRef.current?.(markdown);
    return markdown;
  }, [clearTimer, contentRef, editorRef, isComposingRef, onChangeRef]);

  const schedule = useCallback(() => {
    if (onDirtyRef.current) {
      onDirtyRef.current();
      return;
    }
    clearTimer();
    const editor = editorRef.current;
    const viewState = editor?.view as (Editor['view'] & { composing?: boolean }) | undefined;
    if (isComposingRef.current || viewState?.composing) {
      timerRef.current = null;
      return;
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const idleWindow = window as IdleWindow;
      if (!idleWindow.requestIdleCallback) {
        flush();
        return;
      }
      idleCallbackRef.current = idleWindow.requestIdleCallback(() => {
        idleCallbackRef.current = null;
        flush();
      }, { timeout: SERIALIZE_IDLE_TIMEOUT_MS });
    }, SERIALIZE_DEBOUNCE_MS);
  }, [clearTimer, editorRef, flush, isComposingRef, onDirtyRef]);

  return { pendingDirtyRef, clearTimer, flush, schedule };
}
