import { isLocalMarketUiUrl, marketUiAssetUrl, marketUiViewForUrl } from '@shared/lib/market-ui-url';

/** Normalize supported web addresses for stable workspace identity. */
export function canonicalUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (marketUiViewForUrl(parsed.href)) return parsed.href;
    if (isLocalMarketUiUrl(parsed.href)) return marketUiAssetUrl(parsed.href).href;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}
