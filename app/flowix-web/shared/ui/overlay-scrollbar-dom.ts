import { bindScrollbarController, type ScrollbarController } from '@shared/lib/scrollbar-controller';
export interface OverlayScrollbarDomController extends Pick<ScrollbarController, 'update' | 'destroy'> {
  frame: HTMLDivElement;
  scroller: HTMLDivElement;
}

interface OverlayScrollbarDomOptions {
  frameClassName?: string;
  scrollerClassName?: string;
  observeContent?: boolean;
  /** Render a horizontal-only overlay, using the shared product scrollbar styles. */
  horizontal?: boolean;
}

export function createOverlayScrollbarDom(
  ownerDocument: Document,
  options: OverlayScrollbarDomOptions = {},
): OverlayScrollbarDomController {
  const horizontal = options.horizontal === true;
  const axis = horizontal ? 'horizontal' : 'vertical';
  const frame = ownerDocument.createElement('div');
  frame.className = ['overlay-scrollbar-frame', options.frameClassName]
    .filter(Boolean)
    .join(' ');

  const scroller = ownerDocument.createElement('div');
  scroller.className = ['overlay-scrollbar', options.scrollerClassName]
    .filter(Boolean)
    .join(' ');

  const track = ownerDocument.createElement('div');
  track.className = `overlay-scrollbar-track overlay-scrollbar-track--${axis}`;
  track.setAttribute('aria-hidden', 'true');

  const thumb = ownerDocument.createElement('div');
  thumb.className = `overlay-scrollbar-thumb overlay-scrollbar-thumb--${axis}`;
  thumb.setAttribute('aria-hidden', 'true');

  frame.append(scroller, track, thumb);
  frame.dataset.scrollable = 'false';
  frame.dataset.horizontalScrollbar = String(horizontal);
  frame.dataset.horizontalScrollable = 'false';

  const controller = bindScrollbarController(frame, scroller, { observeContent: options.observeContent });
  return { frame, scroller, update: controller.update, destroy: controller.destroy };
}
