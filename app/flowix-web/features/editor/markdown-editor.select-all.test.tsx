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

function pasteClipboard(editor: Editor, text: string, html = '', markdown = ''): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', {
    value: {
      types: [
        ...(markdown ? ['text/markdown'] : []),
        ...(text ? ['text/plain'] : []),
        ...(html ? ['text/html'] : []),
      ],
      files: [],
      getData(type: string) {
        if (type === 'text/plain') return text;
        if (type === 'text/html') return html;
        if (type === 'text/markdown') return markdown;
        return '';
      },
    },
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}

function pressUndo(editor: Editor): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'z',
    code: 'KeyZ',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  editor.view.dom.dispatchEvent(event);
  return event;
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
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    Object.defineProperties(Range.prototype, {
      getClientRects: {
        configurable: true,
        value: () => [],
      },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 }),
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
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

  it('coalesces continuous edits before serializing Markdown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onChange = vi.fn();
    let editor: Editor | null = null;

    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content="Before"
            onChange={onChange}
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    // The mount quiet period suppresses initialization updates. Move beyond
    // it before simulating user input.
    vi.setSystemTime(600);
    act(() => {
      editor!.commands.setTextSelection(editor!.state.doc.content.size - 1);
      editor!.commands.insertContent(' one');
      editor!.commands.insertContent(' two');
    });

    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('Before one two');
    vi.useRealTimers();
  });

  it('focuses the first body paragraph when the blank editor surface is clicked', async () => {
    let editor: Editor | null = null;
    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content={'---\nflowix_key: abc12345\n---\n&nbsp;'}
            header={<textarea data-testid="memo-title" defaultValue="File title" />}
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    const surface = container.querySelector<HTMLElement>('.editor-content');
    expect(surface).not.toBeNull();

    await act(async () => {
      surface!.dispatchEvent(new MouseEvent('mousedown', {
        button: 0,
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(editor!.view.hasFocus()).toBe(true);
    expect(editor!.state.selection.empty).toBe(true);
    expect(editor!.state.selection.$from.parent.type.name).toBe('paragraph');
  });

  it('does not show the paragraph placeholder at a selected block boundary', async () => {
    let editor: Editor | null = null;
    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content="Existing"
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    act(() => {
      editor!.commands.setContent({
        type: 'doc',
        content: [
          { type: 'paragraph' },
          {
            type: 'videoAttachment',
            attrs: { src: 'https://example.com/video.mp4' },
          },
          { type: 'paragraph' },
        ],
      });
      editor!.commands.setNodeSelection(2);
    });

    const paragraphs = editor!.view.dom.querySelectorAll('p');
    expect(paragraphs[0]?.classList.contains('is-empty')).toBe(true);
    expect(paragraphs[0]?.getAttribute('data-placeholder')).toBe('');

    paragraphs[1]?.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
    }));
    expect(editor!.state.selection.empty).toBe(true);
    expect(editor!.state.selection.$from.parent.type.name).toBe('paragraph');
  });

  it('drops paragraph alignment while preserving inline formatting across markdown reloads', async () => {
    let editor: Editor | null = null;
    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content={'Existing'}
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    act(() => {
      editor!.commands.setContent(
        '<p style="text-align: start">Normal <strong>bold</strong> text</p>',
        { contentType: 'html' },
      );
    });

    const markdown = editor!.getMarkdown();
    expect(markdown).toBe('Normal **bold** text');
    expect(markdown).not.toContain('<p');
    expect(editor!.getHTML()).toBe('<p>Normal <strong>bold</strong> text</p>');

    act(() => {
      editor!.commands.setContent(markdown, { contentType: 'markdown' });
    });

    expect(editor!.getHTML()).toBe('<p>Normal <strong>bold</strong> text</p>');
  });

  it('reloads bold Chinese text when punctuation before the closing marker is followed without whitespace', async () => {
    let editor: Editor | null = null;
    const sourceHtml = '<p><strong>规则划定的是行为底线，公共文明则需要每个人主动守护。</strong>铁路部门不妨以此为契机。</p>';

    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content={'Existing'}
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    act(() => {
      editor!.commands.setContent(sourceHtml, { contentType: 'html' });
    });


    const markdown = editor!.getMarkdown();
    expect(markdown).toBe(
      '<strong>规则划定的是行为底线，公共文明则需要每个人主动守护。</strong>铁路部门不妨以此为契机。',
    );

    act(() => {
      editor!.commands.setContent(markdown, { contentType: 'markdown' });
    });

    expect(editor!.getHTML()).toBe(sourceHtml);
  });

  it('reads legacy ambiguous bold markdown and migrates it to portable inline HTML on save', async () => {
    let editor: Editor | null = null;
    const legacyMarkdown = '**规则划定的是行为底线。**铁路部门';

    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content={legacyMarkdown}
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    expect(editor!.getHTML()).toBe('<p><strong>规则划定的是行为底线。</strong>铁路部门</p>');
    expect(editor!.getMarkdown()).toBe('<strong>规则划定的是行为底线。</strong>铁路部门');
  });

  it.each(['$', '©', '😀'])('uses portable HTML when bold text ends with the symbol %s', async (symbol) => {
    let editor: Editor | null = null;
    const sourceHtml = `<p><strong>文本${symbol}</strong>后续</p>`;

    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content={'Existing'}
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    act(() => {
      editor!.commands.setContent(sourceHtml, { contentType: 'html' });
    });

    const markdown = editor!.getMarkdown();
    expect(markdown).toBe(`<strong>文本${symbol}</strong>后续`);

    act(() => {
      editor!.commands.setContent(markdown, { contentType: 'markdown' });
    });

    expect(editor!.getHTML()).toBe(sourceHtml);
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

  it('undoes content pasted directly into the document with Ctrl+Z', async () => {
    let editor: Editor | null = null;
    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content="Before"
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    act(() => {
      editor!.commands.setTextSelection(editor!.state.doc.content.size - 1);
      editor!.view.focus();
      pasteClipboard(editor!, ' pasted');
    });
    expect(editor!.getMarkdown()).toBe('Before pasted');

    act(() => {
      const event = pressUndo(editor!);
      expect(event.defaultPrevented).toBe(true);
    });
    expect(editor!.getMarkdown()).toBe('Before');
  });

  it('unwraps presentation-only spans from a webpage paste and keeps native undo', async () => {
    let editor: Editor | null = null;
    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content="Before "
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    const initial = editor!.getMarkdown();
    act(() => {
      editor!.commands.setTextSelection(editor!.state.doc.content.size - 1);
      editor!.view.focus();
      pasteClipboard(
        editor!,
        'Web text',
        '<span style="font-family: Arial; color: rgb(20, 30, 40); font-size: 14px">Web text</span>',
      );
    });

    expect(editor!.getMarkdown()).toBe('Before Web text');
    expect(editor!.getMarkdown()).not.toContain('<span');
    expect(editor!.getMarkdown()).not.toContain('&lt;span');
    expect(editor!.getHTML()).not.toContain('<span');

    act(() => {
      pressUndo(editor!);
    });
    expect(editor!.getMarkdown()).toBe(initial);
  });

  it.each([
    ['markdown blocks', '\n\n## Pasted heading\n\nPasted body', ''],
    ['rich HTML', 'Bold paste', '<p><strong>Bold paste</strong></p>'],
  ])('undoes %s paste with Ctrl+Z', async (_label, text, html) => {
    let editor: Editor | null = null;
    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content="Before"
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    act(() => {
      editor!.commands.setTextSelection(editor!.state.doc.content.size - 1);
      editor!.view.focus();
      pasteClipboard(editor!, text, html);
    });
    expect(editor!.getMarkdown()).not.toBe('Before');

    act(() => {
      pressUndo(editor!);
    });
    expect(editor!.getMarkdown()).toBe('Before');
  });

  it('keeps history when an external prop echoes a local edit before serialization settles', async () => {
    let editor: Editor | null = null;
    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content="Before"
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    act(() => {
      editor!.commands.setTextSelection(editor!.state.doc.content.size - 1);
      editor!.view.focus();
      editor!.commands.insertContent(' local');
      // Simulate the document buffer echoing the just-produced content while
      // MarkdownEditor's debounced serializer still has the old contentRef.
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content={editor!.getMarkdown()}
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    act(() => {
      pressUndo(editor!);
    });
    expect(editor!.getMarkdown()).toBe('Before');
  });

  it('keeps a managed frontmatter paste as one undo event', async () => {
    let editor: Editor | null = null;
    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content={'---\nflowix_key: abc12345\n---\nBefore'}
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    const initial = editor!.getMarkdown();
    act(() => {
      editor!.commands.setTextSelection(editor!.state.doc.content.size - 1);
      editor!.view.focus();
      pasteClipboard(
        editor!,
        '---\ntags: [pasted]\n---\nPasted body',
      );
    });

    expect(editor!.getMarkdown()).not.toBe(initial);
    act(() => {
      pressUndo(editor!);
    });
    expect(editor!.getMarkdown()).toBe(initial);
  });

  it('parses an explicit text/markdown clipboard payload as structured content', async () => {
    let editor: Editor | null = null;
    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content="Before"
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    act(() => {
      editor!.commands.setTextSelection(editor!.state.doc.content.size - 1);
      editor!.view.focus();
      pasteClipboard(editor!, '', '', '## Pasted heading\n\n- Pasted item');
    });

    expect(editor!.getHTML()).toContain('<h2>Pasted heading</h2>');
    expect(editor!.getHTML()).toContain('<li><p>Pasted item</p></li>');
  });

  it('focuses the body editor for programmatic paste', async () => {
    let editor: Editor | null = null;
    const handle = createRef<MarkdownEditorHandle>();
    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            ref={handle}
            content="Before"
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    act(() => {
      handle.current?.pasteToBody?.({
        types: ['text/plain'],
        markdown: '',
        text: 'Pasted body',
        html: '',
        uriList: [],
        files: [],
        sourceMime: 'text/plain',
      });
    });

    expect(editor!.view.hasFocus()).toBe(true);
    expect(editor!.getMarkdown()).toContain('Pasted body');
  });

  it('undoes deletion of an image atom through the ProseMirror history', async () => {
    let editor: Editor | null = null;
    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content={'Before\n\n![image](https://example.com/image.png)'}
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    act(() => {
      let imagePosition: number | null = null;
      editor!.state.doc.descendants((node, position) => {
        if (node.type.name === 'image') imagePosition = position;
      });
      expect(imagePosition).not.toBeNull();
      editor!.commands.setNodeSelection(imagePosition!);
      editor!.view.focus();
      editor!.commands.deleteSelection();
    });

    expect(editor!.state.doc.content.content.some((node) => node.type.name === 'image')).toBe(false);
    act(() => {
      pressUndo(editor!);
    });
    expect(editor!.state.doc.content.content.some((node) => node.type.name === 'image')).toBe(true);
  });

  it('starts a fresh history domain after an external document replacement', async () => {
    let editor: Editor | null = null;
    const handle = createRef<MarkdownEditorHandle>();
    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            ref={handle}
            content="Before"
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    act(() => {
      editor!.commands.setTextSelection(editor!.state.doc.content.size - 1);
      editor!.view.focus();
      editor!.commands.insertContent(' local');
      handle.current?.flushPendingChanges();
    });

    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            ref={handle}
            content="External"
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    expect(editor!.getMarkdown()).toBe('External');
    act(() => {
      pressUndo(editor!);
    });
    expect(editor!.getMarkdown()).toBe('External');
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
              content={'---\nflowix_key: buvbaqmc\n---\n# First\n\nSecond'}
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
            content={'---\nflowix_key: abc12345\ntags: [work]\n---\nExisting body'}
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
            content={'---\nflowix_key: abc12345\n---\nExisting body'}
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
            content={'---\nflowix_key: abc12345\ntags: [work]\n---\nFirst line\n\nRemaining'}
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
            content={'---\nflowix_key: abc12345\n---\nFirst line'}
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

  it('uses the latest editable state for body-to-title navigation', async () => {
    let editor: Editor | null = null;
    const onFocusTitle = vi.fn();
    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content={'---\nflowix_key: abc12345\n---\nFirst line'}
            editable={false}
            onFocusTitle={onFocusTitle}
            onBeforeCreate={(instance) => { editor = instance; }}
          />
        </ShortcutsProvider>,
      );
    });

    await act(async () => {
      root.render(
        <ShortcutsProvider overrides={{}}>
          <MarkdownEditor
            content={'---\nflowix_key: abc12345\n---\nFirst line'}
            editable
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
            content={'---\nflowix_key: abc12345\ntags: [work]\n---\nFirst line\n\nRemaining'}
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
            content={'---\nflowix_key: abc12345\ntags: [work]\n---\n&nbsp;\n\nRemaining'}
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
