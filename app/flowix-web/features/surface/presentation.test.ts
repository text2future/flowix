import { describe, expect, it } from 'vitest';
import type { MemoItem } from '@/types/memo-item';
import type { WorkColumnNavigationState, WorkColumnTarget } from '@features/workspace/store/work-column-target';
import { resolveWorkColumnPresentation } from './presentation';
import type { NoteSurface } from './types';

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

function memo(): MemoItem {
  return {
    id: 'memo-1',
    filename: 'note.md',
    preview: '',
    tags: [],
    todos: [],
    agents: [],
    createdAt: 0,
    updatedAt: 0,
    favorited: false,
    icon: null,
    colors: [],
    properties: {},
  };
}

function note(): NoteSurface {
  return {
    kind: 'note',
    memoId: 'memo-1',
    instanceKey: 'memo:memo-1',
    props: {
      filePath: '/notebook/note.md',
      notebookId: 'notebook-1',
      notebookPath: '/notebook',
      transitionId: null,
      isExternalDocument: false,
    },
  };
}

describe('work column presentation', () => {
  it('derives document header data and capabilities from the resolved surface', () => {
    const presentation = resolveWorkColumnPresentation({
      navigation: navigation({
        kind: 'memo',
        memoId: 'memo-1',
        path: '/notebook/note.md',
        notebookId: 'notebook-1',
        notebookPath: '/notebook',
        transitionId: null,
      }),
      document: {
        identity: {
          kind: 'memo',
          memoId: 'memo-1',
          path: '/notebook/note.md',
          notebookId: 'notebook-1',
          notebookPath: '/notebook',
          transitionId: null,
        },
        memo: memo(),
        surface: note(),
      },
      emptyMessage: 'Select a note',
    });

    expect(presentation.header).toEqual({
      kind: 'document',
      document: {
        currentMemo: memo(),
        externalFilePath: null,
      },
    });
    expect(presentation.content).toEqual({ status: 'surface', surface: markdown() });
    expect(presentation.capabilities).toContain('edit');
  });

  it('preserves the empty reason and uses the document header for the empty surface', () => {
    const presentation = resolveWorkColumnPresentation({
      navigation: navigation({ kind: 'empty' }),
      emptyMessage: 'Select a note',
    });

    expect(presentation.header).toEqual({
      kind: 'document',
      document: { currentMemo: null, externalFilePath: null },
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
