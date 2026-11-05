import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openBrowserColumnWebpage, openBrowserColumnMarkdown, selectBrowserColumnFile, navigateBrowserColumnHistory } from './browser-column-navigation';
import { useBrowserColumnStore } from '../store/browser-column-store';
import { resetBrowserColumnCoordinator } from './browser-column-coordinator';
import { registerWorkspaceSurfaceLifecycle } from '../store/surface-lifecycle-store';
import { findFileDisplayIdentity } from '@/lib/file-display-registry';
const ids: string[] = [];
beforeEach(() => { useBrowserColumnStore.getState().reset(); resetBrowserColumnCoordinator(); });
afterEach(() => { for (const id of ids.splice(0)) registerWorkspaceSurfaceLifecycle(id, null); });
it('opens into the same column and navigates visits without adding replay entries', async () => {
  await openBrowserColumnWebpage('https://a.example/');
  await openBrowserColumnWebpage('https://b.example/');
  await navigateBrowserColumnHistory('back');
  expect(useBrowserColumnStore.getState().current!.target).toEqual({ kind: 'web', url: 'https://a.example/' });
  expect(useBrowserColumnStore.getState().backStack).toEqual([]);
  await navigateBrowserColumnHistory('forward');
  expect(useBrowserColumnStore.getState().current!.target).toEqual({ kind: 'web', url: 'https://b.example/' });
  expect(useBrowserColumnStore.getState().backStack).toHaveLength(1);
});
it('keeps both the surface and history unchanged when saving fails', async () => {
  await openBrowserColumnWebpage('https://a.example/');
  await openBrowserColumnWebpage('https://b.example/');
  const id = useBrowserColumnStore.getState().current?.id!;
  ids.push(id);
  const flush = vi.fn(async () => false);
  registerWorkspaceSurfaceLifecycle(id, { status: 'ready', flush });
  const before = useBrowserColumnStore.getState();
  expect(await navigateBrowserColumnHistory('back')).toBeNull();
  expect(await openBrowserColumnWebpage('https://c.example/')).toBeNull();
  expect(useBrowserColumnStore.getState().current).toBe(before.current);
  expect(useBrowserColumnStore.getState().backStack).toBe(before.backStack);
  expect(useBrowserColumnStore.getState().forwardStack).toBe(before.forwardStack);
  expect(flush).toHaveBeenCalledTimes(2);
});
it('records file-tree selections and restores their full browser context', async () => {
  await openBrowserColumnMarkdown('/workspace/a.md');
  const id = useBrowserColumnStore.getState().current?.id!;
  useBrowserColumnStore.getState().setFileBrowserTreeVisible(id, false);
  await selectBrowserColumnFile(id, '/workspace/b.md', '/workspace');
  expect(useBrowserColumnStore.getState().current).not.toBeNull();
  expect(useBrowserColumnStore.getState().backStack).toHaveLength(1);
  await navigateBrowserColumnHistory('back');
  expect(useBrowserColumnStore.getState().current!.target).toMatchObject({ activeFilePath: '/workspace/a.md', fileTreeVisible: false });
});
it('registers identity before opening a non-previewable local file', async () => {
  const filePath = '/workspace/build/Flowix.dmg';
  await openBrowserColumnMarkdown(filePath);
  expect(findFileDisplayIdentity(filePath)).toMatchObject({ path: filePath });
});
it('serializes a new open behind an unfinished save', async () => {
  await openBrowserColumnWebpage('https://a.example/');
  const id = useBrowserColumnStore.getState().current?.id!;
  ids.push(id);
  let release!: (saved: boolean) => void;
  registerWorkspaceSurfaceLifecycle(id, { status: 'ready', flush: () => new Promise<boolean>((resolve) => { release = resolve; }) });
  const opening = openBrowserColumnWebpage('https://b.example/');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect(useBrowserColumnStore.getState().current!.target).toMatchObject({ url: 'https://a.example/' });
  release(true);
  await opening;
  expect(useBrowserColumnStore.getState().current!.target).toMatchObject({ url: 'https://b.example/' });
});

it('honors consecutive clicks from the mounted tree while rejecting events from an already retired tree', async () => {
  await openBrowserColumnMarkdown('/workspace/a.md');
  const id = useBrowserColumnStore.getState().current!.id;
  const first = selectBrowserColumnFile(id, '/workspace/b.md');
  const second = selectBrowserColumnFile(id, '/workspace/c.md');
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(useBrowserColumnStore.getState().current?.target).toMatchObject({ activeFilePath: '/workspace/c.md' });
  expect(useBrowserColumnStore.getState().backStack.map((entry) => entry.target.kind === 'file-browser' ? entry.target.activeFilePath : null)).toEqual(['/workspace/a.md', '/workspace/b.md']);
  expect(await selectBrowserColumnFile(id, '/workspace/stale.md')).toBe(false);
});
