import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from './dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

it.each(['dropdown', 'popover'])('%s dismisses an outside frame but preserves its embedded frame', async kind => {
  const host = document.createElement('div'); document.body.append(host);
  const outside = document.createElement('iframe'); document.body.append(outside);
  const root = createRoot(host); const change = vi.fn();
  const Root = kind === 'dropdown' ? DropdownMenu : Popover;
  const Content = kind === 'dropdown' ? DropdownMenuContent : PopoverContent;
  const Trigger = kind === 'dropdown' ? DropdownMenuTrigger : PopoverTrigger;
  const previous = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => root.render(<Root open onOpenChange={change}><Trigger>open</Trigger><Content><iframe title="inside" /></Content></Root>));
    const inside = document.querySelector<HTMLIFrameElement>('iframe[title="inside"]')!;
    const send = (frame: HTMLIFrameElement) => window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow, data: { type: 'flowix:web-frame-pointerdown', version: 1 },
    }));
    await act(async () => { send(inside); });
    expect(change).not.toHaveBeenCalled();
    await act(async () => { send(outside); });
    expect(change).toHaveBeenCalledWith(false);
  } finally {
    await act(async () => root.unmount()); host.remove(); outside.remove();
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});
