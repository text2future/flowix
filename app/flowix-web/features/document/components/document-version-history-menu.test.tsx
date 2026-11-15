import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@shared/ui/dropdown-menu';
import { VersionHistorySubmenu } from './document-version-history-menu';

vi.mock('@platform/tauri/client', () => ({ notes: { listVersions: vi.fn(async () => [{ id: 'v1', createdAt: 1, source: 'manual', size: 12 }]) } }));
vi.mock('@phosphor-icons/react', () => ({ ClockIcon: () => null }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

it('portals history outside the scrolling parent and keeps parent ownership during selection', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const select = vi.fn();
  try {
    await act(async () => root.render(<DropdownMenu open><DropdownMenuTrigger>Actions</DropdownMenuTrigger><DropdownMenuContent><VersionHistorySubmenu notebookId="book" relativePath="note.md" refreshKey={0} restoringVersionId={null} onSelectVersion={select} /></DropdownMenuContent></DropdownMenu>));
    const parent = document.querySelector<HTMLElement>('[data-flowix-surface="popover"]')!;
    const trigger = parent.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
    await act(async () => trigger.focus());
    const popup = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(popup).not.toBeNull();
    expect(parent.contains(popup)).toBe(false);
    expect(parent.classList.contains('popup-scroll-area')).toBe(true);
    expect(popup.querySelectorAll('.popup-scroll-area')).toHaveLength(1);
    expect(popup.hasAttribute('data-flowix-menu-child')).toBe(true);
    const item = popup.querySelector<HTMLButtonElement>('.popup-scroll-area button')!;
    await act(async () => {
      item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      item.click();
    });
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: 'v1' }));
    expect(parent.isConnected).toBe(true);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
