import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { AssetFilterCondition } from '@features/collection/public/folder-api';
import { useDatasetFilter, type DatasetFilterController } from './use-dataset-filter';

vi.mock('@features/media-library/public/surface-api', () => ({
  MediaLibraryFilterPanel: ({ onFileNameChange, onApply, onPathSelected }: {
    onFileNameChange: (name: string) => void; onApply: () => void; onPathSelected: (path: string | null) => Promise<boolean>;
  }) => <><button data-edit onClick={() => onFileNameChange('图片')}>编辑</button><button data-apply onClick={onApply}>应用</button><button data-location onClick={() => { void onPathSelected(null); }}>全部位置</button></>,
}));

it.each(['apply', 'dismiss'] as const)('%s saves secondary drafts with the latest location and no location update intent', async (action) => {
  const onChange = vi.fn(async () => true);
  let filter!: DatasetFilterController;
  function Harness({ condition }: { condition: AssetFilterCondition }) {
    filter = useDatasetFilter({ condition, notebookPath: '/book', onChange });
    return filter.open ? filter.renderPanel(false) : null;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness condition={{ path_contains: '旧位置' }} />));
    await act(async () => filter.onMenuOpenChange(true));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-edit]')!.click());
    await act(async () => root.render(<Harness condition={{ path_contains: '新位置' }} />));
    await act(async () => {
      if (action === 'apply') host.querySelector<HTMLButtonElement>('[data-apply]')!.click();
      else filter.onMenuOpenChange(false);
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(
      { file_name_contains: '图片', path_contains: '新位置' }, { updateLocation: false });
    expect(filter.open).toBe(false);
  } finally { await act(async () => root.unmount()); }
});


it('explicit location selection carries update intent even without secondary changes', async () => {
  const onChange = vi.fn(async () => true);
  function Harness() {
    const filter = useDatasetFilter({ condition: { path_contains: '项目' }, notebookPath: '/book', onChange });
    return filter.renderPanel(true);
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-location]')!.click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ path_scope: 'all' }, { updateLocation: true });
  } finally { await act(async () => root.unmount()); }
});
