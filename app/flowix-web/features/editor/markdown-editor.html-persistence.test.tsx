import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { expect, it, vi } from 'vitest';
import { ShortcutsProvider } from '@features/shortcuts';
import { MarkdownEditor, type MarkdownEditorHandle } from './markdown-editor';

it('keeps the original buffer clean across open, layout, focus, blur and unmount', async () => {
  const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = reactGlobal.IS_REACT_ACT_ENVIRONMENT;
  reactGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const ref = createRef<MarkdownEditorHandle>();
  const onChange = vi.fn();
  const onDirty = vi.fn();
  let editor!: Editor;
  const source = '<p align="center"><img src="./docs/logo.png" width="120" /></p>\n\n| A | B |\n| --- | --- |\n| a | b |\n';
  try {
    await act(async () => {
      root.render(<ShortcutsProvider overrides={{}}><MarkdownEditor
        ref={ref} content={source} onChange={onChange} onDirty={onDirty}
        onBeforeCreate={value => {
          editor = value;
          Object.defineProperty(value.view.dom, 'clientWidth', { configurable: true, value: 800 });
        }}
      /></ShortcutsProvider>);
    });
    await act(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      editor.commands.focus();
      editor.commands.blur();
      await new Promise(resolve => setTimeout(resolve, 250));
    });
    const table = editor.state.doc.content.content.find(node => node.type.name === 'table')!;
    expect(table.firstChild!.firstChild!.attrs.colwidth).toEqual([400]);
    expect(ref.current!.getCurrentMarkdown()).toBe(source);
    expect(ref.current!.flushPendingChanges()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(onDirty).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    expect(onChange).not.toHaveBeenCalled();
    expect(onDirty).not.toHaveBeenCalled();
  } finally {
    if (ref.current) await act(async () => root.unmount());
    container.remove();
    scrollBy.mockRestore();
    reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});
