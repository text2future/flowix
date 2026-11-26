// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  listBillingOrders: vi.fn(),
  checkBillingOrder: vi.fn(),
  refreshMembership: vi.fn(),
  getAiCreditBalance: vi.fn(),
  enable: vi.fn(),
}));

vi.mock('@platform/tauri/client', () => ({
  cloud: {
    getState: mocks.getState,
    listBillingOrders: mocks.listBillingOrders,
    checkBillingOrder: mocks.checkBillingOrder,
    refreshMembership: mocks.refreshMembership,
    getAiCreditBalance: mocks.getAiCreditBalance,
  },
}));
vi.mock('@/lib/pi-feature-settings', () => ({
  enableWebSearchAfterMembershipPurchase: mocks.enable,
}));

import { resumeAiMembershipPurchase, watchAiMembershipPurchase } from './ai-membership-purchase';

const account = { authenticated: true, account: { user: { id: 'user-1' } } };

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.clearAllMocks();
  mocks.getState.mockResolvedValue(account);
  mocks.listBillingOrders.mockResolvedValue([{ id: 'order-1', status: 'pending' }]);
  mocks.checkBillingOrder.mockResolvedValue({ confirmed: false });
  mocks.refreshMembership.mockResolvedValue({ aiActive: true });
  mocks.getAiCreditBalance.mockResolvedValue({});
  mocks.enable.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('AI membership purchase tracking', () => {
  it('continues polling after the payment surface closes and enables only after payment', async () => {
    const onEnabled = vi.fn();
    const cancel = await watchAiMembershipPurchase('order-1', false, onEnabled);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.enable).not.toHaveBeenCalled();
    mocks.listBillingOrders.mockResolvedValue([{ id: 'order-1', status: 'paid' }]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.enable).toHaveBeenCalledOnce();
    expect(onEnabled).toHaveBeenCalledOnce();
    cancel();
  });

  it('resumes a pending order after restart and waits for the purchasing account', async () => {
    const cancel = await watchAiMembershipPurchase('order-1', true);
    await vi.advanceTimersByTimeAsync(0);
    const saved = localStorage.getItem('flowix.ai-membership-pending-order.v1');
    cancel();
    localStorage.setItem('flowix.ai-membership-pending-order.v1', saved!);
    mocks.getState.mockResolvedValue({ authenticated: true, account: { user: { id: 'other' } } });
    const stop = resumeAiMembershipPurchase();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.enable).not.toHaveBeenCalled();
    mocks.getState.mockResolvedValue(account);
    mocks.listBillingOrders.mockResolvedValue([{ id: 'order-1', status: 'paid' }]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.enable).toHaveBeenCalledOnce();
    stop();
  });
});
