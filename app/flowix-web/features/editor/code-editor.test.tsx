import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';

import { CodeEditor, type CodeEditorHandle } from '@features/editor/code-editor';
import { ShortcutsProvider } from '@features/shortcuts';
import '@features/shortcuts/actions';

vi.mock(
  '@features/editor/extensions/codeblock-shiki/shiki/shiki-highlighter',
  () => ({
    getShiki: () => ({
      codeToTokensBase: (code: string) =>
        code.split('\n').map((line) =>
          line ? [{ content: line, color: '#123456' }] : []
        ),
      getLoadedThemes: () => ['github-light'],
      getLoadedLanguages: () => [
        'javascript',
        'typescript',
        'jsx',
        'tsx',
        'markdown',
        'python',
      ],
    }),
    loadLanguage: () => Promise.resolve(true),
  }),
);

let container: HTMLDivElement;
let root: Root;
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe('CodeEditor', () => {
  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('renders text content and synchronizes authoritative content without emitting an edit', async () => {
    const editorRef = createRef<CodeEditorHandle>();
    const onChange = vi.fn();

    await act(async () => root.render(
      <CodeEditor
        ref={editorRef}
        filePath="/project/empty.txt"
        content=""
        onChange={onChange}
      />
    ));

    expect(container.querySelector('.cm-editor')).not.toBeNull();
    expect(editorRef.current?.flushPendingChanges()).toBe('');

    await act(async () => root.render(
      <CodeEditor
        ref={editorRef}
        filePath="/project/empty.txt"
        content={'hello\n'}
        onChange={onChange}
      />
    ));

    expect(editorRef.current?.flushPendingChanges()).toBe('hello\n');
    const content = container.querySelector('.cm-content');
    expect(content?.textContent).toBe('hello');
    expect(content?.classList.contains('cm-lineWrapping')).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('moves title tail into the source body after frontmatter', async () => {
    const editorRef = createRef<CodeEditorHandle>();
    const onChange = vi.fn();
    const initialContent = '---\nflowix_key: memo-1\n---\nExisting body';
    const bodyStart = '---\nflowix_key: memo-1\n---\n'.length;

    await act(async () => root.render(
      <CodeEditor
        ref={editorRef}
        filePath="/project/note.md"
        content={initialContent}
        onChange={onChange}
      />
    ));

    act(() => editorRef.current?.moveTitleToBody?.(' tail'));

    expect(editorRef.current?.flushPendingChanges()).toBe(
      '---\nflowix_key: memo-1\n---\n tail\n\nExisting body',
    );
    expect(onChange).toHaveBeenCalledWith(
      '---\nflowix_key: memo-1\n---\n tail\n\nExisting body',
    );
    const content = container.querySelector<HTMLElement>('.cm-content');
    const view = EditorView.findFromDOM(content!);
    expect(view?.state.selection.main.from).toBe(bodyStart);
  });

  it('mounts a scroll header inside CodeMirror scrollDOM', async () => {
    await act(async () => root.render(
      <CodeEditor
        filePath="/project/note.md"
        content={'---\nflowix_key: memo-1\n---\nBody'}
        onChange={vi.fn()}
        scrollHeader={<div data-testid="source-title">Title</div>}
      />
    ));

    const scroller = container.querySelector('.cm-scroller');
    expect(scroller).not.toBeNull();
    expect(container.querySelector('.code-editor--with-scroll-header')).not.toBeNull();
    expect(scroller?.querySelector('.cm-source-header [data-testid="source-title"]')?.textContent)
      .toBe('Title');
    expect(container.querySelector('.cm-content > .cm-source-header')).not.toBeNull();
  });

  it('keeps the source title for an empty memo body', async () => {
    await act(async () => root.render(
      <CodeEditor
        filePath="/project/empty.md"
        content=""
        onChange={vi.fn()}
        scrollHeader={<div data-testid="source-title">Empty note</div>}
      />
    ));

    expect(container.querySelector('.cm-content > .cm-source-header [data-testid="source-title"]')?.textContent)
      .toBe('Empty note');
  });

  it('keeps the source header when the document content is synchronized', async () => {
    const header = <div data-testid="source-title">Title</div>;

    await act(async () => root.render(
      <CodeEditor
        filePath="/project/note.md"
        content={'---\nflowix_key: memo-1\n---\nFirst'}
        onChange={vi.fn()}
        scrollHeader={header}
      />
    ));

    await act(async () => root.render(
      <CodeEditor
        filePath="/project/note.md"
        content={'---\nflowix_key: memo-1\n---\nFirst\nSecond'}
        onChange={vi.fn()}
        scrollHeader={header}
      />
    ));

    expect(container.querySelector('.cm-content > .cm-source-header [data-testid="source-title"]')?.textContent)
      .toBe('Title');
  });

  it('tracks focus in the source header on the editor wrapper', async () => {
    await act(async () => root.render(
      <CodeEditor
        filePath="/project/note.md"
        content={'---\nflowix_key: memo-1\n---\nBody'}
        onChange={vi.fn()}
        scrollHeader={(
          <div className="source-memo-title-row">
            <div contentEditable data-testid="source-title-editable" />
          </div>
        )}
      />
    ));

    const editor = container.querySelector<HTMLElement>('.code-editor');
    const title = container.querySelector<HTMLElement>('[data-testid="source-title-editable"]');
    expect(editor?.hasAttribute('data-source-header-focused')).toBe(false);

    act(() => title?.focus());
    expect(editor?.getAttribute('data-source-header-focused')).toBe('');

    act(() => title?.blur());
    expect(editor?.hasAttribute('data-source-header-focused')).toBe(false);
  });

  it('adds a dedicated gutter layer for the source header surface', async () => {
    await act(async () => root.render(
      <CodeEditor
        filePath="/project/note.md"
        content={'---\nflowix_key: memo-1\n---\nBody'}
        onChange={vi.fn()}
        scrollHeader={<div data-testid="source-title">Title</div>}
      />
    ));

    const gutterBackground = container.querySelector<HTMLElement>(
      '.cm-gutters > .cm-source-header-gutter-background',
    );
    expect(gutterBackground).not.toBeNull();
    expect(gutterBackground?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders an MD control in the source header gutter and switches modes on click', async () => {
    const onToggleEditorMode = vi.fn();

    await act(async () => root.render(
      <CodeEditor
        filePath="/project/note.md"
        content={'---\nflowix_key: memo-1\n---\nBody'}
        onChange={vi.fn()}
        onToggleEditorMode={onToggleEditorMode}
        sourceModeToggleLabel="Switch to rich text mode"
        scrollHeader={<div data-testid="source-title">Title</div>}
      />
    ));

    const toggle = container.querySelector<HTMLButtonElement>('.cm-source-mode-toggle');
    expect(toggle?.querySelector('svg')).not.toBeNull();
    expect(toggle?.querySelector('svg')?.getAttribute('viewBox')).toBe('48 96 160 68');
    const iconPath = toggle?.querySelector('path')?.getAttribute('d') ?? '';
    expect(iconPath).toContain('M128,104');
    expect(iconPath).not.toContain('M232,48H24');
    expect(toggle?.getAttribute('aria-label')).toBe('Switch to rich text mode');

    await act(async () => toggle?.click());
    expect(onToggleEditorMode).toHaveBeenCalledOnce();
  });

  it('focuses the source body after frontmatter', async () => {
    const editorRef = createRef<CodeEditorHandle>();
    const content = '---\nflowix_key: memo-1\n---\nBody';
    const bodyStart = '---\nflowix_key: memo-1\n---\n'.length;

    await act(async () => root.render(
      <CodeEditor
        ref={editorRef}
        filePath="/project/note.md"
        content={content}
        onChange={vi.fn()}
      />
    ));

    act(() => editorRef.current?.focusStart?.());

    const codeContent = container.querySelector<HTMLElement>('.cm-content');
    const view = EditorView.findFromDOM(codeContent!);
    expect(view?.state.selection.main.from).toBe(bodyStart);
    expect(view?.state.selection.main.to).toBe(bodyStart);
  });

  it('uses the current editability when moving the title tail', async () => {
    const editorRef = createRef<CodeEditorHandle>();
    const initialContent = '---\nflowix_key: memo-1\n---\nExisting body';

    await act(async () => root.render(
      <CodeEditor
        ref={editorRef}
        filePath="/project/note.md"
        content={initialContent}
        editable={false}
        onChange={vi.fn()}
      />
    ));

    await act(async () => root.render(
      <CodeEditor
        ref={editorRef}
        filePath="/project/note.md"
        content={initialContent}
        editable
        onChange={vi.fn()}
      />
    ));

    act(() => editorRef.current?.moveTitleToBody?.(' tail'));

    expect(editorRef.current?.flushPendingChanges()).toContain(' tail\n\nExisting body');
  });

  it('colors supported languages through Shiki inline styles', async () => {
    await act(async () => root.render(
      <CodeEditor
        filePath="/project/example.js"
        content={'const answer = "yes";'}
        onChange={vi.fn()}
      />
    ));

    await act(async () => {
      await vi.waitFor(() => {
        // #123456 is serialized by the DOM as rgb(18, 52, 86).
        const colored = Array.from(container.querySelectorAll<HTMLSpanElement>('.cm-content span'))
          .find((el) => el.style.color === 'rgb(18, 52, 86)');
        expect(colored?.textContent).toBe('const answer = "yes";');
      });
    });
  });

  it('falls back to stable tagHighlighter classes for unsupported languages', async () => {
    await act(async () => root.render(
      <CodeEditor
        filePath="/project/example.pl"
        content={'if ($x) { print "yes"; }'}
        onChange={vi.fn()}
      />
    ));

    await act(async () => {
      await vi.waitFor(() => {
        expect(container.querySelector('.cm-code-keyword')?.textContent).toBe('if');
        expect(container.querySelector('.cm-code-string')?.textContent).toBe('"yes"');
      });
    });
  });

  it('selects the focused CodeMirror document through the shared action', async () => {
    await act(async () => root.render(
      <ShortcutsProvider overrides={{}}>
        <CodeEditor
          filePath="/project/example.md"
          content={'First\nSecond'}
          onChange={vi.fn()}
        />
      </ShortcutsProvider>
    ));

    const content = container.querySelector<HTMLElement>('.cm-content');
    expect(content).not.toBeNull();
    content!.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'a',
      code: 'KeyA',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => content!.dispatchEvent(event));

    const view = EditorView.findFromDOM(content!);
    expect(event.defaultPrevented).toBe(true);
    expect(view?.state.selection.main.from).toBe(0);
    expect(view?.state.selection.main.to).toBe(view?.state.doc.length);
  });

  it('undoes and redoes the focused CodeMirror document through shared actions', async () => {
    await act(async () => root.render(
      <ShortcutsProvider overrides={{}}>
        <CodeEditor
          filePath="/project/example.md"
          content="Before"
          onChange={vi.fn()}
        />
      </ShortcutsProvider>
    ));

    const content = container.querySelector<HTMLElement>('.cm-content');
    const view = EditorView.findFromDOM(content!);
    content!.focus();
    act(() => {
      view!.dispatch({ changes: { from: 6, insert: ' after' } });
    });
    expect(view!.state.doc.toString()).toBe('Before after');

    const press = (key: string, shiftKey = false) => {
      const event = new KeyboardEvent('keydown', {
        key,
        code: key === 'z' ? 'KeyZ' : 'KeyY',
        metaKey: true,
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      act(() => content!.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
    };

    press('z');
    expect(view!.state.doc.toString()).toBe('Before');
    press('z', true);
    expect(view!.state.doc.toString()).toBe('Before after');
  });

  it('exposes non-empty selections without changing CodeMirror selection state', async () => {
    await act(async () => root.render(
      <CodeEditor
        filePath="/project/example.md"
        content={'First\nSecond'}
        onChange={vi.fn()}
        scrollHeader={<div data-testid="source-title">Title</div>}
      />
    ));

    const content = container.querySelector<HTMLElement>('.cm-content');
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = EditorView.findFromDOM(content!);
    expect(editor?.hasAttribute('data-has-range-selection')).toBe(false);

    act(() => {
      view?.dispatch({ selection: { anchor: 0, head: 5 } });
    });

    expect(view?.state.selection.main.from).toBe(0);
    expect(view?.state.selection.main.to).toBe(5);
    expect(editor?.getAttribute('data-has-range-selection')).toBe('');

    act(() => {
      view?.dispatch({ selection: { anchor: 5, head: 5 } });
    });

    expect(editor?.hasAttribute('data-has-range-selection')).toBe(false);
  });

  it('keeps the range marker scoped to source memo editors', async () => {
    await act(async () => root.render(
      <CodeEditor
        filePath="/project/example.ts"
        content={'const value = 1;'}
        onChange={vi.fn()}
      />
    ));

    const content = container.querySelector<HTMLElement>('.cm-content');
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = EditorView.findFromDOM(content!);

    act(() => {
      view?.dispatch({ selection: { anchor: 0, head: 5 } });
    });

    expect(editor?.hasAttribute('data-has-range-selection')).toBe(false);
  });
});
