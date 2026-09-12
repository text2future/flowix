import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const titleSession = vi.hoisted(() => ({
  snapshot: {
    filename: 'Original.md',
    draft: 'Original',
    saving: false,
    error: null as string | null,
  },
  setDraft: vi.fn(),
  commit: vi.fn(() => Promise.resolve()),
  cancel: vi.fn(),
}));

vi.mock('./memo-title-session', () => ({
  useMemoTitleSession: () => titleSession,
}));

import { MemoTitleEditor, type MemoTitleBodyNavigation } from './memo-title-editor';

function setTextareaValue(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  setter?.call(element, value);
}

function dispatchKey(
  element: HTMLTextAreaElement,
  key: string,
  keyCode?: number,
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  if (keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: keyCode });
  element.dispatchEvent(event);
  return event;
}

describe('MemoTitleEditor IME handling', () => {
  let container: HTMLDivElement;
  let root: Root;
  let textarea: HTMLTextAreaElement;
  let onMoveToBody: ReturnType<typeof vi.fn<(request: MemoTitleBodyNavigation) => void>>;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onMoveToBody = vi.fn();
    act(() => {
      root.render(createElement(MemoTitleEditor, {
        memoId: 'memo-1',
        filename: 'Original.md',
        editable: true,
        onMoveToBody,
      }));
    });
    textarea = container.querySelector('textarea')!;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps intermediate composition text local until compositionend', () => {
    act(() => {
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      setTextareaValue(textarea, 'ni');
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'ni' }));
    });

    expect(textarea.value).toBe('ni');
    expect(titleSession.setDraft).not.toHaveBeenCalled();

    act(() => {
      setTextareaValue(textarea, '你');
      textarea.dispatchEvent(new CompositionEvent('compositionend', {
        bubbles: true,
        data: '你',
      }));
    });

    expect(titleSession.setDraft).toHaveBeenCalledTimes(1);
    expect(titleSession.setDraft).toHaveBeenCalledWith('你');

    act(() => {
      setTextareaValue(textarea, '你');
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: '你' }));
    });

    expect(titleSession.setDraft).toHaveBeenCalledTimes(1);
  });

  it('does not move to the body when Enter confirms an active composition', () => {
    act(() => {
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      dispatchKey(textarea, 'Enter', 13);
    });

    expect(titleSession.commit).not.toHaveBeenCalled();
    expect(onMoveToBody).not.toHaveBeenCalled();
  });

  it('does not move to the body for WebKit process-key 229', () => {
    act(() => {
      dispatchKey(textarea, 'Enter', 229);
    });

    expect(titleSession.commit).not.toHaveBeenCalled();
    expect(onMoveToBody).not.toHaveBeenCalled();
  });

  it('moves to the body for an ordinary Enter after composition', async () => {
    setTextareaValue(textarea, 'Title tail');
    textarea.setSelectionRange(5, 5);

    await act(async () => {
      const event = dispatchKey(textarea, 'Enter', 13);
      expect(event.defaultPrevented).toBe(true);
      await Promise.resolve();
    });

    expect(titleSession.setDraft).toHaveBeenCalledWith('Title');
    expect(titleSession.commit).toHaveBeenCalledTimes(1);
    expect(onMoveToBody).toHaveBeenCalledWith({
      trailingContent: ' tail',
      insertEmptyLine: true,
    });
  });

  it('does not cancel title editing when Escape belongs to the IME', () => {
    act(() => {
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      dispatchKey(textarea, 'Escape', 229);
    });

    expect(titleSession.cancel).not.toHaveBeenCalled();
  });
});
