import { describe, expect, it } from 'vitest';
import type { ClipboardSnapshot } from './clipboard';
import { splitClipboardForTitlePaste } from './title-paste';

function snapshot(overrides: Partial<ClipboardSnapshot>): ClipboardSnapshot {
  return {
    types: ['text/plain', 'text/html'],
    markdown: '',
    text: '',
    html: '',
    uriList: [],
    files: [],
    sourceMime: 'text/plain',
    ...overrides,
  } as ClipboardSnapshot;
}

describe('splitClipboardForTitlePaste', () => {
  it('keeps rich formatting on the body side of an HTML paste', () => {
    const result = splitClipboardForTitlePaste(snapshot({
      text: 'Title\nBody',
      html: '<p><strong>Title</strong></p><p><em>Body</em></p>',
    }));

    expect(result?.titleLine).toBe('Title');
    expect(result?.body.text).toBe('Body');
    expect(result?.body.html).toContain('<em>Body</em>');
    expect(result?.body.html).not.toContain('Title');
  });

  it('does not split a paste that starts with an empty line', () => {
    expect(splitClipboardForTitlePaste(snapshot({
      text: '\nBody',
    }))).toBeNull();
  });

  it('keeps the Markdown payload on the body side of a Markdown-only paste', () => {
    const result = splitClipboardForTitlePaste(snapshot({
      types: ['text/markdown'],
      markdown: 'Title\n**Body**',
      text: '',
      sourceMime: 'text/markdown',
    }));

    expect(result?.titleLine).toBe('Title');
    expect(result?.body.text).toBe('**Body**');
    expect(result?.body.markdown).toBe('**Body**');
  });
});
