import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';

const { invoke, notebooks } = vi.hoisted(() => ({
  invoke: vi.fn(),
  notebooks: [] as { id: string; name: string; path: string }[],
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@features/memo/store/note-store', () => ({
  useNoteStore: { getState: () => ({ notebooks, notebooksInitialized: true }) },
}));

import { renameMarkdownTitle } from '@features/document/use-cases/local-document-operations';
import { applyLoadedDocumentContent, getDocumentBuffer, recordDocumentEdit } from '@features/document/store/document-session-service';
import { acceptBackgroundDocumentContent, hasLiveUnsavedDocumentAtPath, subscribeWorkspaceDocumentSaves } from '@features/document/public/workspace-api';
import { createNoteReferenceExtension } from '@features/editor/extensions/note-link/view-note';
import { toNoteReferenceAttrs } from '@features/editor/public/mention-data-api';
import { canonicalPath } from '@/lib/path';
import { rewriteNoteLinkMoves, updateNoteLinksAfterMove, acceptWorkspaceDocumentLinkSave } from './note-link-rewriter';
import { ensureFileDisplayIdentity, rebaseFileDisplayPath, pinFileDisplayId } from '@/lib/file-display-registry';

import { applyNotebookPathMove } from '@features/workspace/use-cases/notebook-path-move';
import { localDocumentOperations } from '@features/document/use-cases/local-document-operations';

import { notifyDocumentBufferChanged } from '@features/document/store/buffer-registry';
import { findDocumentSession } from '@features/document/store/document-runtime-session';

let root = '';
const editors: Editor[] = [];
afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  editors.splice(0).forEach(editor => editor.destroy());
  localStorage.removeItem('flowix:pending-note-link-moves');
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

function editor() {
  // The real editor knows which notebook owns the document it is editing.
  const value = new Editor({
    extensions: [
      StarterKit,
      Markdown,
      createNoteReferenceExtension('document', { getOwnerNotebookId: () => notebooks[0]?.id }),
    ],
    content: '<p></p>',
  });
  editors.push(value);
  return value;
}

describe('rename B updates the Markdown reference in A', () => {
  it('uses the real mention serializer, rename entry, job queue, files, and retained document buffer', async () => {
    root = await mkdtemp(join(tmpdir(), 'flowix-link-rename-'));
    const noteA = canonicalPath(join(root, 'A.md'));
    const noteB = canonicalPath(join(root, '教学方案', '简介.md'));
    notebooks.splice(0, notebooks.length, { id: 'test-book', name: 'Test Book', path: canonicalPath(root) });
    await mkdir(dirname(noteB));
    await writeFile(noteB, 'B content', 'utf8');
    const sourceEditor = editor();
    sourceEditor.commands.insertContent({ type: 'noteReference', attrs: toNoteReferenceAttrs({
      notebookId: 'test-book', notebookName: 'Test Book', notebookPath: root,
      relativePath: '教学方案/简介.md', filename: '简介.md', title: '简介',
      originalPath: null, updatedAt: 0,
    }) });
    const original = sourceEditor.getMarkdown();
    await writeFile(noteA, original, 'utf8');
    const identity = { kind: 'md' as const, path: noteA, displayId: `cached-A-${root}` };
    applyLoadedDocumentContent(identity, noteA, original);

    // Only replace the native transport: reads, CAS writes and rename really
    // operate on temporary files. The application pipeline is left intact.
    invoke.mockImplementation(async (command: string, args: Record<string, string>) => {
      if (command === 'rename_file') {
        const target = join(dirname(args.filePath), args.name);
        await rename(args.filePath, target);
        return target;
      }
      if (command === 'get_dir_children') {
        return (await readdir(args.dirPath, { withFileTypes: true })).map(entry => ({
          name: entry.name, type: entry.isDirectory() ? 'folder' : 'document',
          fullPath: canonicalPath(join(args.dirPath, entry.name)),
        }));
      }
      if (command === 'read_external_document') return readFile(args.filePath, 'utf8');
      if (command === 'write_document') {
        if (await readFile(args.filePath, 'utf8') !== args.expectedContent) return null;
        await writeFile(args.filePath, args.content, 'utf8');
        return { path: args.filePath, content: args.content };
      }
      if (command === 'acknowledge_document_operation') return;
      throw new Error(`Unexpected native operation: ${command}`);
    });

    const noteBIdentity = ensureFileDisplayIdentity(noteB);
    await renameMarkdownTitle({
      path: noteB,
      title: '简介2',
      scopePath: root,
      notebook: { id: 'test-book', path: canonicalPath(root) },
      displayId: noteBIdentity.displayId,
      onPathChanged: (previous, next) => rebaseFileDisplayPath(previous, next, noteBIdentity.displayId),
    });
    await vi.waitFor(() => {
      expect(JSON.parse(localStorage.getItem('flowix:pending-note-link-moves') ?? '[]')).toEqual([]);
    });
    const saved = await readFile(noteA, 'utf8');
    // Same notebook: no name and no ID, so the notebook rename cannot break it.
    expect(saved).toContain('[简介2](flowix://open?f=%E6%95%99%E5%AD%A6%E6%96%B9%E6%A1%88%2F%E7%AE%80%E4%BB%8B2.md)');
    expect(saved).not.toContain('Test+Book');
    expect(getDocumentBuffer(identity)).toMatchObject({ content: saved, lastSavedContent: saved, saveState: 'clean' });
    const reopened = editor();
    reopened.commands.setContent(getDocumentBuffer(identity).content, { contentType: 'markdown' });
    expect(reopened.state.doc.firstChild?.firstChild?.attrs.relativePath).toBe('教学方案/简介2.md');
    expect(reopened.view.dom.querySelector('.note-reference__title')?.textContent).toBe('简介2');

    // A persisted chain must reach the final filename in one pass.
    expect(await rewriteNoteLinkMoves([
      { oldPath: noteB, newPath: noteB.replace('简介.md', '简介2.md'), folder: false },
      { oldPath: noteB.replace('简介.md', '简介2.md'), newPath: noteB.replace('简介.md', '简介3.md'), folder: false },
    ])).toBe(true);
    expect(await readFile(noteA, 'utf8')).toContain('[简介3]');
  });

  it('protects an unmounted dirty tab instead of replacing its draft with disk content', () => {
    const identity = { kind: 'md' as const, path: '/retained-dirty-A.md', displayId: 'retained-dirty-A' };
    applyLoadedDocumentContent(identity, identity.path, 'original');
    recordDocumentEdit(identity, 'unsaved user text');
    expect(hasLiveUnsavedDocumentAtPath(identity.path)).toBe(true);
    expect(acceptBackgroundDocumentContent(identity.path, 'rewritten disk')).toBe(false);
    expect(getDocumentBuffer(identity).content).toBe('unsaved user text');
  });
  it('rebases the live source before post-move edits and never rewrites the new references', async () => {
    vi.useFakeTimers();
    root = await mkdtemp(join(tmpdir(), 'flowix-live-source-'));
    notebooks.splice(0, notebooks.length, { id: 'live-book', name: 'Live Book', path: canonicalPath(root) });
    await mkdir(join(root, 'A'));
    await mkdir(join(root, 'B'));
    const oldPath = canonicalPath(join(root, 'A/n.md'));
    const newPath = canonicalPath(join(root, 'B/n.md'));
    await writeFile(oldPath, '[old](./old.png)', 'utf8');
    const fileIdentity = ensureFileDisplayIdentity(oldPath);
    const release = pinFileDisplayId(fileIdentity.displayId);
    const stopSaves = subscribeWorkspaceDocumentSaves(acceptWorkspaceDocumentLinkSave);
    let released = false;
    try {
    const identity = { ...fileIdentity, kind: 'md' as const };
    applyLoadedDocumentContent(identity, oldPath, '[old](./old.png)');
    await rename(oldPath, newPath);
    await applyNotebookPathMove({ notebookId: 'live-book', notebookPath: root, previousRelativePath: 'A/n.md', relativePath: 'B/n.md', directory: false });
    expect(getDocumentBuffer(identity).content).toBe('[old](../A/old.png)');
    const edited = getDocumentBuffer(identity).content + ' [new](./new.png)';
    recordDocumentEdit(identity, edited);
    await writeFile(newPath, edited, 'utf8');
    // Acknowledge the same canonical body as the normal save callback.
    applyLoadedDocumentContent(identity, newPath, edited, { setAsCurrent: false });
    notifyDocumentBufferChanged(identity, 'save_settled');
    stopSaves();
    release();
    released = true;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(findDocumentSession(identity.displayId)?.buffer).toBeUndefined();
    installFileTransport();
    const jobs = JSON.parse(localStorage.getItem('flowix:pending-note-link-moves')!);
    expect(await rewriteNoteLinkMoves(jobs)).toBe(true);
    expect(await readFile(newPath, 'utf8')).toBe('[old](../A/old.png) [new](./new.png)');
    } finally { stopSaves(); if (!released) release(); }
  });

  it('settles a closed moved source before publishing its first editable read', async () => {
    vi.useFakeTimers();
    root = await mkdtemp(join(tmpdir(), 'flowix-closed-source-'));
    notebooks.splice(0, notebooks.length, { id: 'closed-book', name: 'Closed Book', path: canonicalPath(root) });
    await mkdir(join(root, 'A'));
    await mkdir(join(root, 'B'));
    const oldPath = canonicalPath(join(root, 'A/n.md'));
    const newPath = canonicalPath(join(root, 'B/n.md'));
    await writeFile(newPath, '[old](./old.png)', 'utf8');
    installFileTransport();
    updateNoteLinksAfterMove(oldPath, newPath);
    expect(await localDocumentOperations.read({ path: newPath, scopePath: root })).toBe('[old](../A/old.png)');
    expect(await readFile(newPath, 'utf8')).toBe('[old](../A/old.png)');
    // The opened document is settled before its body is published; the durable
    // queue keeps the move so the rest of the library can follow in the
    // background.
    const queued = JSON.parse(localStorage.getItem('flowix:pending-note-link-moves')!) as Array<{
      documents?: Record<string, { applied: number }>;
    }>;
    expect(queued).toHaveLength(1);
    expect(Object.values(queued[0].documents ?? {})).toEqual([{ applied: 1 }]);
  });

});

function installFileTransport() {
  invoke.mockImplementation(async (command: string, args: Record<string, string>) => {
    if (command === 'get_dir_children') return (await readdir(args.dirPath, { withFileTypes: true })).map(entry => ({
      name: entry.name, type: entry.isDirectory() ? 'folder' : 'document', fullPath: canonicalPath(join(args.dirPath, entry.name)),
    }));
    if (command === 'read_external_document') return readFile(args.filePath, 'utf8');
    if (command === 'write_document') {
      if (await readFile(args.filePath, 'utf8') !== args.expectedContent) return null;
      await writeFile(args.filePath, args.content, 'utf8');
      return { path: args.filePath, content: args.content };
    }
    if (command === 'acknowledge_document_operation') return;
    throw new Error(`Unexpected native operation: ${command}`);
  });
}
