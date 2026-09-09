import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { useDynamicVirtualList } from './use-dynamic-virtual-list';

const items = Array.from({ length: 13 }, (_, index) => ({
  id: `memo-${index}`,
}));

function Harness() {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const { virtualItems } = useDynamicVirtualList({
    items,
    getKey: (item) => item.id,
    estimateSize: () => 100,
    scrollerRef,
    enabled: true,
  });

  return createElement('div', {
    ref: scrollerRef,
    'data-rendered-count': String(virtualItems.length),
  });
}

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe('useDynamicVirtualList', () => {
  it('renders every loaded item until the scroller viewport is measurable', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(Harness));
    });

    // jsdom reports clientHeight === 0, matching the first layout pass that
    // can occur while a Tauri column is still being attached.  A zero-height
    // viewport must not collapse the list to overscan + 1 rows.
    expect(container.firstElementChild?.getAttribute('data-rendered-count')).toBe('13');
  });
});

