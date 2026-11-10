import { seedWorkColumn } from '@features/workspace/test-support/workspace-fixtures';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { BrowserColumn } from './browser-column';
import { useBrowserColumnStore } from '@features/workspace/store/browser-column-store';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';
import { getWorkspaceSurfacePresentation } from '@features/surface/workspace-surface-runtime';

vi.mock('./browser-column-header', () => ({ BrowserColumnHeader: () => null }));
vi.mock('@shared/ui/web-frame-scrollbar', () => ({ connectWebFrameScrollbar: vi.fn(() => () => {}) }));
const noop = () => {};

/** Work publishes navigation/loading repeatedly while Browser keeps its mounted web session. */
function Columns() {
  const navigation = useWorkColumnStore((state) => state.navigation);
  return <div>
    <section data-work-state={navigation.phase}>{navigation.pendingTarget?.kind ?? navigation.target.kind}</section>
    <BrowserColumn width={500} layoutKey="split" onResize={noop} />
  </div>;
}

it('retains Browser iframe, URL, history and ready state throughout Work loading, failure and commits', async () => {
  const beforeWork = useWorkColumnStore.getState();
  useBrowserColumnStore.getState().reset();
  const id = useBrowserColumnStore.getState().openContent({ id: 'browser-web-isolation', title: 'Browser', icon: null, target: { kind: 'web', url: 'https://example.com/browser' } });
  const node = document.createElement('div'); document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () => root.render(<Columns />));
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(node.querySelector('iframe')).not.toBeNull();
    });
    const frame = node.querySelector('iframe')!;
    await act(async () => frame.dispatchEvent(new Event('load')));
    expect(getWorkspaceSurfacePresentation(id).state?.status).toBe('ready');
    const browser = useBrowserColumnStore.getState();
    for (const outcome of ['commit', 'failure', 'commit'] as const) {
      const work = useWorkColumnStore.getState();
      const target = { kind: 'web' as const, url: `https://example.com/work-${outcome}` };
      let request = 0;
      await act(async () => {
        useWorkspaceFocusStore.getState().focusColumn('column-1');
        request = work.beginNavigation(target, null);
      });
      expect(node.querySelector('[data-work-state="loading"]')).not.toBeNull();
      expect(node.querySelector('iframe')).toBe(frame);
      expect(getWorkspaceSurfacePresentation(id).state?.status).toBe('ready');
      await act(async () => {
        if (outcome === 'failure') work.failNavigation(request, new Error('Work failed'));
        else work.commitNavigation(request, target);
      });
      expect(node.querySelector('iframe')).toBe(frame);
      expect(frame.getAttribute('src')).toBe('https://example.com/browser');
      expect(getWorkspaceSurfacePresentation(id).state?.status).toBe('ready');
      const next = useBrowserColumnStore.getState();
      expect(next.current).toBe(browser.current);
      expect(next.webRuntime).toBe(browser.webRuntime);
      expect(next.backStack).toBe(browser.backStack);
      expect(next.forwardStack).toBe(browser.forwardStack);
    }
    const workBeforeBrowserNavigation = useWorkColumnStore.getState().navigation;
    await act(async () => { useBrowserColumnStore.getState().navigateWeb(id, 'https://example.com/browser-next'); });
    expect(useWorkColumnStore.getState().navigation).toBe(workBeforeBrowserNavigation);
    expect(node.querySelector('iframe')?.getAttribute('src')).toBe('https://example.com/browser-next');
  } finally {
    await act(async () => root.unmount()); node.remove();
    seedWorkColumn(beforeWork);
    useBrowserColumnStore.getState().reset();
  }
});
