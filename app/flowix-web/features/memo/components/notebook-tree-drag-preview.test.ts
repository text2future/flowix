import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDragClickSuppression, createTreeDragPreview, readDragGrabOffset } from './notebook-tree-drag-preview';

const PREVIEW_SELECTOR = '.notebook-file-tree__drag-preview';

function sourceRow(): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'folder-file-tree__item group';
  row.setAttribute('data-notebook-tree-path', '/notes/a.md');
  row.setAttribute('tabindex', '0');
  row.style.marginLeft = '26px';
  row.style.width = 'calc(100% - 32px)';
  const icon = document.createElement('img');
  icon.id = 'note-icon';
  const label = document.createElement('span');
  label.textContent = 'a';
  row.append(icon, label);
  return row;
}

describe('notebook tree drag preview', () => {
  afterEach(() => {
    document.body.querySelectorAll(PREVIEW_SELECTOR).forEach((preview) => preview.remove());
    vi.restoreAllMocks();
  });

  it('reads the grab offset from the pointerdown rect', () => {
    const row = sourceRow();
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
      x: 10, y: 10, left: 10, top: 10, right: 250, bottom: 42, width: 240, height: 32, toJSON: () => ({}),
    } as DOMRect);
    expect(readDragGrabOffset(row, 130, 26)).toEqual({ x: 120, y: 16, width: 240, height: 32 });
  });

  it('clones the row with identical geometry and a count badge for multi-selection', () => {
    const row = sourceRow();
    const preview = createTreeDragPreview(row, { x: 120, y: 16, width: 240, height: 32 }, 3);

    expect(preview.parentElement).toBe(document.body);
    expect(preview.getAttribute('aria-hidden')).toBe('true');
    expect(preview.style.width).toBe('240px');
    expect(preview.style.height).toBe('32px');

    const clone = preview.querySelector<HTMLElement>('.folder-file-tree__item')!;
    expect(clone.className).toBe(row.className);
    expect(clone.textContent).toBe('a');
    expect(clone.style.width).toBe('240px');
    expect(clone.style.height).toBe('32px');
    expect(Number.parseFloat(clone.style.marginLeft)).toBe(0);
    expect(clone.hasAttribute('data-notebook-tree-path')).toBe(false);
    expect(clone.hasAttribute('tabindex')).toBe(false);
    expect(clone.querySelector('#note-icon')).toBeNull();
    expect(preview.querySelector('.notebook-file-tree__drag-preview-count')?.textContent).toBe('3');
  });

  it('omits the badge for a single selection', () => {
    const preview = createTreeDragPreview(sourceRow(), { x: 0, y: 0, width: 240, height: 32 }, 1);
    expect(preview.querySelector('.notebook-file-tree__drag-preview-count')).toBeNull();
  });
});

describe('drag click suppression', () => {
  it('swallows exactly one click after a drag and resets on the next pointerdown', () => {
    const suppression = createDragClickSuppression();
    expect(suppression.consume()).toBe(false);
    suppression.arm();
    expect(suppression.consume()).toBe(true);
    expect(suppression.consume()).toBe(false);
    suppression.arm();
    suppression.reset();
    expect(suppression.consume()).toBe(false);
  });
});
