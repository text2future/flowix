import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CloudSyncSection } from './cloud-sync';

const mocks = vi.hoisted(() => ({
  listBillingOrders: vi.fn(), listSubscriptions: vi.fn(), checkBillingOrder: vi.fn(), listProducts: vi.fn(), createCheckout: vi.fn(),
  refreshMembership: vi.fn(), success: vi.fn(), info: vi.fn(), error: vi.fn(),
  getAiCreditBalance: vi.fn(),
  membershipAccess: { active: false, lifetime: false, loading: false },
  cloudState: { authenticated: true, account: { user: { id: 'usr_1', displayName: 'User' } } },
}));
vi.mock('@platform/tauri/client', () => ({ cloud: {
  listBillingOrders: mocks.listBillingOrders,
  listSubscriptions: mocks.listSubscriptions,
  checkBillingOrder: mocks.checkBillingOrder,
  createCheckout: mocks.createCheckout,
  listProducts: mocks.listProducts,
  getAiCreditBalance: mocks.getAiCreditBalance,
} }));
vi.mock('@features/preferences/sections/pi-cloud-models-section', () => ({
  PiCloudModelsSection: () => 'PI_MEMBER_MODELS_SECTION',
}));
vi.mock('@features/preferences/hooks/use-cloud-account-state', () => ({
  useCloudAccountState: () => ({
    state: mocks.cloudState,
    refreshMembership: mocks.refreshMembership,
  }),
}));
vi.mock('@features/preferences/public/membership', () => ({
  useMembershipAccess: () => mocks.membershipAccess,
}));
vi.mock('@/lib/i18n', async (importOriginal) => {
  const t = (key: string) => key;
  return { ...await importOriginal<typeof import('@/lib/i18n')>(), useI18n: () => ({ t }) };
});
vi.mock('@/lib/toast', () => ({ toast: { success: mocks.success, info: mocks.info, error: mocks.error } }));
vi.mock('@platform/tauri/event-bus', () => ({ subscribe: () => () => {} }));
vi.mock('@platform/tauri/opener', () => ({ openUrl: vi.fn() }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.cloudState.authenticated = true;
  Object.assign(mocks.membershipAccess, { active: false, lifetime: false, loading: false });
  mocks.listProducts.mockResolvedValue([]);
  mocks.listSubscriptions.mockResolvedValue([]);
  mocks.listBillingOrders.mockResolvedValue([{
    id: 'ord_1', productName: 'Plan', amount: 390, currency: 'CNY', status: 'pending', createdAt: 0,
  }]);
  mocks.refreshMembership.mockResolvedValue('refreshed');
  mocks.getAiCreditBalance.mockResolvedValue({});
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function clickCheck() {
  await act(async () => root.render(<CloudSyncSection />));
  if (!document.body.querySelector('[role="dialog"]')) {
    const orders = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent === 'preferences.cloud.order.title',
    );
    expect(orders).toBeDefined();
    await act(async () => orders!.click());
  }
  const button = Array.from(document.body.querySelectorAll('button')).find(
    (item) => item.textContent === 'preferences.cloud.order.check',
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

it('hides Pi Cloud models while signed out', async () => {
  mocks.cloudState.authenticated = false;
  await act(async () => root.render(<CloudSyncSection />));
  expect(container.textContent).not.toContain('PI_MEMBER_MODELS_SECTION');
});

it('shows privacy and terms links alongside Google sign-in', async () => {
  mocks.cloudState.authenticated = false;
  await act(async () => root.render(<CloudSyncSection />));
  expect(container.textContent).toContain('preferences.cloud.googleSignIn');
  expect(container.textContent).toContain('preferences.cloud.registration.continueLegal');
  expect(Array.from(container.querySelectorAll('a')).map((link) => link.href)).toEqual(expect.arrayContaining([
    expect.stringMatching(/\/privacy\/$/), expect.stringMatching(/\/terms\/$/),
  ]));
});

it('shows Pi Cloud models while signed in', async () => {
  await act(async () => root.render(<CloudSyncSection />));
  expect(container.textContent).toContain('PI_MEMBER_MODELS_SECTION');
});

it.each([
  ['unsupported', 'error', 'needsReview'],
  ['dead_letter', 'error', 'needsReview'],
  ['failed', 'error', 'syncFailed'],
  ['processing', 'info', 'processing'],
  ['pending', 'info', 'notConfirmed'],
  ['unavailable', 'error', 'unavailable'],
  ['refunded', 'info', 'refunded'],
  ['future_status', 'error', 'unknownResult'],
] as const)('presents %s accurately without reporting successful membership recovery', async (checkStatus, kind, message) => {
  mocks.checkBillingOrder.mockResolvedValue({ status: 'pending', confirmed: false, checkStatus });
  await clickCheck();
  expect(mocks[kind]).toHaveBeenCalledWith(`preferences.cloud.order.${message}`);
  expect(mocks.success).not.toHaveBeenCalled();
  expect(mocks.refreshMembership).not.toHaveBeenCalled();
  if (checkStatus === 'failed') {
    expect(document.body.textContent).toContain('preferences.cloud.retry');
  }
});

it('refreshes membership after a confirmed payment', async () => {
  mocks.checkBillingOrder.mockResolvedValue({ status: 'paid', confirmed: true, checkStatus: 'processed' });
  await clickCheck();
  expect(mocks.refreshMembership).toHaveBeenCalledOnce();
  expect(mocks.success).toHaveBeenCalledWith('preferences.cloud.order.confirmed');
  expect(mocks.listBillingOrders).toHaveBeenCalledTimes(2);
});

it('continues a pending order with its original quantity', async () => {
  mocks.listBillingOrders.mockResolvedValue([{ id: 'ord_1', productId: 'ai', productName: 'AI', quantity: 3, amount: 300, currency: 'CNY', status: 'pending', createdAt: 0 }]);
  mocks.createCheckout.mockResolvedValue({ orderId: 'ord_1', checkoutUrl: 'https://pay.example/1' });
  await act(async () => root.render(<CloudSyncSection />));
  const orders = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'preferences.cloud.order.title');
  await act(async () => orders!.click());
  const resume = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'preferences.cloud.order.continuePayment');
  expect(resume).toBeDefined();
  await act(async () => resume!.click());
  expect(mocks.createCheckout).toHaveBeenCalledWith('ai', 3);
});

it('shows the localized rate limit message and keeps retry available', async () => {
  mocks.checkBillingOrder.mockRejectedValue('cloud API error 429 BILLING_RATE_LIMITED: too many checks');
  await clickCheck();
  expect(mocks.error).toHaveBeenCalledWith('preferences.cloud.order.rateLimited');
  expect(document.body.textContent).toContain('preferences.cloud.retry');
});

it('reports a confirmed payment with a failed local refresh without showing success', async () => {
  mocks.checkBillingOrder.mockResolvedValue({ status: 'paid', confirmed: true, checkStatus: 'processed' });
  mocks.refreshMembership.mockResolvedValue('failed');
  await clickCheck();
  expect(mocks.error).toHaveBeenCalledWith('preferences.cloud.order.refreshFailed');
  expect(mocks.success).not.toHaveBeenCalled();
});

it.each(['stale', 'skipped'])('does not show recovery feedback for a %s membership refresh', async (result) => {
  mocks.checkBillingOrder.mockResolvedValue({ status: 'paid', confirmed: true, checkStatus: 'processed' });
  mocks.refreshMembership.mockResolvedValue(result);
  await clickCheck();
  expect(mocks.success).not.toHaveBeenCalled();
  expect(mocks.error).not.toHaveBeenCalled();
});


it('hides membership plans and the lifetime upgrade card while membership is active', async () => {
  mocks.membershipAccess.active = true;
  mocks.listProducts.mockResolvedValue([
    {
      id: 'annual', name: 'Year membership', description: '', billingType: 'subscription',
      price: { amount: 2900, currency: 'USD' },
      entitlement: {
        storageBytes: 5 * 1024 * 1024 * 1024,
        duration: { unit: 'year', count: 1 },
        features: { membership: true },
      },
    },
    {
      id: 'lifetime', name: 'Lifetime membership', description: '', billingType: 'one_time',
      price: { amount: 9800, currency: 'USD' },
      entitlement: {
        storageBytes: 10 * 1024 * 1024 * 1024,
        duration: { unit: 'year', count: 1 },
        features: { membership: true, lifetime: true },
      },
    },
  ]);
  mocks.listBillingOrders.mockResolvedValue([]);

  await act(async () => root.render(<CloudSyncSection />));

  expect(container.textContent).not.toContain('preferences.cloud.member.active');
  expect(container.textContent).not.toContain('preferences.cloud.member.title');
  expect(container.textContent).not.toContain('preferences.cloud.member.upgrade');
  expect(container.textContent).not.toContain('preferences.cloud.member.purchase');
});

it('omits the scheduled-cancellation message from the subscription card', async () => {
  mocks.listSubscriptions.mockResolvedValue([{
    id: 'sub_1', isAnnualMembership: true, status: 'active',
    cancelAtPeriodEnd: true, currentPeriodEnd: Date.UTC(2027, 9, 21),
  }]);
  mocks.listBillingOrders.mockResolvedValue([]);

  await act(async () => root.render(<CloudSyncSection />));

  expect(container.textContent).not.toContain('preferences.cloud.subscription.cancelScheduled');
  expect(container.textContent).not.toContain('preferences.cloud.subscription.renewal');
  expect(container.textContent).not.toContain('preferences.cloud.subscription.cancel');
});

it('shows actionable copy instead of raw subscription and order API errors', async () => {
  const failure = new Error('cloud API error 500 INTERNAL_ERROR: backend failure (request id: secret-ref)');
  mocks.listSubscriptions.mockRejectedValue(failure);
  mocks.listBillingOrders.mockRejectedValue(failure);
  await act(async () => root.render(<CloudSyncSection />));
  expect(container.textContent).toContain('errors.friendly.subscriptionLoad');
  const orders = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === 'preferences.cloud.order.title');
  await act(async () => orders!.click());
  expect(document.body.textContent).toContain('errors.friendly.ordersLoad');
  expect(document.body.textContent).not.toMatch(/INTERNAL_ERROR|backend failure|secret-ref/);
});
