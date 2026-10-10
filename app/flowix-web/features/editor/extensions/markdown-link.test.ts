import { describe, expect, it } from 'vitest';
import { findMarkdownLinkPasteMatches, normalizePlainLinkHref } from './markdown-link';

describe('markdown link destinations', () => {
  it('strips strict angle-bracket destinations on paste', () => {
    const matches = findMarkdownLinkPasteMatches('[计划表](<../计划表.csv>)');
    expect(matches).toHaveLength(1);
    expect(matches[0].data?.href).toBe('../计划表.csv');
  });

  it('keeps plain destinations unchanged', () => {
    const matches = findMarkdownLinkPasteMatches('[方案](../../公共/方案.md)');
    expect(matches).toHaveLength(1);
    expect(matches[0].data?.href).toBe('../../公共/方案.md');
  });

  it('parses a title after a strict bracketed destination containing spaces', () => {
    const matches = findMarkdownLinkPasteMatches('[资料](<../资料/我的 文件.md> "参考")');
    expect(matches).toHaveLength(1);
    expect(matches[0].data?.href).toBe('../资料/我的 文件.md');
    expect(matches[0].data?.title).toBe('参考');
  });

  it('still normalizes bare domains as web links', () => {
    expect(normalizePlainLinkHref('example.com')).toBe('http://example.com');
  });
});
