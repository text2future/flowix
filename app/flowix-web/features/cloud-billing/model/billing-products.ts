import type { CloudProduct } from '@platform/tauri/client';

/**
 * One dialog, two shelves: membership plans and credit packs.
 *
 * The Cloud catalog is the only source of truth. A product belongs to a shelf
 * by its entitlement features, following the same convention the membership
 * plans already use (`membership: true` / `lifetime: true`). Credit packs
 * declare their denomination with `credits` (also accepted as
 * `creditAmount` / `creditsAmount` / `points`), so a new pack needs no client
 * release beyond the catalog entry.
 */
export type BillingTab = 'membership' | 'credits';

export const BILLING_TABS: readonly BillingTab[] = ['membership', 'credits'];

function featureNumber(value: unknown): number | null {
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) return null;
  return number;
}

/** Credit denomination of a pack, or null when the product is not a pack. */
export function creditsOf(product: CloudProduct): number | null {
  const features = product.entitlement?.features ?? {};
  return featureNumber(features.credits)
    ?? featureNumber(features.creditAmount)
    ?? featureNumber(features.creditsAmount)
    ?? featureNumber(features.points);
}

/** Membership products are subscription/one-time entitlements, never packs. */
export function isMembershipProduct(product: CloudProduct): boolean {
  if (creditsOf(product) !== null) return false;
  return product.entitlement?.features?.membership === true;
}

export interface BillingProductGroups {
  membership: CloudProduct[];
  credits: CloudProduct[];
}

export function groupBillingProducts(products: readonly CloudProduct[]): BillingProductGroups {
  const groups: BillingProductGroups = { membership: [], credits: [] };
  products.forEach((product) => {
    if (creditsOf(product) !== null) groups.credits.push(product);
    else if (isMembershipProduct(product)) groups.membership.push(product);
  });
  return groups;
}

export function defaultBillingTab(groups: BillingProductGroups): BillingTab {
  if (groups.membership.length > 0) return 'membership';
  return groups.credits.length > 0 ? 'credits' : 'membership';
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  usd: '$',
  cny: '¥',
  eur: '€',
};

/** Prices arrive in minor units; render the currency the catalog reports. */
export function formatBillingPrice(
  price: { amount: number; currency: string } | null | undefined,
): string {
  if (!price || !Number.isFinite(price.amount)) return '';
  const currency = (price.currency ?? '').trim();
  const symbol = CURRENCY_SYMBOLS[currency.toLowerCase()];
  const amount = price.amount / 100;
  const text = amount.toFixed(amount % 1 === 0 ? 0 : 2);
  if (symbol) return `${symbol}${text}`;
  return currency ? `${text} ${currency.toUpperCase()}` : text;
}
