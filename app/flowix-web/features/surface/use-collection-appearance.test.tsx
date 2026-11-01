import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FolderCollectionSummary } from '@features/collection/public/folder-api';

const api = vi.hoisted(() => ({
  ensureFolderCollection: vi.fn(),
  updateCollectionProperties: vi.fn(),
  resolveCollectionScope: vi.fn(() => ({ relativePath: '客户周报', depth: 'direct_children' as const })),
}));

vi.mock('@features/collection/public/folder-api', () => ({
  ensureFolderCollection: api.ensureFolderCollection,
  updateCollectionProperties: api.updateCollectionProperties,
  resolveCollectionScope: api.resolveCollectionScope,
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

import { useCollectionAppearance } from './use-collection-appearance';

const created = {
  source: '', formatVersion: 3 as const, fileTree: true,
  domains: ['notes' as const], views: [], defaultByDomain: {}, sources: {},
  collectionId: 'folder-collection', revision: 0, properties: {},
};

function AppearanceProbe({ setSummary, existing = null }: { existing?: FolderCollectionSummary | null; setSummary: (value: FolderCollectionSummary) => void }) {
  const appearance = useCollectionAppearance({
    existing,
    indexPath: '/book/客户周报/.index.yaml',
    notebookPath: '/book',
    notebookId: 'book',
    isFolderCollection: true,
    currentFolderPath: '/book/客户周报',
    folderName: '客户周报',
    editable: true,
    setSummary,
  });
  return <>
    <span data-testid="icon">{appearance.icon.value}</span>
    <button data-save-icon onClick={() => appearance.icon.save('custom-icon')}>save icon</button>
    <button data-reset-icon onClick={() => appearance.icon.save('')}>reset icon</button>
    <span data-testid="visible">{String(appearance.banner.visible)}</span>
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
});

describe('useCollectionAppearance', () => {
  it('reads the persisted icon and saves or resets it in collection properties', async () => {
    const saved = { ...created, properties: { icon: { type: 'Text' as const, value: 'saved-icon' } } };
    api.updateCollectionProperties.mockResolvedValue(saved);
    host = document.createElement('div');
    root = createRoot(host);
    const setSummary = vi.fn();
    await act(async () => root?.render(<AppearanceProbe existing={saved} setSummary={setSummary} />));
    expect(host.querySelector('[data-testid="icon"]')?.textContent).toBe('saved-icon');
    await act(async () => host?.querySelector<HTMLButtonElement>('[data-save-icon]')?.click());
    expect(api.updateCollectionProperties).toHaveBeenLastCalledWith(expect.objectContaining({
      properties: { icon: { type: 'Text', value: 'custom-icon' } },
    }));
    await act(async () => host?.querySelector<HTMLButtonElement>('[data-reset-icon]')?.click());
    expect(api.updateCollectionProperties).toHaveBeenLastCalledWith(expect.objectContaining({ properties: { icon: null } }));
    expect(api.ensureFolderCollection).not.toHaveBeenCalled();
  });

  it('explicitly enables the banner from its hidden default', async () => {
    api.ensureFolderCollection.mockResolvedValue(created);
    api.updateCollectionProperties.mockResolvedValue(created);
    host = document.createElement('div');
    root = createRoot(host);
    await act(async () => root?.render(<AppearanceProbe setSummary={vi.fn()} />));
    await act(async () => { host?.querySelector<HTMLButtonElement>('[data-toggle]')?.click(); });
    expect(api.updateCollectionProperties).toHaveBeenCalledWith(expect.objectContaining({
      properties: { banner_hidden: { type: 'Boolean', value: false } },
    }));
  });

  it('keeps a folder-scoped image source and creates the folder collection when its first banner is selected', async () => {
    api.ensureFolderCollection.mockResolvedValue(created);
    api.updateCollectionProperties.mockResolvedValue({
      ...created,
      revision: 1,
      properties: { banner_image: { type: 'Text', value: 'https://example.test/banner.jpg' } },
    });
    const setSummary = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root?.render(<AppearanceProbe setSummary={setSummary} />));

    expect(host.querySelector('[data-testid="selected-image"]')?.textContent).toBe('');
    expect(host.querySelector('[data-testid="visible"]')?.textContent).toBe('false');
    expect(api.resolveCollectionScope).toHaveBeenCalledWith(
      { scope: 'containing_folder', depth: 'direct_children' },
      '/book/客户周报/.index.yaml',
      '/book',
    );

    await act(async () => {
      [...host!.querySelectorAll('button')].find((button) => button.textContent === 'select')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.ensureFolderCollection).toHaveBeenCalledWith('/book/客户周报', '/book', '客户周报', 'notes');
    expect(api.updateCollectionProperties).toHaveBeenCalledWith(expect.objectContaining({
      notebookId: 'book',
      notebookPath: '/book',
      collectionId: 'folder-collection',
      expectedRevision: 0,
      properties: { banner_image: { type: 'Text', value: 'https://example.test/banner.jpg' } },
    }));
    expect(setSummary).toHaveBeenCalledTimes(2);
  });
});
