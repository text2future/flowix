import { act, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurfacePresentationUpdate } from '@features/workspace/model/surface-contract';
import { useDocumentEditorViewStore, setDocumentEditorMode } from '@features/document/store/document-editor-view-store';
import { HtmlResourceView } from './html-resource-view';
import { HTML_PREVIEW_TIMEOUT_MS } from './use-local-html-preview';
import bridgeSource from '../../../flowix-desktop/src/local_html_preview.js?raw';

const mocks = vi.hoisted(() => ({ read: vi.fn(), finish: vi.fn(), sourceMount: vi.fn(), watch: vi.fn(), metadata: vi.fn(), openLink: vi.fn() }));
vi.mock('@features/workspace/public/html-link-api', () => ({ openHtmlLink: mocks.openLink }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@platform/tauri/client', () => ({
  externalDocuments: { read: mocks.read },
  files: { toAssetUrl: (path: string) => `asset://localhost/${encodeURIComponent(path)}` },
}));
vi.mock('@features/document/store/external-document-watch', () => ({ subscribeExternalDocumentChanges: mocks.watch }));
vi.mock('@features/document/store/document-store', () => ({ useDocumentStore: { getState: () => ({ finishDocumentTransition: mocks.finish }) } }));
vi.mock('@features/document/components/document-container', () => ({ DocumentContainer: () => {
  useEffect(() => { mocks.sourceMount(); }, []);
  return <div data-source-editor />;
} }));
vi.mock('@features/workspace/public/surface-api', () => ({ workspaceSurfaceAppearance: () => ({ contentBackground: 'document', stateBackground: 'document' }) }));
vi.mock('@shared/ui/tooltip', () => ({ Tooltip: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
let host: HTMLDivElement;
let root: Root;
let updates: SurfacePresentationUpdate[];
const reportPresentation = (update: SurfacePresentationUpdate) => updates.push(update);
const latest = () => updates.filter((update) => update.state !== undefined).slice(-1)[0]?.state;
async function render(path = '/book/index.html') {
  await act(async () => root.render(<HtmlResourceView filePath={path} scopePath="/book"
    documentProps={{ fileIdentity: { path, displayId: path }, transitionId: 7, onMetainfoData: mocks.metadata }} reportPresentation={reportPresentation} />));
}
async function message(frame: HTMLIFrameElement, url = frame.src, source: MessageEventSource | null = frame.contentWindow) {
  await act(async () => window.dispatchEvent(new MessageEvent('message', {
    source, data: { type: 'flowix:local-html-document-ready', url },
  })));
}
async function selectMode(mode: 'rich' | 'source', path = '/book/index.html') {
  await act(async () => setDocumentEditorMode('main-third', { kind: 'md', path, displayId: path }, mode));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useDocumentEditorViewStore.getState().reset();
  mocks.watch.mockReturnValue(() => undefined);
  mocks.openLink.mockResolvedValue(undefined);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  updates = [];
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('HTML preview lifecycle', () => {
  it('accepts only the current preview background and clears it for source, retry and another file', async () => {
    mocks.read.mockResolvedValue('<html></html>');
    await render();
    const frame = host.querySelector('iframe')!;
    const latestColor = () => updates.reduce<string | null | undefined>((color, update) => (
      'headerBackgroundColor' in update ? update.headerBackgroundColor : color
    ), undefined);
    const send = async (color: unknown, source: MessageEventSource | null = frame.contentWindow, url = frame.src) => {
      await act(async () => window.dispatchEvent(new MessageEvent('message', {
        source, data: { type: 'flowix:local-html-background', url, color },
      })));
    };
    await message(frame);
    await send('rgb(17, 34, 51)', window);
    await send('rgb(17, 34, 51)', frame.contentWindow, 'asset://localhost/other.html');
    await send('url(https://example.com/image)');
    await send('rgb(999, 0, 0)');
    expect(latestColor()).toBeNull();
    await send('rgb(17, 34, 51)');
    expect(latestColor()).toBe('rgb(17, 34, 51)');
    await send('rgb(240, 241, 242)', frame.contentWindow, `${frame.src}#section`);
    expect(latestColor()).toBe('rgb(240, 241, 242)');
    await selectMode('source');
    expect(latestColor()).toBeNull();
    await selectMode('rich');
    expect(latestColor()).toBeNull();
    const next = host.querySelector('iframe')!;
    await message(next);
    await send('rgb(17, 34, 51)', next.contentWindow, next.src);
    expect(latestColor()).toBe('rgb(17, 34, 51)');
    await render('/book/other.html');
    expect(latestColor()).toBeNull();
  });

  it('routes only current-frame links to Browser, including after an in-page anchor change', async () => {
    mocks.read.mockResolvedValue('<html></html>');
    await render();
    const frame = host.querySelector('iframe')!;
    const send = async (source: MessageEventSource | null, url = frame.src, href: unknown = 'report.pdf') => {
      await act(async () => window.dispatchEvent(new MessageEvent('message', { source,
        data: { type: 'flowix:local-html-link', url, href, baseHref: null } })));
    };
    await send(window);
    await send(frame.contentWindow, 'asset://localhost/other.html');
    await send(frame.contentWindow, frame.src, {});
    expect(mocks.openLink).not.toHaveBeenCalled();
    await send(frame.contentWindow, `${frame.src}#library`);
    expect(mocks.openLink).toHaveBeenCalledWith({ href: 'report.pdf', baseHref: null }, '/book/index.html', '/book', null);
    await selectMode('source');
    await send(frame.contentWindow);
    expect(mocks.openLink).toHaveBeenCalledTimes(1);
  });
  it('authorizes the file, accepts only its document-ready signal, and keeps repeated preview clicks idempotent', async () => {
    const read = deferred();
    mocks.read.mockReturnValue(read.promise);
    await render();
    expect(host.querySelector('iframe')).toBeNull();
    expect(latest()).toMatchObject({ status: 'loading', loadingMode: 'background', retainContent: true });
    expect(host.querySelector('.editor-toolbar')).toBeNull();
    expect(mocks.sourceMount).not.toHaveBeenCalled();
    await act(async () => read.resolve('<html></html>'));
    expect(mocks.read).toHaveBeenCalledWith('/book/index.html', '/book');
    const frame = host.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(mocks.finish).toHaveBeenCalledWith(7, 'ready');
    expect(mocks.metadata).toHaveBeenCalledWith(expect.objectContaining({ memoContent: '<html></html>' }));
    // iframe load also fires for some failed navigations; it is not proof of readiness.
    await act(async () => frame.dispatchEvent(new Event('load')));
    await message(frame, frame.src, window);
    await message(frame, 'asset://localhost/other.html');
    expect(latest()?.status).toBe('loading');
    await message(frame);
    expect(latest()?.status).toBe('ready');
    await selectMode('rich');
    expect(host.querySelector('iframe')).toBe(frame);
    expect(latest()?.status).toBe('ready');
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled read and does not mount a frame from a late result', async () => {
    const read = deferred();
    mocks.read.mockReturnValue(read.promise);
    await render();
    await act(async () => vi.advanceTimersByTime(HTML_PREVIEW_TIMEOUT_MS));
    expect(host.textContent).toContain('htmlResource.timeout');
    expect(latest()?.status).toBe('ready');
    expect(mocks.finish).toHaveBeenCalledWith(7, 'unavailable');
    await act(async () => read.resolve('late'));
    expect(host.querySelector('iframe')).toBeNull();
    mocks.read.mockResolvedValue('<html></html>');
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'error.retry')!.click());
    expect(host.querySelector('iframe')).not.toBeNull();
  });

  it('offers recovery for a stalled frame and accepts late document readiness', async () => {
    mocks.read.mockResolvedValue('<html></html>');
    await render();
    const frame = host.querySelector('iframe')!;
    await act(async () => vi.advanceTimersByTime(HTML_PREVIEW_TIMEOUT_MS));
    expect(host.textContent).toContain('htmlResource.timeout');
    expect(host.querySelector('.editor-toolbar')).toBeNull();
    await message(frame);
    expect(host.textContent).not.toContain('htmlResource.timeout');
    expect(latest()?.status).toBe('ready');
  });

  it('isolates old reads and frame messages when switching files or opening source', async () => {
    const old = deferred();
    mocks.read.mockReturnValueOnce(old.promise).mockResolvedValue('<html></html>');
    await render('/book/old.html');
    await render('/book/new.html');
    const frame = host.querySelector('iframe')!;
    await act(async () => old.resolve('old'));
    expect(frame.src).toContain('new.html');
    await selectMode('source', '/book/new.html');
    expect(host.querySelector('iframe')).toBeNull();
    expect(host.querySelector('[data-source-editor]')).not.toBeNull();
    await message(frame);
    expect(latest()?.status).toBe('loading');
  });

  it('rejects late events from a failed attempt and refreshes on an external file change', async () => {
    mocks.read.mockResolvedValue('<html></html>');
    await render();
    const oldFrame = host.querySelector('iframe')!;
    const oldWindow = oldFrame.contentWindow;
    await act(async () => oldFrame.dispatchEvent(new Event('error', { bubbles: true })));
    await message(oldFrame);
    expect(host.textContent).toContain('document.file.unavailable');
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'error.retry')!.click());
    const newFrame = host.querySelector('iframe')!;
    expect(newFrame).not.toBe(oldFrame);
    await message(newFrame, newFrame.src, oldWindow);
    expect(latest()?.status).toBe('loading');
    await message(newFrame);
    expect(latest()?.status).toBe('ready');
    await act(async () => mocks.watch.mock.calls[0][2]({ kind: 'modified', path: '/book/index.html' }));
    expect(host.querySelector('iframe')).not.toBe(newFrame);
    expect(mocks.watch).toHaveBeenCalledTimes(1);
  });

  it('shows scoped read errors locally without mounting an unauthorized frame', async () => {
    mocks.read.mockRejectedValue(new Error('outside authorized scope'));
    await render();
    expect(host.querySelector('iframe')).toBeNull();
    expect(host.textContent).toContain('document.file.unavailable');
    expect(latest()?.status).toBe('ready');
    await selectMode('source');
    expect(host.querySelector('[data-source-editor]')).not.toBeNull();
  });
});

describe('native local HTML readiness bridge', () => {
  it('delegates cross-document links, leaves local anchors alone, and removes listeners on unload', () => {
    const parent = { postMessage: vi.fn() };
    const frame = Object.assign(new EventTarget(), { parent });
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML = '<a href="#library">anchor</a><a href="file:///repo/README.md" target="_blank"><span>note</span></a><a href="javascript:alert(1)">invalid</a>';
    Object.defineProperty(doc, 'baseURI', { value: 'asset://localhost/book/index.html' });
    new Function('window', 'document', 'location', bridgeSource)(frame, doc, { href: doc.baseURI });
    const click = (target: Element) => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    parent.postMessage.mockClear();
    expect(click(doc.querySelector('a')!)).toBe(false);
    doc.querySelector('a')!.setAttribute('href', '#');
    expect(click(doc.querySelector('a')!)).toBe(false);
    expect(parent.postMessage).not.toHaveBeenCalled();
    expect(click(doc.querySelector('span')!)).toBe(true);
    expect(parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'flowix:local-html-link', href: 'file:///repo/README.md', baseHref: null }), '*');
    expect(click(doc.querySelectorAll('a')[2])).toBe(true);
    frame.dispatchEvent(new Event('pagehide'));
    expect(click(doc.querySelector('span')!)).toBe(false);
  });
  it('reports parsed local documents before window load and answers probes', () => {
    const parent = { postMessage: vi.fn() };
    const frame = Object.assign(new EventTarget(), { parent });
    const doc = Object.assign(new EventTarget(), { readyState: 'loading' });
    const run = new Function('window', 'document', 'location', bridgeSource);
    run(frame, doc, { href: 'asset://localhost/book/index.html' });
    expect(parent.postMessage).not.toHaveBeenCalled();
    doc.readyState = 'interactive';
    doc.dispatchEvent(new Event('readystatechange'));
    expect(parent.postMessage).toHaveBeenCalledWith({ type: 'flowix:local-html-document-ready', url: 'asset://localhost/book/index.html' }, '*');
    frame.dispatchEvent(new MessageEvent('message', { source: parent as unknown as Window, data: { type: 'flowix:local-html-document-probe' } }));
    expect(parent.postMessage).toHaveBeenCalledTimes(2);
  });

  it('does not initialize remote frames or top-level documents', () => {
    const parent = { postMessage: vi.fn() };
    const doc = Object.assign(new EventTarget(), { readyState: 'complete' });
    const run = new Function('window', 'document', 'location', bridgeSource);
    run(Object.assign(new EventTarget(), { parent }), doc, { href: 'https://example.com/index.html' });
    const top = Object.assign(new EventTarget(), { parent: undefined as unknown });
    top.parent = top;
    run(top, doc, { href: 'asset://localhost/book/index.html' });
    expect(parent.postMessage).not.toHaveBeenCalled();
  });
});
