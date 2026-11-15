import { afterEach, expect, it, vi } from 'vitest';
import { subscribeFrameInteraction } from './frame-interaction';

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); document.body.replaceChildren(); });
function send(source: Window | null, version = 1) {
  window.dispatchEvent(new MessageEvent('message', { source, data: { type: 'flowix:web-frame-pointerdown', version } }));
}
it('maps repeated remote interactions to the connected iframe and rejects unrelated messages', () => {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const listener = vi.fn();
  cleanups.push(subscribeFrameInteraction(document, listener));
  send(window); send(null); send(frame.contentWindow, 2);
  expect(listener).not.toHaveBeenCalled();
  send(frame.contentWindow); send(frame.contentWindow);
  expect(listener.mock.calls).toEqual([[frame], [frame]]);
  const source = frame.contentWindow;
  frame.remove(); send(source);
  expect(listener).toHaveBeenCalledTimes(2);
});
it('retains other subscribers when the first popup closes and supports reopening', () => {
  const frame = document.createElement('iframe'); document.body.append(frame);
  const first = vi.fn(); const second = vi.fn();
  const closeFirst = subscribeFrameInteraction(document, first);
  const closeSecond = subscribeFrameInteraction(document, second);
  closeFirst(); send(frame.contentWindow);
  expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledOnce();
  closeSecond(); send(frame.contentWindow); expect(second).toHaveBeenCalledOnce();
  cleanups.push(subscribeFrameInteraction(document, first));
  send(frame.contentWindow); expect(first).toHaveBeenCalledWith(frame);
});
