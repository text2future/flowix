import { getSessionId } from '../store/workspace-session-store';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { requireFileDisplayIdentity } from '@/lib/file-display-registry';
import { useWorkspaceSessionStore } from '../store/workspace-session-store';
import { ensureFileDisplayTrackingStarted } from './file-display-tracking';

beforeEach(() => {
  useWorkspaceSessionStore.getState().reset();
  ensureFileDisplayTrackingStarted();
});
afterEach(() => useWorkspaceSessionStore.getState().reset());

it('retains a primary file-browser identity through layout updates and container swaps', () => {
  const path = '/Users/rop/Desktop/vibe/flowix-main/.build/Flowix.dmg';
  const store = useWorkspaceSessionStore.getState();
  store.commitTarget(getSessionId(0), {
    kind: 'file-browser', activeFilePath: path, scopePath: '/Users/rop/Desktop/vibe/flowix-main',
    folderPath: null, notebookId: null, fileTreeVisible: true, fileTreeWidth: 220,
  });
  const identity = requireFileDisplayIdentity(path);
  store.setBrowserLayout({ visible: true });
  expect(requireFileDisplayIdentity(path)).toEqual(identity);
});
