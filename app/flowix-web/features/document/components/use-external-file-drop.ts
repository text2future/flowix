import { useEffect, useRef, useState } from 'react';
import { getCurrentWebview, getCurrentWindow } from '@platform/tauri/window';
import { onceUnlisten } from '@platform/tauri/event-bus';
import {
  normalizeTauriDropPosition,
  type NativeDropPosition,
} from '@platform/tauri/drag-drop-position';

export const EXTERNAL_FILE_DROP_EVENT = 'flowix:external-file-drop';
export const EXTERNAL_FILE_DROP_TARGET_SELECTOR = '[data-notebook-external-drop-target="true"]';

export interface ExternalFileDropDetail {
  type: 'enter' | 'over' | 'drop' | 'leave';
  paths: string[];
}

type WorkspaceHost = 'main-third' | 'browser-column';

interface ResolvedDropLocation {
  hit: Element | null;
  notebookTarget: HTMLElement | null;
  workspaceHost: WorkspaceHost | null;
}

interface UseExternalFileDropOptions {
  onDropPaths: (paths: string[], destination?: WorkspaceHost) => void | Promise<void>;
  onDropError?: (error: unknown) => void;
}

export function useExternalFileDrop({
  onDropPaths,
  onDropError,
}: UseExternalFileDropOptions) {
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [draggingDestination, setDraggingDestination] = useState<WorkspaceHost | null>(null);
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
      target.dispatchEvent(new CustomEvent<ExternalFileDropDetail>(EXTERNAL_FILE_DROP_EVENT, {
        bubbles: true,
        detail: { type: 'leave', paths: draggedPathsRef.current },
      }));
      routedTargetRef.current = null;
    };
    const resolveDropLocation = (position: NativeDropPosition | null | undefined): ResolvedDropLocation => {
      const clientPosition = position
        ? normalizeTauriDropPosition(position, dropScaleFactorRef.current)
        : null;
      const hit = clientPosition && typeof document.elementFromPoint === 'function'
        ? document.elementFromPoint(clientPosition.x, clientPosition.y)
        : null;
      const notebookTarget = hit?.closest<HTMLElement>(EXTERNAL_FILE_DROP_TARGET_SELECTOR) ?? null;
      const host = hit?.closest<HTMLElement>('[data-workspace-host]')?.dataset.workspaceHost;
      const workspaceHost: WorkspaceHost | null = host === 'main-third' || host === 'browser-column' ? host : null;
      return { hit, notebookTarget, workspaceHost };
    };
    const dispatchToTarget = (
      type: ExternalFileDropDetail['type'],
      paths: string[],
      location: ResolvedDropLocation,
    ): boolean => {
      const { hit, notebookTarget: target } = location;
      if (!hit || !target) {
        clearRoutedTarget();
        return false;
      }
      if (routedTargetRef.current && routedTargetRef.current !== target) {
        routedTargetRef.current.dispatchEvent(new CustomEvent<ExternalFileDropDetail>(EXTERNAL_FILE_DROP_EVENT, {
          bubbles: true,
          detail: { type: 'leave', paths },
        }));
      }
      routedTargetRef.current = target;
      hit.dispatchEvent(new CustomEvent<ExternalFileDropDetail>(EXTERNAL_FILE_DROP_EVENT, {
        bubbles: true,
        detail: { type, paths },
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
        const location = resolveDropLocation(event.payload.position);
        if (draggedPathsRef.current.length > 0 && dispatchToTarget('enter', draggedPathsRef.current, location)) {
          setIsDraggingFile(false);
          setDraggingDestination(null);
          return;
        }
        clearRoutedTarget();
        const destination = location.workspaceHost;
        setDraggingDestination(destination);
        setIsDraggingFile(Boolean(destination && draggedPathsRef.current.length));
        return;
      }

      if (type === 'over') {
        const location = resolveDropLocation(event.payload.position);
        if (draggedPathsRef.current.length > 0 && dispatchToTarget('over', draggedPathsRef.current, location)) {
          setIsDraggingFile(false);
          setDraggingDestination(null);
          return;
        }
        clearRoutedTarget();
        const destination = location.workspaceHost;
        setDraggingDestination(destination);
        setIsDraggingFile(Boolean(destination && draggedPathsRef.current.length));
        return;
      }

      if (type === 'leave') {
        clearRoutedTarget();
        draggedPathsRef.current = [];
        setIsDraggingFile(false);
        setDraggingDestination(null);
        return;
      }

      const paths = Array.isArray(event.payload.paths)
        ? event.payload.paths
        : draggedPathsRef.current;
      const location = resolveDropLocation(event.payload.position);
      if (paths.length > 0 && dispatchToTarget('drop', paths, location)) {
        routedTargetRef.current = null;
        setIsDraggingFile(false);
        setDraggingDestination(null);
        draggedPathsRef.current = [];
        return;
      }

      clearRoutedTarget();
      setIsDraggingFile(false);
      setDraggingDestination(null);
      draggedPathsRef.current = [];
      if (paths.length === 0) return;
      const destination = location.workspaceHost ?? undefined;
      if (!destination) return;
      const requestId = ++dropRequestRef.current;
      const dropResult = onDropPathsRef.current(paths, destination);
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

  return { isDraggingFile, draggingDestination };
}
