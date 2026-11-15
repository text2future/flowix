type FrameInteractionListener = (frame: HTMLIFrameElement) => void;
const subscriptions = new WeakMap<Document, Set<FrameInteractionListener>>();

/** Resolve only connected, host-owned frames. A remote origin is deliberately
 * allowed: source identity, rather than a URL allowlist, identifies the frame.
 * One message listener is shared by all open popups in a document. */
export function subscribeFrameInteraction(document: Document, listener: FrameInteractionListener): () => void {
  const ownerWindow = document.defaultView;
  if (!ownerWindow) return () => {};
  let listeners = subscriptions.get(document);
  if (!listeners) {
    listeners = new Set();
    subscriptions.set(document, listeners);
  }
  const current = listeners;
  const onMessage = (event: MessageEvent) => {
    if (event.data?.type !== 'flowix:web-frame-pointerdown' || event.data?.version !== 1 || !event.source) return;
    const frame = Array.from(document.querySelectorAll('iframe')).find(frame => frame.contentWindow === event.source);
    if (frame) for (const callback of [...current]) callback(frame);
  };
  // Keep the handler alongside the first subscription's cleanup through a
  // separate weak map, so closing that popup does not detach other subscribers.
  if (current.size === 0) {
    ownerWindow.addEventListener('message', onMessage);
    cleanups.set(document, () => ownerWindow.removeEventListener('message', onMessage));
  }
  current.add(listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    current.delete(listener);
    if (current.size === 0) {
      cleanups.get(document)?.();
      cleanups.delete(document);
      subscriptions.delete(document);
    }
  };
}
const cleanups = new WeakMap<Document, () => void>();
