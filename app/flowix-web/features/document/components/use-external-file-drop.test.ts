import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listener: null as ((event: { payload: Record<string, unknown> }) => void) | null,
  unlisten: vi.fn(),
  onDragDropEvent: vi.fn(),
}));

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: mocks.onDragDropEvent,
  }),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    scaleFactor: vi.fn().mockResolvedValue(1),
  }),
}));

import {
  EXTERNAL_FILE_DROP_EVENT,
  useExternalFileDrop,
} from './use-external-file-drop';

interface HarnessProps {
  onDropPaths: (paths: string[], destination?: 'main-third' | 'browser-column') => void | Promise<void>;
  onError?: (error: unknown) => void;
}

function Harness({ onDropPaths, onError }: HarnessProps) {
  const { isDraggingFile } = useExternalFileDrop({
    onDropPaths,
    onDropError: onError,
  });
  return createElement('span', null, isDraggingFile ? 'dragging' : 'idle');
}

describe('useExternalFileDrop', () => {
  let container: HTMLDivElement;
  let root: Root;
  let previousElementFromPoint: typeof document.elementFromPoint;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.listener = null;
    mocks.onDragDropEvent.mockImplementation(async (listener) => {
      mocks.listener = listener;
      return mocks.unlisten;
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    previousElementFromPoint = document.elementFromPoint;
    const host = document.createElement('div');
    host.dataset.workspaceHost = 'main-third';
    document.body.appendChild(host);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => host,
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: previousElementFromPoint,
    });
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.useRealTimers();
  });

  it('shows over a work column and forwards every file type on drop', async () => {
    const onDropPaths = vi.fn(async () => undefined);
    await act(async () => root.render(createElement(Harness, { onDropPaths })));

    expect(mocks.onDragDropEvent).toHaveBeenCalledOnce();
    expect(mocks.listener).not.toBeNull();

    await act(async () => {
      mocks.listener?.({ payload: { type: 'enter', paths: undefined as unknown as string[] } });
    });
    expect(container.textContent).toBe('idle');

    await act(async () => {
      mocks.listener?.({ payload: { type: 'enter', paths: ['/notes/a.txt'], position: { x: 10, y: 10 } } });
    });
    expect(container.textContent).toBe('dragging');

    await act(async () => {
      mocks.listener?.({ payload: { type: 'enter', paths: ['/notes/a.md'], position: { x: 10, y: 10 } } });
    });
    expect(container.textContent).toBe('dragging');

    await act(async () => {
      mocks.listener?.({ payload: { type: 'leave' } });
    });
    expect(container.textContent).toBe('idle');

    await act(async () => {
      mocks.listener?.({ payload: { type: 'enter', paths: ['/notes/a.md', '/notes/b.markdown'], position: { x: 10, y: 10 } } });
    });
    expect(container.textContent).toBe('dragging');

    await act(async () => {
      mocks.listener?.({
        payload: {
          type: 'drop',
          paths: ['/notes/a.txt', '/notes/b.markdown', '/notes/c.md'],
          position: { x: 10, y: 10 },
        },
      });
    });
    expect(container.textContent).toBe('idle');
    expect(onDropPaths).toHaveBeenCalledOnce();
    expect(onDropPaths).toHaveBeenCalledWith(['/notes/a.txt', '/notes/b.markdown', '/notes/c.md'], 'main-third');
  });

  it('treats empty or undefined paths as a no-op drop', async () => {
    const onDropPaths = vi.fn();
    await act(async () => root.render(createElement(Harness, { onDropPaths })));

    await act(async () => {
      mocks.listener?.({ payload: { type: 'drop', paths: [] } });
    });
    expect(onDropPaths).not.toHaveBeenCalled();

    await act(async () => {
      mocks.listener?.({ payload: { type: 'drop', paths: undefined as unknown as string[] } });
    });
    expect(onDropPaths).not.toHaveBeenCalled();

    await act(async () => {
      mocks.listener?.({ payload: { type: 'drop', paths: ['/notes/a.txt'] } });
    });
    expect(onDropPaths).not.toHaveBeenCalled();
  });

  it('routes every external file type to the notebook drop target', async () => {
    const onDropPaths = vi.fn();
    const target = document.createElement('div');
    target.dataset.notebookExternalDropTarget = 'true';
    document.body.appendChild(target);
    const routedEvents: CustomEvent[] = [];
    const onRoutedEvent = (event: Event) => {
      routedEvents.push(event as CustomEvent);
    };
    window.addEventListener(EXTERNAL_FILE_DROP_EVENT, onRoutedEvent);
    const previousElementFromPoint = document.elementFromPoint;
    const elementFromPoint = vi.fn(() => target);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: elementFromPoint,
    });

    await act(async () => root.render(createElement(Harness, { onDropPaths })));
    await act(async () => {
      mocks.listener?.({
        payload: {
          type: 'enter',
          paths: ['/external/a.md', '/external/image.png', '/external/archive.zip'],
          position: { x: 10, y: 20 },
        },
      });
      mocks.listener?.({
        payload: {
          type: 'drop',
          paths: ['/external/a.md', '/external/image.png', '/external/archive.zip'],
          position: { x: 10, y: 20 },
        },
      });
    });

    expect(routedEvents.map((event) => event.detail.type)).toEqual(['enter', 'drop']);
    expect(routedEvents[0].detail.paths).toEqual(['/external/a.md', '/external/image.png', '/external/archive.zip']);
    expect(routedEvents[0].target).toBe(target);
    expect(onDropPaths).not.toHaveBeenCalled();
    window.removeEventListener(EXTERNAL_FILE_DROP_EVENT, onRoutedEvent);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: previousElementFromPoint,
    });
  });

  it('resolves each native event position once', async () => {
    const elementFromPoint = vi.fn(() => document.querySelector('[data-workspace-host]'));
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: elementFromPoint,
    });
    const onDropPaths = vi.fn();
    await act(async () => root.render(createElement(Harness, { onDropPaths })));

    await act(async () => {
      mocks.listener?.({ payload: { type: 'enter', paths: ['/notes/a.md'], position: { x: 10, y: 10 } } });
      mocks.listener?.({ payload: { type: 'over', position: { x: 11, y: 11 } } });
      mocks.listener?.({ payload: { type: 'drop', paths: ['/notes/a.md'], position: { x: 12, y: 12 } } });
    });

    expect(elementFromPoint).toHaveBeenCalledTimes(3);
    expect(onDropPaths).toHaveBeenCalledOnce();
  });

  it('does not let an unrelated HTML drag suppress native file events', async () => {
    const onDropPaths = vi.fn();
    await act(async () => root.render(createElement(Harness, { onDropPaths })));

    await act(async () => {
      document.dispatchEvent(new Event('dragstart', { bubbles: true }));
      mocks.listener?.({ payload: { type: 'enter', paths: ['/notes/a.md'], position: { x: 10, y: 10 } } });
      mocks.listener?.({ payload: { type: 'drop', paths: ['/notes/a.md'], position: { x: 10, y: 10 } } });
    });

    expect(onDropPaths).toHaveBeenCalledOnce();
    expect(onDropPaths).toHaveBeenCalledWith(['/notes/a.md'], 'main-third');
  });

  it('ignores late native events after the host unmounts', async () => {
    let resolveRegistration: ((unlisten: () => void) => void) | undefined;
    mocks.onDragDropEvent.mockImplementation((listener) => {
      mocks.listener = listener;
      return new Promise<() => void>((resolve) => {
        resolveRegistration = resolve;
      });
    });
    const onDropPaths = vi.fn();
    await act(async () => root.render(createElement(Harness, { onDropPaths })));

    await act(async () => root.unmount());
    mocks.listener?.({ payload: { type: 'drop', paths: ['/notes/a.md'] } });
    resolveRegistration?.(mocks.unlisten);
    await Promise.resolve();

    expect(onDropPaths).not.toHaveBeenCalled();
    expect(mocks.unlisten).toHaveBeenCalledOnce();
    root = createRoot(container);
  });

  it('reports asynchronous open failures and unregisters the native listener', async () => {
    const failure = new Error('open failed');
    const onError = vi.fn();
    await act(async () => root.render(createElement(Harness, {
      onDropPaths: async () => { throw failure; },
      onError,
    })));

    await act(async () => {
      mocks.listener?.({ payload: { type: 'drop', paths: ['/notes/a.md'], position: { x: 10, y: 10 } } });
      await Promise.resolve();
    });
    expect(onError).toHaveBeenCalledWith(failure);

    await act(async () => root.unmount());
    expect(mocks.unlisten).toHaveBeenCalledOnce();
    root = createRoot(container);
  });
});
