import { describe, expect, it } from 'vitest';

import { isContentSemanticallyEqual } from './buffer-equality';

describe('document buffer semantic equality', () => {
  it('ignores line endings and YAML key order', () => {
    const left = '---\r\nkey: abc12345\r\nstatus: draft\r\n---\r\nbody\r\n';
    const right = '---\nstatus: draft\nkey: abc12345\n---\nbody\n';
    expect(isContentSemanticallyEqual(left, right)).toBe(true);
  });

  it('treats a tags change as a real edit', () => {
    const left = '---\nkey: abc12345\ntags: [product]\n---\nbody\n';
    const right = '---\nkey: abc12345\ntags: [design]\n---\nbody\n';
    expect(isContentSemanticallyEqual(left, right)).toBe(false);
  });

  it('does not discard changes in invalid YAML', () => {
    const left = '---\ntags: [product\n---\nbody\n';
    const right = '---\ntags: [design\n---\nbody\n';
    expect(isContentSemanticallyEqual(left, right)).toBe(false);
  });
});
