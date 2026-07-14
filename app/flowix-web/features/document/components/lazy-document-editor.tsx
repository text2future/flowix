import { forwardRef, lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';
import type { MarkdownEditorHandle } from '@features/editor/markdown-editor';

type DocumentEditorProps = ComponentProps<
  typeof import('@features/editor/markdown-editor').MarkdownEditor
>;

const LazyMarkdownEditor = lazy(() =>
  import('@features/editor/markdown-editor').then((module) => ({
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
