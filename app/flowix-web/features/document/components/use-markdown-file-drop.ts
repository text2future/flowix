import { useEffect, useRef, useState } from 'react';
import { getCurrentWebview, getCurrentWindow } from '@platform/tauri/window';
import { onceUnlisten } from '@platform/tauri/event-bus';
import { isNotebookResourcePath } from '@features/editor/code-file';

const MARKDOWN_EXTENSION_PATTERN = /\.(md|markdown)$/i;

export const EXTERNAL_FILE_DROP_EVENT = 'flowix:external-file-drop';
export const EXTERNAL_FILE_DROP_TARGET_SELECTOR = '[data-notebook-external-drop-target="true"]';

export interface ExternalDropPosition {
  x: number;
  y: number;
}

export interface ExternalFileDropDetail {
  type: 'enter' | 'over' | 'drop' | 'leave';
  paths: string[];
  position: ExternalDropPosition | null;
}

/** Resolve Tauri's drop position across physical- and logical-pixel WebViews. */
export function elementFromExternalDropPosition(
  position?: ExternalDropPosition | null,
  scaleFactor = window.devicePixelRatio || 1,
): Element | null {
  if (!position || typeof document.elementFromPoint !== 'function') return null;
  return document.elementFromPoint(
    position.x / (scaleFactor || 1),
    position.y / (scaleFactor || 1),
  );
}

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

function notebookResourcePaths(paths: readonly string[]): string[] {
  return paths.filter(isNotebookResourcePath);
}

interface UseMarkdownFileDropOptions {
  onDropPaths: (paths: string[], destination?: 'main-third' | 'browser-column') => void | Promise<void>;
  onDropError?: (error: unknown) => void;
}

export function useMarkdownFileDrop({
  onDropPaths,
  onDropError,
}: UseMarkdownFileDropOptions) {
  const [isDraggingMarkdown, setIsDraggingMarkdown] = useState(false);
  const draggedPathsRef = useRef<string[]>([]);
  const dropScaleFactorRef = useRef(window.devicePixelRatio || 1);
  const routedTargetRef = useRef<HTMLElement | null>(null);
  const onDropPathsRef = useRef(onDropPaths);
  const onDropErrorRef = useRef(onDropError);
  const dropRequestRef = useRef(0);

  useEffect(() => {
    onDropPathsRef.current = onDropPaths;
    onDropErrorRef.current = onDropError;
  }, [onDropError, onDropPaths]);

  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    void getCurrentWindow().scaleFactor().then((factor) => {
      if (Number.isFinite(factor) && factor > 0) dropScaleFactorRef.current = factor;
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const clearRoutedTarget = () => {
      const target = routedTargetRef.current;
      if (!target) return;
      window.dispatchEvent(new CustomEvent<ExternalFileDropDetail>(EXTERNAL_FILE_DROP_EVENT, {
        detail: { type: 'leave', paths: draggedPathsRef.current, position: null },
      }));
      routedTargetRef.current = null;
    };
    const dispatchToTarget = (
      type: ExternalFileDropDetail['type'],
      paths: string[],
      position: ExternalDropPosition | null | undefined,
    ): boolean => {
      const target = elementFromExternalDropPosition(position, dropScaleFactorRef.current)
        ?.closest<HTMLElement>(EXTERNAL_FILE_DROP_TARGET_SELECTOR) ?? null;
      if (!target) {
        clearRoutedTarget();
        return false;
      }
      if (routedTargetRef.current && routedTargetRef.current !== target) {
        window.dispatchEvent(
          new CustomEvent<ExternalFileDropDetail>(EXTERNAL_FILE_DROP_EVENT, {
            detail: { type: 'leave', paths, position: null },
          }),
        );
      }
      routedTargetRef.current = target;
      window.dispatchEvent(new CustomEvent<ExternalFileDropDetail>(EXTERNAL_FILE_DROP_EVENT, {
        detail: { type, paths, position: position ?? null },
      }));
      return true;
    };

    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
      return undefined;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    getCurrentWebview().onDragDropEvent((event) => {
      if (disposed) return;

      const { type } = event.payload;
      if (type === 'enter') {
        draggedPathsRef.current = Array.isArray(event.payload.paths)
          ? event.payload.paths
          : [];
        const acceptedPaths = notebookResourcePaths(draggedPathsRef.current);
        if (acceptedPaths.length > 0 && dispatchToTarget('enter', acceptedPaths, event.payload.position)) {
          setIsDraggingMarkdown(false);
          return;
        }
        clearRoutedTarget();
        setIsDraggingMarkdown(Boolean(firstMarkdownPath(draggedPathsRef.current)));
        return;
      }

      if (type === 'over') {
        const acceptedPaths = notebookResourcePaths(draggedPathsRef.current);
        if (acceptedPaths.length > 0 && dispatchToTarget('over', acceptedPaths, event.payload.position)) {
          setIsDraggingMarkdown(false);
          return;
        }
        clearRoutedTarget();
        setIsDraggingMarkdown(Boolean(firstMarkdownPath(draggedPathsRef.current)));
        return;
      }

      if (type === 'leave') {
        clearRoutedTarget();
        draggedPathsRef.current = [];
        setIsDraggingMarkdown(false);
        return;
      }

      const paths = Array.isArray(event.payload.paths)
        ? event.payload.paths
        : draggedPathsRef.current;
      const acceptedPaths = notebookResourcePaths(paths);
      if (acceptedPaths.length > 0 && dispatchToTarget('drop', acceptedPaths, event.payload.position)) {
        routedTargetRef.current = null;
        setIsDraggingMarkdown(false);
        draggedPathsRef.current = [];
        return;
      }

      clearRoutedTarget();
      setIsDraggingMarkdown(false);
      draggedPathsRef.current = [];
      const markdownOnly = markdownPaths(paths);
      if (markdownOnly.length === 0) return;
      const dropHost = elementFromExternalDropPosition(event.payload.position, dropScaleFactorRef.current)
        ?.closest<HTMLElement>('[data-workspace-host]')
        ?.dataset.workspaceHost;
      const destination = dropHost === 'main-third' || dropHost === 'browser-column'
        ? dropHost
        : undefined;
      const requestId = ++dropRequestRef.current;
      const dropResult = destination === undefined
        ? onDropPathsRef.current(markdownOnly)
        : onDropPathsRef.current(markdownOnly, destination);
      void Promise.resolve(dropResult).catch((error) => {
        if (dropRequestRef.current !== requestId || disposed) return;
        onDropErrorRef.current?.(error);
      });
    }).then((next) => {
      const stop = onceUnlisten(next);
      if (disposed) stop();
      else unlisten = stop;
    }).catch((error) => {
      if (!disposed) onDropErrorRef.current?.(error);
    });

    return () => {
      disposed = true;
      clearRoutedTarget();
      unlisten?.();
    };
  }, []);

  return { isDraggingMarkdown };
}
