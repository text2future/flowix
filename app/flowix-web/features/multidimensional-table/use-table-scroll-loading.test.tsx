import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useTableScrollLoading } from './use-table-scroll-loading';

it('loads once per batch, reconnects for the next page and stops at the end or in embedded mode', async () => {
  const observers: { fire: () => void; disconnect: ReturnType<typeof vi.fn>; root: Element | Document | null | undefined; rootMargin?: string }[] = [];
  vi.stubGlobal('IntersectionObserver', class {
    disconnect = vi.fn();
    observe = vi.fn();
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
      observers.push({
        fire: () => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver),
        disconnect: this.disconnect, root: options.root, rootMargin: options.rootMargin,
      });
    }
  });
  const load = vi.fn();
  function Probe({ page, enabled = true, viewportRoot = false }: { page: number; enabled?: boolean; viewportRoot?: boolean }) {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const sentinelRef = useRef<HTMLDivElement>(null);
    useTableScrollLoading({ enabled, viewportRoot, scrollerRef, sentinelRef, page, pageCount: 3, onLoadMore: load });
    return <div ref={scrollerRef}><div ref={sentinelRef} /></div>;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Probe page={0} />));
    expect(observers[0].root).toBe(container.firstChild);
    act(() => { observers[0].fire(); observers[0].fire(); });
    expect(load).toHaveBeenCalledTimes(1);
    expect(observers[0].disconnect).toHaveBeenCalled();
    await act(async () => root.render(<Probe page={1} />));
    act(() => observers[1].fire());
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => root.render(<Probe page={2} />));
    expect(observers).toHaveLength(2);
    await act(async () => root.render(<Probe page={0} enabled={false} />));
    expect(observers).toHaveLength(2);
    await act(async () => root.render(<Probe page={0} viewportRoot />));
    expect(observers[2].root).toBeNull();
    expect(observers[2].rootMargin).toBe(`0px 0px ${Math.max(200, window.innerHeight)}px 0px`);
    await act(async () => root.render(<Probe page={0} />));
    expect(observers[3].rootMargin).toBe('0px 0px 200px 0px');
    Object.defineProperty(container.firstChild, 'clientHeight', { configurable: true, value: 900 });
    await act(async () => root.render(<Probe page={1} />));
    expect(observers[4].rootMargin).toBe('0px 0px 900px 0px');
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
