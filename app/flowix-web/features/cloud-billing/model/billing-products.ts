import type { CloudProduct } from '@platform/tauri/client';

/**
 * One dialog, two shelves: cloud storage plans and AI point subscriptions.
 *
 * `entitlementKind` is authoritative and comes straight from the Cloud catalog.
 * Catalogs cached before the two-kind split are still grouped by the credit
 * denomination, so an old client cache cannot hide a product.
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

/**
 * The catalog's kind wins. A cached pre-split entry keeps the old
 * feature-based classification, and an unclassified legacy entry is ignored
 * rather than shown on the wrong shelf.
 */
function entitlementKindOfProduct(product: CloudProduct): 'storage' | 'ai' | null {
  if (product.entitlementKind === 'storage' || product.entitlementKind === 'ai') {
    return product.entitlementKind;
  }
  if (creditsOf(product) !== null) return 'ai';
  return product.entitlement?.features?.membership === true ? 'storage' : null;
}

/** True for the cloud storage kind; AI point products are never storage plans. */
export function isMembershipProduct(product: CloudProduct): boolean {
  return entitlementKindOfProduct(product) === 'storage';
}

export interface BillingProductGroups {
  membership: CloudProduct[];
  credits: CloudProduct[];
}

export function groupBillingProducts(products: readonly CloudProduct[]): BillingProductGroups {
  const groups: BillingProductGroups = { membership: [], credits: [] };
  products.forEach((product) => {
    const kind = entitlementKindOfProduct(product);
    if (kind === 'ai') groups.credits.push(product);
    else if (kind === 'storage') groups.membership.push(product);
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
