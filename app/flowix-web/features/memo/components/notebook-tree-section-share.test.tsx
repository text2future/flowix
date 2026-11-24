import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { NotebookTreeSectionMenu } from './notebook-tree-section-menu';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@features/document/public/header-api', () => ({
  NoteShareControl: ({ filePath, openRequest }: { filePath: string; openRequest: number }) =>
    <div data-share-path={filePath} data-open-request={openRequest} />,
}));

it('opens sharing for the notebook root from the item below sorting', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<NotebookTreeSectionMenu canMoveUp={false} canMoveDown={false}
      onMoveUp={() => {}} onMoveDown={() => {}} sort="filenameAsc" onSort={() => {}} sharePath="/book" />));
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')];
    const sort = buttons.findIndex((button) => button.textContent?.includes('memo.list.sortLabel'));
    const share = buttons.findIndex((button) => button.textContent?.includes('document.share.menuAction'));
    expect(share).toBe(sort + 1);
    await act(async () => buttons[share]!.click());
    expect(host.querySelector('[data-share-path="/book"]')?.getAttribute('data-open-request')).toBe('1');
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it.each([
  ['memo.create.newView', 'memo.create.mediaLibraryMenuLabel', 'database'],
  ['memo.fileTree.import', 'memo.fileTree.importFiles', 'import'],
  ['memo.list.sortLabel', 'memo.list.sortUpdated', 'sort'],
])('renders %s in an independent submenu and runs its action', async (label, option, kind) => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const action = vi.fn();
  try {
    await act(async () => root.render(<NotebookTreeSectionMenu canMoveUp={false} canMoveDown={false}
      onMoveUp={() => {}} onMoveDown={() => {}} sort="filenameAsc" onSort={kind === 'sort' ? action : () => {}}
      onCreateMediaLibrary={kind === 'database' ? action : () => {}} onImportFiles={kind === 'import' ? action : () => {}} />));
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
    const trigger = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes(label));
    expect(trigger).toBeDefined();
    await act(async () => trigger!.click());
    const popup = document.querySelector<HTMLElement>('[data-flowix-menu-child]');
    expect(popup).not.toBeNull();
    expect(popup!.parentElement).toBe(document.body);
    const item = [...popup!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes(option));
    expect(item).toBeDefined();
    await act(async () => item!.click());
    expect(action).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
