import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SERIALIZE_DEBOUNCE_MS,
  SERIALIZE_IDLE_TIMEOUT_MS,
  useDeferredMarkdownSerialization,
  type DeferredSerialization,
} from './use-deferred-markdown-serialization';

/**
 * Each rule pinned here was added for a reported bug: typing must not serialize
 * per keystroke, an IME composition must not persist a half-composed document,
 * and an unchanged document must not reach the buffer again.
 */
interface FakeEditor {
  isDestroyed: boolean;
  view: { composing?: boolean };
  getMarkdown: () => string;
}

interface HarnessRefs {
  editorRef: { current: FakeEditor | null };
  contentRef: { current: string };
  isComposingRef: { current: boolean };
  onChangeRef: { current: (markdown: string) => void };
  onDirtyRef: { current: (() => void) | undefined };
}

function mountHook() {
  const refs: HarnessRefs = {
    editorRef: {
      current: {
        isDestroyed: false,
        view: {},
        getMarkdown: () => text,
      },
    },
    contentRef: { current: '' },
    isComposingRef: { current: false },
    onChangeRef: { current: vi.fn() },
    onDirtyRef: { current: undefined },
  };
  let text = '';
  let api: DeferredSerialization | null = null;

  function Harness() {
    api = useDeferredMarkdownSerialization({
      editorRef: refs.editorRef as never,
      contentRef: refs.contentRef as never,
      isComposingRef: refs.isComposingRef as never,
      onChangeRef: refs.onChangeRef as never,
      onDirtyRef: refs.onDirtyRef as never,
    });
    return null;
  }

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => { root.render(<Harness />); });

  return {
    refs,
    setMarkdown(next: string) { text = next; },
    get api() { return api as DeferredSerialization; },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

let harness: ReturnType<typeof mountHook>;

beforeEach(() => {
  vi.useFakeTimers();
  harness = mountHook();
});

afterEach(() => {
  harness.unmount();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'requestIdleCallback', { configurable: true, value: undefined });
});

describe('useDeferredMarkdownSerialization', () => {
  it('waits for the debounce window before serializing', async () => {
    harness.setMarkdown('first');
    act(() => {
      harness.api.pendingDirtyRef.current = true;
      harness.api.schedule();
    });

    expect(harness.refs.onChangeRef.current).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(SERIALIZE_DEBOUNCE_MS - 1); });
    expect(harness.refs.onChangeRef.current).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(1); });
    expect(harness.refs.onChangeRef.current).toHaveBeenCalledWith('first');
    expect(harness.refs.contentRef.current).toBe('first');
    expect(harness.api.pendingDirtyRef.current).toBe(false);
  });

  it('prefers an idle callback, with the timeout as fallback', async () => {
    const requestIdleCallback = vi.fn((callback: () => void) => {
      callback();
      return 1;
    });
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      writable: true,
      value: requestIdleCallback,
    });
    harness.setMarkdown('idle');

    act(() => {
      harness.api.pendingDirtyRef.current = true;
      harness.api.schedule();
    });
    await act(async () => { vi.advanceTimersByTime(SERIALIZE_DEBOUNCE_MS); });

    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), {
      timeout: SERIALIZE_IDLE_TIMEOUT_MS,
    });
    expect(harness.refs.onChangeRef.current).toHaveBeenCalledWith('idle');
  });

  it('does not serialize while an IME composition is open', async () => {
    harness.setMarkdown('composed');
    harness.refs.isComposingRef.current = true;

    act(() => {
      harness.api.pendingDirtyRef.current = true;
      harness.api.schedule();
    });
    await act(async () => { vi.advanceTimersByTime(SERIALIZE_DEBOUNCE_MS * 4); });

    expect(harness.refs.onChangeRef.current).not.toHaveBeenCalled();
    expect(harness.api.pendingDirtyRef.current).toBe(true);

    harness.refs.isComposingRef.current = false;
    expect(harness.api.flush()).toBe('composed');
  });

  it('flushes during composition only when forced', () => {
    harness.setMarkdown('forced');
    harness.refs.isComposingRef.current = true;
    act(() => { harness.api.pendingDirtyRef.current = true; });

    expect(harness.api.flush()).toBeNull();
    expect(harness.api.flush({ force: true })).toBe('forced');
  });

  it('skips the buffer when the serialized text already matches', () => {
    harness.setMarkdown('same');
    harness.refs.contentRef.current = 'same';
    act(() => { harness.api.pendingDirtyRef.current = true; });

    expect(harness.api.flush()).toBeNull();
    expect(harness.refs.onChangeRef.current).not.toHaveBeenCalled();
  });

  it('delegates to the host dirty clock instead of scheduling', async () => {
    const dirty = vi.fn();
    harness.refs.onDirtyRef.current = dirty;
    harness.setMarkdown('host-clock');

    act(() => {
      harness.api.pendingDirtyRef.current = true;
      harness.api.schedule();
    });
    await act(async () => { vi.advanceTimersByTime(SERIALIZE_DEBOUNCE_MS * 4); });

    expect(dirty).toHaveBeenCalledTimes(1);
    expect(harness.refs.onChangeRef.current).not.toHaveBeenCalled();
  });

  it('does nothing without an editor or without pending edits', () => {
    expect(harness.api.flush()).toBeNull();

    harness.refs.editorRef.current = null;
    act(() => { harness.api.pendingDirtyRef.current = true; });
    expect(harness.api.flush()).toBeNull();
  });
});
