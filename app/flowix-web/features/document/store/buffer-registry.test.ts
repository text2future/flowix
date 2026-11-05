import { describe, expect, it, vi } from 'vitest';

import {
  applyLoadedDocumentContent,
  discardDocumentDraft,
  getActiveDocumentDraft,
  getDocumentBuffer,
  rebaseActiveDocumentPath,
  recordDocumentEdit,
  hasDocumentUnsavedChanges,
  registerDocumentCapture,
  captureLatestDocumentContent,
} from './document-session-service';
import { subscribeDocumentBufferChanges, releaseDocumentBuffer } from './buffer-registry';
import { getDocumentSession, findDocumentSession } from './document-runtime-session';

describe('document buffer change notifications', () => {
  it('clears the loaded flag when a retained session releases its body', () => {
    const identity = { kind: 'md' as const, path: '/released.md', displayId: 'display-released-body' };
    applyLoadedDocumentContent(identity, identity.path, 'body');
    const runtime = getDocumentSession(identity);
    const capture = { capture: () => null };
    runtime.captures.add(capture);
    releaseDocumentBuffer(identity.displayId);
    expect(runtime.loaded).toBe(false);
    expect(runtime.buffer).toBeUndefined();
    runtime.captures.delete(capture);
    releaseDocumentBuffer(identity.displayId);
    expect(findDocumentSession(identity.displayId)).toBeUndefined();
  });
  it('captures only the requested document host when one is provided', () => {
    const identity = { kind: 'md' as const, path: '/memo-capture-host.md', displayId: 'display-capture-host' };
    const mainCapture = vi.fn(() => '# main');
    const browserCapture = vi.fn(() => '# browser');
    const unregisterMain = registerDocumentCapture(identity, mainCapture, 'column-1');
    const unregisterBrowser = registerDocumentCapture(identity, browserCapture, 'column-2');

    try {
      captureLatestDocumentContent(identity, 'column-1');
      expect(mainCapture).toHaveBeenCalledOnce();
      expect(browserCapture).not.toHaveBeenCalled();

      captureLatestDocumentContent(identity);
      expect(mainCapture).toHaveBeenCalledTimes(2);
      expect(browserCapture).toHaveBeenCalledOnce();
    } finally {
      unregisterMain();
      unregisterBrowser();
    }
  });

  it('notifies listeners when a memo is loaded and edited', () => {
    const identity = { kind: 'md' as const, path: '/memo-buffer-events.md', displayId: 'display-buffer-events' };
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
    const identity = { kind: 'md' as const, path: '/memo-buffer-unsubscribe.md', displayId: 'display-buffer-unsubscribe' };
    const listener = vi.fn();
    const unsubscribe = subscribeDocumentBufferChanges(listener);
    unsubscribe();

    recordDocumentEdit(identity, 'ignored edit');

    expect(listener).not.toHaveBeenCalled();
  });

  it('rebases a renamed memo path without changing the unsaved content baseline', () => {
    const identity = { kind: 'md' as const, path: '/before.md', displayId: 'display-path-rebase' };
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
    const identity = { kind: 'md' as const, path: '/memo-missing-source.md', displayId: 'display-missing-source' };
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
