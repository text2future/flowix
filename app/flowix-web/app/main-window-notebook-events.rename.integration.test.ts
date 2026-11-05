import { seedWorkColumn, seedBrowserColumn } from '@features/workspace/test-support/workspace-fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  renameCalls: [] as Array<{ oldPath: string; newPath: string }>,
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    native.listeners.set(name, handler);
    return () => native.listeners.delete(name);
  }),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'main', setTitle: vi.fn() }),
}));

import { mountMainWindowNotebookEvents } from './main-window-notebook-events';
import { mountMemoListRefreshService } from '@features/memo/services/memo-list-refresh-service';
import { renameWorkspaceFile } from '@features/workspace/public/shell-api';
import { ensureFileDisplayTrackingStarted } from '@features/workspace/public/app-api';
import { useDocumentStore } from '@features/document/store/document-store';
import { useDocumentHistoryStore } from '@features/document/store/document-history-store';
import { useWorkspaceRestoreStore } from '@features/workspace/store/workspace-restore-store';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { useBrowserColumnStore } from '@features/workspace/store/browser-column-store';
import { useNoteStore } from '@features/memo/store/note-store';
import { useTodoCountStore } from '@features/memo/store/todo-count-store';
import { useTagStore } from '@features/memo/store/tag-store';
import { canonicalPath } from '@/lib/path';
import { findFileDisplayPath } from '@/lib/file-display-registry';

const notebookId = 'rename-integration-book';
const noteEntry = (relativePath: string) => ({
  relativePath,
  title: relativePath.split('/').pop()?.replace(/\.md$/i, '') ?? '',
  preview: 'A note body',
  thumbnail: null,
  tags: [],
  todos: [],
  agents: [],
  createdAt: 1,
  updatedAt: 2,
  favorited: false,
  icon: null,
  colors: [],
  properties: {},
});

let root = '';
let stopNotebookEvents: (() => void) | null = null;
let stopMemoEvents: (() => void) | null = null;

function emitNativeEvent(event: unknown): void {
  native.listeners.get('flowix:path-note-changed')?.({ payload: event });
}

function prepareWorkspace(oldPath: string): void {
  const notebook = { id: notebookId, name: 'Rename Integration', path: root, createdAt: 1, updatedAt: 1, isDefault: false };
  const oldRelativePath = relative(root, oldPath).replace(/\\/g, '/');
  useNoteStore.getState().setNotebooks([notebook], notebookId);
  useNoteStore.setState({
    selectedNote: { notebookId, relativePath: oldRelativePath },
    memoListQuery: { notebookId, filter: 'all', sort: 'createdAt', pluginId: null, customFilterId: null },
    memoListQueryKey: 'rename-integration-query',
    memoListNextCursor: 'next-page-cursor',
    memoListHasMore: true,
    notes: [{
      kind: 'path-note', notebookId,
      relativePath: oldRelativePath,
      renderKey: 'stable-note-card',
      filename: 'Old.md', title: 'Old', preview: 'A note body', thumbnail: null,
      tags: [], todos: [], agents: [], createdAt: 1, updatedAt: 2,
      favorited: false, icon: null, colors: [], properties: {},
    }],
  });

  const target = { kind: 'external' as const, path: oldPath, scopePath: root, transitionId: null };
  seedWorkColumn({
    navigation: {
      phase: 'committed', showWorkColumnLoading: false, requestId: 1,
      target, pendingTarget: null, previousTarget: null, failure: null, retryToken: null,
    },
  });
  seedBrowserColumn({
    visible: true,
    current: {
      id: 'rename-integration-tab', title: 'Old.md', icon: null,
      target: {
        kind: 'file-browser', folderPath: root, notebookId, scopePath: root,
        fileTreeVisible: true, fileTreeWidth: 220, activeFilePath: oldPath,
      },
    },
  });
  useWorkspaceRestoreStore.getState().setDesiredTarget({ kind: 'external', path: oldPath, scopePath: root });
  useDocumentHistoryStore.getState().pushBack({ kind: 'external', path: oldPath, scopePath: root, openedAt: 1 });
}

describe('main-window rename event integration', () => {
  afterEach(async () => {
    stopNotebookEvents?.();
    stopNotebookEvents = null;
    stopMemoEvents?.();
    stopMemoEvents = null;
    await useDocumentStore.getState().clearDocument();
    useDocumentHistoryStore.getState().clear();
    useBrowserColumnStore.getState().reset();
    useWorkspaceRestoreStore.getState().setDesiredTarget(null);
    seedWorkColumn((state) => ({
      navigation: {
        ...state.navigation,
        phase: 'idle', showWorkColumnLoading: false,
        target: { kind: 'empty' }, pendingTarget: null, previousTarget: null,
        failure: null, retryToken: null,
      },
    }));
    useNoteStore.getState().setNotebooks([], null);
    useNoteStore.setState({ notes: [], selectedNote: null, memoListQuery: null, memoListQueryKey: null, memoListNextCursor: null, memoListHasMore: false });
    useTodoCountStore.setState({ counts: {} });
    useTagStore.setState({ tags: [], selectedTagId: null, metadataRefreshVersion: 0 });
    native.listeners.clear();
    native.renameCalls.splice(0);
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
  });

  it('keeps the real card, selection, open session and workspace references stable through repeated renames', async () => {
    root = canonicalPath(await mkdtemp(join(tmpdir(), 'flowix-rename-events-')));
    const oldPath = canonicalPath(join(root, 'Folder', 'Old.md'));
    const middlePath = canonicalPath(join(root, 'Folder', 'Middle.md'));
    const finalPath = canonicalPath(join(root, 'Folder', 'Final.md'));
    await mkdir(join(root, 'Folder'), { recursive: true });
    await writeFile(oldPath, '# Old\n\nA note body\n', 'utf8');

    prepareWorkspace(oldPath);
    ensureFileDisplayTrackingStarted();
    await useDocumentStore.getState().openExternalDocument(oldPath, {
      scopePath: root, notebookId, notebookPath: root, relativePath: 'Folder/Old.md', indexable: true,
    });
    let document = useDocumentStore.getState();
    document.finishDocumentTransition(document.documentTransitionId);
    const displayId = document.activeExternalSession?.fileIdentity.displayId;
    const openedAt = useDocumentStore.getState().activeExternalSession!.openedAt;
    const transitionId = useDocumentStore.getState().activeExternalSession!.transitionId;
    stopNotebookEvents = mountMainWindowNotebookEvents();
    stopMemoEvents = mountMemoListRefreshService();

    const mutationResolvers: Array<(result: unknown) => void> = [];
    native.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'rename_file') {
        const oldFile = String(args.filePath);
        const nextFile = canonicalPath(join(dirname(oldFile), String(args.name)));
        await rename(oldFile, nextFile);
        const oldRelativePath = relative(root, oldFile).replace(/\\/g, '/');
        emitNativeEvent({ notebookId, relativePath: oldRelativePath, deleted: true, changeId: `watcher-delete:${oldRelativePath}` });
        return new Promise((resolve) => {
          native.renameCalls.push({ oldPath: oldFile, newPath: nextFile });
          mutationResolvers.push(resolve);
        });
      }
      if (command === 'get_indexed_note_by_path') return noteEntry(String(args.relativePath));
      if (command === 'get_all_tags') return { tags: [] };
      if (command === 'get_used_memo_tag_ids') return { usedTagIds: [], tagCounts: [], totalMemoCount: 1, agentMemoCount: 0, todoMemoCount: 0 };
      if (command === 'list_recovery_drafts') return [];
      if (command === 'acknowledge_document_operation') return undefined;
      throw new Error(`Unexpected native command: ${command}`);
    });
    await vi.waitFor(() => expect(native.listeners.has('flowix:path-note-changed')).toBe(true));

    let firstRenameError: unknown;
    const firstRename = renameWorkspaceFile({ path: oldPath, name: 'Middle.md', scopePath: root, notebookId })
      .catch((error: unknown) => { firstRenameError = error; throw error; });
    await vi.waitFor(() => {
      if (firstRenameError) throw firstRenameError;
      expect(native.renameCalls).toHaveLength(1);
    });
    expect(useDocumentStore.getState().currentDocumentPath).toBe(oldPath);
    expect(useNoteStore.getState().selectedNote?.relativePath).toBe('Folder/Old.md');
    expect(useNoteStore.getState().notes[0]?.relativePath).toBe('Folder/Old.md');
    const tabDuringRename = useBrowserColumnStore.getState().current;
    expect(tabDuringRename?.target.kind === 'file-browser' ? tabDuringRename.target.activeFilePath : null).toBe(oldPath);

    mutationResolvers.shift()!({
      path: middlePath,
      notebookChange: {
        notebookId, previousRelativePath: 'Folder/Old.md', relativePath: 'Folder/Middle.md',
        directory: false, changeId: 'move-old-middle',
      },
    });
    await firstRename;
    await vi.waitFor(() => expect(useNoteStore.getState().notes[0]?.relativePath).toBe('Folder/Middle.md'));

    const secondRename = renameWorkspaceFile({ path: middlePath, name: 'Final.md', scopePath: root, notebookId });
    await vi.waitFor(() => expect(native.renameCalls).toHaveLength(2));
    mutationResolvers.shift()!({
      path: finalPath,
      notebookChange: {
        notebookId, previousRelativePath: 'Folder/Middle.md', relativePath: 'Folder/Final.md',
        directory: false, changeId: 'move-middle-final',
      },
    });
    await secondRename;
    await vi.waitFor(() => expect(useNoteStore.getState().notes[0]?.relativePath).toBe('Folder/Final.md'));
    await vi.waitFor(() => expect(native.invoke.mock.calls.filter(([command]) => command === 'list_recovery_drafts').length).toBeGreaterThanOrEqual(2));

    // A delayed distinct-ID copy of A→B is still an old path and cannot undo B→C.
    emitNativeEvent({
      notebookId, previousRelativePath: 'Folder/Old.md', relativePath: 'Folder/Middle.md',
      directory: false, changeId: 'delayed-move-old-middle',
    });
    await vi.waitFor(() => expect(native.invoke.mock.calls.filter(([command]) => command === 'list_recovery_drafts').length).toBeGreaterThanOrEqual(3));

    document = useDocumentStore.getState();
    const card = useNoteStore.getState().notes[0];
    expect(await readFile(finalPath, 'utf8')).toContain('A note body');
    expect(findFileDisplayPath(displayId!)).toBe(finalPath);
    expect(document.currentDocumentPath).toBe(finalPath);
    expect(document.activeExternalSession).toMatchObject({ openedAt, transitionId, relativePath: 'Folder/Final.md' });
    expect(useWorkColumnStore.getState().navigation.target).toMatchObject({ kind: 'external', path: finalPath });
    expect(useBrowserColumnStore.getState().current?.target).toMatchObject({ kind: 'file-browser', activeFilePath: finalPath });
    expect(useWorkspaceRestoreStore.getState().desiredTarget).toMatchObject({ kind: 'external', path: finalPath });
    expect(useDocumentHistoryStore.getState().backStack[0]).toMatchObject({ kind: 'external', path: finalPath });
    expect(card).toMatchObject({ relativePath: 'Folder/Final.md', filename: 'Final.md', title: 'Final', renderKey: 'stable-note-card' });
    expect(useNoteStore.getState()).toMatchObject({
      selectedNote: { notebookId, relativePath: 'Folder/Final.md' },
      memoListQueryKey: 'rename-integration-query',
      memoListNextCursor: 'next-page-cursor',
      memoListHasMore: true,
    });
    expect(native.invoke.mock.calls.some(([command]) => command === 'get_path_notes')).toBe(false);
  });
});
