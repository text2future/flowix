import { afterEach, describe, expect, it } from 'vitest';

import {
  documentEditorViewKey,
  getDocumentEditorMode,
  setDocumentEditorMode,
  useDocumentEditorViewStore,
} from './document-editor-view-store';

const memoIdentity = { kind: 'md' as const, path: '/memo-1.md', displayId: 'display-1' };

describe('document editor view store', () => {
  afterEach(() => {
    useDocumentEditorViewStore.getState().reset();
  });

  it('defaults every document host to rich mode', () => {
    expect(getDocumentEditorMode('column-1', memoIdentity)).toBe('rich');
  });

  it('keeps modes isolated by host and document identity', () => {
    setDocumentEditorMode('column-1', memoIdentity, 'source');

    expect(getDocumentEditorMode('column-1', memoIdentity)).toBe('source');
    expect(getDocumentEditorMode('column-2', memoIdentity)).toBe('rich');
    expect(getDocumentEditorMode('column-1', { kind: 'md', path: '/memo-2.md', displayId: 'display-2' })).toBe('rich');
  });

  it('uses stable keys for equivalent identity objects', () => {
    expect(documentEditorViewKey('column-1', memoIdentity)).toBe('column-1:md:display-1');
    expect(documentEditorViewKey('column-1', { ...memoIdentity })).toBe(
      documentEditorViewKey('column-1', memoIdentity),
    );
  });
});
