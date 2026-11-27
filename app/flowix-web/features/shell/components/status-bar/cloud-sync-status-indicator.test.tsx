import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CloudSyncStatusIndicator } from './cloud-sync-status-indicator';

type TestStatus = { notebookId: string; runId: string; startedAt: number; state: string; phase: string };

const mocks = vi.hoisted(() => ({
  access: vi.fn(), state: vi.fn(), notebook: vi.fn(), enable: vi.fn(), sync: vi.fn(),
  refresh: vi.fn(), login: vi.fn(), preferences: vi.fn(), error: vi.fn(),
  onStatus: undefined as ((status: TestStatus) => void) | undefined,
}));
vi.mock('@platform/tauri/client', () => ({
  cloud: { getStorageAccess: mocks.access, getState: mocks.state, getNotebookState: mocks.notebook,
    setNotebookEnabled: mocks.enable, syncNow: mocks.sync, refreshMembership: mocks.refresh },
  windows: { openPreferences: mocks.preferences },
  listenToCloudStateChanges: () => () => {}, listenToCloudStorageAccessChanges: () => () => {},
  listenToCloudSyncStatusChanges: (callback: (status: TestStatus) => void) => { mocks.onStatus = callback; return () => {}; },
}));
vi.mock('@features/preferences/public/cloud-login-dialog', () => ({ openCloudLoginDialog: mocks.login }));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.error } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@shared/ui/tooltip', () => ({ Tooltip: ({ children }: { children: ReactNode }) => children }));
vi.mock('@shared/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverContent: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@shared/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? children : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

let host: HTMLDivElement;
let root: Root;
async function openPrompt() {
  await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="cloudSync.disabled.title"]')!.click(); });
}
async function clickEnable() {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent === 'cloudSync.disabled.enable');
  await act(async () => { button!.click(); });
}
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.notebook.mockResolvedValue(null);
  mocks.enable.mockResolvedValue({ enabled: true });
  mocks.sync.mockResolvedValue({});
  mocks.refresh.mockResolvedValue({});
  mocks.login.mockResolvedValue(undefined);
  mocks.preferences.mockResolvedValue(undefined);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<CloudSyncStatusIndicator notebookId="first" />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('enables configured S3 without requiring an account', async () => {
  mocks.access.mockResolvedValue({ target: 'customS3', canUpload: true });
  await openPrompt(); await clickEnable();
  expect(mocks.state).not.toHaveBeenCalled();
  expect(mocks.login).not.toHaveBeenCalled();
  expect(mocks.enable).toHaveBeenCalledWith('first', true);
  expect(mocks.sync).toHaveBeenCalledWith('first');
  expect(host.textContent).not.toContain('cloudSync.disabled.prompt');
});

it('waits for membership verification after login before enabling', async () => {
  mocks.access.mockResolvedValueOnce({ target: 'official', canUpload: false })
    .mockResolvedValueOnce({ target: 'official', canUpload: false })
    .mockResolvedValueOnce({ target: 'official', canUpload: true });
  mocks.state.mockResolvedValueOnce({ authenticated: false })
    .mockResolvedValueOnce({ authenticated: true, syncAccess: { restriction: 'verifying' } })
    .mockResolvedValueOnce({ authenticated: true, syncAccess: { restriction: null } });
  await openPrompt(); await clickEnable();
  expect(mocks.login).toHaveBeenCalledOnce();
  await act(async () => { mocks.login.mock.calls[0][0](); });
  expect(mocks.refresh).toHaveBeenCalledOnce();
  expect(mocks.enable).toHaveBeenCalledWith('first', true);
  expect(mocks.preferences).not.toHaveBeenCalled();
});

it('does not enable the previous notebook if it changed during login', async () => {
  mocks.access.mockResolvedValue({ target: 'official', canUpload: false });
  mocks.state.mockResolvedValue({ authenticated: false });
  await openPrompt(); await clickEnable();
  await act(async () => root.render(<CloudSyncStatusIndicator notebookId="second" />));
  await act(async () => { mocks.login.mock.calls[0][0](); });
  expect(mocks.enable).not.toHaveBeenCalled();
});


it('keeps one indicator through a brief transfer gap and removes it after fading', async () => {
  mocks.access.mockResolvedValue({ target: 'customS3', canUpload: true });
  await openPrompt(); await clickEnable();
  vi.useFakeTimers();
  const status = { notebookId: 'first', runId: 'run', startedAt: 1, state: 'syncing', phase: 'upload' };
  await act(async () => { mocks.onStatus!(status); vi.advanceTimersByTime(20); });
  expect(host.querySelectorAll('svg')).toHaveLength(1);
  await act(async () => { mocks.onStatus!({ ...status, state: 'success', phase: 'complete' }); vi.advanceTimersByTime(200); });
  expect(host.querySelectorAll('svg')).toHaveLength(1);
  await act(async () => { mocks.onStatus!({ ...status, runId: 'next', startedAt: 2 }); vi.advanceTimersByTime(20); });
  expect(host.querySelectorAll('svg')).toHaveLength(1);
  await act(async () => { mocks.onStatus!({ ...status, runId: 'next', startedAt: 2, state: 'success', phase: 'complete' }); });
  await act(async () => { vi.advanceTimersByTime(300); });
  expect(host.querySelector('.opacity-0')).not.toBeNull();
  await act(async () => { vi.advanceTimersByTime(300); });
  expect(host.querySelectorAll('svg')).toHaveLength(0);
  vi.useRealTimers();
});
