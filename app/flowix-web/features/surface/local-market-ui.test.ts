import { describe, expect, it } from 'vitest';
import { canonicalUrl } from '@/lib/url';
import { isLocalMarketUiUrl, marketUiAssetUrl, marketUiEntryUrl, marketUiViewForUrl } from '@shared/lib/market-ui-url';
import { skillMarketContentOriginForUrl, skillMarketLanguageForUrl, skillMarketUrlForLanguage } from '@features/surface/skill-market-origin';

describe('local market URL contract', () => {
  it('accepts only stable internal entry URLs for the market views', () => {
    for (const view of ['skills', 'templates'] as const) {
      const entry = marketUiEntryUrl(view);
      expect(canonicalUrl(entry)).toBe(entry);
      expect(marketUiViewForUrl(entry)).toBe(view);
    }
    for (const entry of ['flowix://market/other', 'flowix://other/skills', 'file:///tmp/index.html']) {
      expect(canonicalUrl(entry)).toBeNull();
      expect(marketUiViewForUrl(entry)).toBeNull();
    }
  });

  for (const origin of ['asset://localhost', 'http://asset.localhost', 'https://asset.localhost']) {
    for (const path of ['/Users/用户/Library/Application Support/flowix/skill-market-ui/prod/versions/1.0.0/index.html', 'C:\\Users\\user\\flowix\\skill-market-ui\\staging\\versions\\1.0.0\\index.html']) {
      it(`preserves local resources and language navigation for ${origin} ${path}`, () => {
        const raw = `${origin}/${encodeURIComponent(path)}`;
        const url = marketUiAssetUrl(raw);
        expect(canonicalUrl(raw)).toBe(url.href);
        url.search = '?view=templates'; url.hash = '#cards';
        expect(canonicalUrl(url.href)).toBe(url.href);
        const css = new URL('./css/skill-market.css', url);
        expect(decodeURIComponent(css.pathname)).toContain('/skill-market-ui/');
        expect(decodeURIComponent(css.pathname)).toMatch(/versions\/1\.0\.0\/css\/skill-market\.css$/);
        expect(skillMarketContentOriginForUrl(url.href)).toBe('https://skills.flowix.cc');
        const english = skillMarketUrlForLanguage(url.href, 'en-US')!;
        expect(skillMarketLanguageForUrl(english)).toBe('en-US');
        expect(new URL(english).search).toBe('?view=templates');
        expect(new URL(english).hash).toBe('#cards');
        expect(skillMarketUrlForLanguage(english, 'zh-CN')).toBe(url.href);
      });
    }
  }
  it('does not widen navigation to arbitrary asset files or sources', () => {
    for (const url of ['asset://localhost/etc/passwd', 'file:///tmp/index.html', 'asset://evil/skill-market-ui/versions/1.0.0/index.html']) {
      expect(isLocalMarketUiUrl(url)).toBe(false);
      expect(canonicalUrl(url)).toBeNull();
    }
  });
});
