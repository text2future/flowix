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
}));
vi.mock('@platform/tauri/opener', () => ({ openUrl: mocks.openUrl }));
vi.mock('@/lib/i18n', () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ t }) };
});

import { PaymentDialog } from './payment-dialog';

const MEMBERSHIP: CloudProduct = {
  id: 'member-annual',
  name: 'Annual membership',
  description: 'Cloud storage and member models',
  price: { amount: 2900, currency: 'usd' },
  billingType: 'subscription',
  entitlement: {
    storageBytes: 5 * 1024 ** 3,
    duration: { unit: 'year', count: 1 },
    features: { membership: true },
  },
};

const CREDITS: CloudProduct = {
  id: 'credits-5000',
  name: 'Credit pack',
  description: '',
  price: { amount: 1000, currency: 'usd' },
  billingType: 'one_time',
  entitlement: {
    storageBytes: 0,
    duration: { unit: 'day', count: 0 },
    features: { credits: 5000 },
  },
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listProducts.mockResolvedValue([MEMBERSHIP, CREDITS]);
  mocks.createCheckout.mockResolvedValue({ checkoutUrl: 'https://pay.example/1', orderId: 'o1', status: 'pending' });
  mocks.openUrl.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.replaceChildren();
});

describe('PaymentDialog', () => {
  it('opens on the membership shelf and hides credit packs', async () => {
    await render('membership');
    expect(productNames()).toEqual(['Annual membership']);
    expect(document.body.querySelector('.payment-dialog__amount')?.textContent).toBe('$29');
    expect(document.body.querySelector('.payment-dialog__tab.is-active')?.textContent)
      .toBe('billing.dialog.tab.membership');
  });

  it('shows denominations on the credit shelf', async () => {
    await render('credits');
    expect(productNames()).toEqual(['billing.dialog.creditsAmount']);
    expect(document.body.querySelector('.payment-dialog__tab.is-active')?.textContent)
      .toBe('billing.dialog.tab.credits');
  });

  it('starts a checkout from either shelf and closes', async () => {
    const onClose = await render('credits');
    const buy = document.body.querySelector<HTMLButtonElement>('.payment-dialog__product button');
    await act(async () => {
      buy!.click();
      await Promise.resolve();
    });
    expect(mocks.createCheckout).toHaveBeenCalledWith('credits-5000');
    expect(mocks.openUrl).toHaveBeenCalledWith('https://pay.example/1');
    expect(onClose).toHaveBeenCalled();
  });

  it('reports an empty shelf instead of an empty list', async () => {
    mocks.listProducts.mockResolvedValue([MEMBERSHIP]);
    await render('credits');
    expect(document.body.querySelector('.payment-dialog__state')?.textContent)
      .toBe('billing.dialog.empty.credits');
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
    expect(productNames()).toEqual(['Annual membership']);
  });

  it('closes on escape', async () => {
    const onClose = await render('membership');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalled();
  });
});
