import { Component, act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentPage } from '@platform/tauri/client';
import { DocumentListView } from './document-list-view';
import type { DocumentListSurface } from './types';

const probe = vi.hoisted(() => ({ read: vi.fn<(request: unknown) => Promise<DocumentPage>>() }));
vi.mock('@platform/tauri/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@platform/tauri/client')>();
  return { ...actual, files: { ...actual.files, listDocumentPage: probe.read } };
});
vi.mock('@platform/tauri/event-bus', () => ({ subscribe: () => () => {} }));

class RequestLoopBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div>Directory request loop</div> : this.props.children; }
}

const surface: DocumentListSurface = {
  kind: 'document-list', instanceKey: 'folder', displayId: 'folder',
  folderPath: '/notes/empty', notebookPath: '/notes', notebookId: 'notes', filters: {},
};
const emptyPage: DocumentPage = { folders: [], items: [], nextCursor: null, hasMore: false };

describe('DocumentListView folder loading', () => {
  let host: HTMLDivElement;
  let root: Root;
  let scrollToDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    probe.read.mockReset();
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} });
    scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host, { onCaughtError: () => {} });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    if (scrollToDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollToDescriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
    vi.unstubAllGlobals();
  });

  function respondWith(page: Promise<DocumentPage>) {
    probe.read.mockImplementation(() => {
      // Fail boundedly if the loading effect starts requesting on every render.
      if (probe.read.mock.calls.length > 5) throw new Error('Directory request loop');
      return page;
    });
  }

  async function render(nextSurface = surface) {
    await act(async () => root.render(
      <RequestLoopBoundary><DocumentListView surface={nextSurface} /></RequestLoopBoundary>,
    ));
  }

  it('requests an empty folder once and exits loading when it resolves', async () => {
    let resolve!: (page: DocumentPage) => void;
    respondWith(new Promise<DocumentPage>((done) => { resolve = done; }));
    await render();
    expect(probe.read).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('正在整理文件列表');

    await act(async () => resolve(emptyPage));
    expect(host.textContent).toContain('列表内容为空');
    expect(host.textContent).not.toContain('正在整理文件列表');
    await render();
    expect(probe.read).toHaveBeenCalledTimes(1);
  });

  it('renders directory entries and reloads when the selected folder changes', async () => {
    respondWith(Promise.resolve({
      ...emptyPage,
      folders: [{ name: 'subfolder', fullPath: '/notes/empty/subfolder', resourceKind: 'folder', sizeBytes: null, modifiedMs: null, createdMs: null }],
      items: [{ name: 'readme.txt', fullPath: '/notes/empty/readme.txt', resourceKind: 'other', sizeBytes: 4, modifiedMs: null, createdMs: null }],
    }));
    await render();
    expect(probe.read).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('subfolder');
    expect(host.textContent).toContain('readme');
    expect(host.textContent).not.toContain('正在整理文件列表');

    respondWith(Promise.resolve(emptyPage));
    await render({ ...surface, displayId: 'other', folderPath: '/notes/other' });
    expect(probe.read).toHaveBeenCalledTimes(2);
    expect(probe.read).toHaveBeenLastCalledWith(expect.objectContaining({ folderPath: '/notes/other' }));
    expect(host.textContent).toContain('列表内容为空');
    expect(host.textContent).not.toContain('subfolder');
  });
});
