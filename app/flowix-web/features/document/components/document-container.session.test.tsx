import { act, type ComponentProps } from 'react';
import { invoke } from '@platform/tauri/core';
import { createRoot, type Root } from 'react-dom/client';
import type { Editor, JSONContent } from '@tiptap/core';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { DocumentContainer } from './document-container';
import { DocumentSaveNotifications } from './document-save-status';
import { ActionableNoticeHost } from '@features/notifications/actionable-notice-host';
import { I18nProvider } from '@/lib/i18n';
import { ShortcutsProvider } from '@features/shortcuts';
import '@features/shortcuts/actions';
import { Toaster } from 'sonner';
import { useNoteStore } from '@features/memo/store/note-store';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';
import { useWorkspaceSessionStore } from '@features/workspace/store/workspace-session-store';
import { ensureFileDisplayIdentity, reconcileFileDisplays, findFileDisplayPath, rebaseFileDisplayPath } from '@/lib/file-display-registry';
import { getDocumentSession } from '../store/document-runtime-session';
import { getDocumentBuffer, captureLatestDocumentContent, stageDocumentSnapshot } from '../store/document-session-service';
import { notifyDocumentBufferChanged } from '../store/buffer-registry';
import { waitForDocumentCommits } from '../store/document-commit-queue';
import { EditorView } from '@codemirror/view';
import { publishAgentLocationRequest, peekAgentLocationRequest } from '../use-cases/agent-location-navigation';
import * as attachmentIo from '@features/editor/extensions/attachment-link/upload/io';

const mocks = vi.hoisted(() => ({
  recoveryRead: vi.fn().mockResolvedValue(null),
  read: vi.fn(),
  write: vi.fn(),
  rename: vi.fn(),
  publish: vi.fn(),
  parseMarkdown: vi.fn<(markdown: string) => Promise<{
    id: number;
    ok: boolean;
    document?: JSONContent;
    workerMs?: number;
    error?: string;
  }>>(),
}));
vi.mock('@platform/tauri/core', () => ({ invoke: vi.fn(), convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}` }));
vi.mock('@features/editor/markdown-parser', () => ({ parseMarkdownInWorker: mocks.parseMarkdown }));
vi.mock('./lazy-document-editor', async () => ({
  LazyDocumentEditor: (await import('@features/editor/markdown-editor')).MarkdownEditor,
  preloadDocumentEditor: () => {},
}));
vi.mock('../use-cases/local-document-operations', () => ({
  markdownFilenameForTitle: (path: string, title: string) => {
    const extension = path.match(/(\.markdown|\.md)$/i)?.[0] ?? '';
    const trimmed = title.trim();
    return trimmed ? `${trimmed}${extension}` : null;
  },
  renameMarkdownTitle: async ({ path, title, onPathChanged }: {
    path: string; title: string; onPathChanged?: (oldPath: string, newPath: string) => void;
  }) => {
    const filename = `${title.trim()}.md`;
    const renamed = await mocks.rename({ path, name: filename });
    onPathChanged?.(path, renamed.path);
    return { path: renamed.path, filename: renamed.path.split(/[\\/]/).pop() ?? filename, changed: true };
  },
  localDocumentOperations: { read: mocks.read, write: mocks.write, rename: mocks.rename },
}));
vi.mock('@platform/tauri/client/desktop', async importOriginal => {
  const original = await importOriginal<typeof import('@platform/tauri/client/desktop')>();
  return {
    ...original,
    files: {
      ...original.files,
      rename: async (path: string, name: string, scopePath: string) => (await mocks.rename({ path, name, scopePath })).path,
    },
  };
});
vi.mock('@features/memo/services/note-link-rewriter', () => ({ updateNoteLinksAfterMove: vi.fn() }));
vi.mock('@features/workspace/use-cases/workspace-navigation', () => ({ replaceExternalDocumentPath: (displayId: string, oldPath: string, path: string) => {
  rebaseFileDisplayPath(oldPath, path, displayId); mocks.publish(path);
}, openExternalTarget: vi.fn().mockResolvedValue({ host: 'column-1', state: 'active' }) }));
vi.mock('../store/recovery-draft-store', () => ({
  persistRecoveryDraft: vi.fn().mockResolvedValue(true), readRecoveryDraft: mocks.recoveryRead,
  clearRecoveryDraftThrough: vi.fn().mockResolvedValue(undefined), rebaseRecoveryDraftPath: vi.fn(),
  flushRecoveryOperations: vi.fn().mockResolvedValue(true),
}));
vi.mock('@platform/tauri/window', () => ({ getCurrentWindow: () => ({ label: 'main', listen: async () => () => {} }) }));

let root: Root; let container: HTMLDivElement; let sequence = 0;
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
function pasteScreenshot(editor: Editor): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', {
    value: {
      types: ['Files'],
      files: [new File(['image'], 'Screenshot.png', { type: 'image/png' })],
      getData: () => '',
    },
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}

function setup(initialBoth = true, callbacks: Pick<ComponentProps<typeof DocumentContainer>, 'onContentStateChange' | 'onSurfaceLifecycleReady'> = {}) {
  useWorkspaceSessionStore.getState().setBrowserLayout({ visible: initialBoth });
  const identity = { kind: 'md' as const, ...ensureFileDisplayIdentity('/container-' + ++sequence + '/A.md') };
  reconcileFileDisplays([identity]);
  let path = identity.path; let both = initialBoth; let mounts = 0;
  const editors: Record<string, Editor | null> = {};
  const ready = (host: string) => (editor: Editor | null) => { if (editor) { editors[host] = editor; mounts++; } };
  const leftReady = ready('left'); const rightReady = ready('right');
  const render = () => root.render(<I18nProvider language="en-US"><ShortcutsProvider overrides={{}}>
    <Toaster /><DocumentSaveNotifications /><ActionableNoticeHost />
    <DocumentContainer {...callbacks} fileIdentity={{ ...identity, path }} isExternalDocument externalEditorMode="markdown" externalScopePath={path.replace(/\/[^/]+$/, '')} onEditorReady={leftReady} />
    {both && <DocumentContainer fileIdentity={{ ...identity, path }}
      isExternalDocument externalEditorMode="markdown" externalScopePath={path.replace(/\/[^/]+$/, '')} documentSessionMode="isolated" onEditorReady={rightReady} />}
  </ShortcutsProvider></I18nProvider>);
  mocks.publish.mockImplementation(next => { path = next; render(); });
  mocks.rename.mockImplementation(async request => ({ path: path.replace(/[^/]+$/, request.name) }));
  return { identity, editors, render, mounts: () => mounts,
    openRight: () => { both = true; useWorkspaceSessionStore.getState().setBrowserLayout({ visible: true }); render(); },
    closeRight: () => { both = false; useWorkspaceSessionStore.getState().setBrowserLayout({ visible: false }); render(); },
    rename: (title: string) => {
      const input = container.querySelector('textarea.memo-title-editor')! as HTMLTextAreaElement;
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, title);
      input.dispatchEvent(new InputEvent('input', { bubbles: true })); input.blur();
    } };
}

describe('real document container session lifecycle', () => {
  it('reports loading until the editor is mounted, then registers its ready lifecycle', async () => {
    const onContentStateChange = vi.fn();
    const onSurfaceLifecycleReady = vi.fn();
    const doc = setup(false, { onContentStateChange, onSurfaceLifecycleReady });
    let finishParse!: (reply: {
      id: number;
      ok: boolean;
      document?: JSONContent;
      workerMs?: number;
      error?: string;
    }) => void;
    mocks.parseMarkdown.mockImplementationOnce(() => new Promise((resolve) => { finishParse = resolve; }));
    await act(async () => { doc.render(); });
    expect(mocks.read).toHaveBeenCalled();
    expect(mocks.parseMarkdown).toHaveBeenCalledWith('Body');
    expect(doc.editors.left).toBeUndefined();
    expect(onContentStateChange).toHaveBeenLastCalledWith({ status: 'loading', retainContent: true });
    expect(onSurfaceLifecycleReady).not.toHaveBeenCalled();
    // A caller-provided content-state callback owns its loading presentation;
    // DocumentContainer only renders its fallback spinner without that callback.
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(async () => {
      finishParse({
        id: 1,
        ok: true,
        document: { type: 'doc', content: [{ type: 'paragraph' }] },
        workerMs: 1,
      });
    });
    expect(doc.editors.left).toBeDefined();
    expect(onContentStateChange).toHaveBeenLastCalledWith({ status: 'ready' });
    expect(onSurfaceLifecycleReady).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'ready' }));
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('switches a rich Markdown view to source and consumes a pending Agent location after load', async () => {
    const doc = setup(false);
    mocks.read.mockResolvedValue('first\nsecond\nthird');
    publishAgentLocationRequest({
      path: doc.identity.path,
      location: { line: 2, column: 3 },
      host: 'column-1',
      viewId: 'column-1',
    });

    await act(async () => { doc.render(); });
    const content = container.querySelector<HTMLElement>('.cm-content');
    expect(content).not.toBeNull();
    const view = EditorView.findFromDOM(content!);
    expect(view).not.toBeNull();
    expect(view!.state.selection.main.from).toBe(view!.state.doc.line(2).from + 2);
  });

  it('reveals a cross-document heading anchor in the rich text view without switching to source', async () => {
    const doc = setup(false);
    mocks.read.mockResolvedValue('## 实验步骤\n\n正文段落');
    publishAgentLocationRequest({
      path: doc.identity.path,
      anchor: '实验步骤',
      host: 'column-1',
      viewId: 'column-1',
    });

    await act(async () => { doc.render(); });
    // 标题锚点是语义定位：富文本视图保持不变，不切换源码。
    expect(container.querySelector('.cm-content')).toBeNull();
    expect(doc.editors.left).not.toBeNull();
    // 定位请求被消费。
    expect(peekAgentLocationRequest(doc.identity.path)).toBeNull();
  });

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
    vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
    useNoteStore.setState({ notebooks: [], selectedNotebook: null });
    mocks.parseMarkdown.mockReset().mockRejectedValue(new Error('Web Workers are unavailable'));
    mocks.read.mockReset().mockResolvedValue('Body');
    mocks.recoveryRead.mockReset().mockResolvedValue(null);
    mocks.write.mockReset().mockImplementation(async request => ({ status: 'saved', path: request.path, content: request.content }));
    mocks.rename.mockReset(); mocks.publish.mockReset();
    vi.spyOn(useNoteStore.getState(), 'handleMemoEvent').mockImplementation(() => {});
    useWorkspaceFocusStore.getState().focusColumn('column-1');
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
  it('pastes a screenshot into its owning note when another notebook is selected', async () => {
    const doc = setup(false);
    const notebook = { id: 'owner', name: 'Notebook', path: doc.identity.path.replace('/A.md', ''), createdAt: 1, updatedAt: 1, isDefault: false };
    const other = { ...notebook, id: 'other', path: '/another-notebook' };
    useNoteStore.setState({ notebooks: [other, notebook], selectedNotebook: other });
    vi.spyOn(attachmentIo, 'readFileBase64').mockResolvedValue('aW1hZ2U=');
    const saved = `${notebook.path}/attachments/Screenshot.png`;
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'begin_attachment_upload') return 'screenshot-upload';
      if (command === 'finish_attachment_upload') return { path: saved, created: true };
    });

    await act(async () => { doc.render(); });
    await act(async () => { expect(pasteScreenshot(doc.editors.left!).defaultPrevented).toBe(true); });

    expect(invoke).toHaveBeenCalledWith('begin_attachment_upload', {
      notePath: doc.identity.path, fileName: 'Screenshot.png', size: 5, deduplicate: true,
    });
    expect(invoke).toHaveBeenCalledWith('append_attachment_upload', {
      uploadId: 'screenshot-upload', offset: 0, content: 'aW1hZ2U=',
    });
    expect(invoke).toHaveBeenCalledWith('finish_attachment_upload', { uploadId: 'screenshot-upload' });
    expect(doc.editors.left!.getMarkdown()).toContain('Screenshot.png');
    expect(doc.editors.left!.getMarkdown()).toContain(encodeURIComponent(saved));
  });
  it.each(['paste', 'insertFiles', 'drop'] as const)('uses the renamed note path for %s without remounting the editor', async method => {
    const doc = setup(false);
    const notebook = { id: 'owner', name: 'Notebook', path: doc.identity.path.replace('/A.md', ''), createdAt: 1, updatedAt: 1, isDefault: false };
    useNoteStore.setState({ notebooks: [notebook], selectedNotebook: notebook });
    vi.spyOn(attachmentIo, 'readFileBase64').mockResolvedValue('aW1hZ2U=');
    const saved = `${notebook.path}/attachments/Screenshot.png`;
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'begin_attachment_upload') return 'screenshot-upload';
      if (command === 'finish_attachment_upload') return { path: saved, created: true };
    });
    await act(async () => { doc.render(); });
    const editor = doc.editors.left!;
    await act(async () => { doc.rename('Renamed'); await waitForDocumentCommits('md:' + doc.identity.displayId); });
    const renamedPath = `${notebook.path}/Renamed.md`;
    expect(findFileDisplayPath(doc.identity.displayId)).toBe(renamedPath);

    await act(async () => {
      if (method === 'paste') {
        pasteScreenshot(editor);
        return;
      }
      const files = [new File(['image'], 'Screenshot.png', { type: 'image/png' })];
      if (method === 'insertFiles') {
        expect(editor.commands.insertFiles({ files })).toBe(true);
        return;
      }
      vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: editor.state.selection.from, inside: -1 });
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        dataTransfer: { value: { files, types: ['Files'], getData: () => '' } },
        clientX: { value: 0 },
        clientY: { value: 0 },
      });
      editor.view.dom.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    expect(invoke).toHaveBeenCalledWith('begin_attachment_upload', {
      notePath: renamedPath, fileName: 'Screenshot.png', size: 5, deduplicate: true,
    });
    expect(editor.getMarkdown()).toContain('Screenshot.png');
    expect(doc.editors.left).toBe(editor);
    expect(doc.mounts()).toBe(1);
  });
  it('inserts a picked image into a path-based note even when another notebook is selected', async () => {
    const doc = setup(false);
    const notebook = { id: 'owner', name: 'Notebook', path: doc.identity.path.replace('/A.md', ''), createdAt: 1, updatedAt: 1, isDefault: false };
    const other = { ...notebook, id: 'other', path: '/another-notebook' };
    useNoteStore.setState({ notebooks: [other, notebook], selectedNotebook: other });
    vi.stubGlobal('__TAURI__', {});
    const saved = `${notebook.path}/attachments/fig.png`;
    vi.mocked(invoke).mockImplementation(async (command) => command === 'select_files' ? ['/selected/fig.png'] : { path: saved, created: true });
    await act(async () => { doc.render(); });
    await act(async () => { doc.editors.left!.commands.openFileDialog({ accept: 'image/*' }); });
    expect(invoke).toHaveBeenCalledWith('save_notebook_asset', {
      sourcePath: '/selected/fig.png', notebookId: 'owner', deduplicate: true, reuseNotebookFile: false, reuseExistingAttachment: true,
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
    vi.mocked(invoke).mockImplementation(async (command) => command === 'select_files' ? ['/selected/fig.png'] : { path: `${path}/attachments/fig.png`, created: true });
    await act(async () => { doc.editors.left!.commands.openFileDialog(); });
    expect(invoke).toHaveBeenCalledWith('save_notebook_asset', {
      sourcePath: '/selected/fig.png', notebookId: 'owner', deduplicate: true, reuseNotebookFile: false, reuseExistingAttachment: true,
    });
  });
  it('does not save an image to the selected notebook when the document is outside it', async () => {
    const doc = setup(false);
    const other = { id: 'other', name: 'Other', path: '/another-notebook', createdAt: 1, updatedAt: 1, isDefault: false };
    useNoteStore.setState({ notebooks: [other], selectedNotebook: other });
    vi.stubGlobal('__TAURI__', {});
    vi.mocked(invoke).mockResolvedValue(['/selected/fig.png']);
    await act(async () => { doc.render(); });
    vi.mocked(invoke).mockClear();
    await act(async () => { doc.editors.left!.commands.openFileDialog(); });
    // The watch lease is unrelated lifecycle noise; assert no asset was saved.
    expect(invoke).not.toHaveBeenCalledWith('save_notebook_asset', expect.anything());
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
    // A rejected rename restores the confirmed title and keeps the attempted
    // title recoverable through an explicit action.
    expect((container.querySelector('textarea.memo-title-editor') as HTMLTextAreaElement).value).toBe('A');
    expect(container.textContent).toContain('Recover unsaved title');
    expect(getDocumentSession(doc.identity).restoredTitle?.draft).toBe('Taken');
    expect(doc.mounts()).toBe(2);
  });
  it('autosaves committed content without submitting or closing an active property draft', async () => {
    const doc = setup();
    mocks.read.mockResolvedValue('---\ncustom: old\n---\nBody');
    await act(async () => { doc.render(); });
    act(() => { doc.editors.left!.commands.insertContent('pending body '); });
    act(() => {
      doc.editors.left!.view.dom.querySelector<HTMLElement>('.frontmatter-property__display-value')!.click();
    });
    const input = document.body.querySelector<HTMLTextAreaElement>('.frontmatter-property__edit-input')!;
    input.value = 'still typing';
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(document.body.querySelector('.frontmatter-property__edit-input')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('still typing');
    expect(getDocumentBuffer(doc.identity).content).toContain('custom: old');
    expect(getDocumentBuffer(doc.identity).content).not.toContain('still typing');
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('pending body'),
    }));
    expect(mocks.write.mock.calls.every(([request]) => !request.content.includes('still typing'))).toBe(true);
  });
  it('captures an open property draft when workspace ownership changes without a pointer event', async () => {
    const doc = setup();
    mocks.read.mockResolvedValue('---\ncustom: old\n---\nBody');
    await act(async () => { doc.render(); });
    act(() => {
      doc.editors.left!.view.dom.querySelector<HTMLElement>('.frontmatter-property__display-value')!.click();
    });
    const input = document.body.querySelector<HTMLTextAreaElement>('.frontmatter-property__edit-input')!;
    expect(input).not.toBeNull();
    input.value = 'retained draft';
    await act(async () => { useWorkspaceFocusStore.getState().focusColumn('column-2'); });
    expect(getDocumentBuffer(doc.identity).content).toContain('custom: retained draft');
    expect(doc.editors.right!.getMarkdown()).toContain('custom: retained draft');
    expect(document.body.querySelector('.frontmatter-property__edit-popover')).toBeNull();
  });
  it('captures outgoing input before enabling the other view and ignores inactive snapshots', async () => {
    const doc = setup(); await act(async () => { doc.render(); });
    act(() => { doc.editors.left!.commands.insertContent('left '); });
    await act(async () => { useWorkspaceFocusStore.getState().focusColumn('column-2'); });
    expect(getDocumentBuffer(doc.identity).content).toContain('left');
    expect(doc.editors.right!.getMarkdown()).toContain('left');
    act(() => { doc.editors.right!.commands.insertContent('right '); });
    act(() => { captureLatestDocumentContent(doc.identity); });
    expect(getDocumentBuffer(doc.identity).content).toContain('right');
    expect(getDocumentBuffer(doc.identity).content).toContain('left');
  });
  it('shows one global conflict notice when another view closes', async () => {
    const doc = setup(); await act(async () => { doc.render(); });
    act(() => {
      const buffer = getDocumentBuffer(doc.identity); buffer.conflicted = true; buffer.saveState = 'conflict';
      notifyDocumentBufferChanged(doc.identity, 'save_settled');
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(container.querySelectorAll('[data-actionable-notice-host] [role="alert"]')).toHaveLength(1);
    expect(container.querySelector('[data-actionable-notice-host] [role="alert"]')?.textContent).toContain('Saved version conflicts');
    expect([...container.querySelectorAll('[data-actionable-notice-host] [role="alert"] button')].map(button => button.textContent))
      .toEqual(['Use the file version', 'Use editor version']);
    await act(async () => { doc.closeRight(); await vi.advanceTimersByTimeAsync(300); });
    expect(container.querySelectorAll('[data-actionable-notice-host] [role="alert"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-sonner-toast]')).toHaveLength(0);
  });
});
