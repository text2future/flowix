export interface PopoverPosition {
  left: number;
  top: number;
  placeAbove: boolean;
}

export function calculateAnchoredPopoverPosition(options: {
  anchorRect: DOMRect;
  popoverWidth: number;
  popoverHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  padding: number;
  offset: number;
}): PopoverPosition {
  const {
    anchorRect,
    popoverWidth,
    popoverHeight,
    viewportWidth,
    viewportHeight,
    padding,
    offset,
  } = options;
  const spaceBelow = viewportHeight - anchorRect.bottom - padding - offset;
  const placeAbove = spaceBelow < popoverHeight && anchorRect.top > spaceBelow;
  const maxLeft = Math.max(padding, viewportWidth - padding - popoverWidth);
  const left = Math.min(Math.max(anchorRect.left, padding), maxLeft);
  const rawTop = placeAbove
    ? anchorRect.top - offset - popoverHeight
    : anchorRect.bottom + offset;
  const maxTop = Math.max(padding, viewportHeight - padding - popoverHeight);
  const top = Math.min(Math.max(rawTop, padding), maxTop);
  return { left, top, placeAbove };
}

export function applyPopoverPosition(
  popover: HTMLElement,
  position: PopoverPosition,
): void {
  popover.style.left = `${position.left}px`;
  popover.style.top = `${position.top}px`;
}
