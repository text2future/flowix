import { seedWorkColumn, seedBrowserColumn } from '@features/workspace/test-support/workspace-fixtures';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { notes } from '@platform/tauri/client';
import { useNoteStore, type Notebook } from '@features/memo/store/note-store';
import { useBrowserColumnStore } from '@features/workspace/store/browser-column-store';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';
import { resetBrowserColumnCoordinator } from '@features/workspace/use-cases/browser-column-coordinator';
import { ComposerNoteReference } from './view-note';

const initialNotes = useNoteStore.getState();
const initialWorkColumn = useWorkColumnStore.getState();
const initialBrowserColumn = useBrowserColumnStore.getState();
const initialFocus = useWorkspaceFocusStore.getState();
let editor: Editor | null = null;

beforeEach(() => { vi.spyOn(notes, 'pathStatus').mockResolvedValue('present'); });

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.replaceChildren();
  resetBrowserColumnCoordinator();
  useNoteStore.setState(initialNotes);
  seedWorkColumn(initialWorkColumn);
  seedBrowserColumn(initialBrowserColumn);
  useWorkspaceFocusStore.setState(initialFocus);
  vi.restoreAllMocks();
});

it('opens the referenced note from its composer preview while a conversation is active', async () => {
  const notebook: Notebook = {
    id: 'work', name: 'Work', path: '/notes',
    createdAt: 0, updatedAt: 0, isDefault: true,
  };
  useNoteStore.setState({ notebooks: [notebook], selectedNotebook: notebook, selectedNotebookId: notebook.id });
  useBrowserColumnStore.getState().reset();
  resetBrowserColumnCoordinator();
  const conversation = { kind: 'agent-conversation' as const, instanceId: 'current-conversation' };
  seedWorkColumn({
    navigation: {
      ...initialWorkColumn.navigation,
      phase: 'committed', target: conversation,
    },
  });
  vi.spyOn(notes, 'getIndexed').mockResolvedValue({
    relativePath: 'Projects/Plan.md', title: 'Plan', preview: 'The referenced note', thumbnail: null,
    tags: [], todos: [], agents: [], createdAt: 0, updatedAt: 0,
    favorited: false, icon: null, colors: [], properties: {},
  });

  const element = document.createElement('div');
  document.body.append(element);
  editor = new Editor({
    element,
    extensions: [StarterKit, ComposerNoteReference],
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{
        type: 'noteReference', attrs: { notebookId: 'work', relativePath: 'Projects/Plan.md' },
      }] }],
    },
  });

  const card = editor.view.dom.querySelector<HTMLElement>('.note-reference__card')!;
  card.click();
  const openButton = document.querySelector<HTMLButtonElement>('.agent-composer__note-reference-preview-open')!;
  await vi.waitFor(() => expect(openButton.disabled).toBe(false));
  expect(useBrowserColumnStore.getState().current).toBeNull();

  openButton.click();
  await vi.waitFor(() => {
    const browser = useBrowserColumnStore.getState();
    expect(browser.current).not.toBeNull();
    expect(browser.current?.target).toMatchObject({
      kind: 'file-browser', activeFilePath: '/notes/Projects/Plan.md', scopePath: '/notes',
    });
  });
  expect(useWorkColumnStore.getState().navigation.target).toEqual(conversation);
  expect(document.querySelector<HTMLElement>('.agent-composer__note-reference-preview')?.hidden).toBe(true);

  card.click();
  await vi.waitFor(() => expect(openButton.disabled).toBe(false));
  openButton.click();
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>('.agent-composer__note-reference-preview')?.hidden).toBe(true));
  expect(useBrowserColumnStore.getState().current).not.toBeNull();
  expect(useWorkColumnStore.getState().navigation.target).toEqual(conversation);
});

it('keeps the current note (and its embedded conversation) in the work column', async () => {
  const notebook: Notebook = {
    id: 'work', name: 'Work', path: '/notes',
    createdAt: 0, updatedAt: 0, isDefault: true,
  };
  useNoteStore.setState({ notebooks: [notebook], selectedNotebook: notebook, selectedNotebookId: notebook.id });
  useBrowserColumnStore.getState().reset();
  resetBrowserColumnCoordinator();
  // The agent conversation lives in a thread card embedded in the current note,
  // so the work column target is the note document, not an agent-conversation.
  const currentNote = {
    kind: 'external' as const, path: '/notes/Projects/Plan.md', scopePath: '/notes', transitionId: null,
  };
  seedWorkColumn({
    navigation: {
      ...initialWorkColumn.navigation,
      phase: 'committed', target: currentNote,
    },
  });
  vi.spyOn(notes, 'getIndexed').mockResolvedValue({
    relativePath: 'Projects/Plan.md', title: 'Plan', preview: 'The referenced note', thumbnail: null,
    tags: [], todos: [], agents: [], createdAt: 0, updatedAt: 0,
    favorited: false, icon: null, colors: [], properties: {},
  });

  const element = document.createElement('div');
  document.body.append(element);
  editor = new Editor({
    element,
    extensions: [StarterKit, ComposerNoteReference],
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{
        type: 'noteReference', attrs: { notebookId: 'work', relativePath: 'Projects/Plan.md' },
      }] }],
    },
  });

  const card = editor.view.dom.querySelector<HTMLElement>('.note-reference__card')!;
  card.click();
  const openButton = document.querySelector<HTMLButtonElement>('.agent-composer__note-reference-preview-open')!;
  await vi.waitFor(() => expect(openButton.disabled).toBe(false));

  openButton.click();
  await vi.waitFor(() => {
    expect(useBrowserColumnStore.getState().current).not.toBeNull();
  });
  // The work column must not be emptied by opening the same note on the right.
  expect(useWorkColumnStore.getState().navigation.target).toEqual(currentNote);
});
