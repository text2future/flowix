import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Popover, PopoverContent, PopoverTrigger } from './popover';

let container: HTMLDivElement;
let root: Root;
let nextAnimationFrame: FrameRequestCallback | null;
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function TestPopover({
  open,
  onExitComplete,
  onOpenChange = vi.fn(),
}: {
  open: boolean;
  onExitComplete?: () => void;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button type="button">Toggle</button>
      </PopoverTrigger>
      <PopoverContent onExitComplete={onExitComplete}>Content</PopoverContent>
    </Popover>
  );
}

describe('PopoverContent motion lifecycle', () => {
  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    nextAnimationFrame = null;

    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      nextAnimationFrame = callback;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('positions before entering and stays mounted until the exit animation ends', async () => {
    const onExitComplete = vi.fn();
    await act(async () => root.render(createElement(TestPopover, { open: false, onExitComplete })));
    expect(document.body.querySelector('.flowix-popover-content')).toBeNull();

    await act(async () => root.render(createElement(TestPopover, { open: true, onExitComplete })));
    const startingContent = document.body.querySelector<HTMLElement>('.flowix-popover-content');
    expect(startingContent?.dataset.motionState).toBe('starting');
    expect(startingContent?.style.top).toBe('4px');

    await act(async () => nextAnimationFrame?.(16));
    expect(startingContent?.dataset.motionState).toBe('open');

    await act(async () => root.render(createElement(TestPopover, { open: false, onExitComplete })));
    const closingContent = document.body.querySelector<HTMLElement>('.flowix-popover-content');
    expect(closingContent?.dataset.motionState).toBe('closing');

    await act(async () => vi.advanceTimersByTime(499));
    expect(document.body.querySelector('.flowix-popover-content')).not.toBeNull();

    await act(async () => vi.advanceTimersByTime(1));
    expect(document.body.querySelector('.flowix-popover-content')).toBeNull();
    expect(onExitComplete).toHaveBeenCalledOnce();
  });

  it('closes on pointerdown outside the trigger and content', async () => {
    const onOpenChange = vi.fn();
    await act(async () => root.render(createElement(TestPopover, { open: true, onOpenChange })));

    const outside = document.createElement('button');
    document.body.appendChild(outside);
    await act(async () => {
      outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps ancestors open for portaled child and grandchild interactions but closes outside', async () => {
    const parentChange = vi.fn();
    const childChange = vi.fn();
    const grandchildChange = vi.fn();
    await act(async () => root.render(
      <Popover open onOpenChange={parentChange}>
        <PopoverTrigger asChild><button>Dataset</button></PopoverTrigger>
        <PopoverContent>
          <Popover open onOpenChange={childChange}>
            <PopoverTrigger asChild><button>Asset filter</button></PopoverTrigger>
            <PopoverContent aria-label="Asset conditions">
              <input aria-label="Filename" />
              <Popover open onOpenChange={grandchildChange}>
                <PopoverTrigger asChild><button>Types</button></PopoverTrigger>
                <PopoverContent><button>Image type</button></PopoverContent>
              </Popover>
            </PopoverContent>
          </Popover>
        </PopoverContent>
      </Popover>,
    ));
    for (const target of [
      document.querySelector('[aria-label="Asset conditions"]')!,
      document.querySelector('[aria-label="Filename"]')!,
      [...document.querySelectorAll('button')].find((button) => button.textContent === 'Image type')!,
    ]) {
      parentChange.mockClear();
      childChange.mockClear();
      await act(async () => target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
      expect(parentChange).not.toHaveBeenCalled();
      expect(childChange).not.toHaveBeenCalled();
    }
    await act(async () => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    expect(parentChange).toHaveBeenCalledWith(false);
    expect(childChange).toHaveBeenCalledWith(false);
    expect(grandchildChange).toHaveBeenCalledWith(false);
  });

  it('registers child content opened after mount, including its delayed portal mount', async () => {
    const parentChange = vi.fn();
    function Menu() {
      const [childOpen, setChildOpen] = useState(false);
      return <Popover open onOpenChange={parentChange}>
        <PopoverTrigger asChild><button>Dataset</button></PopoverTrigger>
        <PopoverContent>
          <Popover open={childOpen} onOpenChange={setChildOpen}>
            <PopoverTrigger asChild><button>Open asset filter</button></PopoverTrigger>
            <PopoverContent><input aria-label="Asset filename" /></PopoverContent>
          </Popover>
        </PopoverContent>
      </Popover>;
    }
    await act(async () => root.render(<Menu />));
    await act(async () => {
      [...document.querySelectorAll('button')].find((button) => button.textContent === 'Open asset filter')!.click();
    });
    const input = document.querySelector<HTMLInputElement>('[aria-label="Asset filename"]')!;
    expect(input).not.toBeNull();
    await act(async () => { input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
    expect(parentChange).not.toHaveBeenCalled();
  });

  it('anchors to the entire field row instead of its nested button', async () => {
    const rect = new DOMRect(20, 60, 320, 32);
    const getBounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-table-field-item') ? rect : new DOMRect(50, 60, 80, 32);
    });
    try {
      await act(async () => root.render(createElement('div', { 'data-table-field-item': true },
        createElement(TestFieldRowPopover))));
      const content = document.body.querySelector<HTMLElement>('.flowix-popover-content');
      expect(content?.style.left).toBe('340px');
      expect(content?.style.top).toBe('60px');
    } finally {
      getBounds.mockRestore();
    }
  });
});

function TestFieldRowPopover() {
  return createElement(Popover, { open: true, children: null },
    createElement(PopoverTrigger, { asChild: true }, createElement('button', {}, 'Field')),
    createElement(PopoverContent, { anchorSelector: '[data-table-field-item]', side: 'right', align: 'start', sideOffset: 0, children: null }, 'Editor'));
}
