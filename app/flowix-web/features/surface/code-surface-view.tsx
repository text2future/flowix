'use client';

import type { ComponentProps } from 'react';
import { DocumentContainer } from '@features/document/components/document-container';
import { FileBrowserView, type FileBrowserViewSurface } from './file-browser-view';

type DocumentProps = ComponentProps<typeof DocumentContainer>;

export type CodeSurfaceFileTree = Omit<FileBrowserViewSurface, 'content'>;

export function CodeSurfaceView({
  props,
  fileTree,
}: {
  props: DocumentProps;
  fileTree: CodeSurfaceFileTree | null;
}) {
  if (!fileTree) return <DocumentContainer {...props} />;

  const documentProps = {
    ...props,
    filePath: fileTree.activeFilePath ?? props.filePath,
    externalScopePath: fileTree.scopePath,
  };
  const content = fileTree.activeFilePath
    ? <DocumentContainer {...documentProps} />
    : undefined;
  return <FileBrowserView surface={{
    ...fileTree,
    content,
  }} />;
}
