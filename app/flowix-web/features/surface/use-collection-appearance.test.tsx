import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectionProperty, FolderCollectionSummary } from '@features/collection/public/folder-api';

const api = vi.hoisted(() => ({
  updateCollectionProperties: vi.fn(),
  resolveCollectionScope: vi.fn(() => ({ relativePath: '客户周报', depth: 'descendants' as const })),
  useFolderAppearance: vi.fn(),
  saveFolderAppearance: vi.fn(),
}));

vi.mock('@features/collection/public/folder-api', () => ({
  updateCollectionProperties: api.updateCollectionProperties,
  resolveCollectionScope: api.resolveCollectionScope,
}));
/** 文件夹外观现在住在 `folder_index` 表里，与集合文件属性是两条互不相干的写路径。 */
vi.mock('@features/collection/folder-appearance', () => ({
  useFolderAppearance: api.useFolderAppearance,
  saveFolderAppearance: api.saveFolderAppearance,
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

import { useCollectionAppearance } from './use-collection-appearance';

const created = {
  source: '', formatVersion: 3 as const, fileTree: true,
  domains: ['notes' as const], views: [], defaultByDomain: {}, sources: {},
  collectionId: 'folder-collection', revision: 0, properties: {},
};

function AppearanceProbe({ setSummary, existing = null, folderOnly = true }: {
  existing?: FolderCollectionSummary | null;
  setSummary: (value: FolderCollectionSummary) => void;
  folderOnly?: boolean;
}) {
  const appearance = useCollectionAppearance({
    existing,
    indexPath: '/book/客户周报/.index.yaml',
    notebookPath: '/book',
    notebookId: 'book',
    isFolderCollection: true,
    currentFolderPath: '/book/客户周报',
    editable: true,
    setSummary,
    folderOnly,
  });
  return <>
    <span data-testid="icon">{appearance.icon.value}</span>
    <button data-save-icon onClick={() => appearance.icon.save('custom-icon')}>save icon</button>
    <button data-reset-icon onClick={() => appearance.icon.save('')}>reset icon</button>
    <span data-testid="visible">{String(appearance.banner.visible)}</span>
    <span data-testid="scope">{`${appearance.banner.scope?.relativePath ?? ''}:${appearance.banner.scope?.depth ?? ''}`}</span>
    <button data-toggle onClick={appearance.banner.toggleHidden}>toggle</button>
    <span data-testid="selected-image">{appearance.banner.selectedImage}</span>
    <button onClick={() => appearance.banner.selectImage('https://example.test/banner.jpg')}>select</button>
  </>;
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
  vi.clearAllMocks();
  api.useFolderAppearance.mockReturnValue(undefined);
});

function mount(element: ReactNode) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  return act(async () => root?.render(element));
}

describe('useCollectionAppearance', () => {
  it('文件夹读 folder_index 的图标，写回同一张表，不碰集合属性', async () => {
    api.useFolderAppearance.mockReturnValue({ icon: { type: 'Text', value: 'saved-icon' } } as Record<string, CollectionProperty>);
    api.saveFolderAppearance.mockResolvedValue({});
    await mount(<AppearanceProbe setSummary={vi.fn()} />);

    expect(host!.querySelector('[data-testid="icon"]')?.textContent).toBe('saved-icon');
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-save-icon]')?.click());
    expect(api.saveFolderAppearance).toHaveBeenLastCalledWith('/book', '客户周报', {
      icon: { type: 'Text', value: 'custom-icon' },
    });
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-reset-icon]')?.click());
    expect(api.saveFolderAppearance).toHaveBeenLastCalledWith('/book', '客户周报', { icon: null });
    expect(api.updateCollectionProperties).not.toHaveBeenCalled();
  });

  it('文件夹头图按目录取图，默认隐藏，开启时写 banner_hidden', async () => {
    api.saveFolderAppearance.mockResolvedValue({});
    await mount(<AppearanceProbe setSummary={vi.fn()} />);

    expect(host!.querySelector('[data-testid="scope"]')?.textContent).toBe('客户周报:descendants');
    expect(host!.querySelector('[data-testid="visible"]')?.textContent).toBe('false');

    await act(async () => host!.querySelector<HTMLButtonElement>('[data-toggle]')?.click());
    expect(api.saveFolderAppearance).toHaveBeenCalledWith('/book', '客户周报', {
      banner_hidden: { type: 'Boolean', value: false },
    });
    // 文件夹没有媒体域，头图范围不走集合的 dataset.source 换算。
    expect(api.resolveCollectionScope).not.toHaveBeenCalled();
  });

  it('文件夹选头图直接写表，不会为了存外观创建集合文件', async () => {
    api.saveFolderAppearance.mockResolvedValue({});
    await mount(<AppearanceProbe setSummary={vi.fn()} />);

    expect(host!.querySelector('[data-testid="selected-image"]')?.textContent).toBe('');
    await act(async () => {
      [...host!.querySelectorAll('button')].find((button) => button.textContent === 'select')?.click();
      await Promise.resolve();
    });

    expect(api.saveFolderAppearance).toHaveBeenCalledWith('/book', '客户周报', {
      banner_image: { type: 'Text', value: 'https://example.test/banner.jpg' },
    });
    expect(api.updateCollectionProperties).not.toHaveBeenCalled();
  });

  it('集合文件仍走集合属性（图标 / 头图同源）', async () => {
    const saved: FolderCollectionSummary = {
      ...created,
      properties: { icon: { type: 'Text', value: 'saved-icon' } },
    };
    api.updateCollectionProperties.mockResolvedValue(saved);
    const setSummary = vi.fn();
    await mount(<AppearanceProbe existing={saved} folderOnly={false} setSummary={setSummary} />);

    expect(host!.querySelector('[data-testid="icon"]')?.textContent).toBe('saved-icon');
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-save-icon]')?.click());

    expect(api.updateCollectionProperties).toHaveBeenLastCalledWith(expect.objectContaining({
      notebookId: 'book',
      notebookPath: '/book',
      collectionId: 'folder-collection',
      expectedRevision: 0,
      properties: { icon: { type: 'Text', value: 'custom-icon' } },
    }));
    expect(api.saveFolderAppearance).not.toHaveBeenCalled();
  });
});
