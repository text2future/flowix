import { lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';

type DocumentEditorProps = ComponentProps<
  typeof import('../../../components/editor/markdown-editor').MarkdownEditor
>;

const LazyMarkdownEditor = lazy(() =>
  import('../../../components/editor/markdown-editor').then((module) => ({
    default: module.MarkdownEditor,
  }))
);

export function LazyDocumentEditor(props: DocumentEditorProps) {
  return (
    <Suspense fallback={null}>
      <LazyMarkdownEditor {...props} />
    </Suspense>
  );
}
