import { describe, expect, it } from 'vitest';
import { markdownToHtml } from '@/lib/export';

describe('markdownToHtml', () => {
  it('keeps dunder identifiers literal instead of bolding them', () => {
    const html = markdownToHtml('删除 __pycache__ 目录');

    expect(html).toContain('__pycache__');
    expect(html).not.toContain('<strong>');
  });

  it('still renders asterisk bold and italic', () => {
    const html = markdownToHtml('**重点** 与 *斜体*');

    expect(html).toContain('<strong>重点</strong>');
    expect(html).toContain('<em>斜体</em>');
  });

  it('leaves underscores in code untouched', () => {
    const html = markdownToHtml('```\nrm -rf __pycache__\n```');

    expect(html).toContain('rm -rf __pycache__');
  });
});
