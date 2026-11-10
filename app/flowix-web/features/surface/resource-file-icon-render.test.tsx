import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResourceFileIcon, getResourceSetiIcon } from './resource-file-icon';

describe('ResourceFileIcon', () => {
  it('renders markdown files with the shared note glyph', () => {
    const html = renderToStaticMarkup(<ResourceFileIcon path="notes/产品需求.md" />);

    // 视图框与笔记图标一致，说明走的是 content 层的 NoteContentIcon，而不是 Seti 字形。
    expect(html).toContain('viewBox="0 0 18 18"');
    expect(html).not.toContain('data-seti-icon');
  });

  it('keeps the Seti glyph for non-markdown files', () => {
    const icon = getResourceSetiIcon('src/main.ts', 'light');
    const html = renderToStaticMarkup(<ResourceFileIcon path="src/main.ts" />);

    expect(html).toContain(`data-seti-icon="${icon.definitionKey}"`);
    expect(html).toContain(icon.glyph);
  });
});
