import { expect, it } from 'vitest';
import {
  reportWorkspaceHeaderFullscreen, clearWorkspaceHeaderFullscreen, getWorkspaceHeaderFullscreen,
  reportWorkspaceHeaderScrolled, clearWorkspaceHeaderScrolled, getWorkspaceHeaderScrolled,
} from './workspace-header-store';

it('isolates the two hosts and rejects cleanup from a replaced fullscreen/scroll owner', () => {
  const first = {}, replacement = {}, browser = {};
  const info = { title: 'First', instanceId: 'one', threadId: null, typeKey: 'codex' as const };
  try {
    reportWorkspaceHeaderFullscreen('main-third', first, info);
    reportWorkspaceHeaderFullscreen('browser-column', browser, { ...info, title: 'Browser' });
    reportWorkspaceHeaderFullscreen('main-third', replacement, { ...info, title: 'Replacement' });
    clearWorkspaceHeaderFullscreen('main-third', first);
    expect(getWorkspaceHeaderFullscreen('main-third')?.title).toBe('Replacement');
    expect(getWorkspaceHeaderFullscreen('browser-column')?.title).toBe('Browser');
    reportWorkspaceHeaderScrolled('main-third', first, true);
    expect(getWorkspaceHeaderScrolled('browser-column')).toBe(false);
    reportWorkspaceHeaderScrolled('main-third', replacement, true);
    clearWorkspaceHeaderScrolled('main-third', first);
    expect(getWorkspaceHeaderScrolled('main-third')).toBe(true);
    clearWorkspaceHeaderScrolled('main-third', replacement);
    clearWorkspaceHeaderFullscreen('main-third', replacement);
    expect(getWorkspaceHeaderScrolled('main-third')).toBe(false);
    expect(getWorkspaceHeaderFullscreen('main-third')).toBeNull();
    expect(getWorkspaceHeaderFullscreen('browser-column')?.title).toBe('Browser');
  } finally {
    clearWorkspaceHeaderFullscreen('main-third', replacement);
    clearWorkspaceHeaderFullscreen('browser-column', browser);
    clearWorkspaceHeaderScrolled('main-third', replacement);
  }
});
