import { act, useLayoutEffect, useRef } from 'react';
import { NATIVE_CLIPBOARD_ACTION_EVENT } from '@shared/clipboard/native-clipboard-action';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocTreeItem } from '@platform/tauri/client';
import type { FolderTreeController } from './use-folder-tree';
import { treePasteDirectory, treeTransferSources, useNotebookTreeClipboard } from './use-notebook-tree-clipboard';

const mocks = vi.hoisted(() => ({ copyPath: vi.fn(), save: vi.fn(), move: vi.fn(), refresh: vi.fn(), notify: vi.fn() }));
vi.mock('@platform/tauri/client', () => ({ files: { copyPath: mocks.copyPath } }));
vi.mock('@features/document/public/workspace-api', () => ({ saveWorkspaceTransferSources: mocks.save }));
vi.mock('../store/note-store', () => ({ useNoteStore: { getState: () => ({ triggerRefresh: mocks.notify }) } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function node(path: string, type: 'document' | 'folder' = 'document'): DocTreeItem {
  return { id: path, fullPath: path, name: path.split('/').pop()!, type, parentId: null, children: null,
    sizeBytes: null, modifiedMs: null, createdMs: null, memoCreatedMs: null };
}
const first = node('/root/a.md');
const second = node('/root/b.png');
const folder = node('/root/target', 'folder');
const destinationFile = node('/root/target/existing.md');
const nodes = new Map([first, second, folder, destinationFile].map(item => [item.fullPath, item]));
const selection = Object.freeze([first.fullPath, second.fullPath]);

describe('access-space clipboard using the existing selection', () => {
  let root: Root;
  let host: HTMLDivElement;
  let clipboard: ReturnType<typeof useNotebookTreeClipboard>;
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  function Harness({ selectedFolder = null }: { selectedFolder?: string | null }) {
    const rootRef = useRef<HTMLDivElement>(null);
    const value = useNotebookTreeClipboard({
      notebookPath: '/root', selectedFilePaths: selectedFolder ? [] : selection, selectedFolderPath: selectedFolder, rootRef,
      activeFilePath: first.fullPath, getSelectionAnchorPath: () => second.fullPath,
      items: nodes, tree: { refresh: mocks.refresh } as unknown as FolderTreeController, onMoveNote: mocks.move,
    });
    useLayoutEffect(() => { clipboard = value; });
    return <div ref={rootRef} tabIndex={-1} onKeyDownCapture={value.handleKeyDown}>
      <div data-notebook-tree-path={first.fullPath} data-testid="source" className={value.isCut(first.fullPath) ? 'opacity-50' : ''} tabIndex={0}><input /></div>
      <div data-notebook-tree-path={folder.fullPath} data-testid="folder" tabIndex={0} />
    </div>;
  }
  beforeEach(async () => {
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.save.mockResolvedValue(true);
    mocks.copyPath.mockImplementation(async (path: string) => `/root/target/${path.split('/').pop()}`);
    mocks.refresh.mockResolvedValue(undefined);
    mocks.move.mockResolvedValue({ movedPaths: [], failedPaths: [] });
    host = document.createElement('div'); document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<Harness />));
  });
  afterEach(async () => {
    await act(async () => root.unmount()); host.remove();
    environment.IS_REACT_ACT_ENVIRONMENT = false;
  });
  async function paste(item: DocTreeItem) {
    await act(async () => { clipboard.actionsFor(item).paste(); await new Promise(resolve => setTimeout(resolve, 0)); });
  }

  it('copies every selected file into the clicked file’s parent without changing selection', async () => {
    await act(async () => clipboard.actionsFor(first).copy());
    await paste(destinationFile);
    expect(mocks.copyPath.mock.calls.map(call => call.slice(0, 4))).toEqual([
      [first.fullPath, folder.fullPath, '/root', '/root'],
      [second.fullPath, folder.fullPath, '/root', '/root'],
    ]);
    expect(selection).toEqual(['/root/a.md', '/root/b.png']);
    expect(mocks.move).not.toHaveBeenCalled();
    expect(mocks.save).toHaveBeenCalledBefore(mocks.copyPath);
  });

  it('captures mixed selections when the context item is a selected folder', () => {
    expect(treeTransferSources(folder, [first.fullPath, folder.fullPath], nodes)).toEqual([
      { path: first.fullPath, isFolder: false, resourceKind: first.resourceKind },
      { path: folder.fullPath, isFolder: true, resourceKind: undefined },
    ]);
  });

  it('acts on one unselected row or one folder, preserving the existing multi-selection', () => {
    expect(treeTransferSources(destinationFile, selection, nodes).map(item => item.path)).toEqual([destinationFile.fullPath]);
    expect(treeTransferSources(folder, selection, nodes)).toEqual([{ path: folder.fullPath, isFolder: true, resourceKind: undefined }]);
    expect(treePasteDirectory(folder, '/root')).toBe(folder.fullPath);
    expect(treePasteDirectory(destinationFile, '/root')).toBe(folder.fullPath);
  });

  it('cuts lazily and retains only failed sources for another paste', async () => {
    mocks.move.mockResolvedValueOnce({ movedPaths: ['/root/target/a.md'], failedPaths: [second.fullPath] })
      .mockResolvedValueOnce({ movedPaths: ['/root/target/b.png'], failedPaths: [] });
    await act(async () => clipboard.actionsFor(first).cut());
    expect(mocks.move).not.toHaveBeenCalled();
    expect(clipboard.isCut(first.fullPath)).toBe(true);
    await paste(folder);
    expect(clipboard.isCut(first.fullPath)).toBe(false);
    expect(clipboard.isCut(second.fullPath)).toBe(true);
    await paste(folder);
    expect(mocks.move.mock.calls[1][0].map((source: { path: string }) => source.path)).toEqual([second.fullPath]);
    expect(clipboard.actionsFor().canPaste).toBe(false);
  });

  it('blocks disk operations when drafts cannot be saved and permits a retry', async () => {
    mocks.save.mockResolvedValueOnce(false);
    await act(async () => clipboard.actionsFor(first).cut());
    await paste(folder);
    expect(mocks.move).not.toHaveBeenCalled();
    expect(clipboard.isCut(first.fullPath)).toBe(true);
  });

  it('handles tree shortcuts while leaving an input’s text clipboard alone', async () => {
    const source = host.querySelector('[data-testid="source"]')!;
    const input = host.querySelector('input')!;
    const target = host.querySelector('[data-testid="folder"]')!;
    await act(async () => source.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true })));
    const editable = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => input.dispatchEvent(editable));
    expect(editable.defaultPrevented).toBe(false);
    expect(mocks.copyPath).not.toHaveBeenCalled();
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', metaKey: true, bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(mocks.copyPath).toHaveBeenCalledTimes(2);
  });

  it('cuts via the native macOS command, dims the sources, then pastes into a newly selected folder without keydown', async () => {
    const source = host.querySelector<HTMLElement>('[data-testid="source"]')!;
    await act(async () => source.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })));
    expect(document.activeElement).toBe(source);
    const cut = new CustomEvent(NATIVE_CLIPBOARD_ACTION_EVENT, { detail: 'cut', cancelable: true });
    await act(async () => { document.dispatchEvent(cut); });
    expect(cut.defaultPrevented).toBe(true);
    expect(source.classList.contains('opacity-50')).toBe(true);
    expect(clipboard.isCut(second.fullPath)).toBe(true);
    expect(mocks.move).not.toHaveBeenCalled();

    await act(async () => root.render(<Harness selectedFolder={folder.fullPath} />));
    const target = host.querySelector<HTMLElement>('[data-testid="folder"]')!;
    await act(async () => target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })));
    // A navigation/virtualized render can return focus to body. Keep the last
    // actual tree click as the clipboard context until the user clicks elsewhere.
    target.blur();
    mocks.move.mockResolvedValueOnce({ movedPaths: ['/root/target/a.md', '/root/target/b.png'], failedPaths: [] });
    const paste = new CustomEvent(NATIVE_CLIPBOARD_ACTION_EVENT, { detail: 'paste', cancelable: true });
    await act(async () => {
      document.dispatchEvent(paste);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(paste.defaultPrevented).toBe(true);
    expect(mocks.move).toHaveBeenCalledOnce();
    expect(mocks.move.mock.calls[0][0].map((item: { path: string }) => item.path)).toEqual(selection);
    expect(mocks.move.mock.calls[0][1]).toBe(folder.fullPath);
    expect(clipboard.isCut(first.fullPath)).toBe(false);
    expect(clipboard.actionsFor().canPaste).toBe(false);
  });

  it('leaves native text clipboard events unclaimed after clicking an input', async () => {
    const source = host.querySelector<HTMLElement>('[data-testid="source"]')!;
    const input = host.querySelector('input')!;
    await act(async () => {
      source.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      input.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      input.focus();
    });
    const cut = new CustomEvent(NATIVE_CLIPBOARD_ACTION_EVENT, { detail: 'cut', cancelable: true });
    await act(async () => { document.dispatchEvent(cut); });
    expect(cut.defaultPrevented).toBe(false);
  });

  it('cancels pending cut with Escape and rejects pasting a folder into itself', async () => {
    await act(async () => clipboard.actionsFor(folder).copy());
    await paste(folder);
    expect(mocks.copyPath).not.toHaveBeenCalled();
    await act(async () => clipboard.actionsFor(first).cut());
    await act(async () => host.firstElementChild!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(clipboard.actionsFor().canPaste).toBe(false);
  });
});
