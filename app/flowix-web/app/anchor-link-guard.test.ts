import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toastMock = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock('@/lib/toast', () => ({ toast: toastMock }));
vi.mock('@features/preferences/public/runtime-api', () => ({
  getCurrentAppLanguage: () => 'zh-CN',
}));

import { attachAnchorLinkGuard } from './anchor-link-guard';

let detach: (() => void) | null = null;

function renderAnchor(href: string): HTMLAnchorElement {
  document.body.innerHTML = `<p><a href="${href}">link</a></p>`;
  return document.querySelector('a') as HTMLAnchorElement;
}

function click(anchor: HTMLAnchorElement): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  anchor.dispatchEvent(event);
  return event;
}

describe('anchor link guard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    toastMock.error.mockClear();
    detach = attachAnchorLinkGuard(document);
  });

  afterEach(() => {
    detach?.();
    detach = null;
    document.body.innerHTML = '';
  });

  it('blocks an unhandled sibling-path link instead of letting the webview navigate', () => {
    const event = click(renderAnchor('skills/RESOLVER.md'));

    expect(event.defaultPrevented).toBe(true);
    expect(toastMock.error).toHaveBeenCalledOnce();
  });

  it('leaves a handled link alone', () => {
    const anchor = renderAnchor('skills/RESOLVER.md');
    anchor.addEventListener('click', (event) => event.preventDefault());

    const event = click(anchor);

    expect(event.defaultPrevented).toBe(true);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it.each(['https://example.com', 'example.com/docs', '#heading', '/Users/rop/notes/a.md'])(
    'keeps the existing meaning of %s',
    href => {
      const event = click(renderAnchor(href));

      expect(event.defaultPrevented).toBe(false);
      expect(toastMock.error).not.toHaveBeenCalled();
    },
  );

  it('ignores clicks that are not on a link', () => {
    document.body.innerHTML = '<p>plain text</p>';
    const paragraph = document.querySelector('p') as HTMLParagraphElement;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });

    paragraph.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(toastMock.error).not.toHaveBeenCalled();
  });
});
