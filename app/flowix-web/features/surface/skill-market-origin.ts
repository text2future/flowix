import { isLocalMarketUiUrl, marketUiRootUrl, MARKET_CONTENT_ORIGIN } from '@shared/lib/market-ui-url';
const PRODUCTION_ORIGINS = new Set(['https://skills.flowix.cc', 'https://flowix.cc']);

const CHINESE_ENTRY = /^\/i(?:\/(?:index(?:\.html)?)?)?\/?$/;
const ENGLISH_ENTRY = /^\/i\/en(?:\/(?:index(?:\.html)?)?)?\/?$/;
const LOCAL_ENGLISH_ENTRY = /\/en\/index\.html$/;

export const isLocalSkillMarketUiUrl = isLocalMarketUiUrl;

export function skillMarketLanguageForUrl(url: string): 'zh-CN' | 'en-US' {
  try {
    const parsed = new URL(url);
    const pathname = decodeURIComponent(parsed.pathname).replace(/\\/g, '/');
    return ENGLISH_ENTRY.test(pathname) || LOCAL_ENGLISH_ENTRY.test(pathname) ? 'en-US' : 'zh-CN';
  } catch {
    return 'zh-CN';
  }
}

/** Keep aliases and query/hash when already localized; switch only market entries. */
export function skillMarketUrlForLanguage(url: string, language: string, allowLocal = false): string | null {
  if (!skillMarketOriginForUrl(url, allowLocal) || !['zh-CN', 'en-US'].includes(language)) return null;
  const parsed = new URL(url);
  if (isLocalMarketUiUrl(url)) {
    if (skillMarketLanguageForUrl(url) !== language) {
      const next = new URL(language === 'en-US' ? 'en/index.html' : 'index.html', marketUiRootUrl(url));
      next.search = parsed.search;
      next.hash = parsed.hash;
      return next.href;
    }
    return parsed.href;
  }
  if (!CHINESE_ENTRY.test(parsed.pathname) && !ENGLISH_ENTRY.test(parsed.pathname)) return null;
  if (skillMarketLanguageForUrl(url) !== language) {
    const extension = PRODUCTION_ORIGINS.has(parsed.origin) ? '' : '.html';
    parsed.pathname = (language === 'en-US' ? '/i/en/index' : '/i/index') + extension;
  }
  return parsed.href;
}

/** Local skill pages may access the native bridge on loopback ports only in development builds. */
export function skillMarketOriginForUrl(url: string, allowLocal = false): string | null {
  try {
    const parsed = new URL(url);
    if (isLocalSkillMarketUiUrl(url)) return parsed.origin;
    if (parsed.pathname !== '/i' && !parsed.pathname.startsWith('/i/')) return null;
    if (PRODUCTION_ORIGINS.has(parsed.origin)) return parsed.origin;
    if (allowLocal && parsed.protocol === 'http:'
      && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) return parsed.origin;
  } catch {
    // Invalid addresses cannot activate the native installation bridge.
  }
  return null;
}

/** Resource trust is independent of the embedded page transport. */
export function skillMarketContentOriginForUrl(url: string, allowLocal = false): string | null {
  return isLocalMarketUiUrl(url) ? MARKET_CONTENT_ORIGIN : skillMarketOriginForUrl(url, allowLocal);
}
