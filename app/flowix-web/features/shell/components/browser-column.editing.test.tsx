import { seedWorkColumn } from '@features/workspace/test-support/workspace-fixtures';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { BrowserColumn } from './browser-column';
import { useBrowserColumnStore } from '@features/workspace/store/browser-column-store';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';

const resolveSurface = vi.hoisted(() => vi.fn((_tab: unknown, _options: { readOnly?: boolean }) => null));
const renderHeader = vi.hoisted(() => vi.fn((_props: Record<string, unknown>) => null));
vi.mock('@features/surface/browser-column-registry', () => ({
  resolveBrowserColumnSurface: resolveSurface,
  BrowserColumnSurfaceHost: () => null,
}));
vi.mock('./browser-column-header', () => ({ BrowserColumnHeader: renderHeader }));

it('does not force the right document read-only when the same memo is open on the left', async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const element = document.createElement('div');
  const root = createRoot(element);
  const previousNavigation = useWorkColumnStore.getState().navigation;
  const target = { kind: 'external' as const, path: '/notes/both.md', scopePath: '/notes', transitionId: 1 };
  const work = useWorkColumnStore.getState();
  work.commitNavigation(work.beginNavigation(target, null), target);
  const tab = { id: 'memo:both', title: 'Both', icon: null, target: { kind: 'file-browser' as const, activeFilePath: target.path, folderPath: '/notes', notebookId: 'notes', scopePath: '/notes', fileTreeVisible: true, fileTreeWidth: 220 } };
  useBrowserColumnStore.getState().openContent(tab);
  try {
    await act(async () => root.render(<BrowserColumn width={500} layoutKey="test" onResize={() => {}} toolbarCollapsed={false} onToolbarCollapsedChange={() => {}} />));
    for (const host of ['column-1', 'column-2'] as const) {
      await act(async () => useWorkspaceFocusStore.getState().focusColumn(host));
      expect(resolveSurface.mock.lastCall?.[1].readOnly).toBe(false);
    }
  } finally {
    await act(async () => root.unmount());
    useBrowserColumnStore.getState().reset();
    seedWorkColumn({ navigation: previousNavigation });
    useWorkspaceFocusStore.getState().reset();
    environment.IS_REACT_ACT_ENVIRONMENT = false;
  }
});

it('keeps the content host and horizontal resize control mounted at narrow widths', async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const element = document.createElement('div');
  const root = createRoot(element);
  const resize = vi.fn();
  const props = { width: 500, layoutKey: 'wide', onResize: resize, toolbarCollapsed: false, onToolbarCollapsedChange: () => {} };
  try {
    await act(async () => root.render(<BrowserColumn {...props} />));
    const host = element.querySelector('section');
    const content = host?.lastElementChild;
    const divider = element.querySelector('[role="separator"]');
    expect(divider).not.toBeNull();
    await act(async () => { divider?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
    expect(resize).toHaveBeenCalledWith(520);
    await act(async () => root.render(<BrowserColumn {...props} width={360} layoutKey="narrow" />));
    expect(element.querySelector('section')).toBe(host);
    expect(host?.lastElementChild).toBe(content);
    expect(element.querySelector('[role="separator"]')).not.toBeNull();
    expect(host?.style.width).toBe('360px');
    await act(async () => root.render(<BrowserColumn {...props} />));
    expect(host?.lastElementChild).toBe(content);
    expect(element.querySelector('[role="separator"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    environment.IS_REACT_ACT_ENVIRONMENT = false;
  }
});
