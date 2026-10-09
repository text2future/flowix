import { act } from 'react';
import { invoke } from '@platform/tauri/core';
import { createRoot, type Root } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { DocumentContainer } from './document-container';
import { DocumentSaveNotifications } from './document-save-status';
import { I18nProvider } from '@/lib/i18n';
import { ShortcutsProvider } from '@features/shortcuts';
import '@features/shortcuts/actions';
import { Toaster } from 'sonner';
import { useNoteStore } from '@features/memo/store/note-store';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';
import { ensureFileDisplayIdentity, reconcileFileDisplays, findFileDisplayPath, rebaseFileDisplayPath } from '@/lib/file-display-registry';
import { getDocumentSession } from '../store/document-runtime-session';
import { getDocumentBuffer, captureLatestDocumentContent, stageDocumentSnapshot } from '../store/document-session-service';
import { notifyDocumentBufferChanged } from '../store/buffer-registry';
import { waitForDocumentCommits } from '../store/document-commit-queue';

const mocks = vi.hoisted(() => ({ recoveryRead: vi.fn().mockResolvedValue(null), read: vi.fn(), write: vi.fn(), rename: vi.fn(), publish: vi.fn() }));
vi.mock('@platform/tauri/core', () => ({ invoke: vi.fn(), convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}` }));
vi.mock('./lazy-document-editor', async () => ({
  LazyDocumentEditor: (await import('@features/editor/markdown-editor')).MarkdownEditor,
  preloadDocumentEditor: () => {},
}));
vi.mock('../use-cases/local-document-operations', () => ({ localDocumentOperations: { read: mocks.read, write: mocks.write, rename: mocks.rename } }));
vi.mock('@features/workspace/use-cases/workspace-navigation', () => ({ replaceExternalDocumentPath: (displayId: string, oldPath: string, path: string) => {
  rebaseFileDisplayPath(oldPath, path, displayId); mocks.publish(path);
} }));
vi.mock('../store/recovery-draft-store', () => ({
  persistRecoveryDraft: vi.fn().mockResolvedValue(true), readRecoveryDraft: mocks.recoveryRead,
  clearRecoveryDraftThrough: vi.fn().mockResolvedValue(undefined), rebaseRecoveryDraftPath: vi.fn(),
  flushRecoveryOperations: vi.fn().mockResolvedValue(true),
}));
vi.mock('@platform/tauri/window', () => ({ getCurrentWindow: () => ({ label: 'main', listen: async () => () => {} }) }));

let root: Root; let container: HTMLDivElement; let sequence = 0;
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
function setup(initialBoth = true) {
  const identity = { kind: 'md' as const, ...ensureFileDisplayIdentity('/container-' + ++sequence + '/A.md') };
  reconcileFileDisplays([identity]);
  let path = identity.path; let both = initialBoth; let mounts = 0;
  const editors: Record<string, Editor | null> = {};
  const ready = (host: string) => (editor: Editor | null) => { if (editor) { editors[host] = editor; mounts++; } };
  const leftReady = ready('left'); const rightReady = ready('right');
  const render = () => root.render(<I18nProvider language="en-US"><ShortcutsProvider overrides={{}}>
    <Toaster /><DocumentSaveNotifications />
    <DocumentContainer fileIdentity={{ ...identity, path }} isExternalDocument externalEditorMode="markdown" externalScopePath={path.replace(/\/[^/]+$/, '')} onEditorReady={leftReady} />
    {both && <DocumentContainer fileIdentity={{ ...identity, path }}
      isExternalDocument externalEditorMode="markdown" externalScopePath={path.replace(/\/[^/]+$/, '')} documentSessionMode="isolated" onEditorReady={rightReady} />}
  </ShortcutsProvider></I18nProvider>);
  mocks.publish.mockImplementation(next => { path = next; render(); });
  mocks.rename.mockImplementation(async request => ({ path: path.replace(/[^/]+$/, request.name) }));
  return { identity, editors, render, mounts: () => mounts,
    openRight: () => { both = true; render(); },
    closeRight: () => { both = false; render(); },
    rename: (title: string) => {
      const input = container.querySelector('textarea.memo-title-editor')! as HTMLTextAreaElement;
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, title);
      input.dispatchEvent(new InputEvent('input', { bubbles: true })); input.blur();
    } };
}

describe('real document container session lifecycle', () => {
  it('opens a just-created document without another disk or recovery read', async () => {
    const doc = setup(false);
    stageDocumentSnapshot(doc.identity, doc.identity.path, 'fresh body');
    await act(async () => { doc.render(); });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.recoveryRead).not.toHaveBeenCalled();
    expect(doc.editors.left?.getMarkdown()).toBe('fresh body');
  });
  it('ignores a recovery draft for a different path', async () => {
    const doc = setup(false);
    mocks.recoveryRead.mockResolvedValue({
      originalPath: '/old/deleted.md',
      createdAt: 100, updatedAt: 300, revision: 1, bodyRevision: 1,
      content: 'old deleted body', baseContent: 'Body',
    });
    await act(async () => { doc.render(); });
    expect(doc.editors.left?.getMarkdown()).toBe('Body');
  });
  it('automatically reconciles an opening recovery draft with independent disk edits', async () => {
    const doc = setup(false);
    const base = 'first\nsecond\n';
    const merged = 'FIRST\nSECOND\n';
    mocks.read.mockResolvedValue('first\nSECOND\n');
    mocks.recoveryRead.mockResolvedValue({
      originalPath: doc.identity.path,
      createdAt: 100, updatedAt: 300, revision: 1, bodyRevision: 1,
      content: 'FIRST\nsecond\n', baseContent: base,
    });
    mocks.write.mockResolvedValueOnce({ status: 'saved', path: doc.identity.path, content: merged, merged: true });
    await act(async () => { doc.render(); await waitForDocumentCommits('md:' + doc.identity.displayId); });
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ expectedContent: base }));
    expect(getDocumentBuffer(doc.identity)).toMatchObject({ content: merged, conflicted: false, saveState: 'clean' });
    expect(doc.editors.left?.getMarkdown()).toContain('FIRST');
    expect(doc.editors.left?.getMarkdown()).toContain('SECOND');
  });
  beforeEach(() => {
    vi.useFakeTimers(); environment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(invoke).mockReset();
    useNoteStore.setState({ notebooks: [], selectedNotebook: null });
    mocks.read.mockReset().mockResolvedValue('Body');
    mocks.recoveryRead.mockReset().mockResolvedValue(null);
    mocks.write.mockReset().mockImplementation(async request => ({ status: 'saved', path: request.path, content: request.content }));
    mocks.rename.mockReset(); mocks.publish.mockReset();
    vi.spyOn(useNoteStore.getState(), 'handleMemoEvent').mockImplementation(() => {});
    useWorkspaceFocusStore.getState().focusHost('main-third');
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 }) },
    });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); await vi.advanceTimersByTimeAsync(300); });
    container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
    environment.IS_REACT_ACT_ENVIRONMENT = false;
  });
  it('inserts a picked image into a path-based note even when another notebook is selected', async () => {
    const doc = setup(false);
    const notebook = { id: 'owner', name: 'Notebook', path: doc.identity.path.replace('/A.md', ''), createdAt: 1, updatedAt: 1, isDefault: false };
    const other = { ...notebook, id: 'other', path: '/another-notebook' };
    useNoteStore.setState({ notebooks: [other, notebook], selectedNotebook: other });
    vi.stubGlobal('__TAURI__', {});
    const saved = `${notebook.path}/attachments/fig.png`;
    vi.mocked(invoke).mockImplementation(async (command) => command === 'select_files' ? ['/selected/fig.png'] : saved);
    await act(async () => { doc.render(); });
    await act(async () => { doc.editors.left!.commands.openFileDialog({ accept: 'image/*' }); });
    expect(invoke).toHaveBeenCalledWith('save_attachment', {
      sourcePath: '/selected/fig.png', memoId: undefined, notebookId: 'owner',
    });
    const images: string[] = [];
    doc.editors.left!.state.doc.descendants(node => { if (node.type.name === 'image') images.push(node.attrs.src); });
    expect(images).toHaveLength(1);
    expect(decodeURIComponent(images[0])).toContain(saved);
    expect(doc.editors.left!.getMarkdown()).toContain('fig.png');
  });
  it('resolves the nearest notebook at upload time, excluding similar path prefixes', async () => {
    const doc = setup(false);
    await act(async () => { doc.render(); });
    const base = { name: 'Notebook', createdAt: 1, updatedAt: 1, isDefault: false };
    const path = doc.identity.path.replace('/A.md', '');
    useNoteStore.setState({ notebooks: [
      { ...base, id: 'parent', path: '/' },
      { ...base, id: 'similar', path: path.slice(0, -1) },
      { ...base, id: 'owner', path },
    ] });
    vi.stubGlobal('__TAURI__', {});
    vi.mocked(invoke).mockImplementation(async (command) => command === 'select_files' ? ['/selected/fig.png'] : `${path}/attachments/fig.png`);
    await act(async () => { doc.editors.left!.commands.openFileDialog(); });
    expect(invoke).toHaveBeenCalledWith('save_attachment', {
      sourcePath: '/selected/fig.png', memoId: undefined, notebookId: 'owner',
    });
  });
  it('does not save an image to the selected notebook when the document is outside it', async () => {
    const doc = setup(false);
    const other = { id: 'other', name: 'Other', path: '/another-notebook', createdAt: 1, updatedAt: 1, isDefault: false };
    useNoteStore.setState({ notebooks: [other], selectedNotebook: other });
    vi.stubGlobal('__TAURI__', {});
    vi.mocked(invoke).mockResolvedValue(['/selected/fig.png']);
    await act(async () => { doc.render(); });
    await act(async () => { doc.editors.left!.commands.openFileDialog(); });
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(['select_files']);
    expect(doc.editors.left!.getMarkdown()).toBe('Body');
  });
  it('opening a second view preserves scheduled autosave', async () => {
    mocks.recoveryRead.mockResolvedValue(null);
    const doc = setup(false); await act(async () => { doc.render(); });
    act(() => { doc.editors.left!.commands.insertContent('UNSAVED INPUT '); });
    await act(async () => { doc.openRight(); });
    expect(getDocumentBuffer(doc.identity).content).toContain('UNSAVED INPUT');
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('UNSAVED INPUT') }));
  });
  it('shares the complete opening across both views before accepting edits', async () => {
    let finish!: (value: null) => void;
    mocks.recoveryRead.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const doc = setup(); await act(async () => { doc.render(); });
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.recoveryRead).toHaveBeenCalledTimes(1);
    await act(async () => { finish(null); });
    expect(doc.editors.left).toBeTruthy();
    expect(doc.editors.right).toBeTruthy();
    act(() => { doc.editors.left!.commands.insertContent('NEW INPUT '); captureLatestDocumentContent(doc.identity); });
    expect(getDocumentBuffer(doc.identity).content).toContain('NEW INPUT');
    expect(doc.editors.right!.getMarkdown()).toContain('NEW INPUT');
  });
  it('keeps both editors and their session through repeated renames, with no body reload', async () => {
    const doc = setup(); await act(async () => { doc.render(); });
    const initialReads = mocks.read.mock.calls.length;
    const left = doc.editors.left!; const right = doc.editors.right!;
    const session = getDocumentSession(doc.identity);
    const bodyRevision = session.buffer!.capturedRevision;
    await act(async () => { doc.rename('B'); await waitForDocumentCommits('md:' + doc.identity.displayId); });
    await act(async () => { doc.rename('C'); await waitForDocumentCommits('md:' + doc.identity.displayId); });
    expect(mocks.read).toHaveBeenCalledTimes(initialReads);
    expect(initialReads).toBe(1);
    expect(doc.mounts()).toBe(2); expect(doc.editors.left).toBe(left); expect(doc.editors.right).toBe(right);
    expect(getDocumentSession(doc.identity)).toBe(session);
    expect(session.buffer!.capturedRevision).toBe(bodyRevision);
    expect(session.identity.path).toMatch(/C.md$/);
    expect(mocks.rename.mock.calls.map(([request]) => request.path)).toEqual([doc.identity.path, doc.identity.path.replace('A.md', 'B.md')]);
    act(() => { left.commands.insertContent('after rename '); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(mocks.write).toHaveBeenLastCalledWith(expect.objectContaining({ path: session.identity.path, content: expect.stringContaining('after rename') }));
    act(() => { left.commands.undo(); }); expect(left.getMarkdown()).toBe('Body');
  });
  it('saves body at the confirmed path when the title is rejected', async () => {
    const doc = setup(); await act(async () => { doc.render(); });
    mocks.rename.mockRejectedValueOnce(new Error('name already exists'));
    await act(async () => { doc.rename('Taken'); await waitForDocumentCommits('md:' + doc.identity.displayId); });
    act(() => { doc.editors.left!.commands.insertContent('retained body '); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(findFileDisplayPath(doc.identity.displayId)).toBe(doc.identity.path);
    expect(mocks.write).toHaveBeenLastCalledWith(expect.objectContaining({ path: doc.identity.path, content: expect.stringContaining('retained body') }));
    expect((container.querySelector('textarea.memo-title-editor') as HTMLTextAreaElement).value).toBe('Taken');
    expect(doc.mounts()).toBe(2);
  });
  it('captures outgoing input before enabling the other view and ignores inactive snapshots', async () => {
    const doc = setup(); await act(async () => { doc.render(); });
    act(() => { doc.editors.left!.commands.insertContent('left '); });
    await act(async () => { useWorkspaceFocusStore.getState().focusHost('browser-column'); });
    expect(getDocumentBuffer(doc.identity).content).toContain('left');
    expect(doc.editors.right!.getMarkdown()).toContain('left');
    act(() => { doc.editors.right!.commands.insertContent('right '); });
    act(() => { captureLatestDocumentContent(doc.identity); });
    expect(getDocumentBuffer(doc.identity).content).toContain('right');
    expect(getDocumentBuffer(doc.identity).content).toContain('left');
  });
  it('shows one conflict panel in the focused editor when another view closes', async () => {
    const doc = setup(); await act(async () => { doc.render(); });
    act(() => {
      const buffer = getDocumentBuffer(doc.identity); buffer.conflicted = true; buffer.saveState = 'conflict';
      notifyDocumentBufferChanged(doc.identity, 'save_settled');
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(container.querySelectorAll('.document-container [role="alert"]')).toHaveLength(1);
    expect(container.querySelector('.document-container [role="alert"]')?.textContent).toContain('Saved version conflicts');
    expect([...container.querySelectorAll('.document-container [role="alert"] button')].map(button => button.textContent))
      .toEqual(['Use the file version', 'Use editor version']);
    await act(async () => { doc.closeRight(); await vi.advanceTimersByTimeAsync(300); });
    expect(container.querySelectorAll('.document-container [role="alert"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-sonner-toast]')).toHaveLength(0);
  });
});
