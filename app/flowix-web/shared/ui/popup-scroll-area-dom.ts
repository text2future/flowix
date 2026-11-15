import { createOverlayScrollbarDom, type OverlayScrollbarDomController } from './overlay-scrollbar-dom';

/** DOM-owned popup counterpart of PopupScrollArea. Keep this controller until
 * the popup closes, render into scroller, and destroy it before removing frame. */
export function createPopupScrollAreaDom(
  ownerDocument: Document,
  options: { frameClassName?: string; scrollerClassName?: string } = {},
): OverlayScrollbarDomController {
  return createOverlayScrollbarDom(ownerDocument, {
    frameClassName: ['overlay-scrollbar-frame--custom-mac popup-scroll-area', options.frameClassName].filter(Boolean).join(' '),
    scrollerClassName: ['popup-scroll-area__viewport', options.scrollerClassName].filter(Boolean).join(' '),
    observeContent: true,
  });
}
