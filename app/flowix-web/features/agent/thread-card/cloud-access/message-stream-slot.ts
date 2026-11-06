/**
 * Placement of the in-conversation Cloud access notice.
 *
 * The notice is a row of the message stream, not a widget stacked on the
 * composer and not a decoration of the welcome block: it is the turn's reply,
 * so it reads as the last thing the conversation said. The stream ends with a
 * persistent thinking row, and the notice goes directly before it — on an empty
 * conversation that is the end of the stream, which is exactly where a first
 * reply belongs.
 *
 * A visible notice is message state, so the welcome block of an empty
 * conversation gives way while the notice is on screen (see `hideEmptyState`).
 *
 * Both surfaces keep it attached through an observer because the message
 * renderer re-inserts the list before the thinking row on every structural
 * render, rebuilds the welcome block from scratch, and clears the stream
 * entirely when the card collapses.
 */

const LOADING_INDICATOR_CLASS = 'agent-thread-card__loading-indicator';
const THINKING_ROW_SELECTOR = `:scope > .${LOADING_INDICATOR_CLASS}`;
/**
 * The centred welcome block of an empty conversation. It owns `margin-block:
 * auto` and declares a display of its own, so a visible notice has to hide it
 * by attribute (the renderer owns the block and would rebuild it anyway).
 * `--expanded` is the standalone/fullscreen form, `--inline-card` the
 * note-embedded one.
 */
const EMPTY_STATE_SELECTOR =
  ':scope > .agent-thread-card__empty--expanded, :scope > .agent-thread-card__empty--inline-card';

/**
 * Duck-typed on purpose: this runs from mutations, so it must not touch DOM
 * globals that a torn-down environment may already have removed.
 */
function queryStream(stream: Node, selector: string): Element | null {
  const scoped = stream as Element;
  return typeof scoped.querySelector === 'function'
    ? scoped.querySelector(selector)
    : null;
}

function findThinkingRow(stream: Node): Node | null {
  return queryStream(stream, THINKING_ROW_SELECTOR);
}

/** Put the notice where it belongs; a no-op when it already is. */
export function attachToMessageStream(el: HTMLElement, stream: Node | null): void {
  if (!stream) return;
  const anchor = findThinkingRow(stream);
  if (anchor) {
    if (el.parentNode === stream && el.nextElementSibling === anchor) return;
    stream.insertBefore(el, anchor);
    return;
  }
  // Without a thinking row the end of the stream is only a fallback, so never
  // re-append an element that is already a child: that would churn the DOM on
  // every observed mutation.
  if (el.parentNode !== stream) stream.appendChild(el);
}

/**
 * Keep the notice attached for as long as it is mounted, and return the
 * disposer that stops watching.
 *
 * `onAttach` re-applies state that the renderer can undo behind our back — it
 * rebuilds the welcome block from scratch, so hiding it once is not enough.
 */
export function observeMessageStream(
  el: HTMLElement,
  stream: Node | null,
  onAttach?: (stream: Node) => void,
): () => void {
  const attach = () => {
    attachToMessageStream(el, stream);
    if (stream) onAttach?.(stream);
  };
  attach();
  if (!stream) return () => undefined;
  const observer = new MutationObserver(attach);
  observer.observe(stream as Element, { childList: true });
  return () => observer.disconnect();
}

/**
 * Show or drop the empty-conversation welcome block.
 *
 * A visible notice is message state; leaving "nothing here yet" above it would
 * contradict the conversation. The block is owned by the renderer, so it is
 * hidden rather than removed — removal would only make the next render build
 * it again.
 */
export function hideEmptyState(stream: Node | null, hidden: boolean): void {
  if (!stream) return;
  const emptyState = queryStream(stream, EMPTY_STATE_SELECTOR);
  if (!emptyState) return;
  if (hidden) emptyState.setAttribute('hidden', '');
  else emptyState.removeAttribute('hidden');
}

/**
 * Pull the stream down when the notice landed below the fold: a blocked send
 * produces no run and therefore no scroll of its own, so on a long conversation
 * the card would otherwise appear off screen. Only the stream's own scroll
 * offset moves, never an ancestor (the notice also lives inside note cards).
 */
export function revealInMessageStream(el: HTMLElement, stream: Node | null): void {
  if (!stream) return;
  const scroller = stream as HTMLElement;
  if (typeof scroller.getBoundingClientRect !== 'function') return;
  const box = el.getBoundingClientRect();
  const viewport = scroller.getBoundingClientRect();
  const overflow = box.bottom - viewport.bottom;
  if (viewport.height > 0 && overflow > 0) scroller.scrollTop += overflow + 8;
}
