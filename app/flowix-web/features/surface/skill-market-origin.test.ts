import { describe, expect, it } from 'vitest';
import { skillMarketLanguageForUrl, skillMarketOriginForUrl, skillMarketUrlForLanguage } from './skill-market-origin';
import { createWorkspaceWebRuntime, navigateWorkspaceWebRuntime, replaceWorkspaceWebRuntimeUrl, moveWorkspaceWebHistory } from '../workspace/model/web-navigation';

describe('skill market origin allowlist', () => {
  it('recognizes production routes', () => {
    expect(skillMarketOriginForUrl('https://skills.flowix.cc/i/index')).toBe('https://skills.flowix.cc');
    expect(skillMarketOriginForUrl('https://skills.flowix.cc/i/')).toBe('https://skills.flowix.cc');
    expect(skillMarketOriginForUrl('https://skills.flowix.cc/i/en/index')).toBe('https://skills.flowix.cc');
  });
  it('allows localhost development servers on any port only in development builds', () => {
    for (const host of ['localhost', '127.0.0.1']) {
      for (const port of ['8080', '8088', '1420', '5173']) {
        const url = `http://${host}:${port}/i/index.html`;
        expect(skillMarketOriginForUrl(url)).toBeNull();
        expect(skillMarketOriginForUrl(url, true)).toBe(`http://${host}:${port}`);
      }
    }
  });
  it('rejects unrelated hosts, ports, protocols and routes', () => {
    for (const url of ['https://localhost:8088/i/', 'http://localhost:8080/other',
      'http://localhost.evil.test:8088/i/', 'http://192.168.1.2:8088/i/',
      'https://skills.flowix.cc/other', 'https://skills.flowix.cc.evil.test/i/', 'invalid']) {
      expect(skillMarketOriginForUrl(url, true)).toBeNull();
    }
  });
});

describe('skill market product language routing', () => {
  it('maps Chinese and English entries while preserving query and hash', () => {
    expect(skillMarketUrlForLanguage('https://skills.flowix.cc/i/index?from=app#writing', 'en-US'))
      .toBe('https://skills.flowix.cc/i/en/index?from=app#writing');
    expect(skillMarketUrlForLanguage('https://skills.flowix.cc/i/en/', 'zh-CN'))
      .toBe('https://skills.flowix.cc/i/index');
  });
  it('keeps localized aliases to prevent redirect loops', () => {
    for (const path of ['/i/en', '/i/en/', '/i/en/index', '/i/en/index.html']) {
      const url = `https://skills.flowix.cc${path}`;
      expect(skillMarketLanguageForUrl(url)).toBe('en-US');
      expect(skillMarketUrlForLanguage(url, 'en-US')).toBe(url);
    }
  });
  it('only redirects allowed market entries and development origins', () => {
    expect(skillMarketUrlForLanguage('https://evil.example/i/index', 'en-US')).toBeNull();
    expect(skillMarketUrlForLanguage('https://skills.flowix.cc/i/another-page', 'en-US')).toBeNull();
    expect(skillMarketUrlForLanguage('http://localhost:8088/i/index', 'en-US')).toBeNull();
    expect(skillMarketUrlForLanguage('http://localhost:8088/i/index', 'en-US', true)).toBe('http://localhost:8088/i/en/index.html');
    expect(skillMarketUrlForLanguage('https://skills.flowix.cc/i/index', 'unknown')).toBeNull();
  });
  it('replaces the automatic redirect history entry so Back leaves the market', () => {
    const start = createWorkspaceWebRuntime('https://example.com');
    const entered = navigateWorkspaceWebRuntime(start, 'https://skills.flowix.cc/i/index');
    const redirected = replaceWorkspaceWebRuntimeUrl(entered, 'https://skills.flowix.cc/i/en/index');
    expect(redirected.history).toEqual(['https://example.com', 'https://skills.flowix.cc/i/en/index']);
    expect(moveWorkspaceWebHistory(redirected, -1)?.currentUrl).toBe('https://example.com');
  });
});


it('connects the official website market without forcing the skills subdomain', () => {
  expect(skillMarketOriginForUrl('https://flowix.cc/i/?view=templates')).toBe('https://flowix.cc');
  expect(skillMarketUrlForLanguage('https://flowix.cc/i/?view=templates', 'en-US')).toBe('https://flowix.cc/i/en/index?view=templates');
});
