import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { memos as memosClient } from '../../../lib/tauri/client';
import type { MemoItem } from '../../../lib/store';

const EXTERNAL_MARKDOWN_OPENED_EVENT = 'external-markdown-opened';
const MARKDOWN_EXTENSION_PATTERN = /\.(md|markdown)$/i;

function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSION_PATTERN.test(path);
}

function firstMarkdownPath(paths?: string[]): string | undefined {
  return paths?.find(isMarkdownPath);
}

interface UseExternalDocumentOpenOptions {
  openExternalDocumentSession: (path: string) => Promise<void>;
  setSelectedMemo: (memo: MemoItem | null) => void;
}

export function useExternalDocumentOpen({
  openExternalDocumentSession,
  setSelectedMemo,
}: UseExternalDocumentOpenOptions) {
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const isInternalHtml5DragRef = useRef(false);

  const openExternalDocument = useCallback(async (path: string | undefined) => {
    if (!path || !isMarkdownPath(path)) return;
    // Keep this ordering: document store must commit the external source before
    // selectedMemo becomes null, otherwise MemoList's selectedMemo effect can
    // clear the document before the external session lands.
    await openExternalDocumentSession(path);
    setSelectedMemo(null);
  }, [openExternalDocumentSession, setSelectedMemo]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    memosClient.getLaunchOpenFiles()
      .then((paths) => {
        const path = firstMarkdownPath(paths);
        if (!disposed && path) {
          openExternalDocument(path);
        }
      })
      .catch((error) => console.warn('[useExternalDocumentOpen] Failed to read launch files:', error));

    listen<string[]>(EXTERNAL_MARKDOWN_OPENED_EVENT, (event) => {
      openExternalDocument(firstMarkdownPath(event.payload));
    }).then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openExternalDocument]);

  useEffect(() => {
    const onHtmlDragStart = () => {
      isInternalHtml5DragRef.current = true;
    };
    const onHtmlDragEnd = () => {
      isInternalHtml5DragRef.current = false;
    };
    document.addEventListener('dragstart', onHtmlDragStart);
    document.addEventListener('dragend', onHtmlDragEnd);
    document.addEventListener('drop', onHtmlDragEnd);
    return () => {
      document.removeEventListener('dragstart', onHtmlDragStart);
      document.removeEventListener('dragend', onHtmlDragEnd);
      document.removeEventListener('drop', onHtmlDragEnd);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    getCurrentWindow().onDragDropEvent((event) => {
      if (isInternalHtml5DragRef.current) {
        return;
      }

      const { type } = event.payload;
      if (type === 'enter' || type === 'over') {
        if (type === 'enter') {
          setIsDraggingFiles(true);
        }
        return;
      }
      if (type === 'leave' || type === 'drop') {
        setIsDraggingFiles(false);
      }
      if (type !== 'drop') return;

      const { paths } = event.payload;
      if (!paths || paths.length === 0) return;
      openExternalDocument(firstMarkdownPath(paths));
    }).then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlisten = fn;
      }
    }).catch((error) => {
      console.warn('[useExternalDocumentOpen] Failed to listen for file drops:', error);
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openExternalDocument]);

  return {
    isDraggingFiles,
    openExternalDocument,
  };
}
