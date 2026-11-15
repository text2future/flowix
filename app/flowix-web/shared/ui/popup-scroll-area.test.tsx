import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PopupScrollArea, PopupSurface, type PopupScrollAreaHandle } from './popup-scroll-area';
import { createPopupScrollAreaDom } from './popup-scroll-area-dom';
import { Select, SelectTrigger, SelectContent, SelectItem } from './select';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from './dropdown-menu';
import { SCROLLBAR_HIDE_DELAY_MS } from '@shared/lib/scrollbar-config';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function overflow(scroller: HTMLElement) {
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: 400 },
    clientWidth: { configurable: true, value: 120 },
    scrollWidth: { configurable: true, value: 120 },
  });
}

describe('popup scrolling contract', () => {
  it('preserves shell refs, list semantics and viewport refs', async () => {
    const frameRef = { current: null as HTMLDivElement | null };
    const scrollerRef = { current: null as HTMLDivElement | null };
    await act(async () => root.render(<PopupScrollArea frameRef={frameRef} scrollerRef={scrollerRef} scrollerProps={{ id: 'options', role: 'listbox', 'aria-label': 'Options' }}><button role="option">One</button></PopupScrollArea>));
    expect(frameRef.current).toBe(host.firstElementChild);
    expect(scrollerRef.current).toBe(host.querySelector('[role="listbox"]'));
    expect(scrollerRef.current?.id).toBe('options');
    expect(scrollerRef.current?.getAttribute('aria-label')).toBe('Options');
    expect(frameRef.current?.dataset.scrolling).toBeUndefined();
  });

  it('ignores programmatic positioning, reveals on user scroll, then hides after idle', async () => {
    const ref = { current: null as PopupScrollAreaHandle | null };
    await act(async () => root.render(<PopupScrollArea ref={ref}><p>Content</p></PopupScrollArea>));
    const scroller = ref.current!.getScroller()!;
    const frame = host.firstElementChild as HTMLElement;
    overflow(scroller);
    ref.current!.update({ reveal: false, schedule: false });
    await act(async () => {
      scroller.scrollTop = 40;
      scroller.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(16);
    });
    expect(frame.dataset.scrollable).toBe('true');
    expect(frame.dataset.scrolling).toBeUndefined();
    await act(async () => {
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 50 }));
      scroller.scrollTop = 90;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(frame.dataset.scrolling).toBe('true');
    await act(async () => vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS - 1));
    expect(frame.dataset.scrolling).toBe('true');
    await act(async () => vi.advanceTimersByTime(1));
    expect(frame.dataset.scrolling).toBeUndefined();
  });

  it('lets compound shells own one inner area instead of wrapping a second viewport', async () => {
    await act(async () => root.render(<PopupSurface scrollable={false}><input aria-label="Search" /><PopupScrollArea><p>Items</p></PopupScrollArea><button>Done</button></PopupSurface>));
    expect(host.querySelectorAll('.popup-scroll-area')).toHaveLength(1);
    expect(host.firstElementChild?.firstElementChild?.tagName).toBe('INPUT');
    expect(host.firstElementChild?.lastElementChild?.textContent).toBe('Done');
  });

  it('rebinds after StrictMode cleanup and releases pending work on unmount', async () => {
    const ref = { current: null as PopupScrollAreaHandle | null };
    await act(async () => root.render(<StrictMode><PopupScrollArea ref={ref}><p>Items</p></PopupScrollArea></StrictMode>));
    const scroller = ref.current!.getScroller()!;
    const frame = host.firstElementChild as HTMLElement;
    overflow(scroller);
    ref.current!.update({ reveal: false, schedule: false });
    await act(async () => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 20 }));
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(frame.dataset.scrolling).toBe('true');
    await act(async () => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a drag visible beyond the idle delay and fades after release', async () => {
    const ref = { current: null as PopupScrollAreaHandle | null };
    await act(async () => root.render(<PopupScrollArea ref={ref}><p>Items</p></PopupScrollArea>));
    const scroller = ref.current!.getScroller()!;
    const frame = host.firstElementChild as HTMLElement;
    const thumb = frame.querySelector<HTMLElement>('.overlay-scrollbar-thumb--vertical')!;
    overflow(scroller);
    thumb.setPointerCapture = vi.fn();
    thumb.releasePointerCapture = vi.fn();
    ref.current!.update({ reveal: false, schedule: false });
    await act(async () => {
      thumb.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0, clientY: 10 }));
      vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS * 2);
      thumb.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientY: 30 }));
    });
    expect(frame.dataset.dragging).toBe('true');
    expect(frame.dataset.scrolling).toBe('true');
    expect(scroller.scrollTop).toBeGreaterThan(0);
    await act(async () => {
      thumb.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
      vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS);
    });
    expect(frame.dataset.dragging).toBeUndefined();
    expect(frame.dataset.scrolling).toBeUndefined();
  });

  it('Select uses the shared viewport and still commits and closes on selection', async () => {
    const onValueChange = vi.fn();
    await act(async () => root.render(<Select onValueChange={onValueChange}><SelectTrigger>Choose</SelectTrigger><SelectContent fitViewport><SelectItem value="one">First choice</SelectItem></SelectContent></Select>));
    await act(async () => host.querySelector('button')!.click());
    const surface = document.querySelector<HTMLElement>('[data-flowix-surface="select"]')!;
    expect(surface.classList.contains('popup-scroll-area')).toBe(true);
    const item = surface.querySelector<HTMLButtonElement>(':scope > .popup-scroll-area__viewport > button')!;
    await act(async () => item.click());
    expect(onValueChange).toHaveBeenCalledWith('one');
    expect(document.querySelector('[data-flowix-surface="select"]')).toBeNull();
  });

  it('Dropdown uses the same viewport while retaining item click behavior', async () => {
    const onClick = vi.fn();
    await act(async () => root.render(<DropdownMenu><DropdownMenuTrigger>Actions</DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem onClick={onClick}>Run action</DropdownMenuItem></DropdownMenuContent></DropdownMenu>));
    await act(async () => host.querySelector('button')!.click());
    const surface = document.querySelector<HTMLElement>('[data-flowix-surface="popover"]')!;
    const item = surface.querySelector<HTMLButtonElement>(':scope > .popup-scroll-area__viewport > button')!;
    expect(surface.classList.contains('popup-scroll-area')).toBe(true);
    await act(async () => item.click());
    expect(onClick).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-flowix-surface="popover"]')).toBeNull();
  });

  it('uses the same DOM adapter and respects rounded-corner track clearance', () => {
    const area = createPopupScrollAreaDom(document);
    host.append(area.frame);
    overflow(area.scroller);
    Object.defineProperty(area.frame.querySelector('.overlay-scrollbar-track--vertical'), 'clientHeight', { value: 80 });
    area.update({ reveal: false, schedule: false });
    expect(area.frame.classList.contains('popup-scroll-area')).toBe(true);
    expect(area.frame.classList.contains('overlay-scrollbar-frame--custom-mac')).toBe(true);
    expect(area.frame.style.getPropertyValue('--overlay-scrollbar-thumb-height')).toBe('24px');
    area.scroller.scrollTop = 300;
    area.update({ reveal: false, schedule: false });
    expect(area.frame.style.getPropertyValue('--overlay-scrollbar-thumb-top')).toBe('56px');
    expect(area.frame.dataset.scrolling).toBeUndefined();
    area.scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 30, bubbles: true }));
    area.scroller.dispatchEvent(new Event('scroll'));
    expect(area.frame.dataset.scrolling).toBe('true');
    area.destroy();
    vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS);
  });
});
