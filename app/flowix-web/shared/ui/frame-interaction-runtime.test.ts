import { expect, it, vi } from 'vitest';
import runtime from '../../../flowix-desktop/src/web_frame_interaction.js?raw';

function setup(topLevel = false) {
  const document = new EventTarget();
  const child = window;
  const postMessage = vi.fn();
  const frame = Object.assign(new EventTarget(), { parent: { postMessage }, frames: [child], top: {} });
  if (topLevel) frame.top = frame;
  // Execute the shipped source with isolated frame globals, including nested frames.
  new Function('window', 'document', runtime)(frame, document);
  return { frame, document, child, postMessage };
}
it('reports every pointerdown without cancelling or stopping page input', () => {
  const { document, postMessage } = setup();
  const pageHandler = vi.fn(); document.addEventListener('pointerdown', pageHandler);
  for (let index = 0; index < 2; index++) {
    const event = new Event('pointerdown', { cancelable: true });
    document.dispatchEvent(event); expect(event.defaultPrevented).toBe(false);
  }
  expect(pageHandler).toHaveBeenCalledTimes(2);
  expect(postMessage.mock.calls).toEqual(Array(2).fill([{ type: 'flowix:web-frame-pointerdown', version: 1 }, '*']));
});
it('forwards valid direct-child messages and rejects unrelated sources and payloads', () => {
  const { frame, child, postMessage } = setup();
  const send = (source: Window | null, version = 1, type = 'flowix:web-frame-pointerdown') => {
    frame.dispatchEvent(new MessageEvent('message', { source, data: { type, version } }));
  };
  send(null); send({} as Window); send(child, 2); send(child, 1, 'other');
  expect(postMessage).not.toHaveBeenCalled();
  send(child); expect(postMessage).toHaveBeenCalledOnce();
});
it('stays inert in the host document', () => {
  const { frame, document, child, postMessage } = setup(true);
  document.dispatchEvent(new Event('pointerdown'));
  frame.dispatchEvent(new MessageEvent('message', { source: child, data: { type: 'flowix:web-frame-pointerdown', version: 1 } }));
  expect(postMessage).not.toHaveBeenCalled();
});
