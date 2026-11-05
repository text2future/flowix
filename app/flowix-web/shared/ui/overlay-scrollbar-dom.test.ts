import { describe, expect, it, vi } from 'vitest';
import { createOverlayScrollbarDom } from './overlay-scrollbar-dom';

describe('createOverlayScrollbarDom', () => {
  it('syncs the overlay thumb geometry from the scroller', () => {
    const overlay = createOverlayScrollbarDom(document);
    Object.defineProperties(overlay.scroller, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });

    overlay.update({ reveal: false, schedule: false });

    expect(overlay.frame.dataset.scrollable).toBe('true');
    expect(overlay.frame.style.getPropertyValue('--overlay-scrollbar-thumb-height')).toBe('25px');
    expect(overlay.frame.style.getPropertyValue('--overlay-scrollbar-thumb-top')).toBe('25px');
    overlay.destroy();
  });
});

it('reveals the horizontal overlay only for user scrolling and hides after 700ms', () => {
  vi.useFakeTimers();
  const overlay = createOverlayScrollbarDom(document, { horizontal: true });
  try {
    Object.defineProperties(overlay.scroller, {
      clientWidth: { value: 200 }, scrollWidth: { value: 800 },
      scrollLeft: { writable: true, value: 200 },
    });
    overlay.update({ reveal: false, schedule: false });
    expect(overlay.frame.dataset.horizontalScrollable).toBe('true');
    expect(overlay.frame.dataset.scrolling).toBeUndefined();
    expect(overlay.frame.style.getPropertyValue('--overlay-scrollbar-thumb-width')).toBe('50px');
    expect(overlay.frame.style.getPropertyValue('--overlay-scrollbar-thumb-left')).toBe('50px');
    overlay.scroller.dispatchEvent(new Event('scroll'));
    expect(overlay.frame.dataset.scrolling).toBeUndefined();
    overlay.scroller.dispatchEvent(new WheelEvent('wheel', { deltaX: 20 }));
    overlay.scroller.dispatchEvent(new Event('scroll'));
    expect(overlay.frame.dataset.scrolling).toBe('true');
    vi.advanceTimersByTime(699);
    expect(overlay.frame.dataset.scrolling).toBe('true');
    vi.advanceTimersByTime(1);
    expect(overlay.frame.dataset.scrolling).toBeUndefined();
    overlay.scroller.dispatchEvent(new WheelEvent('wheel', { deltaX: 20 }));
    overlay.scroller.dispatchEvent(new Event('scroll'));
    overlay.destroy();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    overlay.destroy();
    vi.useRealTimers();
  }
});

it('ends horizontal dragging when pointer capture is lost', () => {
  vi.useFakeTimers();
  const overlay = createOverlayScrollbarDom(document, { horizontal: true });
  const thumb = overlay.frame.querySelector<HTMLElement>('.overlay-scrollbar-thumb')!;
  thumb.setPointerCapture = vi.fn();
  thumb.releasePointerCapture = vi.fn();
  Object.defineProperties(overlay.scroller, {
    clientWidth: { value: 200 }, scrollWidth: { value: 800 }, scrollLeft: { value: 0, writable: true },
  });
  const pointer = (type: string, button = 0) => {
    const event = new MouseEvent(type, { button, clientX: 20, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: 7 });
    return event;
  };
  try {
    overlay.update({ reveal: false, schedule: false });
    thumb.dispatchEvent(pointer('pointerdown', 2));
    expect(overlay.frame.dataset.horizontalDragging).toBeUndefined();
    thumb.dispatchEvent(pointer('pointerdown'));
    expect(overlay.frame.dataset.horizontalDragging).toBe('true');
    thumb.dispatchEvent(pointer('lostpointercapture'));
    expect(overlay.frame.dataset.horizontalDragging).toBeUndefined();
    vi.advanceTimersByTime(700);
    expect(overlay.frame.dataset.scrolling).toBeUndefined();
  } finally { overlay.destroy(); vi.useRealTimers(); }
});
