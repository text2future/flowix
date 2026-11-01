import { act, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CollectionNoteFilterSlot } from '@shared/ui/collection-note-filter-slot';
import { NoteFilterMenu } from '@features/collection/public/note-filter-menu';
import { useDatasetFilter } from './use-dataset-filter';

it('expands note conditions inside the asset dataset menu without forwarding to another panel', async () => {
  const forward = vi.fn();
  function AssetMenu() {
    const filter = useDatasetFilter({ condition: {}, notebookPath: '', onChange: async () => true });
    return filter.renderMenu({ title: '资料筛选', set: '已设置', empty: '未设置', label: '数据集合',
      otherFilter: { label: '笔记筛选', onSelect: forward } });
  }
  function Harness() {
    const [target, setTarget] = useState<HTMLDivElement | null>(null);
    return <CollectionNoteFilterSlot.Provider value={{ target, setTarget }}>
      <AssetMenu />
      {target && createPortal(<NoteFilterMenu filterOnly embedded saving={false}
        t={(key) => key} onSave={async () => true} filterLabel="笔记筛选" />, target)}
    </CollectionNoteFilterSlot.Provider>;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="数据集合"]')!.click());
    const note = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('笔记筛选'))!;
    await act(async () => note.click());
    expect(forward).not.toHaveBeenCalled();
    expect(document.body.contains(note)).toBe(true);
    expect(document.body.textContent).toContain('资料筛选');
    expect(document.body.textContent).toContain('multidimensionalTable.autoCollect.properties');
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
