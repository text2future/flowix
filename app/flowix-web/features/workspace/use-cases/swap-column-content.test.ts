import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserColumnStore } from '../store/browser-column-store';
import { useWorkColumnStore } from '../store/work-column-store';
import { useWorkspaceSessionStore, getSessionRuntimeAtHost } from '../store/workspace-session-store';
import { swapWorkspaceColumnContent } from './swap-column-content';

beforeEach(() => {
  useWorkspaceSessionStore.getState().reset();
  useBrowserColumnStore.getState().reset();
  useBrowserColumnStore.getState().setVisible(true);
  useWorkColumnStore.setState({
    notebookSwitchesInFlight: 0,
    navigation: { ...useWorkColumnStore.getState().navigation, phase: 'committed',
      target: { kind: 'web', url: 'https://work.example/' } },
  });
});

describe('session placement exchange', () => {
  it('atomically exchanges ownership without changing either runtime or its history', async () => {
    const browser = useBrowserColumnStore.getState();
    browser.openContent({ id: 'a', title: 'A', icon: null, target: { kind: 'web', url: 'https://a.example/' } });
    browser.openContent({ id: 'b', title: 'B', icon: null, target: { kind: 'web', url: 'https://b.example/' } });
    const workBefore = useWorkColumnStore.getState();
    const browserBefore = useBrowserColumnStore.getState();
    const transitions = vi.fn();
    const stop = useWorkspaceSessionStore.subscribe(transitions);
    try {
      await expect(swapWorkspaceColumnContent()).resolves.toBe(true);
      expect(getSessionRuntimeAtHost('main-third')).toBe('browser-column');
      expect(getSessionRuntimeAtHost('browser-column')).toBe('main-third');
      expect(useWorkColumnStore.getState()).toBe(workBefore);
      expect(useBrowserColumnStore.getState()).toBe(browserBefore);
      expect(transitions).toHaveBeenCalledTimes(1);
      await swapWorkspaceColumnContent();
      expect(getSessionRuntimeAtHost('main-third')).toBe('main-third');
      expect(useWorkColumnStore.getState()).toBe(workBefore);
      expect(useBrowserColumnStore.getState()).toBe(browserBefore);
    } finally { stop(); }
  });

  it('does not require a common supported target or reopen an empty session', async () => {
    useWorkColumnStore.setState({ navigation: {
      ...useWorkColumnStore.getState().navigation, phase: 'idle', target: { kind: 'empty' },
    } });
    await expect(swapWorkspaceColumnContent()).resolves.toBe(true);
  });

  it('does not exchange a hidden container or a pending navigation', async () => {
    useBrowserColumnStore.getState().setVisible(false);
    await expect(swapWorkspaceColumnContent()).resolves.toBe(false);
    useBrowserColumnStore.getState().setVisible(true);
    useWorkColumnStore.setState({ navigation: { ...useWorkColumnStore.getState().navigation, phase: 'loading' } });
    await expect(swapWorkspaceColumnContent()).resolves.toBe(false);
  });

  it('keeps URL history and forward history owned by the same session', async () => {
    const browser = useBrowserColumnStore.getState();
    browser.openContent({ id: 'a', title: 'A', icon: null, target: { kind: 'web', url: 'https://a.example/' } });
    browser.navigateWeb('a', 'https://b.example/');
    browser.navigateWeb('a', 'https://c.example/');
    browser.goBackWeb('a');
    const runtime = useBrowserColumnStore.getState().webRuntime;
    await swapWorkspaceColumnContent();
    expect(useBrowserColumnStore.getState().webRuntime).toBe(runtime);
    expect(runtime?.history).toEqual(['https://a.example/', 'https://b.example/', 'https://c.example/']);
    expect(runtime?.historyIndex).toBe(1);
  });

  it('rejects a stale placement transaction', () => {
    const revision = useWorkspaceSessionStore.getState().revision;
    expect(useWorkspaceSessionStore.getState().swap(revision)).toBe(true);
    expect(useWorkspaceSessionStore.getState().swap(revision)).toBe(false);
  });
});

it('retains Header view state and geometry-independent session identities across exchange', async () => {
  const store = useWorkspaceSessionStore.getState();
  store.setAddressBarVisible('primary-session', 'web-a', true);
  store.setAddressBarVisible('secondary-session', 'web-b', false);
  const sessions = useWorkspaceSessionStore.getState().sessions;
  await swapWorkspaceColumnContent();
  expect(useWorkspaceSessionStore.getState().sessions).toBe(sessions);
  expect(sessions['primary-session'].headerState['web-a'].addressBarVisible).toBe(true);
  expect(useWorkspaceSessionStore.getState().hosts['browser-column']).toBe('primary-session');
});

it('does not reopen Browser when the session currently in Work navigates its history', async () => {
  const { navigateBrowserColumnHistory } = await import('./browser-column-navigation');
  const runtime = useBrowserColumnStore.getState();
  runtime.openContent({ id: 'a', title: 'A', icon: null, target: { kind: 'web', url: 'https://a.example/' } });
  runtime.openContent({ id: 'b', title: 'B', icon: null, target: { kind: 'web', url: 'https://b.example/' } });
  await swapWorkspaceColumnContent();
  useBrowserColumnStore.getState().setVisible(false);
  await navigateBrowserColumnHistory('back');
  expect(useBrowserColumnStore.getState().current?.target).toEqual({ kind: 'web', url: 'https://a.example/' });
  expect(useBrowserColumnStore.getState().visible).toBe(false);
});
