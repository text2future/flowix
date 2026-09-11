import { describe, expect, it, vi } from 'vitest';

import {
  applyLoadedDocumentContent,
  discardDocumentDraft,
  getActiveDocumentDraft,
  getDocumentBuffer,
  rebaseActiveDocumentPath,
  recordDocumentEdit,
  hasDocumentUnsavedChanges,
} from './document-session-service';
import { subscribeDocumentBufferChanges } from './buffer-registry';

describe('document buffer change notifications', () => {
  it('notifies listeners when a memo is loaded and edited', () => {
    const identity = { kind: 'memo' as const, id: 'memo-buffer-events' };
    const listener = vi.fn();
    const unsubscribe = subscribeDocumentBufferChanges(listener);

    try {
      applyLoadedDocumentContent(identity, '/notes/events.md', 'base content');
      recordDocumentEdit(identity, 'local edit');
    } finally {
      unsubscribe();
    }

    expect(listener).toHaveBeenNthCalledWith(1, identity, 'loaded');
    expect(listener).toHaveBeenNthCalledWith(2, identity, 'edited');
  });

  it('stops notifying after unsubscribe', () => {
    const identity = { kind: 'memo' as const, id: 'memo-buffer-unsubscribe' };
    const listener = vi.fn();
    const unsubscribe = subscribeDocumentBufferChanges(listener);
    unsubscribe();

    recordDocumentEdit(identity, 'ignored edit');

    expect(listener).not.toHaveBeenCalled();
  });

  it('rebases a renamed memo path without changing the unsaved content baseline', () => {
    const identity = { kind: 'memo' as const, id: 'memo-path-rebase' };
    applyLoadedDocumentContent(identity, '/notes/old.md', 'saved body');
    recordDocumentEdit(identity, 'unsaved body');

    rebaseActiveDocumentPath(identity, '/notes/new.md');

    expect(getActiveDocumentDraft()).toMatchObject({ path: '/notes/new.md', content: 'unsaved body' });
    expect(getDocumentBuffer(identity)).toMatchObject({
      content: 'unsaved body',
      pendingContent: 'unsaved body',
      lastSavedContent: 'saved body',
    });
  });

  it('clears the dirty barrier when a missing source is explicitly discarded', () => {
    const identity = { kind: 'memo' as const, id: 'memo-missing-source' };
    applyLoadedDocumentContent(identity, '/notes/deleted.md', 'saved body');
    recordDocumentEdit(identity, 'unsaved body');

    discardDocumentDraft(identity);

    expect(hasDocumentUnsavedChanges(identity)).toBe(false);
    expect(getDocumentBuffer(identity)).toMatchObject({
      content: 'unsaved body',
      pendingContent: null,
      lastSavedContent: 'unsaved body',
    });
  });
});
