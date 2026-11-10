// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudProduct } from '@platform/tauri/client';

const mocks = vi.hoisted(() => ({
  listProducts: vi.fn(),
  createCheckout: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock('@platform/tauri/client', () => ({
  cloud: {
    listProducts: mocks.listProducts,
    createCheckout: mocks.createCheckout,
  },
  // `product-catalog.ts` probes both of these at module load time. A vitest
  // module mock throws on any export that is not declared, even with `?.`.
  product: undefined,
  listenToCloudStateChanges: undefined,
}));
vi.mock('@platform/tauri/opener', () => ({ openUrl: mocks.openUrl }));
vi.mock('@/lib/i18n', () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ t }) };
});

import { PaymentDialog } from './payment-dialog';

// The catalog's entitlementKind is authoritative. Deliberately leave the old
// `membership` feature flag off so a regression to feature-based grouping fails.
const STORAGE: CloudProduct = {
  id: 'storage-annual',
  name: 'Annual cloud storage',
  description: 'Cloud storage and member models',
  price: { amount: 2900, currency: 'usd' },
  billingType: 'subscription',
  entitlementKind: 'storage',
  entitlement: {
    storageBytes: 5 * 1024 ** 3,
    duration: { unit: 'year', count: 1 },
    features: {},
  },
};

const AI: CloudProduct = {
  id: 'ai-monthly',
  name: 'AI monthly',
  description: '',
  price: { amount: 1000, currency: 'usd' },
  billingType: 'subscription',
  entitlementKind: 'ai',
  entitlement: {
    storageBytes: 0,
    duration: { unit: 'month', count: 1 },
    features: { credits: 5000 },
  },
};

/** Pre-split cached catalogs carry no kind and have to fall back to features. */
const LEGACY_STORAGE: CloudProduct = {
  ...STORAGE,
  id: 'legacy-annual',
  entitlementKind: undefined,
  entitlement: { ...STORAGE.entitlement, features: { membership: true } },
};
const LEGACY_AI: CloudProduct = {
  ...AI,
  id: 'legacy-credits',
  entitlementKind: undefined,
};

let container: HTMLDivElement;
let root: Root;

async function render(initialTab: 'membership' | 'credits' = 'membership', onClose = vi.fn()) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<PaymentDialog initialTab={initialTab} onClose={onClose} />);
  });
  return onClose;
}

// The dialog portals to `document.body`, so queries run against the document.
function productNames(): string[] {
  return Array.from(document.body.querySelectorAll('.payment-dialog__product-name'))
    .map((node) => node.textContent ?? '');
}

function productElements(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>('.payment-dialog__product'));
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.listProducts.mockResolvedValue([STORAGE, AI]);
  mocks.createCheckout.mockResolvedValue({ checkoutUrl: 'https://pay.example/1', orderId: 'o1', status: 'pending' });
  mocks.openUrl.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.replaceChildren();
});

describe('PaymentDialog', () => {
  it('shows both entitlement kinds in one list, classified by entitlementKind', async () => {
    await render('membership');
    expect(productNames()).toEqual([
      'billing.dialog.product.aiMembership',
      'billing.dialog.product.storageExperience',
    ]);
    expect(productElements()[0].classList.contains('payment-dialog__product--ai')).toBe(true);
    expect(productElements()[1].classList.contains('payment-dialog__product--storage')).toBe(true);
    expect(document.body.querySelector('.payment-dialog__amount')?.textContent).toBe('$10');
  });

  it('keeps an AI product on the AI shelf even without a credit denomination', async () => {
    const aiWithoutCredits: CloudProduct = {
      ...AI,
      entitlement: { ...AI.entitlement, features: {} },
    };
    mocks.listProducts.mockResolvedValue([STORAGE, aiWithoutCredits]);
    await render();
    expect(productNames()[0]).toBe('billing.dialog.product.aiMembership');
    expect(productElements()[0].classList.contains('payment-dialog__product--ai')).toBe(true);
  });

  it('falls back to features for cached catalogs written before the two-kind split', async () => {
    mocks.listProducts.mockResolvedValue([LEGACY_STORAGE, LEGACY_AI]);
    await render();
    expect(productNames()).toEqual([
      'billing.dialog.product.aiMembership',
      'billing.dialog.product.storageExperience',
    ]);
  });

  it('focuses the AI shelf when opened from a credits notice', async () => {
    await render('credits');
    const focused = document.body.querySelector<HTMLElement>('[data-payment-initial-focus]');
    expect(focused?.closest('.payment-dialog__product')?.classList.contains('payment-dialog__product--ai')).toBe(true);
  });

  it('starts a checkout and closes', async () => {
    const onClose = await render('credits');
    const buy = document.body.querySelector<HTMLButtonElement>('.payment-dialog__product button');
    await act(async () => {
      buy!.click();
      await Promise.resolve();
    });
    expect(mocks.createCheckout).toHaveBeenCalledWith('ai-monthly');
    expect(mocks.openUrl).toHaveBeenCalledWith('https://pay.example/1');
    expect(onClose).toHaveBeenCalled();
  });

  it('reports an empty catalog instead of an empty list', async () => {
    mocks.listProducts.mockResolvedValue([]);
    await render('credits');
    expect(document.body.querySelector('.payment-dialog__state')?.textContent)
      .toBe('billing.dialog.empty.all');
  });

  it('surfaces a catalog failure and retries', async () => {
    mocks.listProducts.mockRejectedValueOnce(new Error('offline'));
    await render('membership');
    expect(document.body.querySelector('.payment-dialog__state--error')).not.toBeNull();
    const retry = document.body.querySelector<HTMLButtonElement>('.payment-dialog__state--error button');
    await act(async () => {
      retry!.click();
      await Promise.resolve();
    });
    expect(mocks.listProducts).toHaveBeenCalledTimes(2);
    expect(productNames()).toHaveLength(2);
  });

  it('closes on escape', async () => {
    const onClose = await render('membership');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalled();
  });
});
