import { describe, expect, it } from 'vitest';
import { sanitizeLinkHref } from './safe-link';

describe('sanitizeLinkHref', () => {
  it('keeps supported local file href forms intact for the Agent parser', () => {
    expect(sanitizeLinkHref('/D:/Notes/a%20b.md:144')).toBe('/D:/Notes/a%20b.md:144');
    expect(sanitizeLinkHref('http://tauri.localhost/D:/Notes/a.md:144'))
      .toBe('http://tauri.localhost/D:/Notes/a.md:144');
    expect(sanitizeLinkHref('file:///D:/Notes/a%20b.md#L144C8'))
      .toBe('file:///D:/Notes/a%20b.md#L144C8');
    expect(sanitizeLinkHref('\\\\server\\share\\a.md')).toBe('\\\\server\\share\\a.md');
  });

  it('rejects controls even when the href begins with a path prefix', () => {
    expect(sanitizeLinkHref('/safe/\njavascript:alert(1)')).toBeNull();
    expect(sanitizeLinkHref('http://tauri.localhost/a\u0000.md')).toBeNull();
  });
});
