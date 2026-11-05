import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CollectionAreaMenu, type CollectionAreaMenuItem } from './collection-area-menu';

let container: HTMLDivElement;
let root: Root;
let createNote: Mock<() => void>;
let importNotes: Mock<() => void>;

const ITEMS: CollectionAreaMenuItem[] = [
  { key: 'new-note', label: '新建笔记', onSelect: () => createNote() },
  { key: 'import-notes', label: '导入笔记 .md', onSelect: () => importNotes() },
];

async function render(items: readonly CollectionAreaMenuItem[]) {
  await act(async () => root.render(<CollectionAreaMenu items={items}>
    <div data-testid="list">
      <div data-testid="row">
        <span data-testid="row-body">Row</span>
      </div>
    </div>
  </CollectionAreaMenu>));
}

function element(selector: string) { return document.querySelector<HTMLElement>(selector)!; }

async function rightClick(selector: string) {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 24 });
  await act(async () => element(selector).dispatchEvent(event));
  return event;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  createNote = vi.fn();
  importNotes = vi.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('collection area context menu', () => {
  it('opens at the pointer with the items the tab declares', async () => {
    await render(ITEMS);
    const event = await rightClick('[data-testid="row-body"]');
    expect(event.defaultPrevented).toBe(true);
    const menu = element('[data-flowix-surface="context-menu"]');
    expect(menu.textContent).toContain('新建笔记');
    expect(menu.textContent).toContain('导入笔记 .md');
    expect(menu.style.left).toBe('12px');
    expect(menu.style.top).toBe('24px');
  });

  it('runs the item action and closes the menu', async () => {
    await render(ITEMS);
    await rightClick('[data-testid="row"]');
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((node) => node.textContent?.includes('导入笔记'));
    expect(item).toBeTruthy();
    await act(async () => item!.click());
    expect(importNotes).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-flowix-surface="context-menu"]')).toBeNull();
  });

  it('leaves the native menu alone when the tab declares no items', async () => {
    await render([]);
    const event = await rightClick('[data-testid="row"]');
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector('[data-flowix-surface="context-menu"]')).toBeNull();
  });

  it('does not stack a second menu over a row menu that already handled the event', async () => {
    await render(ITEMS);
    const row = element('[data-testid="row"]');
    const stop = (event: Event) => { event.preventDefault(); event.stopPropagation(); };
    row.addEventListener('contextmenu', stop);
    const event = await rightClick('[data-testid="row-body"]');
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector('[data-flowix-surface="context-menu"]')).toBeNull();
    row.removeEventListener('contextmenu', stop);
  });
});
