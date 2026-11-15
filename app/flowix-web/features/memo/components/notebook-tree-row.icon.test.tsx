import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocTreeItem } from '@platform/tauri/client';

const collectionSnapshots = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@features/collection/use-collection-summary', () => ({
  useCollectionSummary: (path: string) => [collectionSnapshots.get(path) ?? 'missing'],
}));
/**
 * 文件夹图标已从「目录里的 `.index.yaml`」搬到索引库的 `folder_index` 表，
 * 键是笔记本相对目录路径。这个桩只实现行组件用到的那一个入口。
 */
const folderAppearance = vi.hoisted(() => ({ entries: new Map<string, { icon?: { type: string; value: string } }>() }));
vi.mock('@features/collection/folder-appearance', () => ({
  useFolderAppearance: (notebookPath: string | null, folderPath: string | null) => {
    if (!notebookPath || !folderPath) return undefined;
    const prefix = `${notebookPath.replace(/[\\/]+$/, '')}/`;
    const relative = folderPath.startsWith(prefix) ? folderPath.slice(prefix.length) : null;
    return relative === null ? undefined : folderAppearance.entries.get(relative);
  },
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
  ContextMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => <div onClick={onClick}>{children}</div>,
  useContextMenuContext: () => ({ openAt: vi.fn() }),
}));
vi.mock('@features/memo/components/memo-card-actions', () => ({ MemoCardActions: () => null }));
vi.mock('@features/memo/components/notebook-create-context-menu', () => ({ NotebookCreateContextMenuItems: () => null }));
vi.mock('@features/memo/components/notebook-copy-context-menu', () => ({ NotebookCopyContextMenu: () => null }));

import { NotebookTreeRow } from './notebook-tree-row';
import { CollectionIcon } from '@features/collection/public/appearance-api';
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
    folderAppearance.entries.clear();
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

  /** 树行必须与 header / 侧边栏共用同一枚集合默认图标。 */
  async function collectionDefaultMarkup() {
    const referenceHost = document.createElement('div');
    document.body.append(referenceHost);
    const referenceRoot = createRoot(referenceHost);
    await act(async () => referenceRoot.render(<CollectionIcon />));
    const markup = referenceHost.querySelector('svg')?.innerHTML ?? '';
    await act(async () => referenceRoot.unmount());
    referenceHost.remove();
    return markup;
  }

  it.each([
    ['table', '表格2221'],
    ['media_library', '媒体库121'],
    ['work_documents', '工作文档'],
  ] as const)('pinned %s collection renders the shared database icon', async (type, title) => {
    // 集合默认图形已统一为数据库圆柱：视图域（表格 / 媒体库 / 工作文档）不再
    // 换图标，树行也不该回头去读 `.index.yaml` 的视图类型。
    const expected = await collectionDefaultMarkup();
    expect(expected).toContain('<ellipse');
    await mount(pinnedCollectionItem(title, type));
    expect(host.innerHTML).toContain(expected);
  });

  it('pinned collections prefer their persisted custom icon', async () => {
    const item = pinnedCollectionItem('自定义', 'table');
    const icon = PROPERTY_ICON_OPTIONS[0]!;
    collectionSnapshots.set(item.fullPath, { views: [{ domain: 'notes' }], properties: { icon: { type: 'Text', value: icon.value } } });
    await mount(item);
    expect(host.querySelector('img')?.getAttribute('src')).toBe(icon.src);
  });

  it('folder rows keep the folder default and read custom icons from folder_index', async () => {
    const item = { ...noteItem('/notes/项目'), type: 'folder' } as DocTreeItem;
    await mount(item);
    const reference = document.createElement('div');
    reference.innerHTML = folderIcon;
    expect(host.innerHTML).toContain(reference.querySelector('svg')!.innerHTML);

    const icon = PROPERTY_ICON_OPTIONS[0]!;
    folderAppearance.entries.set('项目', { icon: { type: 'Text', value: icon.value } });
    await mount(item);
    expect(host.querySelector('img')?.getAttribute('src')).toBe(icon.src);
  });

  it('folder rows no longer read a stale .index.yaml appearance', async () => {
    const item = { ...noteItem('/notes/项目'), type: 'folder' } as DocTreeItem;
    const icon = PROPERTY_ICON_OPTIONS[0]!;
    collectionSnapshots.set('/notes/项目/.index.yaml', { views: [{ domain: 'notes' }], properties: { icon: { type: 'Text', value: icon.value } } });
    await mount(item);
    expect(host.querySelector('img')).toBeNull();
  });
});

/**
 * 重命名态没有展开按钮 (普通态那个 20px 的 chevron 容器), 图标槽必须自己保持
 * 同样的宽度, 否则进入重命名时图标左移 1px、输入框左移 2px。
 */
describe('NotebookTreeRow rename icon slot', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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

  async function renameAndReadIconSlot(item: DocTreeItem) {
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
    const renameEntry = Array.from(host.querySelectorAll<HTMLElement>('div'))
      .find((el) => el.textContent === 'memo.fileTree.rename');
    expect(renameEntry).toBeTruthy();
    await act(async () => { renameEntry!.click(); });
    const input = host.querySelector<HTMLInputElement>('input');
    expect(input).not.toBeNull();
    return input!.previousElementSibling as HTMLElement;
  }

  it('keeps the folder icon slot as wide as the expand button it replaces', async () => {
    const slot = await renameAndReadIconSlot({ ...noteItem('/notes/项目'), type: 'folder' } as DocTreeItem);
    expect(slot.className).toContain('h-5 w-5');
  });

  it('keeps the file icon slot at the shared 18px', async () => {
    const slot = await renameAndReadIconSlot(noteItem('/notes/a.md'));
    expect(slot.className).toContain('h-[18px] w-[18px]');
  });
});
