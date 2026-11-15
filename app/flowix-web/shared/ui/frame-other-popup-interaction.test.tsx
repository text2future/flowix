import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent } from './context-menu';
import { Select, SelectTrigger, SelectContent } from './select';

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
it.each(['context', 'select', 'cell-select'])('%s preserves an inside frame and closes on an outside frame repeatedly', async kind => {
  const host = document.createElement('div'); document.body.append(host);
  const outside = document.createElement('iframe'); document.body.append(outside);
  const root = createRoot(host); const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => root.render(kind === 'context'
      ? <ContextMenu><ContextMenuTrigger><button>open</button></ContextMenuTrigger><ContextMenuContent><iframe title="popup-frame" /></ContextMenuContent></ContextMenu>
      : <Select anchorToCell={kind === 'cell-select'}><SelectTrigger>open</SelectTrigger><SelectContent><iframe title="popup-frame" /></SelectContent></Select>));
    const send = (frame: HTMLIFrameElement) => window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow, data: { type: 'flowix:web-frame-pointerdown', version: 1 },
    }));
    for (let index = 0; index < 2; index++) {
      await act(async () => { host.querySelector('button')!.dispatchEvent(new MouseEvent(kind === 'context' ? 'contextmenu' : 'click', { bubbles: true, cancelable: true })); });
      const inside = document.querySelector<HTMLIFrameElement>('iframe[title="popup-frame"]')!;
      expect(inside).not.toBeNull();
      await act(async () => { send(inside); });
      expect(inside.isConnected).toBe(true);
      await act(async () => { send(outside); });
      expect(inside.isConnected).toBe(false);
    }
  } finally {
    await act(async () => root.unmount()); host.remove(); outside.remove(); environment.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});
