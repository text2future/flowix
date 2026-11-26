import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotePickerController } from './note-picker-controller';
import { ComposerAddMenuController } from '../composer/composer-add-menu-controller';
import type { ComposerAttachmentController } from '../composer/composer-attachment-controller';

const mocks = vi.hoisted(() => ({
  searchPathNotes: vi.fn(),
  notebooks: [{ id: 'notebook-1', name: 'Notes' }],
}));

vi.mock('@platform/tauri/client', () => ({
  notes: { search: mocks.searchPathNotes },
}));
vi.mock('@features/memo/store/note-store', () => ({
  useNoteStore: { getState: () => ({ notebooks: mocks.notebooks }) },
}));

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  mocks.searchPathNotes.mockReset();
});

describe('NotePickerController', () => {
  it('searches indexed notes and inserts a path reference without role choices', async () => {
    vi.useFakeTimers();
    mocks.searchPathNotes.mockResolvedValue([{ relativePath: 'Projects/Plan.md', title: 'Plan' }]);
    const trigger = document.createElement('button');
    const popover = document.createElement('div');
    const addPopover = document.createElement('div');
    document.body.append(trigger, addPopover, popover);
    const injectMemoReference = vi.fn();
    let addMenu: ComposerAddMenuController | null = null;
    const picker = new NotePickerController({
      trigger,
      popover,
      t: (key) => key,
      isDestroyed: () => false,
      injectMemoReference,
      onSelect: () => addMenu?.close(),
    });

    addMenu = new ComposerAddMenuController({
      trigger,
      popover: addPopover,
      notePopover: popover,
      notePicker: picker,
      attachments: { addFiles: vi.fn() } as unknown as ComposerAttachmentController,
      t: (key) => key,
      isDestroyed: () => false,
    });
    trigger.click();
    const addNote = addPopover.querySelector<HTMLButtonElement>('button');
    expect(addNote?.textContent).toContain('editor.threadCard.addNote');
    addNote?.dispatchEvent(new Event('pointerenter'));
    addNote?.click();
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS_FOR_TEST);
    expect(mocks.searchPathNotes).toHaveBeenCalledWith('notebook-1', '', 10);
    expect(popover.textContent).toContain('Plan');
    expect(popover.textContent).not.toContain('selectRole');
    popover.querySelector<HTMLButtonElement>('.agent-composer__note-item')?.click();
    expect(injectMemoReference).toHaveBeenCalledWith(expect.objectContaining({
      notebookId: 'notebook-1',
      relativePath: 'Projects/Plan.md',
      title: 'Plan',
    }));
    expect(popover.hidden).toBe(true);
    expect(addPopover.hidden).toBe(true);
    addMenu.dispose();
    picker.dispose();
  });
});

const SEARCH_DELAY_MS_FOR_TEST = 160;
