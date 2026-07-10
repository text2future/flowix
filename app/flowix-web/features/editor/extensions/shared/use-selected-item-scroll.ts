import { useLayoutEffect, useRef } from 'react';

const SELECTED_ITEM_SCROLL_PADDING_TOP = 20;

interface UseSelectedItemScrollOptions<Item> {
  items: Item[];
  selectedIndex: number;
}

export function useSelectedItemScroll<Item>({
  items,
  selectedIndex,
}: UseSelectedItemScrollOptions<Item>) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // 键盘上下键移动 selectedIndex 后, 仅在当前 item 即将离开弹窗内部
  // 视口时滚动一次; 滚动发生时尽量把 item 放到顶部下方 20px。
  // items 也进依赖: 过滤导致列表换血时, 即使 selectedIndex 没变
  // 也需要重新评估 (新列表里 selectedIndex 可能对应不同位置的 item)。
  useLayoutEffect(() => {
    const item = itemRefs.current[selectedIndex];
    const scroller = scrollerRef.current;
    if (!item || !scroller) return;

    const scrollerRect = scroller.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const itemTop = itemRect.top - scrollerRect.top + scroller.scrollTop;
    const itemBottom = itemRect.bottom - scrollerRect.top + scroller.scrollTop;
    const visibleTop = scroller.scrollTop + SELECTED_ITEM_SCROLL_PADDING_TOP;
    const visibleBottom = scroller.scrollTop + scroller.clientHeight;

    if (itemTop >= visibleTop && itemBottom <= visibleBottom) return;

    const targetTop = itemTop - SELECTED_ITEM_SCROLL_PADDING_TOP;
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.max(0, Math.min(targetTop, maxScrollTop));
  }, [selectedIndex, items]);

  return { scrollerRef, itemRefs };
}
