import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NoteShareControl } from './note-share-control';

const mocks = vi.hoisted(() => ({
  toast: vi.fn(), notebooks: [{ id: 'book', path: '/book' }] as { id: string; path: string }[], loadNotebooks: vi.fn(),
  access: vi.fn(), state: vi.fn(), notebook: vi.fn(), enable: vi.fn(), sync: vi.fn(), link: vi.fn(), folderLink: vi.fn(), save: vi.fn(),
}));
vi.mock('@platform/tauri/client/cloud', () => ({
  cloud: { getStorageAccess: mocks.access, getState: mocks.state, getNotebookState: mocks.notebook,
    setNotebookEnabled: mocks.enable, syncNow: mocks.sync, createNoteShareLink: mocks.link, createFolderShareLink: mocks.folderLink },
  listenToCloudSyncStatusChanges: () => () => {},
}));
vi.mock('@platform/tauri/client', () => ({ windows: { openPreferences: vi.fn() } }));
vi.mock('@features/preferences/public/cloud-login-dialog', () => ({ openCloudLoginDialog: vi.fn() }));
vi.mock('@features/cloud-billing/public/payment-dialog', () => ({ openPaymentDialog: vi.fn() }));
vi.mock('@features/memo/public/workspace-api', () => ({ getWorkspaceMemoState: () => ({ notebooks: mocks.notebooks, loadNotebooks: mocks.loadNotebooks }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.toast } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string, params?: { id?: string }) => params?.id ? `${key}:${params.id}` : key, language: 'en-US' }) }));
vi.mock('@shared/ui/tooltip', () => ({ Tooltip: ({ children }: { children: ReactNode }) => children }));
vi.mock('@shared/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? children : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@shared/ui/button', () => ({ Button: ({ children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => <button onClick={onClick} disabled={disabled}>{children}</button> }));
let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.notebooks = [{ id: 'book', path: '/book' }];
  mocks.loadNotebooks.mockResolvedValue(undefined);
  mocks.access.mockResolvedValue({ target: 'official', canUpload: true });
  mocks.state.mockResolvedValue({ authenticated: true, syncAccess: { canUpload: true } });
  mocks.notebook.mockResolvedValue({ enabled: true });
  mocks.save.mockResolvedValue(true);
  mocks.sync.mockResolvedValue({});
  mocks.link.mockResolvedValue({ url: 'https://example.com/share', expiresAt: Date.now() + 60000 });
  mocks.folderLink.mockResolvedValue({ url: 'https://example.com/folder', expiresAt: Date.now() + 60000 });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<NoteShareControl filePath="/book/a.md" flushDocument={mocks.save} iconButtonClass="" />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('synchronizes and creates a folder link with a dynamic-sharing notice', async () => {
  await act(async () => root.render(<NoteShareControl filePath="/book/folder" kind="folder" flushDocument={mocks.save} iconButtonClass="" />));
  await act(async () => { host.querySelector('button')!.click(); });
  expect(mocks.folderLink).toHaveBeenCalledWith('book', 'folder');
  expect(mocks.sync.mock.invocationCallOrder[0]).toBeLessThan(mocks.folderLink.mock.invocationCallOrder[0]);
  expect(host.textContent).toContain('document.share.folderDescription');
  expect(host.querySelector('input')?.value).toBe('https://example.com/folder');
});

it('opens the notebook root share dialog from an external menu request', async () => {
  await act(async () => root.render(<NoteShareControl filePath="/book" kind="folder" hideTrigger openRequest={1} flushDocument={mocks.save} iconButtonClass="" />));
  expect(mocks.folderLink).toHaveBeenCalledWith('book', '');
  expect(host.textContent).toContain('document.share.notebookDescription');
  expect(host.querySelector('input')?.value).toBe('https://example.com/folder');
});

it('saves and synchronizes an already enabled notebook before creating a link', async () => {
  await act(async () => { host.querySelector('button')!.click(); });
  expect(mocks.save).toHaveBeenCalledOnce();
  expect(mocks.sync).toHaveBeenCalledWith('book');
  expect(mocks.sync.mock.invocationCallOrder[0]).toBeLessThan(mocks.link.mock.invocationCallOrder[0]);
  expect(host.querySelector('input')?.value).toBe('https://example.com/share');
});

it('asks before enabling sync and does not create a link if sync fails', async () => {
  mocks.notebook.mockResolvedValue({ enabled: false });
  mocks.sync.mockRejectedValue(new Error('offline'));
  await act(async () => { host.querySelector('button')!.click(); });
  expect(host.textContent).toContain('document.share.step.sync');
  await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'document.share.stepAction.sync')!.click(); });
  expect(mocks.enable).toHaveBeenCalledWith('book', true);
  expect(mocks.link).not.toHaveBeenCalled();
  expect(host.textContent).toContain('document.share.syncFailed');
});

it.each([
  ['cloud API error 503 COS_READ_FAILED: private details (request id: abc_123)', 'document.share.storageFailed', 'COS_READ_FAILED'],
  ['cloud API error 401 INVALID_TOKEN: expired (request id: req_1)', 'document.share.authFailed', 'INVALID_TOKEN'],
  ['cloud API error 500 INTERNAL_ERROR: private details', 'document.share.serverFailed', 'INTERNAL_ERROR'],
  ['cloud request failed: connection error', 'document.share.networkFailed', ''],
])('reports the appropriate share failure for %s', async (failure, expected, code) => {
  mocks.link.mockRejectedValue(failure);
  await act(async () => { host.querySelector('button')!.click(); });
  expect(host.textContent).toContain(expected);
  if (code) expect(host.textContent).toContain(code);
  if (failure.includes('abc_123')) expect(host.textContent).toContain('document.share.requestId:abc_123');
  expect(host.textContent).not.toContain('private details');
});

it('continues sync after closing the dialog and shows the resulting link when reopened', async () => {
  let finishSync!: () => void;
  mocks.sync.mockReturnValue(new Promise<void>((resolve) => { finishSync = resolve; }));
  await act(async () => { host.querySelector('button')!.click(); });
  await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'document.share.backgroundSync')!.click(); });
  expect(mocks.link).not.toHaveBeenCalled();
  await act(async () => { finishSync(); });
  expect(mocks.link).toHaveBeenCalledOnce();
  await act(async () => { host.querySelector('button')!.click(); });
  expect(host.querySelector('input')?.value).toBe('https://example.com/share');
  expect(mocks.link).toHaveBeenCalledOnce();
});


it('reports an unsupported folder after the backend rejects it', async () => {
  mocks.folderLink.mockRejectedValue(new Error('CLOUD_SHARE_INVALID_FOLDER'));
  await act(async () => root.render(<NoteShareControl filePath="/book/node_modules" kind="folder" hideTrigger openRequest={1} flushDocument={mocks.save} iconButtonClass="" />));
  expect(host.textContent).toContain('document.share.invalidFolder');
});

it('reports an unresolved notebook and releases the pending request', async () => {
  mocks.notebooks = [];
  mocks.loadNotebooks.mockRejectedValue(new Error('offline'));
  const onOpenChange = vi.fn();
  await act(async () => root.render(<NoteShareControl filePath="/missing/folder" kind="folder" hideTrigger openRequest={1} onOpenChange={onOpenChange} flushDocument={mocks.save} iconButtonClass="" />));
  expect(mocks.toast).toHaveBeenCalledWith('document.share.notebookUnavailable');
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(mocks.sync).not.toHaveBeenCalled();
});
