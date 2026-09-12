import { describe, expect, it } from 'vitest';

import { isImeKeyboardEvent } from '@/lib/input-method';

function keyboardEvent(options: KeyboardEventInit & { keyCode?: number } = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', options);
  if (options.keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { value: options.keyCode });
  }
  return event;
}

describe('isImeKeyboardEvent', () => {
  it('accepts the standard composing signal', () => {
    expect(isImeKeyboardEvent(keyboardEvent({ key: 'Enter', isComposing: true }))).toBe(true);
  });

  it('accepts process-key 229 when WebKit does not expose isComposing', () => {
    expect(isImeKeyboardEvent(keyboardEvent({ key: 'Enter', keyCode: 229 }))).toBe(true);
  });

  it('accepts a locally tracked composition lifecycle', () => {
    expect(isImeKeyboardEvent(keyboardEvent({ key: 'Enter' }), true)).toBe(true);
  });

  it('does not classify an ordinary Enter as IME input', () => {
    expect(isImeKeyboardEvent(keyboardEvent({ key: 'Enter', keyCode: 13 }))).toBe(false);
  });
});
