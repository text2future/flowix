import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ShortcutsProvider } from '@features/shortcuts';
import '@features/shortcuts/actions';
import { getPlatform } from '@/lib/shortcuts/platform';
import { MarkdownEditor } from './markdown-editor';

let container: HTMLDivElement;
let root: Root;
const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function createFindEvent(): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: 'f',
    code: 'KeyF',
    metaKey: getPlatform() === 'mac',
    ctrlKey: getPlatform() !== 'mac',
    bubbles: true,
    cancelable: true,
  });
}

function pressFind(editor: Editor): KeyboardEvent {
  const event = createFindEvent();
  editor.view.dom.dispatchEvent(event);
  return event;
}

describe('MarkdownEditor search shortcut', () => {
  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 }),
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (scrollIntoViewDescriptor) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoViewDescriptor);
    } else {
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    }
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('does not claim Ctrl+F when there is no rich editor handler', async () => {
    await act(async () => root.render(
      <ShortcutsProvider overrides={{}}><input aria-label="Search target" /></ShortcutsProvider>,
    ));

    const input = container.querySelector<HTMLInputElement>('input')!;
    const event = createFindEvent();
    act(() => input.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(false);
  });

  it('opens the local search panel and finds text when no parent controls it', async () => {
    let editor: Editor | null = null;
    await act(async () => root.render(
      <ShortcutsProvider overrides={{}}>
        <MarkdownEditor content="needle and needle" onBeforeCreate={value => { editor = value; }} />
      </ShortcutsProvider>,
    ));

    act(() => {
      editor!.view.focus();
      expect(pressFind(editor!).defaultPrevented).toBe(true);
    });

    const searchPanel = container.querySelector('.editor-search-replace-panel');
    const searchInput = searchPanel?.querySelector<HTMLInputElement>('input');
    expect(searchPanel).not.toBeNull();
    expect(searchInput).not.toBeNull();

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(searchInput, 'needle');
      searchInput!.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 180));
    });

    expect(editor!.storage.searchAndReplace.results).toHaveLength(2);
    expect(editor!.view.dom.querySelectorAll('.search-result')).toHaveLength(2);
  });

  it('opens through the paired controlled state and callback', async () => {
    let editor: Editor | null = null;
    function ControlledEditor() {
      const [open, setOpen] = useState(false);
      return (
        <MarkdownEditor
          content="controlled search"
          searchPanelOpen={open}
          onSearchPanelOpenChange={setOpen}
          onBeforeCreate={value => { editor = value; }}
        />
      );
    }

    await act(async () => root.render(
      <ShortcutsProvider overrides={{}}><ControlledEditor /></ShortcutsProvider>,
    ));
    act(() => {
      editor!.view.focus();
      pressFind(editor!);
    });

    expect(container.querySelector('.editor-search-replace-panel')).not.toBeNull();
  });
});
