import { seedBrowserColumn } from '@features/workspace/test-support/workspace-fixtures';
import { getSessionId } from '../store/workspace-session-store';
import { sessionFor } from '../model/workspace-session';
import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkspaceSessionStore } from '../store/workspace-session-store';
import { canSwapColumnContents, swapColumnContents } from './swap-column-contents';

const web = (name: string) => ({ kind: 'web' as const, url: `https://${name}.example/` });
const sessions = () => ({
  0: sessionFor(useWorkspaceSessionStore.getState(), 0),
  1: sessionFor(useWorkspaceSessionStore.getState(), 1),
});
const currentUrl = (id: 0 | 1) => {
  const current = sessions()[id].navigation.current;
  return current && current.target.kind === 'web' ? current.target.url : null;
};

beforeEach(() => {
  useWorkspaceSessionStore.getState().reset();
  seedBrowserColumn({ visible: true, current: null, backStack: [], forwardStack: [], webRuntime: null });
});

describe('swap column contents', () => {
  it('exchanges what each column shows without moving the columns themselves', () => {
    const store = useWorkspaceSessionStore.getState();
    store.commitTarget(getSessionId(0), web('notes'), { history: 'push' });
    store.commitTarget(getSessionId(1), web('chat'), { history: 'push' });

    expect(swapColumnContents()).toBe(true);

    expect(currentUrl(0)).toBe('https://chat.example/');
    expect(currentUrl(1)).toBe('https://notes.example/');
    expect(sessions()[0].id).toBe('column-2');
    expect(sessions()[1].id).toBe('column-1');
  });

  it('moves the whole navigation state, not just the visible entry', () => {
    const store = useWorkspaceSessionStore.getState();
    store.commitTarget(getSessionId(0), web('a'), { history: 'push' });
    store.commitTarget(getSessionId(0), web('b'), { history: 'push' });
    store.commitTarget(getSessionId(1), web('c'), { history: 'push' });

    swapColumnContents();

    expect(sessions()[1].navigation.backStack).toHaveLength(1);
    expect(sessions()[0].navigation.backStack).toHaveLength(0);
  });

  it('opens the second column and exchanges positions when collapsed', () => {
    const store = useWorkspaceSessionStore.getState();
    store.commitTarget(getSessionId(0), web('notes'), { history: 'push' });
    seedBrowserColumn({ visible: false });

    expect(canSwapColumnContents()).toBe(true);
    expect(swapColumnContents()).toBe(true);
    expect(useWorkspaceSessionStore.getState().browserLayout.visible).toBe(true);
    expect(currentUrl(0)).toBeNull();
    expect(currentUrl(1)).toBe('https://notes.example/');
  });

  it('stays unavailable while either column is switching notebook', () => {
    const store = useWorkspaceSessionStore.getState();
    store.commitTarget(getSessionId(0), web('notes'), { history: 'push' });
    useWorkspaceSessionStore.getState().updateSession(getSessionId(1), (session) => ({
      ...session, notebookSwitchesInFlight: 1,
    }));

    expect(swapColumnContents()).toBe(false);
  });

  it('keeps every destination rule pointing at the same column afterwards', () => {
    const store = useWorkspaceSessionStore.getState();
    store.commitTarget(getSessionId(0), web('old-notes'), { history: 'push' });
    store.commitTarget(getSessionId(1), web('old-chat'), { history: 'push' });
    swapColumnContents();

    useWorkspaceSessionStore.getState().commitTarget(getSessionId(0), web('new-note'), { history: 'push' });

    expect(currentUrl(0)).toBe('https://new-note.example/');
    expect(currentUrl(1)).toBe('https://old-notes.example/');
  });
});
