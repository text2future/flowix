import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CloudState } from '@platform/tauri/client';
import { useCloudAccountState } from './use-cloud-account-state';

const mocks = vi.hoisted(() => ({
  getState: vi.fn(), refreshMembership: vi.fn(), unlisten: vi.fn(),
  receive: null as null | ((state: CloudState) => void),
  ready: null as null | (() => void),
}));
vi.mock('@platform/tauri/client', () => ({
  cloud: { getState: mocks.getState, refreshMembership: mocks.refreshMembership },
  listenToCloudStateChanges: (receive: (state: CloudState) => void, options?: { onListenerReady?: () => void }) => {
    mocks.receive = receive;
    mocks.ready = options?.onListenerReady ?? null;
    return mocks.unlisten;
  },
}));

let root: Root;
let container: HTMLDivElement;
let current: ReturnType<typeof useCloudAccountState>;
function Harness() {
  current = useCloudAccountState();
  return <div>{current.state?.revision ?? 'pending'}</div>;
}
function snapshot(revision: number): CloudState {
  return { revision, authenticated: false, authStatus: 'signed_out' };
}
function authenticatedSnapshot(revision: number): CloudState {
  return { ...snapshot(revision), authenticated: true, authStatus: 'authenticated',
    account: { user: { id: 'user-1', email: 'user@example.com', displayName: 'User', region: 'non_mainland' } } };
}
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.refreshMembership.mockResolvedValue({});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

it('recovers changes missed while the native listener was being registered', async () => {
  mocks.getState.mockResolvedValueOnce(snapshot(1)).mockResolvedValueOnce(snapshot(3));
  await act(async () => root.render(<Harness />));
  expect(current.state?.revision).toBe(1);
  await act(async () => mocks.ready!());
  expect(current.state?.revision).toBe(3);
  expect(mocks.getState).toHaveBeenCalledTimes(2);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it('rejects stale queries and command results after a newer account event', async () => {
  let resolve!: (state: CloudState) => void;
  mocks.getState.mockReturnValue(new Promise<CloudState>((done) => { resolve = done; }));
  await act(async () => root.render(<Harness />));
  await act(async () => mocks.receive!(snapshot(3)));
  await act(async () => resolve(snapshot(1)));
  expect(current.state?.revision).toBe(3);
  await act(async () => current.applyState(snapshot(2)));
  expect(current.state?.revision).toBe(3);
  await act(async () => current.applyState(snapshot(4)));
  expect(current.state?.revision).toBe(4);
});

it('does not surface an obsolete query error after receiving a valid state', async () => {
  let reject!: (error: Error) => void;
  mocks.getState.mockReturnValue(new Promise<CloudState>((_, fail) => { reject = fail; }));
  await act(async () => root.render(<Harness />));
  await act(async () => mocks.receive!(snapshot(2)));
  await act(async () => reject(new Error('old query failed')));
  expect(current.loadError).toBeNull();
  expect(current.state?.revision).toBe(2);
});

it('reports initial query failure and recovers through a later state event', async () => {
  mocks.getState.mockRejectedValue(new Error('offline'));
  await act(async () => root.render(<Harness />));
  expect(current.loadError).toBe('offline');
  expect(current.loading).toBe(false);
  await act(async () => mocks.receive!({ ...snapshot(1), authStatus: 'restoring' }));
  expect(current.loadError).toBeNull();
  expect(current.loading).toBe(true);
  await act(async () => mocks.receive!(snapshot(2)));
  expect(current.loading).toBe(false);
});

it('removes subscriptions and ignores a query response after unmount', async () => {
  let resolve!: (state: CloudState) => void;
  mocks.getState.mockReturnValue(new Promise<CloudState>((done) => { resolve = done; }));
  await act(async () => root.render(<Harness />));
  await act(async () => root.unmount());
  await act(async () => resolve(snapshot(1)));
  expect(mocks.unlisten).toHaveBeenCalledOnce();
  expect(current.state).toBeNull();
});

it('shows membership failures and allows a successful retry', async () => {
  mocks.getState.mockResolvedValue(authenticatedSnapshot(1));
  mocks.refreshMembership.mockRejectedValueOnce(new Error('offline'));
  await act(async () => root.render(<Harness />));
  expect(mocks.refreshMembership).not.toHaveBeenCalled();
  expect(current.membershipError).toBeNull();
  let result: string | undefined;
  await act(async () => { result = await current.refreshMembership(); });
  expect(result).toBe('failed');
  expect(current.membershipError).toBe('offline');
  expect(current.membershipLoading).toBe(false);
  await act(async () => { result = await current.refreshMembership(); });
  expect(result).toBe('refreshed');
  expect(current.membershipError).toBeNull();
  expect(mocks.refreshMembership).toHaveBeenCalledTimes(2);
});

it('keeps failed verification locked through retries and stale cached snapshots', async () => {
  const member = { ...snapshot(5), authenticated: true, authStatus: 'authenticated',
    account: { user: { id: 'member' } },
    membership: { active: true, expiresAt: Date.now() + 60_000 } } as CloudState;
  mocks.getState.mockResolvedValue(member);
  await act(async () => root.render(<Harness />));
  mocks.refreshMembership.mockRejectedValueOnce(new Error('offline'));
  await act(async () => { await current.refreshMembership(); });
  expect(current.membershipError).toBe('offline');

  let resolve!: () => void;
  mocks.refreshMembership.mockReturnValueOnce(new Promise((done) => { resolve = () => done({}); }));
  let retry!: ReturnType<typeof current.refreshMembership>;
  await act(async () => { retry = current.refreshMembership(); });
  expect(current.membershipLoading).toBe(true);
  expect(current.membershipError).toBe('offline');
  await act(async () => { mocks.receive!({ ...member, revision: 4 }); mocks.ready!(); });
  expect(current.membershipError).toBe('offline');
  expect(current.state?.revision).toBe(5);
  await act(async () => { resolve(); await retry; });
  expect(current.membershipError).toBeNull();
});

it('accepts a successful membership refresh from another window after verification failed', async () => {
  mocks.getState.mockResolvedValue(authenticatedSnapshot(1));
  mocks.refreshMembership.mockRejectedValueOnce(new Error('offline'));
  await act(async () => root.render(<Harness />));
  await act(async () => { await current.refreshMembership(); });
  expect(current.membershipError).toBe('offline');
  await act(async () => mocks.receive!({ ...snapshot(2), authenticated: true, authStatus: 'authenticated',
    membershipStatus: 'verified',
    membership: { active: true, expiresAt: Date.now() + 60_000 } } as CloudState));
  expect(current.membershipError).toBeNull();
});

it('ignores a membership failure from a previous session', async () => {
  let reject!: (error: Error) => void;
  mocks.getState.mockResolvedValue(authenticatedSnapshot(1));
  mocks.refreshMembership.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
  await act(async () => root.render(<Harness />));
  expect(mocks.refreshMembership).not.toHaveBeenCalled();
  await act(async () => { void current.refreshMembership(); });
  expect(current.membershipLoading).toBe(true);
  await act(async () => mocks.receive!(snapshot(2)));
  await act(async () => reject(new Error('old failure')));
  expect(current.membershipError).toBeNull();
  expect(current.membershipLoading).toBe(false);
});

it('coalesces explicit membership refreshes and does not refresh on focus', async () => {
  let resolve!: () => void;
  mocks.getState.mockResolvedValue({ ...snapshot(1), authenticated: true, authStatus: 'authenticated', account: { user: { id: 'user-1' } } } as CloudState);
  mocks.refreshMembership.mockReturnValueOnce(new Promise((done) => { resolve = () => done({}); }));
  await act(async () => root.render(<Harness />));
  await act(async () => {
    void current.refreshMembership();
    void current.refreshMembership();
  });
  expect(mocks.refreshMembership).toHaveBeenCalledTimes(1);
  await act(async () => resolve());
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(mocks.refreshMembership).toHaveBeenCalledTimes(1);
});

it('does not poll membership after authentication or window focus', async () => {
  mocks.getState.mockResolvedValue({ ...snapshot(1), authenticated: true, authStatus: 'authenticated', account: { user: { id: 'user-1' } } } as CloudState);
  const setInterval = vi.spyOn(window, 'setInterval');
  await act(async () => root.render(<Harness />));
  expect(mocks.refreshMembership).not.toHaveBeenCalled();
  expect(setInterval).not.toHaveBeenCalled();
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(mocks.refreshMembership).not.toHaveBeenCalled();
  await act(async () => mocks.receive!(snapshot(2)));
  await act(async () => mocks.receive!({ ...snapshot(3), authenticated: true, authStatus: 'authenticated', account: { user: { id: 'user-1' } } } as CloudState));
  expect(mocks.refreshMembership).not.toHaveBeenCalled();
});

it('returns failure to callers and success after retry without an unhandled rejection', async () => {
  mocks.getState.mockResolvedValue(authenticatedSnapshot(1));
  await act(async () => root.render(<Harness />));
  mocks.refreshMembership.mockRejectedValueOnce(new Error('offline'));
  let result: string | undefined;
  await act(async () => { result = await current.refreshMembership(); });
  expect(result).toBe('failed');
  expect(current.membershipError).toBe('offline');
  await act(async () => { result = await current.refreshMembership(); });
  expect(result).toBe('refreshed');
  expect(current.membershipError).toBeNull();
});

it('returns stale to all coalesced callers after the session changes', async () => {
  mocks.getState.mockResolvedValue(authenticatedSnapshot(1));
  await act(async () => root.render(<Harness />));
  let finish!: () => void;
  mocks.refreshMembership.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
  let first!: ReturnType<typeof current.refreshMembership>;
  let second!: ReturnType<typeof current.refreshMembership>;
  await act(async () => {
    first = current.refreshMembership();
    second = current.refreshMembership();
  });
  await act(async () => mocks.receive!(snapshot(2)));
  await act(async () => finish());
  await expect(first).resolves.toBe('stale');
  await expect(second).resolves.toBe('stale');
  expect(current.membershipError).toBeNull();
  expect(current.membershipLoading).toBe(false);
});

it.each(['success', 'failure'] as const)('returns stale to all callers when a refresh ends with %s after unmount', async (outcome) => {
  mocks.getState.mockResolvedValue(authenticatedSnapshot(1));
  await act(async () => root.render(<Harness />));
  let finish!: () => void;
  mocks.refreshMembership.mockReturnValueOnce(new Promise<void>((resolve, reject) => {
    finish = () => outcome === 'success' ? resolve() : reject(new Error('late failure'));
  }));
  let first!: ReturnType<typeof current.refreshMembership>;
  let second!: ReturnType<typeof current.refreshMembership>;
  await act(async () => {
    first = current.refreshMembership();
    second = current.refreshMembership();
  });
  expect(mocks.refreshMembership).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  await act(async () => finish());
  await expect(first).resolves.toBe('stale');
  await expect(second).resolves.toBe('stale');
});
