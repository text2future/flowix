import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

const MARKDOWN_EXTENSION_PATTERN = /\.(md|markdown)$/i;

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSION_PATTERN.test(path);
}

export function firstMarkdownPath(paths?: readonly string[] | null): string | undefined {
  if (!paths) return undefined;
  for (const path of paths) {
    if (isMarkdownPath(path)) return path;
  }
  return undefined;
}

export function markdownPaths(paths?: readonly string[] | null): string[] {
  if (!paths) return [];
  const result: string[] = [];
  for (const path of paths) {
    if (isMarkdownPath(path)) result.push(path);
  }
  return result;
}

interface UseMarkdownFileDropOptions {
  onDropPaths: (paths: string[]) => void | Promise<void>;
  onDropError?: (error: unknown) => void;
}

export function useMarkdownFileDrop({
  onDropPaths,
  onDropError,
}: UseMarkdownFileDropOptions) {
  const [isDraggingMarkdown, setIsDraggingMarkdown] = useState(false);
  const isInternalHtml5DragRef = useRef(false);
  const onDropPathsRef = useRef(onDropPaths);
  const onDropErrorRef = useRef(onDropError);
  const dropRequestRef = useRef(0);

  useEffect(() => {
    onDropPathsRef.current = onDropPaths;
    onDropErrorRef.current = onDropError;
  }, [onDropError, onDropPaths]);

  useEffect(() => {
    const onHtmlDragStart = () => {
      isInternalHtml5DragRef.current = true;
    };
    const resetDrag = () => {
      isInternalHtml5DragRef.current = false;
    };
    const onHtmlDragEnd = resetDrag;
    const onHtmlDrop = resetDrag;
    const onWindowBlur = resetDrag;
    const onPointerCancel = resetDrag;
    document.addEventListener('dragstart', onHtmlDragStart);
    document.addEventListener('dragend', onHtmlDragEnd);
    document.addEventListener('drop', onHtmlDrop);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('dragend', onHtmlDragEnd);
    return () => {
      document.removeEventListener('dragstart', onHtmlDragStart);
      document.removeEventListener('dragend', onHtmlDragEnd);
      document.removeEventListener('drop', onHtmlDrop);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('dragend', onHtmlDragEnd);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    getCurrentWindow().onDragDropEvent((event) => {
      if (disposed || isInternalHtml5DragRef.current) return;

      const { type } = event.payload;
      if (type === 'enter') {
        setIsDraggingMarkdown(Boolean(firstMarkdownPath(event.payload.paths)));
        return;
      }
      if (type === 'over') return;
      if (type === 'leave' || type === 'drop') {
        setIsDraggingMarkdown(false);
      }
      if (type !== 'drop') return;

      const paths = markdownPaths(event.payload.paths);
      if (paths.length === 0) return;
      const requestId = ++dropRequestRef.current;
      void Promise.resolve(onDropPathsRef.current(paths)).catch((error) => {
        if (dropRequestRef.current !== requestId || disposed) return;
        onDropErrorRef.current?.(error);
      });
    }).then((next) => {
      if (disposed) next();
      else unlisten = next;
    }).catch((error) => {
      if (!disposed) onDropErrorRef.current?.(error);
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return { isDraggingMarkdown };
}
