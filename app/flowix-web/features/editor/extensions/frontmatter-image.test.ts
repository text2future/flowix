import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { dialogs, files, notebookAssets } from '@platform/tauri/client';
import { useNoteStore, type Notebook } from '@features/memo/store/note-store';
import { useSettingsStore } from '@/lib/store/settings-store';
import { parseVisibleFrontmatter } from '@features/document/properties/frontmatter-model';
import Frontmatter from './frontmatter';

vi.mock('@platform/tauri/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@platform/tauri/client')>();
  return {
    ...actual,
    dialogs: { ...actual.dialogs, selectFiles: vi.fn(async () => ['/source/photo.png']) },
    notebookAssets: { ...actual.notebookAssets, saveFromPath: vi.fn(async () => ({ path: '/notes/attachments/photo.png' })) },
    files: { ...actual.files, readImage: vi.fn(async () => 'data:image/png;base64,preview') },
  };
});

const originalNotebooks = useNoteStore.getState().notebooks;
const originalPropertiesVisible = useSettingsStore.getState().propertiesVisible;
let editor: Editor | undefined;
let host: HTMLElement | undefined;
afterEach(async () => {
  await act(async () => editor?.destroy());
  host?.remove();
  useNoteStore.setState({ notebooks: originalNotebooks });
  useSettingsStore.setState({ propertiesVisible: originalPropertiesVisible });
  vi.clearAllMocks();
});

it('uploads an empty image property, persists its relative path, renders its thumbnail and respects read-only mode', async () => {
  useNoteStore.setState({ notebooks: [{ id: 'image-notebook', path: '/notes' } as Notebook] });
  useSettingsStore.setState({ propertiesVisible: true });
  host = document.createElement('div');
  document.body.append(host);
  await act(async () => {
    editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter.configure({ getAttachmentNotebookId: () => 'image-notebook' })],
      content: '---\nphoto: ""\nflowix_property_types:\n  photo: Image\n---\nBody',
      contentType: 'markdown',
    });
  });
  const value = () => host!.querySelector<HTMLElement>('[data-property-type="Image"]')!;
  expect(value().getAttribute('role')).toBeNull();
  expect(value().querySelector('img')).toBeNull();
  await act(async () => {
    value().querySelector('button')!.click();
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
  expect(dialogs.selectFiles).toHaveBeenCalledWith({ accept: 'image/*', multiple: false });
  expect(notebookAssets.saveFromPath).toHaveBeenCalledWith('/source/photo.png', { notebookId: 'image-notebook' });
  expect(parseVisibleFrontmatter(editor!.state.doc.firstChild!.attrs.yamlContent).data.photo)
    .toEqual(['attachments/photo.png']);
  expect(files.readImage).toHaveBeenCalledWith('/notes/attachments/photo.png', '/notes');
  expect(value().querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,preview');
  expect(document.querySelector('.frontmatter-property__edit-popover')).toBeNull();
  await act(async () => {
    editor!.setEditable(false);
    editor!.view.dom.dispatchEvent(new Event('flowix:editor-editability-change'));
  });
  expect(value().querySelector('button')!.disabled).toBe(true);
});
