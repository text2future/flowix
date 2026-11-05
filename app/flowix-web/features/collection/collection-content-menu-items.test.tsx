import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DropdownMenu } from '@shared/ui/dropdown-menu';
import { CollectionContentMenuItems } from './collection-content-menu-items';
import type { FolderCollectionSummary } from './folder-collection';

const io = vi.hoisted(() => ({ read: vi.fn(), add: vi.fn(), getPreferences: vi.fn(), setPreferences: vi.fn() }));
vi.mock('@features/collection/public/folder-api', () => ({ readCollectionSummary: io.read }));
vi.mock('./folder-collection', () => ({ addCollectionDomain: io.add }));
vi.mock('@platform/tauri/client/desktop', () => ({ files: { getNotebookViewPreferences: io.getPreferences, setNotebookViewPreferences: io.setPreferences } }));
vi.mock('@platform/tauri/event-bus', () => ({ subscribe: () => () => {} }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
let root: Root;
let node: HTMLDivElement;
const summary = (domains: FolderCollectionSummary['domains'], revision: number) => ({
  collectionId: 'target-collection', revision, domains,
} as FolderCollectionSummary);
const item = (menu: Element, text: string) => [...menu.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes(text))!;

beforeEach(() => {
  io.read.mockResolvedValue(summary(['notes'], 1));
  io.getPreferences.mockResolvedValue({ defaultCreateFolder: null });
  io.setPreferences.mockResolvedValue(undefined);
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.clearAllMocks(); });

function Menu({ host }: { host: string }) {
  return <DropdownMenu open><div data-menu={host}><CollectionContentMenuItems
    indexPath="/target-book/folder/.index.yaml" notebookPath="/target-book" notebookId="target-book" />
  </div></DropdownMenu>;
}

it('the same collection in both containers shares content commands and updates without navigation', async () => {
  io.add.mockResolvedValue(summary(['notes', 'media'], 2));
  await act(async () => root.render(<><Menu host="work" /><Menu host="browser" /></>));
  const menus = [...node.querySelectorAll('[data-menu]')];
  expect(io.read).toHaveBeenCalledOnce();
  for (const menu of menus) {
    expect(item(menu, '展示笔记').disabled).toBe(true);
    expect(item(menu, '展示图/视频').disabled).toBe(false);
  }
  await act(async () => item(menus[1], '展示图/视频').click());
  expect(io.add).toHaveBeenCalledExactlyOnceWith('/target-book/folder/.index.yaml', '/target-book', 'media');
  for (const menu of menus) expect(item(menu, '展示图/视频').disabled).toBe(true);
});

it('sets the default create folder in the collection’s notebook from either container', async () => {
  await act(async () => root.render(<Menu host="browser" />));
  await act(async () => item(node, 'memo.fileTree.setDefaultCreateFolder').click());
  expect(io.setPreferences).toHaveBeenCalledExactlyOnceWith('/target-book', { defaultCreateFolder: 'folder' });
  expect(item(node, 'memo.fileTree.clearDefaultCreateFolder')).toBeDefined();
});

it('does not offer folder-specific commands for a missing collection', async () => {
  io.read.mockResolvedValue(null);
  await act(async () => root.render(<Menu host="work" />));
  expect(node.querySelectorAll('button')).toHaveLength(0);
});
