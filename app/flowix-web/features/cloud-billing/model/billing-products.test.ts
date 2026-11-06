import { describe, expect, it } from 'vitest';
import type { CloudProduct } from '@platform/tauri/client';
import {
  creditsOf,
  defaultBillingTab,
  formatBillingPrice,
  groupBillingProducts,
  isMembershipProduct,
} from './billing-products';

function product(overrides: Partial<CloudProduct> & { features?: Record<string, unknown> } = {}): CloudProduct {
  const { features, ...rest } = overrides;
  return {
    id: 'prod',
    name: 'Product',
    description: '',
    price: { amount: 2900, currency: 'usd' },
    billingType: 'subscription',
    entitlement: {
      storageBytes: 0,
      duration: { unit: 'year', count: 1 },
      features: features ?? {},
    },
    ...rest,
  };
}

describe('creditsOf', () => {
  it('reads the documented denomination fields', () => {
    expect(creditsOf(product({ features: { credits: 5000 } }))).toBe(5000);
    expect(creditsOf(product({ features: { creditAmount: '2000' } }))).toBe(2000);
    expect(creditsOf(product({ features: { points: 100 } }))).toBe(100);
  });

  it('ignores missing or invalid denominations', () => {
    expect(creditsOf(product({ features: {} }))).toBeNull();
    expect(creditsOf(product({ features: { credits: 0 } }))).toBeNull();
    expect(creditsOf(product({ features: { credits: 'many' } }))).toBeNull();
  });
});

describe('groupBillingProducts', () => {
  it('splits membership plans from credit packs', () => {
    const groups = groupBillingProducts([
      product({ id: 'annual', features: { membership: true } }),
      product({ id: 'life', features: { membership: true, lifetime: true } }),
      product({ id: 'pack', features: { credits: 5000 } }),
      product({ id: 'storage', features: {} }),
    ]);
    expect(groups.membership.map((item) => item.id)).toEqual(['annual', 'life']);
    expect(groups.credits.map((item) => item.id)).toEqual(['pack']);
  });

  it('never files a pack as a membership plan', () => {
    const pack = product({ features: { membership: true, credits: 500 } });
    expect(isMembershipProduct(pack)).toBe(false);
    expect(groupBillingProducts([pack]).membership).toHaveLength(0);
  });

  it('opens on the shelf that has products', () => {
    expect(defaultBillingTab({ membership: [], credits: [product({ features: { credits: 1 } })] })).toBe('credits');
    expect(defaultBillingTab({ membership: [product({ features: { membership: true } })], credits: [] })).toBe('membership');
  });
});

describe('formatBillingPrice', () => {
  it('renders minor units with the catalog currency', () => {
    expect(formatBillingPrice({ amount: 2900, currency: 'usd' })).toBe('$29');
    expect(formatBillingPrice({ amount: 1999, currency: 'usd' })).toBe('$19.99');
    expect(formatBillingPrice({ amount: 5800, currency: 'cny' })).toBe('¥58');
    expect(formatBillingPrice({ amount: 100, currency: 'sek' })).toBe('1 SEK');
    expect(formatBillingPrice(undefined)).toBe('');
  });
});
