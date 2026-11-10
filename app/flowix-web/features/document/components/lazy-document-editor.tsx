import { forwardRef, lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';
import type { MarkdownEditorHandle } from '@features/editor/markdown-editor';
import { perfMark } from '@/lib/perf-probe';

type DocumentEditorProps = ComponentProps<
  typeof import('@features/editor/markdown-editor').MarkdownEditor
>;

type MarkdownEditorModule = typeof import('@features/editor/markdown-editor');

/**
 * Who triggered the chunk download. The first caller wins and the duration is
 * reported through `__flowixPerf.dump()`; recording the trigger keeps a
 * preloaded chunk from looking like part of the next document open.
 */
type EditorChunkLoadSource = 'preload' | 'document-open';

let markdownEditorModulePromise: Promise<MarkdownEditorModule> | null = null;

function loadMarkdownEditor(source: EditorChunkLoadSource): Promise<MarkdownEditorModule> {
  if (!markdownEditorModulePromise) {
    const startedAt = performance.now();
    markdownEditorModulePromise = import('@features/editor/markdown-editor')
      .then((module) => {
        perfMark('document-editor:chunk-load', performance.now() - startedAt, { source });
        return module;
      })
      .catch((error) => {
        markdownEditorModulePromise = null;
        throw error;
      });
  }
  return markdownEditorModulePromise;
}

/** Warm the editor chunk without mounting it; safe to call repeatedly. */
export function preloadDocumentEditor(
  source: EditorChunkLoadSource = 'document-open',
): void {
  void loadMarkdownEditor(source).catch(() => {
    // The lazy boundary will retry the import when the editor is rendered.
  });
}

const LazyMarkdownEditor = lazy(() =>
  loadMarkdownEditor('document-open').then((module) => ({
    default: module.MarkdownEditor,
  }))
);

export const LazyDocumentEditor = forwardRef<MarkdownEditorHandle, DocumentEditorProps>(function LazyDocumentEditor(props, ref) {
  return (
    <Suspense fallback={null}>
      <LazyMarkdownEditor {...props} ref={ref} />
    </Suspense>
  );
});
