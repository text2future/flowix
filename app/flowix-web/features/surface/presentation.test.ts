import { ensureFileDisplayIdentity } from '@/lib/file-display-registry';
import { collectionIndexPath } from './collection-frame';
import { describe, expect, it } from 'vitest';
import type { WorkColumnNavigationState, WorkColumnTarget } from '@features/workspace/store/work-column-target';
import { workspaceSurfaceContentPresentation } from '@features/workspace/public/surface-api';
import { resolveWorkColumnRuntimePresentation, resolveWorkColumnPresentation } from './presentation';

function navigation(target: WorkColumnTarget): WorkColumnNavigationState {
  return {
    phase: 'committed',
    showWorkColumnLoading: false,
    requestId: 1,
    target,
    pendingTarget: null,
    previousTarget: null,
    failure: null,
    retryToken: null,
  };
}

describe('work column presentation', () => {
  it('preserves notebook actions through Markdown runtime updates and removes them in previews', () => {
    const path = '/notebook/note.md';
    const fileIdentity = { path, displayId: 'display:path-note' };
    const present = (indexable: boolean) => resolveWorkColumnPresentation({
      navigation: navigation({ kind: 'external', path, scopePath: '/notebook', transitionId: null }),
      document: {
        identity: { kind: 'external', fileIdentity, scopePath: '/notebook', indexable, transitionId: null },
        instanceKey: fileIdentity.displayId,
        documentProps: {
          isExternalDocument: true,
          externalScopePath: '/notebook',
          transitionId: null,
        },
      },
      emptyMessage: 'Select a note',
    });
    const initial = present(true);
    const identity = { kind: 'external' as const, fileIdentity, scopePath: '/notebook', indexable: true, transitionId: null };
    const resolve = (runtime = {}) => resolveWorkColumnRuntimePresentation(initial, runtime, identity);
    expect(initial.capabilities).not.toContain('memo-colors');
    expect(resolve().capabilities).toContain('memo-colors');
    expect(resolve(workspaceSurfaceContentPresentation('file-markdown')).capabilities)
      .toEqual(resolve().capabilities);
    for (const kind of ['mindmap', 'plugin-artifact'] as const) {
      const preview = resolve(workspaceSurfaceContentPresentation(kind));
      expect(preview.capabilities).not.toContain('memo-colors');
      expect(preview.capabilities).not.toContain('version-history');
      expect(preview.capabilities).not.toContain('edit');
    }
    expect(resolveWorkColumnRuntimePresentation(initial,
      workspaceSurfaceContentPresentation('file-markdown'), { ...identity, indexable: false },
    ).capabilities).not.toContain('memo-colors');
    expect(resolveWorkColumnRuntimePresentation(initial, {}, null).capabilities).not.toContain('memo-colors');

  });

  it('derives document header data and capabilities from the resolved surface', () => {
    const presentation = resolveWorkColumnPresentation({
      navigation: navigation({
        kind: 'external',
        path: '/notebook/note.md',
        scopePath: '/notebook',
        transitionId: null,
      }),
      document: {
        identity: {
          kind: 'external',
          fileIdentity: { path: '/notebook/note.md', displayId: 'display:note' },
          scopePath: '/notebook',
          indexable: true,
          transitionId: null,
        },
        instanceKey: 'display:note',
        documentProps: {
          isExternalDocument: true,
          externalScopePath: '/notebook',
          transitionId: null,
        },
      },
      emptyMessage: 'Select a note',
    });

    expect(presentation.header).toEqual({
      kind: 'document',
      document: {
        externalFilePath: '/notebook/note.md',
      },
    });
    expect(presentation.content).toMatchObject({ status: 'surface', surface: { kind: 'md' } });
    expect(presentation.contentKind).toBe('file-markdown');
    expect(presentation.capabilities).toContain('edit');
  });

  it.each([
    ['/book/note.md', undefined],
    ['/book/main.ts', undefined],
    ['/book/folder/.index.yaml', 'table'],
  ] as const)('exposes header context for a primary file-browser target: %s', (path, collectionType) => {
    ensureFileDisplayIdentity(path);
    const initial = resolveWorkColumnPresentation({
      navigation: navigation({ kind: 'file-browser', activeFilePath: path, folderPath: '/book',
        scopePath: '/book', notebookId: 'book', fileTreeVisible: true, fileTreeWidth: 220, collectionType }),
      document: null, emptyMessage: 'Empty',
    });
    expect(initial.header).toEqual({ kind: 'document', document: { externalFilePath: path } });
    if (initial.content.status !== 'surface') throw new Error('Expected file-browser surface');
    expect(collectionIndexPath(initial.content.surface)).toBe(collectionType ? path : null);
    if (path.endsWith('.md')) {
      const runtime = resolveWorkColumnRuntimePresentation(initial, workspaceSurfaceContentPresentation('file-markdown'), null);
      expect(runtime.capabilities).toContain('memo-colors');
      expect(runtime.capabilities).toContain('version-history');
    }
  });

  it('preserves the empty reason and uses the document header for the empty surface', () => {
    const presentation = resolveWorkColumnPresentation({
      navigation: navigation({ kind: 'empty' }),
      emptyMessage: 'Select a note',
    });

    expect(presentation.header).toEqual({
      kind: 'document',
      document: { externalFilePath: null },
    });
    expect(presentation.content).toEqual({
      status: 'empty',
      reason: 'no-target',
      message: 'Select a note',
      tone: 'document',
    });
  });

  it('selects the agent header from the surface definition', () => {
    const presentation = resolveWorkColumnPresentation({
      navigation: navigation({ kind: 'agent-conversation', instanceId: 'agent-1' }),
      emptyMessage: 'Select a note',
    });

    expect(presentation.header).toEqual({ kind: 'agent', instanceId: 'agent-1' });
    expect(presentation.capabilities).toEqual(['stream-conversation']);
  });
});
