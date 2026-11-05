import { describe, expect, it } from 'vitest';
import { rewriteDocumentPathLinks } from './markdown-path-references';
const rename = [{ oldPath: '/book/images/a.png', newPath: '/book/pictures/b.png' }];
describe('relative reference move maintenance', () => {
  it('updates file and image destinations, preserving custom labels, titles and anchors', async () => {
    await expect(rewriteDocumentPathLinks('![custom](../images/a.png "Title") [x](../images/a.png#hello)', '/book/sub/n.md', '/book/sub/n.md', rename))
      .resolves.toBe('![custom](../pictures/b.png "Title") [x](../pictures/b.png#hello)');
  });
  it('rebases outgoing references when the source moves', async () => {
    await expect(rewriteDocumentPathLinks('[x](./target.md) ![a](../images/a.png)', '/book/sub/n.md', '/book/n.md', []))
      .resolves.toBe('[x](./sub/target.md) ![a](./images/a.png)');
  });
  it('keeps references between descendants stable when their folder moves', async () => {
    const text = '[x](./child.md) ![a](../images/a.png)';
    await expect(rewriteDocumentPathLinks(text, '/book/sub/n.md', '/book/archive/sub/n.md', [{ oldPath: '/book/sub', newPath: '/book/archive/sub', folder: true }]))
      .resolves.toBe('[x](./child.md) ![a](../../images/a.png)');
  });
  it('does not rewrite code, external URLs or plain text', async () => {
    const example = '![a](../images/a.png)';
    const text = `\`${example}\`\n\`\`\`md\n${example}\n\`\`\`\n    ${example}\n[x](https://example.com)`;
    await expect(rewriteDocumentPathLinks(text, '/book/sub/n.md', '/book/sub/n.md', rename)).resolves.toBe(text);
  });
  it('uses a file URL when a source moves to another Windows drive', async () => {
    await expect(rewriteDocumentPathLinks('![a](./a.png)', 'C:/Book/n.md', 'D:/Book/n.md', []))
      .resolves.toBe('![a](file:///C:/Book/a.png)');
  });

  it('maintains file URL fallbacks through subsequent target renames', async () => {
    const moved = await rewriteDocumentPathLinks('![a](./a.png#detail)', 'C:/Book/n.md', 'D:/Book/n.md', []);
    expect(moved).toBe('![a](file:///C:/Book/a.png#detail)');
    await expect(rewriteDocumentPathLinks(moved, 'D:/Book/n.md', 'D:/Book/n.md', [{ oldPath: 'C:/Book/a.png', newPath: 'C:/Book/b.png' }]))
      .resolves.toBe('![a](file:///C:/Book/b.png#detail)');
  });
  it('preserves UNC file URL queries while their target folder moves', async () => {
    await expect(rewriteDocumentPathLinks('![a](file://server/share/images/a.png?v=1#detail)', '/book/n.md', '/book/n.md', [{ oldPath: '//server/share/images', newPath: '//server/share/archive', folder: true }]))
      .resolves.toBe('![a](file://server/share/archive/a.png?v=1#detail)');
  });

  it('does not rewrite a valid multiline code span or HTML comments', async () => {
    const source = '`example\n[x](./old.md)\nend`\n\n<!-- [x](./old.md) -->';
    await expect(rewriteDocumentPathLinks(source, '/book/n.md', '/book/n.md', [{ oldPath: '/book/old.md', newPath: '/book/new.md' }])).resolves.toBe(source);
  });
  it('preserves CRLF and nested image links while rewriting actual destinations', async () => {
    const source = '> [![a](./old.png)](https://example.com)\r\n\r\n- [x](./old.md "title")\r\n';
    await expect(rewriteDocumentPathLinks(source, '/book/n.md', '/book/n.md', [
      { oldPath: '/book/old.png', newPath: '/book/new.png' },
      { oldPath: '/book/old.md', newPath: '/book/new.md' },
    ])).resolves.toBe('> [![a](./new.png)](https://example.com)\r\n\r\n- [x](./new.md "title")\r\n');
  });
  it('handles balanced parentheses and escaped backticks around real links', async () => {
    const source = '\\`[x](./a(1).md)\\`';
    await expect(rewriteDocumentPathLinks(source, '/book/n.md', '/book/n.md', [{ oldPath: '/book/a(1).md', newPath: '/book/new.md' }])).resolves.toBe('\\`[x](./new.md)\\`');
  });

});
