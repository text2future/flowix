import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const preloadDocumentEditor = vi.hoisted(() => vi.fn());
vi.mock('../components/lazy-document-editor', () => ({ preloadDocumentEditor }));

import { preloadEditorChunkOnIdle } from './shell-api';

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
};

const originalRequestIdleCallback = (window as IdleWindow).requestIdleCallback;

function setRequestIdleCallback(value: unknown): void {
  Object.defineProperty(window, 'requestIdleCallback', {
    configurable: true,
    writable: true,
    value,
  });
}

beforeEach(() => {
  preloadDocumentEditor.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  setRequestIdleCallback(originalRequestIdleCallback);
});

describe('shell api: preloadEditorChunkOnIdle', () => {
  it('warms the editor chunk from an idle callback when the runtime has one', () => {
    const idleCallbacks: Array<() => void> = [];
    const requestIdleCallback = vi.fn((callback: () => void) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    });
    setRequestIdleCallback(requestIdleCallback);

    preloadEditorChunkOnIdle();

    // Nothing is fetched before the browser is idle.
    expect(preloadDocumentEditor).not.toHaveBeenCalled();
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 2000 });

    idleCallbacks.forEach((callback) => callback());
    expect(preloadDocumentEditor).toHaveBeenCalledTimes(1);
  });

  it('falls back to a short timer when requestIdleCallback is missing', () => {
    setRequestIdleCallback(undefined);

    preloadEditorChunkOnIdle();

    expect(preloadDocumentEditor).not.toHaveBeenCalled();
    vi.advanceTimersByTime(199);
    expect(preloadDocumentEditor).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(preloadDocumentEditor).toHaveBeenCalledTimes(1);
  });
});
