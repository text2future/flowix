import { describe, expect, it, vi } from 'vitest';

const subscribeMock = vi.hoisted(() => vi.fn());

vi.mock('@platform/tauri/event-bus', () => ({
  subscribe: subscribeMock,
}));

describe('memo dispatcher window isolation', () => {
  it('installs only the Tauri bridge and no window-specific handlers', async () => {
    const { memoDispatcher } = await import('./memo-dispatcher');

    expect(subscribeMock).toHaveBeenCalledOnce();
    expect(subscribeMock).toHaveBeenCalledWith('memo-event', expect.any(Function));
    expect(memoDispatcher.size()).toBe(0);
  });
});
