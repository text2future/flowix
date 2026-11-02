import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { SessionViewRecoveryContext, createSessionViewChannel, useSessionScrollRecovery } from './session-view-state-api';
import { useWorkspaceSessionStore } from '../store/workspace-session-store';

let root: Root;
let entryId: string;
let element: HTMLDivElement;
let max: number;
let top: number;
function Harness() { useSessionScrollRecovery(element, 'page'); return null; }
beforeEach(() => {
  useWorkspaceSessionStore.getState().reset();
  useWorkspaceSessionStore.getState().commitTarget('primary-session', { kind: 'web', url: 'https://example.com/' });
  entryId = useWorkspaceSessionStore.getState().sessions['primary-session'].navigation.current!.id;
  root = createRoot(document.createElement('div'));
  element = document.createElement('div'); max = 0; top = 0;
  Object.defineProperty(element, 'scrollTop', { get: () => top, set: (value: number) => { top = Math.min(value, max); } });
});
afterEach(async () => { await act(async () => root.unmount()); });
const channel = () => createSessionViewChannel('primary-session', entryId, 'page');
const render = () => act(async () => root.render(<SessionViewRecoveryContext.Provider value={{ sessionId: 'primary-session', entryId }}><Harness /></SessionViewRecoveryContext.Provider>));

it('waits for asynchronous content to support the saved scroll offset', async () => {
  channel().write({ kind: 'scroll', scrollTop: 400, scrollLeft: 0 });
  await render(); expect(top).toBe(0);
  max = 1000;
  await act(async () => { element.append(document.createElement('div')); });
  expect(top).toBe(400);
  await act(async () => root.render(null));
  expect(channel().read()).toEqual({ kind: 'scroll', scrollTop: 400, scrollLeft: 0 });
});

it('lets user interaction cancel a deferred restoration', async () => {
  channel().write({ kind: 'scroll', scrollTop: 400, scrollLeft: 0 });
  await render();
  element.dispatchEvent(new Event('wheel'));
  max = 1000;
  await act(async () => { element.append(document.createElement('div')); });
  expect(top).toBe(0);
  await act(async () => root.render(null));
  expect(channel().read()).toEqual({ kind: 'scroll', scrollTop: 0, scrollLeft: 0 });
});

it('does not replace an unrestored offset with a loading placeholder offset', async () => {
  const saved = { kind: 'scroll' as const, scrollTop: 400, scrollLeft: 0 };
  channel().write(saved); await render();
  await act(async () => root.render(null));
  expect(channel().read()).toEqual(saved);
});
