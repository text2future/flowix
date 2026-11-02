import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionViewChannel, attachSessionViewCapture } from '../public/session-view-state-api';
import { restoreViewRecovery, restoreViewSnapshot } from '../model/session-view-state';
import { restoreCanonicalSession } from './session-persistence';
import { useWorkspaceSessionStore } from './workspace-session-store';
import { useSessionWebRuntimeStore } from './session-web-runtime-store';
import { createWorkspaceWebRuntime } from '../model/web-navigation';

const editor = { kind: 'editor' as const, anchor: 7, head: 2, scrollTop: 400, scrollLeft: 12 };
const web = { kind: 'web' as const, url: 'https://example.com/' };
beforeEach(() => { localStorage.clear(); useWorkspaceSessionStore.getState().reset(); });

function open(id: 'primary-session' | 'secondary-session') {
  useWorkspaceSessionStore.getState().commitTarget(id, web, { history: 'push' });
  return useWorkspaceSessionStore.getState().sessions[id].navigation.current!.id;
}

describe('session view recovery protocol', () => {
  it.each(['primary-session', 'secondary-session'] as const)('retains %s state with history and across placement swaps', (id) => {
    const entry = open(id);
    const channel = createSessionViewChannel(id, entry, 'editor');
    channel.write(editor);
    useWorkspaceSessionStore.getState().swap();
    useWorkspaceSessionStore.getState().commitTarget(id, { kind: 'web', url: 'https://next.example/' }, { history: 'push' });
    channel.write({ ...editor, head: 3 }); // unmount flush after the next commit
    expect(channel.read()).toEqual({ ...editor, head: 3 });
    const session = useWorkspaceSessionStore.getState().sessions[id];
    const restored = restoreCanonicalSession(JSON.parse(JSON.stringify(session)), session);
    expect(restored.viewStates[entry].recovery?.slots.editor).toEqual({ ...editor, head: 3 });
    expect(restored.navigation.backStack[0].id).toBe(entry);
  });

  it('isolates sessions and renderer slots', () => {
    const a = open('primary-session'); const b = open('secondary-session');
    createSessionViewChannel('primary-session', a, 'editor').write(editor);
    expect(createSessionViewChannel('secondary-session', b, 'editor').read()).toBeUndefined();
    expect(createSessionViewChannel('primary-session', a, 'other-editor').read()).toBeUndefined();
  });

  it('rejects stale captures after a replacement adapter takes ownership', () => {
    const id = open('primary-session');
    const old = createSessionViewChannel('primary-session', id, 'editor');
    const next = createSessionViewChannel('primary-session', id, 'editor');
    const disposeOld = old.claim(); const disposeNext = next.claim();
    next.write(editor); old.write({ ...editor, head: 99 }); disposeOld();
    expect(next.read()).toEqual(editor);
    next.write({ ...editor, head: 6 });
    expect(next.read()?.kind === 'editor' && next.read()).toEqual({ ...editor, head: 6 });
    disposeNext();
  });

  it('does not resurrect entries after reset', () => {
    const id = open('primary-session');
    const channel = createSessionViewChannel('primary-session', id, 'editor');
    useWorkspaceSessionStore.getState().reset(); channel.write(editor);
    expect(channel.read()).toBeUndefined();
  });

  it('preserves renderer recovery when the legacy web runtime writes', () => {
    const id = open('primary-session');
    const channel = createSessionViewChannel('primary-session', id, 'editor'); channel.write(editor);
    useSessionWebRuntimeStore.getState().setRuntime(id, createWorkspaceWebRuntime(web.url));
    expect(channel.read()).toEqual(editor);
  });

  it('throttles updates and flushes on pagehide and teardown', () => {
    vi.useFakeTimers();
    try {
      const id = open('primary-session'); const channel = createSessionViewChannel('primary-session', id, 'editor');
      let value = editor;
      const readView = vi.fn(() => value);
      const capture = attachSessionViewCapture(channel, readView);
      capture.schedule(); capture.schedule(); expect(channel.read()).toBeUndefined();
      vi.advanceTimersByTime(250); expect(channel.read()).toEqual(editor);
      value = { ...editor, head: 5 }; window.dispatchEvent(new Event('pagehide'));
      expect(channel.read()).toEqual(value);
      value = { ...editor, head: 8 }; capture.schedule(); capture.dispose();
      expect(channel.read()).toEqual(value);
      const calls = readView.mock.calls.length;
      vi.advanceTimersByTime(500); window.dispatchEvent(new Event('pagehide'));
      expect(readView).toHaveBeenCalledTimes(calls);
    } finally { vi.useRealTimers(); }
  });

  it('does not overwrite a snapshot while an async renderer is unready', () => {
    const id = open('primary-session'); const channel = createSessionViewChannel('primary-session', id, 'video');
    const value = { kind: 'media' as const, currentTime: 30, volume: 0.5, muted: true, playbackRate: 1.5 };
    channel.write(value);
    attachSessionViewCapture(channel, () => null).dispose();
    expect(channel.read()).toEqual(value);
  });

  it('validates version, finite ranges and whitelists serialized fields', () => {
    expect(restoreViewRecovery({ version: 99, slots: {} })).toBeUndefined();
    expect(restoreViewSnapshot({ ...editor, anchor: NaN })).toBeNull();
    expect(restoreViewSnapshot({ ...editor, scrollTop: -1 })).toBeNull();
    expect(restoreViewSnapshot({ ...editor, run: () => {} })).toEqual(editor);
    expect(restoreViewSnapshot({ kind: 'media', currentTime: 1, volume: 2, muted: false, playbackRate: 1 })).toBeNull();
    expect(restoreViewRecovery({ version: 1, slots: { valid: editor, bad: { ...editor, head: Infinity } } }))
      .toEqual({ version: 1, slots: { valid: editor } });
  });
});
