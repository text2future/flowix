import { forwardRef, type CSSProperties, type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { OverlayScrollbar, type OverlayScrollbarHandle, type OverlayScrollbarProps } from './overlay-scrollbar';

export type PopupScrollAreaHandle = OverlayScrollbarHandle;
export type PopupScrollAreaProps = Omit<OverlayScrollbarProps, 'horizontalScrollbar' | 'customOnMac'>;

/** Popup viewport: one scrollbar implementation, no layout gutter, shared corner clearance.
 * Keep headers/footers outside this component when they should stay fixed.
 * className constrains the frame; scrollerClassName styles the scrolling content.
 * scrollerRef/scrollerProps refer to the viewport; ref exposes the scrollbar handle.
 * For a compound PopoverContent use scrollable={false} and put one area between
 * the fixed header and footer. Simple menus use their built-in area.
 */
export const PopupScrollArea = forwardRef<PopupScrollAreaHandle, PopupScrollAreaProps>(
  function PopupScrollArea({ className, scrollerClassName, observeContent = true, ...props }, ref) {
    return <OverlayScrollbar
      {...props}
      ref={ref}
      observeContent={observeContent}
      className={cn('popup-scroll-area', className)}
      scrollerClassName={cn('popup-scroll-area__viewport', scrollerClassName)}
    />;
  },
);

/** Internal adapter for positioned popup shells. Compound popups own their inner scroll areas. */
interface PopupSurfaceProps extends HTMLAttributes<HTMLDivElement> {
  scrollable: boolean;
  scrollerClassName?: string;
}

export const PopupSurface = forwardRef<HTMLDivElement, PopupSurfaceProps>(
  function PopupSurface({ scrollable, className, scrollerClassName, children, ...props }, ref) {
    if (!scrollable) return <div {...props} ref={ref} className={className}>{children}</div>;
    return <PopupScrollArea
      {...props}
      frameRef={ref}
      className={cn('popup-scroll-area--surface', className)}
      scrollerClassName={scrollerClassName}
    >{children}</PopupScrollArea>;
  },
);

/** Measure full list content even when the popup shell is already height constrained. */
export function getPopupContentHeight(surface: HTMLElement | null): number {
  if (!surface) return Number.POSITIVE_INFINITY;
  const viewport = surface.querySelector<HTMLElement>(':scope > .popup-scroll-area__viewport');
  return viewport
    ? viewport.scrollHeight + surface.offsetHeight - viewport.clientHeight
    : surface.scrollHeight;
}

/** Intersect viewport clearance with the caller's CSS/inline height limit. */
export function limitPopupHeight(surface: HTMLElement, available: number, maxHeight?: CSSProperties['maxHeight']): void {
  surface.style.maxHeight = typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight ?? '';
  const configured = surface.ownerDocument.defaultView?.getComputedStyle(surface).maxHeight;
  surface.style.maxHeight = configured && configured !== 'none'
    ? `min(${configured}, ${Math.max(0, available)}px)`
    : `${Math.max(0, available)}px`;
}
