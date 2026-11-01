import { act, createRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotebookTreeCustomizePanel, type NotebookTreeCustomizePanelHandle } from './notebook-tree-customize-panel';
import type { NotebookTreeHiddenSection, NotebookTreeSection } from './use-notebook-tree-sections';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@shared/ui/popover', () => ({
  Popover: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div>{children}</div> : null,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@shared/ui/flowix-checkbox', () => ({
  FlowixCheckbox: ({ checked, onCheckedChange, 'aria-label': label }: { checked: boolean; onCheckedChange: (checked: boolean) => void; 'aria-label': string }) => <input type="checkbox" aria-label={label} checked={checked} onChange={(event) => onCheckedChange(event.target.checked)} />,
}));
vi.mock('@shared/ui/dialog', () => ({
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

let host: HTMLDivElement;
let root: Root;
const panel = createRef<NotebookTreeCustomizePanelHandle>();
const onChange = vi.fn();
function Harness() {
  const [order, setOrder] = useState<NotebookTreeSection[]>(['files', 'repositories', 'pinned']);
  const [hidden, setHidden] = useState<NotebookTreeHiddenSection[]>(['pinned']);
  return <NotebookTreeCustomizePanel ref={panel} sectionOrder={order} hiddenSections={hidden} onChange={(nextOrder, nextHidden) => {
    onChange(nextOrder, nextHidden);
    setOrder(nextOrder);
    setHidden(nextHidden);
  }} />;
}
beforeEach(async () => {
  onChange.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
  await act(async () => panel.current!.open(new DOMRect(0, 0, 10, 10)));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('notebook tree customization', () => {
  it('reorders by keyboard while retaining hidden sections', async () => {
    await act(async () => host.querySelector('[data-customize-section="repositories"] button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith(['repositories', 'files', 'pinned'], ['pinned']);
    expect([...host.querySelectorAll('[data-customize-section]')].map((node) => node.getAttribute('data-customize-section'))).toEqual(['repositories', 'files', 'pinned']);
  });
  it('changes visibility while retaining the current order', async () => {
    await act(async () => (host.querySelector('[data-customize-section="pinned"] input') as HTMLInputElement).click());
    expect(onChange).toHaveBeenLastCalledWith(['files', 'repositories', 'pinned'], []);
  });
});
