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

it('keeps balanced parentheses and escaped labels intact when pasting links', () => {
  const matches = findMarkdownLinkPasteMatches('[报告\\[最终\\]](./报告(最终).md) [网页](https://example.com/a_(b))');
  expect(matches).toHaveLength(2);
  expect(matches[0]).toMatchObject({ replaceWith: '报告[最终]', data: { href: './报告(最终).md' } });
  expect(matches[1].data?.href).toBe('https://example.com/a_(b)');
});
