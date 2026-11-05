import { describe, expect, it, vi } from 'vitest';
import { getWorkspaceSurfaceLifecycle, registerWorkspaceSurfaceLifecycle, registerWorkspaceColumnIdView, getWorkspaceHostSurfaceLifecycle } from './surface-lifecycle-store';

describe('surface lifecycle ownership', () => {
  it('keeps the replacement editor when an old editor releases its registration', () => {
    const oldOwner = {};
    const newOwner = {};
    const disposeOld = vi.fn();
    const replacement = { status: 'ready' as const, flush: vi.fn().mockResolvedValue(true) };
    registerWorkspaceSurfaceLifecycle('replacement-view', { status: 'ready', dispose: disposeOld }, oldOwner);
    registerWorkspaceSurfaceLifecycle('replacement-view', replacement, newOwner);
    registerWorkspaceSurfaceLifecycle('replacement-view', null, oldOwner);
    expect(getWorkspaceSurfaceLifecycle('replacement-view')).toBe(replacement);
    expect(disposeOld).toHaveBeenCalledOnce();
    registerWorkspaceSurfaceLifecycle('replacement-view', null, newOwner);
    expect(getWorkspaceSurfaceLifecycle('replacement-view')).toBeNull();
  });

  it('keeps independent Work and Browser lifecycles for the same content', () => {
    const owner = {};
    const work = { status: 'ready' as const, flush: vi.fn().mockResolvedValue(true) };
    const browser = { status: 'ready' as const, flush: vi.fn().mockResolvedValue(false) };
    registerWorkspaceSurfaceLifecycle('work:content', work, owner);
    registerWorkspaceSurfaceLifecycle('browser:content', browser, owner);
    registerWorkspaceSurfaceLifecycle('work:content', null, owner);
    expect(getWorkspaceSurfaceLifecycle('browser:content')).toBe(browser);
    registerWorkspaceSurfaceLifecycle('browser:content', null, owner);
  });
});

it('keeps the mounted host view when the old view cleans up after a replacement', () => {
  const old = registerWorkspaceColumnIdView('column-1', 'old-view');
  const current = registerWorkspaceColumnIdView('column-1', 'current-view');
  const lifecycle = { status: 'ready' as const, flush: vi.fn().mockResolvedValue(true) };
  registerWorkspaceSurfaceLifecycle('current-view', lifecycle);
  old();
  expect(getWorkspaceHostSurfaceLifecycle('column-1')).toBe(lifecycle);
  current();
  expect(getWorkspaceHostSurfaceLifecycle('column-1')).toBeNull();
  registerWorkspaceSurfaceLifecycle('current-view', null);
});
