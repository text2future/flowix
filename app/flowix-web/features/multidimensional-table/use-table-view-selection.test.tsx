import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { addTableView, createTableDocument, type MultidimensionalTableDocument } from './model';
import { useTableViewSelection } from './use-table-view-selection';

it('restores embedded selection without writing, persists explicit switches, and allows read-only fallback', async () => {
  const original = createTableDocument();
  const added = addTableView(original, 'gallery');
  const save = vi.fn(async (_document: MultidimensionalTableDocument) => true);
  const onChange = vi.fn();
  let selection!: ReturnType<typeof useTableViewSelection>;
  function Probe({ preferred, editable = true }: { preferred?: string; editable?: boolean }) {
    selection = useTableViewSelection({ document: added.document, initialViewId: preferred, editable, saving: false, save, onActiveViewChange: onChange });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe preferred={original.views.default_id} />));
    expect(selection.activeView?.id).toBe(original.views.default_id);
    expect(save).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => { await selection.selectView(added.view.id); });
    expect(onChange).toHaveBeenLastCalledWith(added.view.id);
    expect(save).not.toHaveBeenCalled(); // Already the file's remembered view.
    await act(async () => { await selection.selectView(original.views.default_id); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].views.default_id).toBe(original.views.default_id);
    await act(async () => root.render(<Probe preferred="missing-reference" editable={false} />));
    expect(selection.activeView?.id).toBe(added.view.id);
    save.mockClear(); onChange.mockClear();
    await act(async () => { await selection.selectView(original.views.default_id); });
    expect(selection.activeView?.id).toBe(original.views.default_id);
    expect(save).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); }
});

it('keeps a local selection after a write failure and blocks overlapping selection writes', async () => {
  const original = createTableDocument();
  const added = addTableView(original, 'gallery');
  let finish!: (saved: boolean) => void;
  const save = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  let selection!: ReturnType<typeof useTableViewSelection>;
  function Probe() {
    selection = useTableViewSelection({ document: added.document, editable: true, saving: false, save });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />));
    let pending!: Promise<void>;
    act(() => { pending = selection.selectView(original.views.default_id); });
    await act(async () => { await selection.selectView(added.view.id); });
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => { finish(false); await pending; });
    expect(selection.activeView?.id).toBe(original.views.default_id);
    expect(added.document.views.default_id).toBe(added.view.id);
  } finally { act(() => root.unmount()); }
});

it('adopts an externally requested view once its content arrives', async () => {
  const original = createTableDocument();
  const added = addTableView(original, 'calendar');
  // 磁盘上文件的「记住的视图」仍是原来那个表格视图：内容迟到时先落回它。
  const arriving: MultidimensionalTableDocument = {
    ...added.document,
    views: { ...added.document.views, default_id: original.views.default_id },
  };
  let selection!: ReturnType<typeof useTableViewSelection>;
  function Probe({ doc }: { doc: MultidimensionalTableDocument }) {
    selection = useTableViewSelection({ document: doc, initialViewId: added.view.id, editable: true, saving: false, save: async () => true });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe doc={original} />));
    expect(selection.activeView?.id).toBe(original.views.default_id);
    await act(async () => root.render(<Probe doc={arriving} />));
    expect(selection.activeView?.id).toBe(added.view.id);
  } finally { act(() => root.unmount()); }
});
