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

it('maintains wiki note paths on source and target moves without touching code or escaped examples', async () => {
  const source = '[[./目标.md]] [[../资料/旧.md#标题|别名]] `[[./目标.md]]` \\[[./目标.md]]';
  await expect(rewriteDocumentPathLinks(source, '/book/sub/source.md', '/book/source.md', [
    { oldPath: '/book/资料/旧.md', newPath: '/book/资料/新.md' },
  ], [{ id: 'book', path: '/book' }])).resolves.toBe('[[./sub/目标.md]] [[./资料/新.md#%E6%A0%87%E9%A2%98|别名]] `[[./目标.md]]` \\[[./目标.md]]');
});

it('maintains absolute Windows and UNC wiki targets', async () => {
  await expect(rewriteDocumentPathLinks('[[C:/Notes/old.md]] [[file://server/share/old.md]]', 'D:/source.md', 'D:/source.md', [
    { oldPath: 'C:/Notes/old.md', newPath: 'C:/Notes/new.md' },
    { oldPath: '//server/share/old.md', newPath: '//server/share/new.md' },
  ])).resolves.toBe('[old](C:/Notes/new.md) [old](file://server/share/new.md)');
});

it('keeps filename delimiters escaped after renaming a wiki target', async () => {
  await expect(rewriteDocumentPathLinks('[[./a%23b%25c.md#section]]', '/book/n.md', '/book/n.md', [
    { oldPath: '/book/a#b%c.md', newPath: '/book/新#%.md' },
  ], [{ id: 'book', path: '/book' }])).resolves.toBe('[[./新%23%25.md#section]]');
});

it.each(['[[./_folder_/target.md]]', '[[./a`b`c.md]]', '[[./target.md|**Name**]]'])(
  'maintains a whole wiki span containing Markdown decorations: %s', async source => {
    const target = source.includes('_folder_') ? '/book/_folder_/target.md'
      : source.includes('`') ? '/book/a`b`c.md' : '/book/target.md';
    const rewritten = await rewriteDocumentPathLinks(source, '/book/source.md', '/book/source.md', [
      { oldPath: target, newPath: '/book/new.md' },
    ], [{ id: 'book', path: '/book' }]);
    expect(rewritten).toBe(source.includes('|') ? '[[./new.md|**Name**]]' : '[[./new.md]]');
  },
);

it('uses Markdown links after a source crosses notebook roots on the same Windows drive', async () => {
  await expect(rewriteDocumentPathLinks('[[./target.md]]', 'C:/Book/sub/source.md', 'C:/Other/source.md', [], [
    { id: 'book', path: 'C:/Book' }, { id: 'other', path: 'C:/Other' },
  ])).resolves.toBe('[target](C:/Book/sub/target.md)');
});

it('keeps frontmatter, fenced code and comments untouched while maintaining real wiki references', async () => {
  const source = '---\nexample: "[[./old.md]]"\n---\n```md\n[[./old.md]]\n```\n<!-- [[./old.md]] -->\n[[./old.md]]';
  await expect(rewriteDocumentPathLinks(source, '/book/source.md', '/book/source.md', [
    { oldPath: '/book/old.md', newPath: '/book/new.md' },
  ], [{ id: 'book', path: '/book' }])).resolves.toBe(source.replace(/\[\[\.\/old.md\]\]$/, '[[./new.md]]'));
});

it('keeps extensionless Wiki references pointed at the Markdown note during moves', async () => {
  const roots = [{ id: 'book', path: '/book' }];
  expect(await rewriteDocumentPathLinks('[[target]] [[./target]] [[folder/target]]', '/book/sub/source.md', '/book/other/source.md', [], roots))
    .toBe('[[../sub/target.md]] [[../sub/target.md]] [[../sub/folder/target.md]]');
  expect(await rewriteDocumentPathLinks('[[target]]', '/book/sub/source.md', '/book/sub/source.md',
    [{ oldPath: '/book/sub/target.md', newPath: '/book/sub/renamed.md', folder: false }], roots)).toBe('[[./renamed.md]]');
});
