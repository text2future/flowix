import type { Editor } from '@tiptap/core';
import { useLayoutEffect, type MutableRefObject } from 'react';
import type { EditorImageContext } from './editor-image-source';

/** Source URLs are view state; changing document context must not dirty Markdown. */
export function useEditorImageSources(editorRef: MutableRefObject<Editor | null>, context?: EditorImageContext) {
  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed) return;
    editor.storage.image.refreshSources();
    editor.storage.preservedHtmlBlock.refreshSources();
    editor.storage.preservedHtmlInline.refreshSources();
  }, [editorRef, context?.documentPath, context?.scopePath]);
}
