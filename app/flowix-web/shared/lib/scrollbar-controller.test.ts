import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createOverlayScrollbarDom } from '@shared/ui/overlay-scrollbar-dom';
import { SCROLLBAR_HIDE_DELAY_MS } from './scrollbar-config';

const frames: HTMLElement[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
});
afterEach(() => { frames.splice(0).forEach((frame) => frame.remove()); vi.unstubAllGlobals(); vi.useRealTimers(); });

function makeArea(horizontal = false, observeContent = false) {
  const area = createOverlayScrollbarDom(document, { horizontal, observeContent });
  document.body.append(area.frame);
  frames.push(area.frame);
  Object.defineProperties(area.scroller, {
    clientHeight: { configurable: true, value: 100 }, scrollHeight: { configurable: true, value: 400 },
    clientWidth: { configurable: true, value: 100 }, scrollWidth: { configurable: true, value: 400 },
  });
  area.update({ reveal: false, schedule: false });
  return area;
}

it.each([false, true])('clamps rubber-band offsets to the track (horizontal=%s)', (horizontal) => {
  const area = makeArea(horizontal);
  const offset = horizontal ? 'scrollLeft' : 'scrollTop';
  const position = horizontal ? '--overlay-scrollbar-thumb-left' : '--overlay-scrollbar-thumb-top';
  try {
    area.scroller[offset] = -30;
    area.update({ reveal: false, schedule: false });
    expect(area.frame.style.getPropertyValue(position)).toBe('0px');
    area.scroller[offset] = 500;
    area.update({ reveal: false, schedule: false });
    expect(area.frame.style.getPropertyValue(position)).toBe('75px');
  } finally { area.destroy(); }
});

it('normalizes line/page wheel input and respects clipped axes', () => {
  const area = makeArea();
  const thumb = area.frame.querySelector('.overlay-scrollbar-thumb')!;
  area.scroller.style.lineHeight = '20px';
  try {
    thumb.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaMode: 1, deltaY: 2 }));
    expect(area.scroller.scrollTop).toBe(40);
    thumb.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaMode: 2, deltaY: 1 }));
    expect(area.scroller.scrollTop).toBe(140);
    area.scroller.style.overflowY = 'hidden';
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 40 });
    thumb.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(area.scroller.scrollTop).toBe(140);
  } finally { area.destroy(); }
});

it('updates for asynchronous image sizing without revealing, and cleans up pending work', () => {
  const observe = vi.fn();
  const unobserve = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class { observe = observe; unobserve = unobserve; disconnect = disconnect; });
  const area = makeArea(false, true);
  const image = document.createElement('img');
  area.scroller.append(image);
  try {
    area.scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 10 }));
    area.scroller.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS);
    expect(area.frame.dataset.scrolling).toBeUndefined();
    Object.defineProperty(area.scroller, 'scrollHeight', { configurable: true, value: 800 });
    image.dispatchEvent(new Event('load'));
    vi.advanceTimersByTime(16);
    expect(area.frame.style.getPropertyValue('--overlay-scrollbar-thumb-height')).toBe('24px');
    expect(area.frame.dataset.scrolling).toBeUndefined();
    area.scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 10 }));
    area.scroller.dispatchEvent(new Event('scroll'));
    area.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(disconnect).toHaveBeenCalled();
    expect(area.frame.dataset.scrolling).toBeUndefined();
    area.update();
    expect(area.frame.dataset.scrolling).toBeUndefined();
  } finally { area.destroy(); }
});

it('lets iframe-owned content handle its own wheel events', () => {
  const iframe = document.createElement('iframe');
  document.body.append(iframe);
  const doc = iframe.contentDocument!;
  const area = createOverlayScrollbarDom(doc);
  const child = doc.createElement('p');
  area.scroller.append(child);
  doc.body.append(area.frame);
  try {
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 30 });
    child.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
  } finally { area.destroy(); iframe.remove(); }
});
