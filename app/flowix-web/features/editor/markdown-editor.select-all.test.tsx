import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MarkdownEditor, type MarkdownEditorHandle } from './markdown-editor';
import { ShortcutsProvider } from '@features/shortcuts';
import '@features/shortcuts/actions';

let container: HTMLDivElement;
let root: Root;
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function pressSelectAll(editor: Editor, modifier: 'command' | 'control' = 'command'): void {
  editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'a',
    code: 'KeyA',
    metaKey: modifier === 'command',
    ctrlKey: modifier === 'control',
    bubbles: true,
    cancelable: true,
  }));
}

describe('MarkdownEditor select all', () => {
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
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('keeps the header in the shared scroller but outside ProseMirror markdown', async () => {
    let editor: Editor | null = null;
    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content={'Body paragraph'}
            header={<textarea data-testid="memo-title" defaultValue="File title" />}
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    const title = container.querySelector('[data-testid="memo-title"]');
    expect(title?.parentElement?.classList.contains('editor-content')).toBe(true);
    expect(editor!.view.dom.contains(title)).toBe(false);
    expect(editor!.getMarkdown()).toBe('Body paragraph');
  });

  it('keeps focus and selects the current editable document', async () => {
    let editor: Editor | null = null;
    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content={'# First\n\nSecond'}
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    expect(editor).not.toBeNull();
    act(() => {
      editor!.view.focus();
      pressSelectAll(editor!);
    });

    expect(editor!.view.hasFocus()).toBe(true);
    expect(editor!.state.selection.from).toBe(0);
    expect(editor!.state.selection.to).toBe(editor!.state.doc.content.size);

  });

  it('normalizes multiple empty task placeholders without invalid positions', async () => {
    let editor: Editor | null = null;
    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content={'- [ ] &nbsp;\n- [ ] &nbsp;'}
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    const taskParagraphs: string[] = [];
    editor!.state.doc.descendants((node) => {
      if (node.type.name === 'taskItem') taskParagraphs.push(node.firstChild?.textContent ?? '');
    });

    expect(taskParagraphs).toEqual(['', '']);
  });

  it('keeps focus and selects a read-only document', async () => {
    let editor: Editor | null = null;
    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content={'# First\n\nSecond'}
            editable={false}
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    expect(editor).not.toBeNull();
    act(() => {
      editor!.view.dom.focus();
      pressSelectAll(editor!);
    });

    expect(editor!.view.hasFocus()).toBe(true);
    expect(editor!.state.selection.from).toBe(0);
    expect(editor!.state.selection.to).toBe(editor!.state.doc.content.size);
  });

  it('selects only the focused editor when two columns are mounted', async () => {
    const editors: Editor[] = [];
    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <>
            <MarkdownEditor
              content={'# Work\n\nWork body'}
              onBeforeCreate={(instance) => { editors[0] = instance; }}
            />
            <MarkdownEditor
              content={'# Browser\n\nBrowser body'}
              onBeforeCreate={(instance) => { editors[1] = instance; }}
            />
          </>
        </ShortcutsProvider>,
      );
    });

    expect(editors).toHaveLength(2);
    act(() => {
      editors[0].view.focus();
      pressSelectAll(editors[0]);
    });

    expect(editors[0].state.selection.from).toBe(0);
    expect(editors[0].state.selection.to).toBe(editors[0].state.doc.content.size);
    expect(editors[1].state.selection.empty).toBe(true);
  });

  it('leaves select-all to a nested input instead of claiming it for the document', async () => {
    let editor: Editor | null = null;
    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content={'# First\n\nSecond'}
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    const input = document.createElement('input');
    input.value = 'nested value';
    editor!.view.dom.appendChild(input);
    input.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'a',
      code: 'KeyA',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => input.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(false);
    expect(editor!.state.selection.empty).toBe(true);
  });

  it.each(['command', 'control'] as const)(
    'selects the body after protected frontmatter with %s+A',
    async (modifier) => {
      let editor: Editor | null = null;
      await act(async () => {
        root.render(
          <ShortcutsProvider overrides={{}}>
            <MarkdownEditor
              content={'---\nkey: buvbaqmc\n---\n# First\n\nSecond'}
              onBeforeCreate={(instance) => { editor = instance; }}
            />
          </ShortcutsProvider>,
        );
      });

      const frontmatter = editor!.state.doc.firstChild;
      expect(frontmatter?.type.name).toBe('frontmatter');
      act(() => {
        editor!.view.focus();
        pressSelectAll(editor!, modifier);
      });

      expect(editor!.state.selection.empty).toBe(false);
      expect(editor!.state.selection.from).toBe(frontmatter!.nodeSize + 1);
      expect(editor!.state.selection.to).toBe(editor!.state.doc.content.size - 1);
    },
  );

  it('inserts title overflow as a new body paragraph after frontmatter', async () => {
    let editor: Editor | null = null;
    const handle = createRef<MarkdownEditorHandle>();
    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            ref={handle}
            content={'---\nkey: abc12345\ntags: [work]\n---\nExisting body'}
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    act(() => handle.current?.moveTitleToBody?.('Moved from title'));

    expect(editor!.getMarkdown()).toContain('Moved from title\n\nExisting body');
    expect(editor!.state.doc.firstChild?.type.name).toBe('frontmatter');
    expect(editor!.state.selection.from).toBe(editor!.state.doc.firstChild!.nodeSize + 1);
  });

  it('inserts an empty body paragraph when title has no overflow', async () => {
    let editor: Editor | null = null;
    const handle = createRef<MarkdownEditorHandle>();
    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            ref={handle}
            content={'---\nkey: abc12345\n---\nExisting body'}
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    act(() => handle.current?.moveTitleToBody?.(''));

    expect(editor!.getMarkdown()).toContain('&nbsp;\n\nExisting body');
  });

  it('keeps the first body paragraph on Enter at its leading edge', async () => {
    let editor: Editor | null = null;
    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content={'---\nkey: abc12345\ntags: [work]\n---\nFirst line\n\nRemaining'}
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    const frontmatter = editor!.state.doc.firstChild!;
    act(() => {
      editor!.commands.setTextSelection(frontmatter.nodeSize + 1);
      editor!.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(editor!.getMarkdown()).toContain('Remaining');
    expect(editor!.getMarkdown()).toContain('First line');
  });

  it('moves from the body leading edge to the title on ArrowUp', async () => {
    let editor: Editor | null = null;
    const onFocusTitle = vi.fn();
    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content={'---\nkey: abc12345\n---\nFirst line'}
            onFocusTitle={onFocusTitle}
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    const frontmatter = editor!.state.doc.firstChild!;
    act(() => {
      editor!.commands.setTextSelection(frontmatter.nodeSize + 1);
      editor!.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(onFocusTitle).toHaveBeenCalledTimes(1);
  });

  it('promotes the first body paragraph on Backspace at the body leading edge', async () => {
    let editor: Editor | null = null;
    const onAppendToTitle = vi.fn();
    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content={'---\nkey: abc12345\ntags: [work]\n---\nFirst line\n\nRemaining'}
            onAppendToTitle={onAppendToTitle}
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    const frontmatter = editor!.state.doc.firstChild!;
    act(() => {
      editor!.commands.setTextSelection(frontmatter.nodeSize + 1);
      editor!.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Backspace',
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(onAppendToTitle).toHaveBeenCalledWith('First line');
    expect(editor!.getMarkdown()).toContain('Remaining');
    expect(editor!.getMarkdown()).not.toContain('First line');
  });

  it('returns to the title when Backspace starts on an empty first body line', async () => {
    let editor: Editor | null = null;
    const onFocusTitle = vi.fn();
    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content={'---\nkey: abc12345\ntags: [work]\n---\n&nbsp;\n\nRemaining'}
            onFocusTitle={onFocusTitle}
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    const frontmatter = editor!.state.doc.firstChild!;
    act(() => {
      editor!.commands.setTextSelection(frontmatter.nodeSize + 1);
      editor!.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Backspace',
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(onFocusTitle).toHaveBeenCalledTimes(1);
    expect(editor!.getMarkdown()).toContain('Remaining');
    expect(editor!.getMarkdown()).not.toContain('&nbsp;');
  });
});
