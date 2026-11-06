/** Pure URL contract shared by navigation and the market bridge. */
export const MARKET_CONTENT_ORIGIN = 'https://skills.flowix.cc';
const LOCAL_ENTRY = /(?:^|\/)skill-market-ui\/(?:staging\/|prod\/)?versions\/\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?\/(?:en\/)?index\.html$/;

export function isLocalMarketUiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const assetOrigin = (url.protocol === 'asset:' && url.hostname === 'localhost')
      || (['http:', 'https:'].includes(url.protocol) && url.hostname === 'asset.localhost');
    const path = decodeURIComponent(url.pathname).replace(/\\/g, '/');
    return assetOrigin && !url.username && !url.password && !url.port
      && !path.split('/').some(part => part === '..' || part === '.') && LOCAL_ENTRY.test(path);
  } catch { return false; }
}

/** Tauri encodes a whole path; preserve directory separators for relative assets. */
export function marketUiAssetUrl(assetUrl: string): URL {
  if (!isLocalMarketUiUrl(assetUrl)) throw new Error('Invalid local market page');
  const url = new URL(assetUrl);
  url.pathname = decodeURIComponent(url.pathname).replace(/\\/g, '/')
    .split('/').map(encodeURIComponent).join('/');
  return url;
}

/** Root of one installed release, independent of the selected language or view. */
export function marketUiRootUrl(assetUrl: string): URL {
  const url = marketUiAssetUrl(assetUrl);
  url.pathname = url.pathname.replace(/(?:en\/)?index\.html$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

export type MarketUiView = 'skills' | 'templates';

/** Stable workspace identity; resource versions and local paths belong to the renderer. */
export function marketUiEntryUrl(view: MarketUiView): string {
  return `flowix://market/${view}`;
}

export function marketUiViewForUrl(value: string): MarketUiView | null {
  if (value === marketUiEntryUrl('skills')) return 'skills';
  if (value === marketUiEntryUrl('templates')) return 'templates';
  return null;
}
