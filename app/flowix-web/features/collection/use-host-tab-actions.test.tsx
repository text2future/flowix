import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { toast } from '@/lib/toast';
import type { CollectionHostTab } from './collection-host-tab';
import { useHostTabActions } from './use-host-tab-actions';
import { useTabInlineEdit, type TabInlineEdit } from './use-tab-inline-edit';

vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

const mediaTab: CollectionHostTab = {
  key: 'media:v1', label: '图墙', placement: 'after', removable: true, domain: 'media', viewId: 'v1',
};

interface Snapshot {
  edit: TabInlineEdit;
  actions: ReturnType<typeof useHostTabActions>;
}

async function mount(options: {
  renameHostTab?: (key: string, name: string) => void;
  removeHostTab?: (key: string) => void;
  editable?: boolean;
  saving?: boolean;
} = {}) {
  const latest: { current: Snapshot | null } = { current: null };
  function Probe() {
    const edit = useTabInlineEdit();
    const actions = useHostTabActions({
      edit,
      renameHostTab: options.renameHostTab,
      removeHostTab: options.removeHostTab,
      editable: options.editable ?? true,
      saving: options.saving ?? false,
    });
    latest.current = { edit, actions };
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Probe />));
  return {
    read: () => latest.current as Snapshot,
    unmount: async () => { await act(async () => root.unmount()); },
  };
}

it('双击改名：编辑态挂在 host: 前缀的 id 上，宽度取原 tab 宽（下限 40）', async () => {
  const view = await mount();
  try {
    await act(async () => view.read().actions.beginRenameHostTab(mediaTab, 96));
    expect(view.read().edit.editingId).toBe('host:media:v1');
    expect(view.read().edit.name).toBe('图墙');
    expect(view.read().edit.width).toBe(96);

    await act(async () => view.read().actions.beginRenameHostTab(mediaTab, 12));
    expect(view.read().edit.width).toBe(40);

    // 双击不传宽度时用默认宽（右键路径会先量好再传）。
    await act(async () => view.read().actions.beginRenameHostTab(mediaTab));
    expect(view.read().edit.width).toBe(48);
  } finally { await view.unmount(); }
});

it('提交改名：空名报错且不落盘，有效名去空格后交给外壳', async () => {
  const renameHostTab = vi.fn();
  const view = await mount({ renameHostTab });
  try {
    await act(async () => view.read().actions.beginRenameHostTab(mediaTab, 80));
    await act(async () => view.read().actions.commitHostTabRename(mediaTab.key, '   '));
    expect(toast.error).toHaveBeenCalled();
    expect(renameHostTab).not.toHaveBeenCalled();
    // 空名也要收起输入框，否则用户卡在编辑态里。
    expect(view.read().edit.editingId).toBeNull();

    await act(async () => view.read().actions.beginRenameHostTab(mediaTab, 80));
    await act(async () => view.read().actions.commitHostTabRename(mediaTab.key, '  项目图墙  '));
    expect(renameHostTab).toHaveBeenCalledWith('media:v1', '项目图墙');
    expect(view.read().edit.editingId).toBeNull();
  } finally { await view.unmount(); }
});

it('删除要先确认：只读或保存中不入队，确认后才交给外壳移除', async () => {
  const removeHostTab = vi.fn();
  const readOnly = await mount({ removeHostTab, editable: false });
  try {
    await act(async () => readOnly.read().actions.requestDeleteHostTab(mediaTab));
    expect(readOnly.read().actions.hostTabPendingDelete).toBeNull();
  } finally { await readOnly.unmount(); }

  const busy = await mount({ removeHostTab, saving: true });
  try {
    await act(async () => busy.read().actions.requestDeleteHostTab(mediaTab));
    expect(busy.read().actions.hostTabPendingDelete).toBeNull();
  } finally { await busy.unmount(); }

  const view = await mount({ removeHostTab });
  try {
    await act(async () => view.read().actions.requestDeleteHostTab(mediaTab));
    // 待删对象带上 tab 全量字段（确认弹窗只读 label），与搬走前的行为一致。
    expect(view.read().actions.hostTabPendingDelete).toMatchObject({ key: 'media:v1', label: '图墙' });
    // 取消不触发移除。
    await act(async () => view.read().actions.cancelDeleteHostTab());
    expect(view.read().actions.hostTabPendingDelete).toBeNull();
    expect(removeHostTab).not.toHaveBeenCalled();

    await act(async () => view.read().actions.requestDeleteHostTab(mediaTab));
    await act(async () => view.read().actions.confirmDeleteHostTab());
    expect(removeHostTab).toHaveBeenCalledWith('media:v1');
    expect(view.read().actions.hostTabPendingDelete).toBeNull();
  } finally { await view.unmount(); }
});

it('一条 tab 条只有一个输入框：后开的编辑顶掉前一个', async () => {
  const view = await mount();
  try {
    await act(async () => view.read().edit.begin('view-a', '表格'));
    expect(view.read().edit.editingId).toBe('view-a');

    await act(async () => view.read().actions.beginRenameHostTab(mediaTab, 80));
    expect(view.read().edit.editingId).toBe('host:media:v1');
    expect(view.read().edit.name).toBe('图墙');

    await act(async () => view.read().edit.begin('view-b', '画廊'));
    expect(view.read().edit.editingId).toBe('view-b');
    expect(view.read().edit.name).toBe('画廊');
  } finally { await view.unmount(); }
});
