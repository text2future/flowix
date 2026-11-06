import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog, DialogContent } from './dialog';
import { Button } from './button';
import { Input } from './input';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('modal boundaries', () => {
  it('blocks both close paths while busy and allows both when ready', async () => {
    const onOpenChange = vi.fn();
    const render = async (busy: boolean) => {
      await act(async () => root.render(
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent closeDisabled={busy}>Import in progress</DialogContent>
        </Dialog>,
      ));
    };
    const click = async (selector: string) => {
      await act(async () => document.body.querySelector<HTMLElement>(selector)!.click());
    };

    await render(true);
    await click('[data-slot="dialog-close"]');
    await click('[data-slot="dialog-overlay"]');
    expect(onOpenChange).not.toHaveBeenCalled();

    await render(false);
    await click('[data-slot="dialog-close"]');
    await click('[data-slot="dialog-overlay"]');
    expect(onOpenChange.mock.calls).toEqual([[false], [false]]);
  });

  it('keeps page controls unchanged and excludes icon buttons and links from action styling', async () => {
    await act(async () => root.render(
      <>
        <Button data-testid="page-button">Page</Button>
        <Input data-testid="page-input" />
        <Dialog open onOpenChange={() => {}}>
          <DialogContent>
            <Button data-testid="modal-button">Save</Button>
            <Input data-testid="modal-input" />
            <Button size="icon" data-testid="modal-icon" aria-label="Edit">+</Button>
            <Button variant="link" data-testid="modal-link">Help</Button>
          </DialogContent>
        </Dialog>
      </>,
    ));
    const classes = (id: string) => document.body.querySelector(`[data-testid="${id}"]`)!.classList;
    expect(classes('page-button').contains('h-8')).toBe(true);
    expect(classes('page-input').contains('h-8')).toBe(true);
    expect(classes('modal-button').contains('h-[38px]')).toBe(true);
    expect(classes('modal-input').contains('h-10')).toBe(true);
    expect(classes('modal-icon').contains('h-[38px]')).toBe(false);
    expect(classes('modal-link').contains('h-[38px]')).toBe(false);
  });
});
