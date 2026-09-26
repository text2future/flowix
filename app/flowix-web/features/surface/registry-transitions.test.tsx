import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDocumentStore } from '@features/document/store/document-store';
import { WorkColumnSurfaceHost } from './registry';
import type { WorkColumnSurface } from './types';

vi.mock('@features/document/components/document-container', () => ({
  DocumentContainer: () => <div>document reader</div>,
  UnavailableFileView: ({ filePath, openContainingFolder }: {
    filePath: string;
    openContainingFolder?: boolean;
  }) => <div data-file-path={filePath} data-open-folder={String(Boolean(openContainingFolder))}>unavailable</div>,
}));
vi.mock('./media-resource-view', () => ({ MediaResourceView: () => <div>media loading</div> }));
vi.mock('./html-resource-view', () => ({ HtmlResourceView: () => <div>html reader</div> }));
vi.mock('./work-file-browser-view', () => ({ CodeSurfaceFileBrowser: () => <div>code reader</div> }));
vi.mock('@shared/ui/surface-suspense-host', () => ({
  SurfaceSuspenseHost: ({ children }: { children: ReactNode }) => children,
}));

const initialDocumentState = useDocumentStore.getState();

afterEach(() => {
  useDocumentStore.setState(initialDocumentState, true);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

function externalSurface(
  kind: 'image-file' | 'video-file' | 'unavailable-file',
  transitionId: number,
): WorkColumnSurface {
  const filePath = kind === 'image-file' ? '/notebook/photo.png'
    : kind === 'video-file' ? '/notebook/movie.mp4' : '/notebook/report.pdf';
  const base = {
    instanceKey: `${kind}:${filePath}`,
    filePath,
    props: { filePath, isExternalDocument: true as const, transitionId },
  };
  switch (kind) {
    case 'unavailable-file': return { ...base, kind };
    case 'image-file': return { ...base, kind, scopePath: '/notebook' };
    case 'video-file': return { ...base, kind, scopePath: '/notebook' };
  }
}

function contentSurface(kind: 'note' | 'md' | 'code' | 'html-file', transitionId: number): WorkColumnSurface {
  const filePath = kind === 'html-file' ? '/notebook/index.html' : '/notebook/readme.md';
  const base = { instanceKey: `${kind}:${filePath}`, filePath };
  switch (kind) {
    case 'note': return {
      ...base, kind, memoId: 'memo-1',
      props: { filePath, transitionId },
    };
    case 'md': return {
      ...base, kind,
      props: { filePath, isExternalDocument: true, transitionId },
    };
    case 'code': return {
      ...base, kind,
      props: { filePath, isExternalDocument: true, transitionId },
    };
    case 'html-file': return {
      ...base, kind, scopePath: '/notebook',
      props: { filePath, isExternalDocument: true, transitionId },
    };
  }
}

describe('work column external-file transition completion', () => {
  it.each(['image-file', 'video-file', 'unavailable-file'] as const)(
    'ends the active transition when %s mounts',
    async (kind) => {
      (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      useDocumentStore.setState({ documentTransitionId: 12, isDocumentTransitioning: true });
      const element = document.createElement('div');
      const root = createRoot(element);
      try {
        await act(async () => root.render(<WorkColumnSurfaceHost surface={externalSurface(kind, 12)} />));
        expect(useDocumentStore.getState().isDocumentTransitioning).toBe(false);
        if (kind === 'unavailable-file') {
          expect(element.querySelector('[data-file-path]')?.getAttribute('data-file-path')).toBe('/notebook/report.pdf');
          expect(element.querySelector('[data-open-folder]')?.getAttribute('data-open-folder')).toBe('false');
        }
      } finally {
        await act(async () => root.unmount());
      }
    },
  );

  it('does not end a newer transition from an older surface', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useDocumentStore.setState({ documentTransitionId: 14, isDocumentTransitioning: true });
    const root = createRoot(document.createElement('div'));
    try {
      await act(async () => root.render(<WorkColumnSurfaceHost surface={externalSurface('unavailable-file', 13)} />));
      expect(useDocumentStore.getState().isDocumentTransitioning).toBe(true);
      await act(async () => root.render(<WorkColumnSurfaceHost surface={externalSurface('unavailable-file', 14)} />));
      expect(useDocumentStore.getState().isDocumentTransitioning).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each(['note', 'md', 'code', 'html-file'] as const)(
    'leaves the %s transition active while its content reader is mounted',
    async (kind) => {
      (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      useDocumentStore.setState({ documentTransitionId: 20, isDocumentTransitioning: true });
      const root = createRoot(document.createElement('div'));
      try {
        await act(async () => root.render(<WorkColumnSurfaceHost surface={contentSurface(kind, 20)} />));
        expect(useDocumentStore.getState().isDocumentTransitioning).toBe(true);
      } finally {
        await act(async () => root.unmount());
      }
    },
  );
});
