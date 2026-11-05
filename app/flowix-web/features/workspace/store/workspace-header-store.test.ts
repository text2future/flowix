import { expect, it } from 'vitest';
import {
  reportWorkspaceHeaderFullscreen, clearWorkspaceHeaderFullscreen, getWorkspaceHeaderFullscreen,
  reportWorkspaceHeaderScrolled, clearWorkspaceHeaderScrolled, getWorkspaceHeaderScrolled,
} from './workspace-header-store';

it('isolates the two hosts and rejects cleanup from a replaced fullscreen/scroll owner', () => {
  const first = {}, replacement = {}, browser = {};
  const info = { title: 'First', instanceId: 'one', threadId: null, typeKey: 'codex' as const };
  try {
    reportWorkspaceHeaderFullscreen('column-1', first, info);
    reportWorkspaceHeaderFullscreen('column-2', browser, { ...info, title: 'Browser' });
    reportWorkspaceHeaderFullscreen('column-1', replacement, { ...info, title: 'Replacement' });
    clearWorkspaceHeaderFullscreen('column-1', first);
    expect(getWorkspaceHeaderFullscreen('column-1')?.title).toBe('Replacement');
    expect(getWorkspaceHeaderFullscreen('column-2')?.title).toBe('Browser');
    reportWorkspaceHeaderScrolled('column-1', first, true);
    expect(getWorkspaceHeaderScrolled('column-2')).toBe(false);
    reportWorkspaceHeaderScrolled('column-1', replacement, true);
    clearWorkspaceHeaderScrolled('column-1', first);
    expect(getWorkspaceHeaderScrolled('column-1')).toBe(true);
    clearWorkspaceHeaderScrolled('column-1', replacement);
    clearWorkspaceHeaderFullscreen('column-1', replacement);
    expect(getWorkspaceHeaderScrolled('column-1')).toBe(false);
    expect(getWorkspaceHeaderFullscreen('column-1')).toBeNull();
    expect(getWorkspaceHeaderFullscreen('column-2')?.title).toBe('Browser');
  } finally {
    clearWorkspaceHeaderFullscreen('column-1', replacement);
    clearWorkspaceHeaderFullscreen('column-2', browser);
    clearWorkspaceHeaderScrolled('column-1', replacement);
  }
});
