import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocTreeItem } from '@platform/tauri/client';

const collectionSnapshots = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@features/collection/use-collection-summary', () => ({
  useCollectionSummary: (path: string) => [collectionSnapshots.get(path) ?? 'missing'],
}));
const setDocumentPropertiesMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@features/document/public/path-properties', () => ({
  setDocumentProperties: setDocumentPropertiesMock,
}));

vi.mock('@/lib/i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/i18n')>(),
  useI18n: () => ({ t: (key: string) => key, language: 'zh-CN' }),
}));

vi.mock('@shared/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useContextMenuContext: () => ({ openAt: vi.fn() }),
}));
vi.mock('@features/memo/components/memo-card-actions', () => ({ MemoCardActions: () => null }));
vi.mock('@features/memo/components/notebook-create-context-menu', () => ({ NotebookCreateContextMenuItems: () => null }));
vi.mock('@features/memo/components/notebook-copy-context-menu', () => ({ NotebookCopyContextMenu: () => null }));

import { NotebookTreeRow } from './notebook-tree-row';
import { ContentIcon } from '@features/content/public/content-api';
import folderIcon from '@/assets/folder-outline.svg?raw';
import { PROPERTY_ICON_OPTIONS } from '@features/document/properties/property-icons';

function noteItem(fullPath: string): DocTreeItem {
  return {
    id: fullPath,
    fullPath,
    name: fullPath.slice(fullPath.lastIndexOf('/') + 1),
    type: 'document',
    parentId: null,
    children: null,
    sizeBytes: 0,
    modifiedMs: null,
    createdMs: null,
    memoCreatedMs: null,
    memoMeta: { icon: null, colors: [], favorited: false },
  } as unknown as DocTreeItem;
}

/**
 * A pinned collection row: the backend returns the collection title as `name`
 * and the type separately, so the row has no filename suffix to classify.
 */
function pinnedCollectionItem(
  title: string,
  pinnedCollectionType: 'table' | 'media_library' | 'work_documents',
): DocTreeItem {
  return {
    ...noteItem(`/notes/${title}.index.yaml`),
    name: title,
    pinned: true,
    pinnedEntryKind: 'collection',
    pinnedCollectionType,
  } as unknown as DocTreeItem;
}

describe('NotebookTreeRow note icon picker', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setDocumentPropertiesMock.mockClear();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    vi.restoreAllMocks();
  });

  async function mountNote(path = '/notes/a.md') {
    const noop = vi.fn();
    await act(async () => root.render(
      <NotebookTreeRow
        item={noteItem(path)}
        notebookPath="/notes"
        parentPath="/notes"
        depth={0}
        expanded={false}
        active={false}
        selected={false}
        onToggle={noop}
        onOpen={noop}
        onCreateNote={noop}
        onCreateFolder={noop}
        onCreateView={noop}
        onCreateMediaLibrary={noop}
        onRename={noop}
        onPointerDown={noop}
      />,
    ));
    return path;
  }

  it('writes flowix_icon when an icon is picked from the note icon popover', async () => {
    const path = await mountNote();
    const trigger = host.querySelector<HTMLElement>('button[aria-label="document.properties.icon.placeholder"]');
    expect(trigger).not.toBeNull();

    await act(async () => { trigger!.click(); });

    const option = PROPERTY_ICON_OPTIONS[0];
    const optionButton = Array.from(document.body.querySelectorAll<HTMLElement>('button[aria-label]'))
      .find((el) => el.getAttribute('aria-label') === option.label && el !== trigger);
    expect(optionButton).toBeTruthy();

    await act(async () => { optionButton!.click(); });

    expect(setDocumentPropertiesMock).toHaveBeenCalledTimes(1);
    expect(setDocumentPropertiesMock).toHaveBeenCalledWith(path, { flowix_icon: option.value });
  });
});

describe('NotebookTreeRow collection icon', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    collectionSnapshots.clear();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    vi.restoreAllMocks();
  });

  async function mount(item: DocTreeItem) {
    const noop = vi.fn();
    await act(async () => root.render(
      <NotebookTreeRow
        item={item}
        notebookPath="/notes"
        parentPath="/notes"
        depth={0}
        expanded={false}
        active={false}
        selected={false}
        onToggle={noop}
        onOpen={noop}
        onCreateNote={noop}
        onCreateFolder={noop}
        onCreateView={noop}
        onCreateMediaLibrary={noop}
        onRename={noop}
        onPointerDown={noop}
      />,
    ));
  }

  /** The icon the row must reuse, rendered by the same component the tree uses. */
  async function referenceIconMarkup(kind: 'multidimensional-table' | 'media-library' | 'work-documents') {
    const referenceHost = document.createElement('div');
    document.body.append(referenceHost);
    const referenceRoot = createRoot(referenceHost);
    await act(async () => referenceRoot.render(<ContentIcon content={{ kind }} />));
    const markup = referenceHost.querySelector('svg')?.innerHTML ?? '';
    await act(async () => referenceRoot.unmount());
    referenceHost.remove();
    return markup;
  }

  it('pinned collections use the actual view data instead of a stale indexed type', async () => {
    const item = pinnedCollectionItem('素材', 'table');
    collectionSnapshots.set(item.fullPath, { views: [{ domain: 'media' }], properties: {} });
    await mount(item);
    expect(host.innerHTML).toContain(await referenceIconMarkup('media-library'));
  });

  it('pinned collections with an unknown indexed type still use their persisted custom icon', async () => {
    const item = { ...pinnedCollectionItem('自定义', 'table'), pinnedCollectionType: 'hybrid' } as DocTreeItem;
    const icon = PROPERTY_ICON_OPTIONS[0]!;
    collectionSnapshots.set(item.fullPath, { views: [{ domain: 'notes' }], properties: { icon: { type: 'Text', value: icon.value } } });
    await mount(item);
    expect(host.querySelector('img')?.getAttribute('src')).toBe(icon.src);
  });

  it.each(['pinned', 'space'] as const)('%s folder collections keep the folder default and allow persisted custom icons', async (section) => {
    const item = section === 'pinned'
      ? { ...pinnedCollectionItem('项目', 'table'), fullPath: '/notes/项目/.index.yaml' }
      : { ...noteItem('/notes/项目'), type: 'folder' } as DocTreeItem;
    const indexPath = '/notes/项目/.index.yaml';
    const summary = { views: [{ domain: 'notes' }], properties: {} };
    collectionSnapshots.set(indexPath, summary);
    await mount(item);
    const reference = document.createElement('div');
    reference.innerHTML = folderIcon;
    expect(host.innerHTML).toContain(reference.querySelector('svg')!.innerHTML);
    const icon = PROPERTY_ICON_OPTIONS[0]!;
    collectionSnapshots.set(indexPath, { ...summary, properties: { icon: { type: 'Text', value: icon.value } } });
    await mount(item);
    expect(host.querySelector('img')?.getAttribute('src')).toBe(icon.src);
  });

  it.each([
    ['table', '表格2221', 'multidimensional-table'],
    ['media_library', '媒体库121', 'media-library'],
    ['work_documents', '工作文档', 'work-documents'],
  ] as const)('keeps the pinned %s collection icon', async (type, title, iconKind) => {
    await mount(pinnedCollectionItem(title, type));
    const expected = await referenceIconMarkup(iconKind);
    expect(expected.length).toBeGreaterThan(0);
    expect(host.innerHTML).toContain(expected);
  });
});
