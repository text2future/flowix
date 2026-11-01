import { useEffect, type RefObject } from 'react';

export function useTableScrollLoading({ enabled, viewportRoot = false, scrollerRef, sentinelRef, page, pageCount, onLoadMore }: {
  enabled: boolean;
  /** 记录区已不再是滚动容器（集合的整页滚动）：改用视口做根，否则 sentinel 恒在根内。 */
  viewportRoot?: boolean;
  scrollerRef: RefObject<HTMLDivElement | null>;
  sentinelRef: RefObject<HTMLDivElement | null>;
  page: number;
  pageCount: number;
  onLoadMore: () => void;
}) {
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const scroller = scrollerRef.current;
    if (!enabled || page >= pageCount - 1 || !sentinel || (!scroller && !viewportRoot)) return;
    if (typeof IntersectionObserver === 'undefined') return;
    let requested = false;
    // Start a full viewport ahead so a fast scroll does not catch the next batch mounting.
    const preloadDistance = Math.max(200, viewportRoot ? window.innerHeight : scroller!.clientHeight);
    const observer = new IntersectionObserver((entries) => {
      if (requested || !entries.some((entry) => entry.isIntersecting)) return;
      requested = true;
      observer.disconnect();
      onLoadMore();
    }, { root: viewportRoot ? null : scroller, rootMargin: `0px 0px ${preloadDistance}px 0px` });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [enabled, viewportRoot, scrollerRef, sentinelRef, page, pageCount, onLoadMore]);
}
