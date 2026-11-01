import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { files } from '@platform/tauri/client';
import { toast } from '@/lib/toast';
import { useCollectionIdentityRepair } from './use-collection-identity-repair';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@platform/tauri/client', () => ({ files: { makeViewDocumentIdentityUnique: vi.fn() } }));

let host: HTMLDivElement;
let root: Root;
let identityByPath: ReturnType<typeof useCollectionIdentityRepair>;
const refresh = vi.fn(async () => {});
const updateIdentity = vi.fn();
const path = '/notes/test.table.yml';
type Options = Parameters<typeof useCollectionIdentityRepair>[0];
let harnessOptions: Partial<Options> = {};

function Harness() {
  identityByPath = useCollectionIdentityRepair({
    kind: 'table',
    notebookId: 'nb',
    itemsByPath: new Map([[path, { relativePath: 'test.table.yml', identityConflict: true }]]),
    refresh,
    updateIdentity,
    ...harnessOptions,
  });
  return null;
}

async function render(overrides: Partial<Options> = {}) {
  harnessOptions = overrides;
  await act(async () => root.render(<Harness />));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(files.makeViewDocumentIdentityUnique).mockResolvedValue('unique');
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(async () => { await act(async () => root.unmount()); });

describe('collection identity repair', () => {
  it('exposes the conflict flag and regenerates a unique identity', async () => {
    await render();
    const entry = identityByPath.get(path)!;
    expect(entry.identityConflict).toBe(true);
    await act(async () => entry.onMakeIdentityUnique!());
    expect(files.makeViewDocumentIdentityUnique).toHaveBeenCalledWith('nb', 'test.table.yml');
    expect(updateIdentity).toHaveBeenCalledWith('test.table.yml', 'unique');
    expect(refresh).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledWith('multidimensionalTable.identityRegenerated');
  });

  it('keeps successful identity repair when the following catalog refresh fails', async () => {
    refresh.mockRejectedValueOnce(new Error('refresh failed'));
    await render({ kind: 'media-library' });
    await act(async () => identityByPath.get(path)!.onMakeIdentityUnique!());
    expect(updateIdentity).toHaveBeenCalledWith('test.table.yml', 'unique');
    expect(toast.success).toHaveBeenCalledWith('mediaLibrary.identityRegenerated');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('reports the failure and skips the catalog refresh when the identity call fails', async () => {
    vi.mocked(files.makeViewDocumentIdentityUnique).mockRejectedValue(new Error('conflict'));
    await render();
    await act(async () => identityByPath.get(path)!.onMakeIdentityUnique!());
    expect(updateIdentity).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('multidimensionalTable.identityRegenerateFailed');
  });
});
