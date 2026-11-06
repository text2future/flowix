import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { useDocumentStore } from '@features/document/store/document-store';
import { WorkColumnSurfaceHost } from './registry';
import type { WorkColumnSurface } from './types';

const mockedDocument = vi.hoisted(() => ({ ready: false }));

vi.mock('@features/document/components/document-container', () => ({
  DocumentContainer: ({ onContentStateChange }: { onContentStateChange?: (state: { status: 'ready' }) => void }) => {
    useEffect(() => { if (mockedDocument.ready) onContentStateChange?.({ status: 'ready' }); }, [onContentStateChange]);
    return <div>document reader</div>;
  },
  UnavailableFileView: ({ filePath, openContainingFolder }: {
    filePath: string;
    openContainingFolder?: boolean;
  }) => <div data-file-path={filePath} data-open-folder={String(Boolean(openContainingFolder))}>unavailable</div>,
}));
vi.mock('@features/editor/use-external-file-content-detection', () => ({
  useExternalFileContentDetection: () => ({ isTextContent: false, loading: false }),
}));
vi.mock('./media-resource-view', () => ({ MediaResourceView: () => <div>media loading</div> }));
vi.mock('./html-resource-view', () => ({ HtmlResourceView: () => <div>html reader</div> }));

const initialDocumentState = useDocumentStore.getState();

// The registry resolves every renderer through a lazy import. Cold, that chunk costs
// several seconds under jsdom (collection shell -> agent shell -> agent session store),
// which used to surface as the module-loading time being charged to the 5s per-case
// timeout. Pay it once here so the cases below only measure transition completion.
beforeAll(async () => {
  await import('./workspace-surface-renderers');
}, 120_000);

afterEach(() => {
  mockedDocument.ready = false;
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
    fileIdentity: { path: filePath, displayId: `display:${filePath}` },
    props: { isExternalDocument: true as const, transitionId },
  };
  switch (kind) {
    case 'unavailable-file': return { ...base, kind, scopePath: '/notebook' };
    case 'image-file': return { ...base, kind, scopePath: '/notebook' };
    case 'video-file': return { ...base, kind, scopePath: '/notebook' };
  }
}

function contentSurface(kind: 'md' | 'code' | 'html-file', transitionId: number): WorkColumnSurface {
  const filePath = kind === 'html-file' ? '/notebook/index.html' : '/notebook/readme.md';
  const base = {
    instanceKey: `${kind}:${filePath}`,
    fileIdentity: { path: filePath, displayId: `display:${filePath}` },
  };
  switch (kind) {
    case 'md': return {
      ...base, kind,
      props: { isExternalDocument: true, transitionId },
    };
    case 'code': return {
      ...base, kind,
      props: { isExternalDocument: true, transitionId },
    };
    case 'html-file': return {
      ...base, kind, scopePath: '/notebook',
      props: { isExternalDocument: true, transitionId },
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
          await vi.waitFor(async () => {
            await act(async () => {});
            expect(element.querySelector('[data-file-path]')?.getAttribute('data-file-path')).toBe('/notebook/report.pdf');
          }, { timeout: 5000 });
          expect(element.querySelector('[data-open-folder]')?.getAttribute('data-open-folder')).toBe('true');
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

  it.each(['md', 'code', 'html-file'] as const)(
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

it('finishes the legacy navigation marker when an independent column document reports ready', async () => {
  mockedDocument.ready = true;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useDocumentStore.setState({ documentTransitionId: 31, isDocumentTransitioning: true });
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<WorkColumnSurfaceHost surface={contentSurface('md', 31)} />));
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(useDocumentStore.getState().isDocumentTransitioning).toBe(false);
    }, { timeout: 5000 });
  } finally { await act(async () => root.unmount()); }
});
