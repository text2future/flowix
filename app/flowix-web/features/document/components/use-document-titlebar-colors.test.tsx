import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureFileDisplayIdentity, reconcileFileDisplays } from '@/lib/file-display-registry';
import { useNoteStore } from '@features/memo/store/note-store';
import type { NoteListItem } from '@/types/note-item';
import { useDocumentTitlebarColors } from './use-document-titlebar-colors';
import { resolveDocumentTitlebarTarget, type DocumentTitlebarTarget } from './document-titlebar-model';

const mocks = vi.hoisted(() => ({ save: vi.fn(), read: vi.fn(), error: vi.fn() }));
vi.mock('../public/path-properties', () => ({ setDocumentProperties: mocks.save }));
vi.mock('@platform/tauri/client', () => ({ notes: { readDocument: mocks.read } }));
// 树里有 import { DEFAULT_APP_LANGUAGE } 的模块（lib/constants、错误边界），
// 只 mock useI18n 会让它们在加载期就失败。
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  translate: (_language: string, key: string) => key,
  DEFAULT_APP_LANGUAGE: 'zh-CN',
}));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.error } }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn() }) }));
vi.mock('@features/memo/store/note-store', async () => {
  const { create } = await import('zustand');
  return {
    NOTE_COLORS: ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'gray'],
    useNoteStore: create(() => ({ notes: [] })),
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function note(target: DocumentTitlebarTarget): NoteListItem {
  return {
    kind: 'path-note', notebookId: target.notebookId!, relativePath: target.relativePath!,
    filename: target.relativePath!, title: '', preview: '', thumbnail: null,
    tags: [], todos: [], agents: [], createdAt: 0, updatedAt: 0, favorited: false,
    icon: null, colors: [], properties: {},
  };
}
let sequence = 0;
let root: Root;
let model: ReturnType<typeof useDocumentTitlebarColors>;
let target: DocumentTitlebarTarget;
let operations: ReturnType<typeof deferred<boolean>>[];
function Probe({ target }: { target: DocumentTitlebarTarget }) {
  model = useDocumentTitlebarColors(target);
  return null;
}
beforeEach(async () => {
  vi.clearAllMocks();
  operations = [];
  mocks.save.mockImplementation(() => {
    const operation = deferred<boolean>();
    operations.push(operation);
    return operation.promise;
  });
  const fileIdentity = ensureFileDisplayIdentity(`/book/color-${++sequence}.md`);
  reconcileFileDisplays([fileIdentity]);
  target = resolveDocumentTitlebarTarget(fileIdentity, {
    fileIdentity, scopePath: '/book', notebookId: 'book', notebookPath: '/book', relativePath: `color-${sequence}.md`, indexable: true,
  }, '/book');
  useNoteStore.setState({ notes: [note(target)] });
  root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Probe target={target} />));
});
afterEach(async () => { await act(async () => root.unmount()); });

describe('titlebar color persistence', () => {
  it('shows both selections immediately and serializes writes without reverting to an intermediate projection', async () => {
    await act(async () => model.changeColors(['red']));
    await act(async () => model.changeColors(['red', 'blue']));
    expect(model.colors).toEqual(['red', 'blue']);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    await act(async () => operations[0].resolve(true));
    expect(model.colors).toEqual(['red', 'blue']);
    expect(mocks.save).toHaveBeenLastCalledWith(target.fileIdentity.path, { flowix_colors: ['red', 'blue'] });
    await act(async () => operations[1].resolve(true));
    expect(useNoteStore.getState().notes[0].colors).toEqual(['red', 'blue']);
  });

  it('retains the unsaved selection on failure and allows later writes', async () => {
    await act(async () => model.changeColors(['red']));
    await act(async () => operations[0].reject(new Error('disk failed')));
    expect(model.colors).toEqual(['red']);
    expect(mocks.error).toHaveBeenCalledOnce();
    await act(async () => useNoteStore.setState({ notes: [note(target)] }));
    expect(model.colors).toEqual(['red']);
    await act(async () => model.changeColors(['green']));
    await act(async () => operations[1].resolve(true));
    expect(model.colors).toEqual(['green']);
  });

  it('ignores a slow frontmatter read after the user has selected a color', async () => {
    const read = deferred<string>();
    mocks.read.mockReturnValue(read.promise);
    await act(async () => {
      useNoteStore.setState({ notes: [] });
      root.render(<Probe key="without-projection" target={target} />);
    });
    await act(async () => model.changeColors(['red']));
    await act(async () => read.resolve('---\nflowix_colors: [gray]\n---\nbody'));
    expect(model.colors).toEqual(['red']);
    await act(async () => operations[0].resolve(true));
  });

  it('keeps a pending write attached to its original file when the titlebar changes targets', async () => {
    await act(async () => model.changeColors(['red']));
    const fileIdentity = ensureFileDisplayIdentity(`/book/other-${sequence}.md`);
    reconcileFileDisplays([target.fileIdentity, fileIdentity]);
    const other = resolveDocumentTitlebarTarget(fileIdentity, {
      fileIdentity, scopePath: '/book', notebookId: 'book', notebookPath: '/book', relativePath: `other-${sequence}.md`, indexable: true,
    }, '/book');
    await act(async () => {
      useNoteStore.setState({ notes: [...useNoteStore.getState().notes,
        note(other)] });
      root.render(<Probe key="other" target={other} />);
    });
    await act(async () => model.changeColors(['blue']));
    await act(async () => operations[1].resolve(true));
    await act(async () => operations[0].resolve(true));
    expect(model.colors).toEqual(['blue']);
    expect(useNoteStore.getState().notes.map((note) => note.colors)).toEqual([['red'], ['blue']]);
  });

  it('keeps writes serialized when the same file gets a new titlebar instance', async () => {
    await act(async () => model.changeColors(['red']));
    await act(async () => root.render(<Probe key="reopened" target={target} />));
    await act(async () => model.changeColors(['blue']));
    expect(mocks.save).toHaveBeenCalledTimes(1);
    await act(async () => operations[0].resolve(true));
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(model.colors).toEqual(['blue']);
    await act(async () => operations[1].resolve(true));
    expect(useNoteStore.getState().notes[0].colors).toEqual(['blue']);
  });
});
