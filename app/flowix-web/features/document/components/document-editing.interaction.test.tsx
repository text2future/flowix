import { act, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Toaster } from 'sonner';
import { createRoot, type Root } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownEditor, type MarkdownEditorHandle } from '@features/editor/markdown-editor';
import { I18nProvider } from '@/lib/i18n';
import { ShortcutsProvider } from '@features/shortcuts';
import '@features/shortcuts/actions';
import { MemoTitleEditor } from './memo-title-editor';
import { DocumentSaveStatus } from './document-save-status';
import { ActionableNoticeHost } from '@features/notifications/actionable-notice-host';
import { useDocumentAutosave } from './session/use-document-autosave';
import { DocumentContentBoundary } from './session/document-content-boundary';
import { notifyDocumentBufferChanged } from '../store/buffer-registry';
import { applyLoadedDocumentContent, registerDocumentCapture, getDocumentBuffer } from '../store/document-session-service';
import { ensureFileDisplayIdentity, rebaseFileDisplayPath, reconcileFileDisplays } from '@/lib/file-display-registry';
import { waitForDocumentCommits } from '../store/document-commit-queue';
import { SessionViewRecoveryContext } from '@features/workspace/public/session-view-state-api';
import { useWorkspaceSessionStore, getSessionId } from '@features/workspace/store/workspace-session-store';
import { sessionFor } from '@features/workspace/model/workspace-session';

const mocks = vi.hoisted(() => ({ write: vi.fn(), read: vi.fn() }));
vi.mock('../use-cases/local-document-operations', () => ({ localDocumentOperations: { write: mocks.write, read: mocks.read } }));
vi.mock('../store/recovery-draft-store', () => ({
  persistRecoveryDraft: vi.fn().mockResolvedValue(true), clearRecoveryDraftThrough: vi.fn().mockResolvedValue(undefined),
  flushRecoveryOperations: vi.fn().mockResolvedValue(true),
}));

let container: HTMLDivElement; let root: Root; let editor: Editor; let mounts = 0;
let releaseRename: () => void;
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let sequence = 0;
function mountDocument() {
  const identity = { kind: 'md' as const, ...ensureFileDisplayIdentity('/interaction-' + ++sequence + '.md') };
  reconcileFileDisplays([identity]);
  applyLoadedDocumentContent(identity, identity.path, 'Body');
  useWorkspaceSessionStore.getState().reset();
  useWorkspaceSessionStore.getState().commitTarget(getSessionId(1), { kind: 'external', path: identity.path, scopePath: '/', transitionId: null });
  const entryId = sessionFor(useWorkspaceSessionStore.getState(), 1).navigation.current!.id;
  const renameGate = new Promise<void>(resolve => { releaseRename = resolve; });
  function Harness() {
    const handle = useRef<MarkdownEditorHandle>(null);
    const path = useRef(identity.path);
    const [filename, setFilename] = useState('Original.md');
    const [clicks, setClicks] = useState(0);
    const capture = useCallback(() => handle.current?.flushPendingChanges() ?? null, []);
    useEffect(() => registerDocumentCapture(identity, capture), [capture]);
    const autosave = useDocumentAutosave({ identity,
      externalScopePath: null, flushPendingContent: capture });
    return <I18nProvider language="en-US"><ShortcutsProvider overrides={{}}>
      {createPortal(<Toaster />, document.body)}
      <ActionableNoticeHost />
      <button data-testid="click" onClick={() => setClicks(value => value + 1)}>Clicks {clicks}</button>
      <DocumentSaveStatus identity={identity} scopePath={null} />
      <SessionViewRecoveryContext.Provider value={{ sessionId: 1, entryId }}>
      <DocumentContentBoundary identity={identity}>{content => <MarkdownEditor ownerPath={path.current} ref={handle} content={content} onChange={autosave.handleChange} onDirty={autosave.handleDirty}
        onBeforeCreate={value => { editor = value; mounts++; }} editable
        header={<MemoTitleEditor displayId={identity.displayId} filename={filename} editable showPropertiesToggle={false}
          onMoveToBody={request => request.insertEmptyLine
            ? handle.current?.moveTitleToBody?.(request.trailingContent ?? '')
            : handle.current?.focusStart?.()}
          renameTitle={async title => {
            await renameGate;
            const next = '/'+title+'.md';
            rebaseFileDisplayPath(path.current, next, identity.displayId);
            path.current = next; setFilename(title+'.md'); return title+'.md';
          }} />}
      />}</DocumentContentBoundary>
      </SessionViewRecoveryContext.Provider>
    </ShortcutsProvider></I18nProvider>;
  }
  return { identity, Harness };
}

describe('live title and rich body during persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers(); environment.IS_REACT_ACT_ENVIRONMENT = true; mounts = 0;
    mocks.write.mockReset().mockImplementation(async request => ({ status: 'saved', path: request.path, content: request.content }));
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 }) },
    });
  });
  afterEach(async () => {
    releaseRename?.();
    await act(async () => { await root.unmount(); await vi.advanceTimersByTimeAsync(300); });
    container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    environment.IS_REACT_ACT_ENVIRONMENT = false;
  });
  it('keeps the body caret and editor instance after Enter saves a renamed title', async () => {
    const { identity, Harness } = mountDocument();
    await act(async () => root.render(<Harness />));
    const originalEditor = editor;
    const title = container.querySelector('textarea')!;
    act(() => {
      title.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(title, 'Renamed');
      title.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });
    act(() => {
      title.setSelectionRange(title.value.length, title.value.length);
      title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(document.activeElement).toBe(editor.view.dom);
    const selection = editor.state.selection.toJSON();
    await act(async () => { releaseRename(); await waitForDocumentCommits('md:' + identity.displayId); });
    expect(editor).toBe(originalEditor);
    expect(mounts).toBe(1);
    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.state.selection.toJSON()).toEqual(selection);
    act(() => { editor.commands.insertContent('continued typing'); });
    expect(editor.getMarkdown()).toContain('continued typing');
  });
  it('keeps body input and clicks live while rename is blocked, then saves at the new path', async () => {
    const { identity, Harness } = mountDocument();
    await act(async () => { root.render(<Harness />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    const originalEditor = editor;
    const title = container.querySelector('textarea')!;
    act(() => {
      title.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(title, 'Renamed');
      title.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });
    act(() => title.blur());
    act(() => {
      editor.commands.insertContent('typing during rename ');
      (container.querySelector('[data-testid="click"]') as HTMLButtonElement).click();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(container.textContent).toContain('Clicks 1');
    expect(editor.getMarkdown()).toContain('typing during rename');
    expect(editor.isEditable).toBe(true);
    expect(mocks.write).not.toHaveBeenCalled();
    await act(async () => { releaseRename(); await waitForDocumentCommits('md:' + identity.displayId); });
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ path: '/Renamed.md', content: expect.stringContaining('typing during rename') }));
    expect(editor).toBe(originalEditor); expect(mounts).toBe(1);
    act(() => { editor.commands.undo(); });
    expect(editor.getMarkdown()).toBe('Body');
  });
  it('does not discard newly typed text while a conflict decision is reading disk', async () => {
    const { identity, Harness } = mountDocument(); let finish!: (content: string) => void;
    mocks.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => root.render(<Harness />));
    act(() => {
      const buffer = getDocumentBuffer(identity); buffer.conflicted = true; buffer.saveState = 'conflict';
      notifyDocumentBufferChanged(identity, 'save_settled');
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const useDisk = [...document.body.querySelectorAll('button')].find(button => button.textContent === 'Use the file version')!;
    await act(async () => { useDisk.click(); });
    act(() => { editor.commands.insertContent('new local input '); });
    await act(async () => { finish('external body'); });
    expect(editor.getMarkdown()).toContain('new local input');
    expect(getDocumentBuffer(identity).content).toContain('new local input');
    expect(getDocumentBuffer(identity).conflicted).toBe(true);
  });
  it('captures an edit immediately after mount without a quiet-period blind spot', async () => {
    const { Harness } = mountDocument();
    await act(async () => root.render(<Harness />));
    expect(mocks.write).not.toHaveBeenCalled();
    act(() => { editor.commands.insertContent('first keystroke '); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('first keystroke') }));
  });
  it('preserves the editor, draft and undo history when a save fails', async () => {
    const { Harness } = mountDocument();
    mocks.write.mockRejectedValueOnce(new Error('disk busy'));
    await act(async () => root.render(<Harness />));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    const originalEditor = editor;
    act(() => { editor.commands.insertContent('unsaved '); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    // The failure notice is an overlay; the editor content itself stays clean.
    expect(editor.getMarkdown()).not.toContain('disk busy');
    expect(document.body.textContent).toContain('disk busy');
    expect(editor.isEditable).toBe(true); expect(editor).toBe(originalEditor); expect(mounts).toBe(1);
    expect(editor.getMarkdown()).toContain('unsaved');
    act(() => { editor.commands.undo(); });
    expect(editor.getMarkdown()).toBe('Body');
  });
});
