import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CollectionViewMenu } from './collection-view-menu';
import type { CollectionHostTabsState } from './use-collection-surface-state';

let root: Root;
let node: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); node?.remove(); });
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
  .find((item) => item.getAttribute('aria-label') === label || item.textContent === label)!;
async function mount(options: Partial<Parameters<typeof CollectionViewMenu>[0]> = {}) {
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  const renameTab = vi.fn(); const onRequestDelete = vi.fn(); const onAddNoteView = vi.fn();
  const tabs = { list: [{ key: 'files', label: '文件树', placement: 'before' },
    { key: 'media:m1', label: '图墙', placement: 'after', removable: true, viewId: 'm1' }],
    renameTab, addAssetView: vi.fn() } as unknown as CollectionHostTabsState;
  await act(async () => root.render(<CollectionViewMenu tabs={tabs} editable bannerVisible
    onToggleBanner={() => {}} titleVisible onToggleTitle={() => {}}
    onRequestDelete={onRequestDelete} onAddNoteView={onAddNoteView}
    onCommitHostTabRename={renameTab} {...options} />));
  await act(async () => button('显示设置').click());
  return { renameTab, onRequestDelete, onAddNoteView };
}
it('复用原按钮和弹层样式，管理视图支持返回、改名及删除确认请求', async () => {
  const { renameTab, onRequestDelete } = await mount();
  expect(button('显示设置').className).toContain('p-1.5');
  const popup = button('管理视图').closest('[data-slot="popover-content"]') ?? button('管理视图').parentElement?.parentElement;
  expect(popup?.className).toContain('rounded-xl');
  expect(popup?.className).toContain('shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]');
  await act(async () => button('管理视图').click());
  expect(document.body.textContent).toContain('固定');
  await act(async () => button('重命名视图：图墙').click());
  const input = document.querySelector<HTMLInputElement>('input[aria-label="重命名视图：图墙"]')!;
  expect(document.activeElement).toBe(input);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '图片');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('保存').click());
  expect(renameTab).toHaveBeenCalledWith('media:m1', '图片');
  await act(async () => button('返回视图类型').click());
  expect(button('表格')).toBeDefined();
  await act(async () => button('管理视图').click());
  await act(async () => button('移除 tab：图墙').click());
  expect(onRequestDelete).toHaveBeenCalledWith(expect.objectContaining({ key: 'media:m1', label: '图墙' }));
  expect(button('管理视图')).toBeUndefined();
});
it('日历与看板保留字段选择步骤，返回不创建视图', async () => {
  const { onAddNoteView } = await mount();
  await act(async () => button('日历').click());
  expect(onAddNoteView).not.toHaveBeenCalled();
  expect(button('日期')).toBeDefined();
  await act(async () => button('返回视图类型').click());
  await act(async () => button('看板').click());
  expect(onAddNoteView).not.toHaveBeenCalled();
  await act(async () => button('状态').click());
  expect(onAddNoteView).toHaveBeenCalledWith('kanban', undefined);
});

it('笔记与资料共用管理菜单；最后一个笔记视图可以改名但不能删除', async () => {
  await mount({ noteViews: [{ id: 'n1', name: '表格' }] });
  await act(async () => button('管理视图').click());
  expect(button('重命名视图：表格').disabled).toBe(false);
  expect(button('移除 tab：表格').disabled).toBe(true);
  expect(button('移除 tab：图墙').disabled).toBe(false);
});
