import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectWebFrameScrollbar } from './web-frame-scrollbar';
import runtime from '../../../flowix-desktop/src/web_frame_scrollbar.js?raw';

const overlayAttribute = 'data-flowix-overlay-scroll';

describe('remote page scrollbar host', () => {
  let iframe: HTMLIFrameElement;
  let disconnect: (() => void) | undefined;

  beforeEach(() => {
    document.documentElement.dataset.os = 'windows';
    document.documentElement.style.setProperty('--muted-foreground', 'oklch(0.55 0.02 260)');
    iframe = document.createElement('iframe');
    document.body.append(iframe);
  });
  afterEach(() => {
    disconnect?.();
    disconnect = undefined;
    iframe.remove();
    delete document.documentElement.dataset.os;
    document.documentElement.removeAttribute('style');
    vi.restoreAllMocks();
  });

  it('delivers the overlay palette without touching the page document', () => {
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage');
    disconnect = connectWebFrameScrollbar(iframe);
    expect(post).toHaveBeenLastCalledWith({
      type: 'flowix:web-frame-scrollbar',
      mac: false,
      color: 'color-mix(in oklch, oklch(0.55 0.02 260) 40%, transparent)',
    }, '*');
    expect(iframe.contentDocument).not.toBeNull();
  });

  it('re-sends on frame readiness, reload and theme changes', async () => {
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage');
    disconnect = connectWebFrameScrollbar(iframe);
    post.mockClear();

    window.dispatchEvent(new MessageEvent('message', {
      source: window, data: { type: 'flowix:web-frame-scrollbar-ready' },
    }));
    expect(post).not.toHaveBeenCalled();

    window.dispatchEvent(new MessageEvent('message', {
      source: iframe.contentWindow, data: { type: 'flowix:web-frame-scrollbar-ready' },
    }));
    expect(post).toHaveBeenCalledOnce();

    iframe.dispatchEvent(new Event('load'));
    expect(post).toHaveBeenCalledTimes(2);

    document.documentElement.style.setProperty('--muted-foreground', 'oklch(0.7 0.02 260)');
    await Promise.resolve();
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({ color: expect.stringContaining('oklch(0.7 0.02 260)') }),
      '*',
    );
  });

  it('reports a viewport bar that stayed native and stays quiet otherwise', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    disconnect = connectWebFrameScrollbar(iframe);

    window.dispatchEvent(new MessageEvent('message', {
      source: window, data: { type: 'flowix:web-frame-scrollbar-status', suppressed: true, gutter: 15 },
    }));
    expect(warn).not.toHaveBeenCalled();

    window.dispatchEvent(new MessageEvent('message', {
      source: iframe.contentWindow, data: { type: 'flowix:web-frame-scrollbar-status', suppressed: true, gutter: 15 },
    }));
    expect(warn).toHaveBeenCalledOnce();

    window.dispatchEvent(new MessageEvent('message', {
      source: iframe.contentWindow, data: { type: 'flowix:web-frame-scrollbar-status', suppressed: false, gutter: 0 },
    }));
    expect(warn).toHaveBeenCalledOnce();
  });

  it('uses the stronger macOS weight and stops after disconnect', () => {
    document.documentElement.dataset.os = 'mac';
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage');
    disconnect = connectWebFrameScrollbar(iframe);
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({
      mac: true, color: expect.stringContaining('78%'),
    }), '*');
    post.mockClear();
    disconnect();
    iframe.dispatchEvent(new Event('load'));
    expect(post).not.toHaveBeenCalled();
  });
});

describe('remote page scrollbar runtime', () => {
  const parent = { postMessage: vi.fn() };
  let originalParent: PropertyDescriptor | undefined;
  let originalTop: PropertyDescriptor | undefined;
  let originalReady: PropertyDescriptor | undefined;
  let originalScroller: PropertyDescriptor | undefined;
  let content: HTMLDivElement;

  const scrollable = (element: HTMLElement, height = 1000, visible = 200) => {
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: height });
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: visible });
    Object.defineProperty(element, 'scrollWidth', { configurable: true, value: 200 });
    Object.defineProperty(element, 'clientWidth', { configurable: true, value: 200 });
    element.getBoundingClientRect = () => ({
      top: 0, left: 0, right: 200, bottom: visible, width: 200, height: visible, x: 0, y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  };
  // Thumbs are appended in adoption order, so the last match belongs to the
  // scrollable container rather than to the (non-scrollable) root document.
  const thumb = (axis: string) => {
    const matches = document.querySelectorAll<HTMLElement>(`.flowix-overlay-thumb[data-axis="${axis}"]`);
    return matches.length > 0 ? matches[matches.length - 1] : undefined;
  };
  const configure = (patch: Record<string, unknown> = {}) => window.dispatchEvent(new MessageEvent('message', {
    source: parent as unknown as Window,
    data: { type: 'flowix:web-frame-scrollbar', mac: true, color: 'rgba(0, 0, 0, 0.3)', ...patch },
  }));

  beforeEach(() => {
    originalParent = Object.getOwnPropertyDescriptor(window, 'parent');
    originalTop = Object.getOwnPropertyDescriptor(window, 'top');
    originalReady = Object.getOwnPropertyDescriptor(document, 'readyState');
    originalScroller = Object.getOwnPropertyDescriptor(document, 'scrollingElement');
    Object.defineProperty(window, 'parent', { configurable: true, value: parent });
    Object.defineProperty(window, 'top', { configurable: true, value: parent });
    Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' });
    Object.defineProperty(document, 'scrollingElement', { configurable: true, value: document.documentElement });
    vi.stubGlobal('location', { protocol: 'https:', hostname: 'example.com', href: 'https://example.com/' });
    vi.stubGlobal('CSS', { supports: () => true });
    content = document.createElement('div');
    scrollable(content);
    document.body.append(content);
  });
  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    content.remove();
    for (const [target, key, descriptor] of [
      [window, 'parent', originalParent], [window, 'top', originalTop],
      [document, 'readyState', originalReady], [document, 'scrollingElement', originalScroller],
    ] as const) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('replaces the native bar with a zero-width overlay thumb', () => {
    window.eval(runtime);
    expect(content.hasAttribute(overlayAttribute)).toBe(true);
    // WebKit resolves the viewport bar from either html or body, so both are claimed.
    expect(document.documentElement.hasAttribute(overlayAttribute)).toBe(true);
    expect(document.body.hasAttribute(overlayAttribute)).toBe(true);
    expect(document.getElementById('flowix-overlay-scroll-layer')).not.toBeNull();
    const vertical = thumb('v')!;
    expect(vertical.style.width).toBe('6px');
    expect(vertical.style.display).toBe('');
    expect(vertical.style.height).not.toBe('');
    const css = document.getElementById('flowix-overlay-scroll-style')?.textContent ?? '';
    // WebKit ignores the width property on native scrollbars; display:none is
    // what actually removes the bar.
    expect(css).toContain('display: none !important');
    expect(css).toContain(`[${overlayAttribute}] { scrollbar-width: none !important;`);
  });

  it('keeps the overlay when the viewport bar refuses to collapse', async () => {
    vi.useFakeTimers();
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 4000 });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 768 });
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1009 });
    try {
      window.eval(runtime);
      await vi.advanceTimersByTimeAsync(1200);
      // The stylesheet and the layer stay: element scrollers keep their collapsed
      // bars. The viewport itself is demoted — scrolling moves to <body>, whose
      // element scrollbar always collapses, so the document never keeps a gutter.
      expect(document.getElementById('flowix-overlay-scroll-style')).not.toBeNull();
      expect(content.hasAttribute(overlayAttribute)).toBe(true);
      expect(document.getElementById('flowix-overlay-scroll-layer')).not.toBeNull();
      const css = document.getElementById('flowix-overlay-scroll-style')?.textContent ?? '';
      expect(css).toContain('position: fixed !important');
      // The demotion keeps both axes scrollable: the horizontal thumb still
      // has overflow to track after <body> becomes the scroller.
      expect(css).toContain('overflow-x: auto !important');
      expect(parent.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'flowix:web-frame-scrollbar-status', mode: 'body-scroller' }),
        '*',
      );
    } finally {
      vi.useRealTimers();
      Reflect.deleteProperty(document.documentElement, 'scrollHeight');
      Reflect.deleteProperty(document.documentElement, 'clientHeight');
      Reflect.deleteProperty(document.documentElement, 'clientWidth');
    }
  });

  it('reveals the thumb on scroll and hides it after the delay', async () => {
    vi.useFakeTimers();
    window.eval(runtime);
    expect(thumb('v')!.style.opacity).toBe('');
    content.dispatchEvent(new Event('scroll'));
    expect(thumb('v')!.style.opacity).toBe('1');
    await vi.advanceTimersByTimeAsync(600);
    content.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(600);
    expect(thumb('v')!.style.opacity).toBe('1');
    await vi.advanceTimersByTimeAsync(150);
    expect(thumb('v')!.style.opacity).toBe('0');
    vi.useRealTimers();
  });

  it('paints and reveals the horizontal thumb like the vertical one', () => {
    const wide = document.createElement('div');
    scrollable(wide, 200, 200);
    Object.defineProperty(wide, 'scrollWidth', { configurable: true, value: 1000 });
    document.body.append(wide);
    try {
      window.eval(runtime);
      // Adopted during start()'s sweep, so the paint already ran.
      const horizontal = thumb('h')!;
      expect(horizontal.style.display).toBe('');
      expect(horizontal.style.height).toBe('6px');
      expect(horizontal.style.width).not.toBe('');
      wide.dispatchEvent(new Event('scroll'));
      expect(horizontal.style.opacity).toBe('1');
    } finally {
      wide.remove();
    }
  });

  it('adopts containers that only become scrollable after load', () => {
    const late = document.createElement('div');
    document.body.append(late);
    window.eval(runtime);
    expect(late.hasAttribute(overlayAttribute)).toBe(false);
    scrollable(late);
    late.dispatchEvent(new Event('scroll'));
    expect(late.hasAttribute(overlayAttribute)).toBe(true);
    late.remove();
  });

  it('applies host colors and honours the enabled switch', () => {
    window.eval(runtime);
    configure({ color: 'rgba(10, 20, 30, 0.5)' });
    expect(document.getElementById('flowix-overlay-scroll-layer')!.style.color).toBe('rgba(10, 20, 30, 0.5)');
    configure({ enabled: false });
    expect(content.hasAttribute(overlayAttribute)).toBe(false);
    expect(document.getElementById('flowix-overlay-scroll-layer')).toBeNull();
  });

  it.each([
    ['the host document', () => { Object.defineProperty(window, 'parent', { configurable: true, value: window }); Object.defineProperty(window, 'top', { configurable: true, value: window }); }],
    ['a nested frame', () => { Object.defineProperty(window, 'top', { configurable: true, value: {} }); }],
  ])('stays out of %s', (_label, arrange) => {
    arrange();
    window.eval(runtime);
    expect(content.hasAttribute(overlayAttribute)).toBe(false);
    expect(document.getElementById('flowix-overlay-scroll-layer')).toBeNull();
  });

  it.each([
    ['asset:', 'localhost', 'asset://localhost/%2Fbook%2Fdemo.html'],
    ['http:', 'asset.localhost', 'http://asset.localhost/D%3A/notes/demo.html'],
  ])('adopts local HTML previews (%s)', (protocol, hostname, href) => {
    vi.stubGlobal('location', { protocol, hostname, href });
    window.eval(runtime);
    expect(content.hasAttribute(overlayAttribute)).toBe(true);
    expect(document.getElementById('flowix-overlay-scroll-layer')).not.toBeNull();
  });

  it('leaves wheel handling and overflow untouched', () => {
    window.eval(runtime);
    const wheel = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true });
    content.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(content.getAttribute('style')).toBeNull();
  });

  it('restores the page on unload', () => {
    window.eval(runtime);
    const layer = document.getElementById('flowix-overlay-scroll-layer');
    window.dispatchEvent(new Event('pagehide'));
    expect(content.hasAttribute(overlayAttribute)).toBe(false);
    expect(layer!.isConnected).toBe(false);
    expect(document.getElementById('flowix-overlay-scroll-style')).toBeNull();
  });
});
