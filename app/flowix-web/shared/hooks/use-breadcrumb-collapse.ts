import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Mirrors the `gap-1` (4px) used by every breadcrumb row. */
const SEGMENT_GAP = 4;

/**
 * Identity of a rendered breadcrumb: what the collapse plan depends on.
 * Labels drive the measured width, the type decides folder vs file styling.
 */
export function breadcrumbSignature(
  items: readonly { label: string; type?: 'folder' | 'file' }[],
): string {
  return items.map((item) => `${item.type ?? ''}\u0001${item.label}`).join('\u0002');
}

export interface BreadcrumbCollapsePlanInput {
  /** Measured widths, in rendered order. */
  itemWidths: readonly number[];
  /** Width the row can occupy. */
  availableWidth: number;
  /** Width reserved for the `···` marker; the repo breadcrumb renders a padded button, the header a bare icon. */
  ellipsisWidth: number;
  gap?: number;
}

/**
 * Which segments survive when a breadcrumb row overflows.
 *
 * Returns `null` when everything fits (or when there is nothing to fold);
 * otherwise the index of the first segment kept after the root. The root and
 * the current file always stay, parents are re-added right-to-left while they
 * fit, and at least one middle segment always collapses — restoring every
 * segment would be the same thing as not folding at all.
 */
export function planBreadcrumbCollapse({
  itemWidths,
  availableWidth,
  ellipsisWidth,
  gap = SEGMENT_GAP,
}: BreadcrumbCollapsePlanInput): number | null {
  const count = itemWidths.length;
  // Nothing measured yet (first layout pass) or nothing to fold: keep it simple.
  if (count <= 2 || availableWidth <= 0) return null;

  const fullWidth = itemWidths.reduce((sum, width) => sum + width, 0) + gap * (count - 1);
  if (fullWidth <= availableWidth) return null;

  let keptWidth = itemWidths[0] + itemWidths[count - 1] + ellipsisWidth + gap * 2;
  let start = count - 1;
  if (count >= 4 && keptWidth + itemWidths[count - 2] + gap <= availableWidth) {
    keptWidth += itemWidths[count - 2] + gap;
    start = count - 2;
  }
  for (let index = count - 3; index > 1; index -= 1) {
    const nextWidth = keptWidth + itemWidths[index] + gap;
    if (nextWidth > availableWidth) break;
    keptWidth = nextWidth;
    start = index;
  }
  return start;
}

interface BreadcrumbCollapseState {
  signature: string;
  hiddenStart: number | null;
}

/**
 * Measures a breadcrumb row and decides which middle segments collapse.
 *
 * `signature` identifies the rendered segments; when it changes the plan is
 * recomputed and, until the next measurement lands, the row renders unfolded
 * instead of applying an index that belongs to the previous path.
 */
export function useBreadcrumbCollapse<T extends HTMLElement = HTMLDivElement>({
  signature,
  itemCount,
  ellipsisWidth,
}: {
  /** Stable identity of the rendered segments (labels + types). */
  signature: string;
  itemCount: number;
  ellipsisWidth: number;
}): {
  containerRef: RefObject<T | null>;
  itemRefs: RefObject<Array<HTMLSpanElement | null>>;
  hiddenStart: number | null;
} {
  const containerRef = useRef<T | null>(null);
  const itemRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const [state, setState] = useState<BreadcrumbCollapseState>({ signature, hiddenStart: null });
  const hiddenStart = state.signature === signature ? state.hiddenStart : null;

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const update = () => {
      const widths = Array.from({ length: itemCount }, (_, index) =>
        itemRefs.current[index]?.getBoundingClientRect().width ?? 0);
      const next = planBreadcrumbCollapse({
        itemWidths: widths,
        availableWidth: container.clientWidth,
        ellipsisWidth,
      });
      setState((previous) => (previous.signature === signature && previous.hiddenStart === next
        ? previous
        : { signature, hiddenStart: next }));
    };

    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(container);
    itemRefs.current.forEach((item) => { if (item) observer?.observe(item); });
    return () => observer?.disconnect();
  }, [ellipsisWidth, itemCount, signature]);

  return { containerRef, itemRefs, hiddenStart };
}
