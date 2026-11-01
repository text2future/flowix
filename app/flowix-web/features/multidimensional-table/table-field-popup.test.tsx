import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { TableDatasetMenu } from './table-dataset-menu';
import { TableFieldHeader } from './table-field-header';
import type { TableField } from './model';

it('keeps note and asset filters together before field actions in the dataset menu', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<TableDatasetMenu open saving={false}
      t={(key) => key} onSave={async () => true} filterLabel="笔记筛选"
      assetFilter={<button type="button">资料筛选</button>}>
      <button type="button">展示字段</button>
    </TableDatasetMenu>));
    const asset = [...document.querySelectorAll('button')].find((button) => button.textContent === '资料筛选')!;
    const menu = asset.parentElement!;
    const rows = [...menu.children];
    expect(rows[0]?.textContent).toContain('multidimensionalTable.autoCollect.browseAndSave');
    expect(rows[1]?.textContent).toContain('笔记筛选');
    expect(rows[2]).toBe(asset);
    expect(rows[3]?.getAttribute('role')).toBe('separator');
    expect(rows[4]?.textContent).toBe('展示字段');
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(1);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it.each((['Select', 'MultiSelect'] as const).flatMap((type) =>
  (['outside', 'parent'] as const).map((close) => ({ type, close })),
))('saves reordered $type options when real nested popovers close via $close', async ({ type, close }) => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const first = { id: `opt_${'b'.repeat(32)}`, label: 'First' };
  const second = { id: `opt_${'c'.repeat(32)}`, label: 'Second' };
  const onSave = vi.fn(async (_options: TableField['options']) => true);
  function Harness() {
    const [datasetOpen, setDatasetOpen] = useState(true);
    const [fieldOpen, setFieldOpen] = useState(true);
    const [field, setField] = useState<TableField>({ id: `fld_${'a'.repeat(32)}`, property_key: 'status', type, options: [first, second] });
    return <><button type="button" onClick={() => setDatasetOpen(false)}>关闭数据集</button>
    <TableDatasetMenu defaultFieldId={field.id} fields={[{ id: field.id, label: 'Status' }]}
      saving={false} t={(key) => key} onSave={async () => true}
      open={datasetOpen} onOpenChange={setDatasetOpen} ignoreOutside={fieldOpen}>
      <TableFieldHeader field={field} label="Status" compact saving={false} open={fieldOpen}
        onOpenChange={setFieldOpen} typeChoices={[]} customPresets={[]} systemPresets={[]}
        t={(key) => key} typeLabel={(kind) => kind} typeIconKind={() => 'text'}
        onSaveEdits={async (_field, _name, options) => {
          await onSave(options);
          setField((current) => ({ ...current, options }));
          return true;
        }} onChangeType={async () => true} onApplyPreset={async () => true}
        onDelete={async () => true} onManagePresets={() => {}} />
    </TableDatasetMenu></>;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const pointer = (target: EventTarget, eventType: string, y: number) => {
    const event = new Event(eventType, { bubbles: true });
    Object.defineProperties(event, { pointerId: { value: 1 }, button: { value: 0 }, clientX: { value: 10 }, clientY: { value: y } });
    target.dispatchEvent(event);
  };
  try {
    await act(async () => root.render(<Harness />));
    const handle = document.querySelector<HTMLButtonElement>('button[aria-label="拖动调整选项顺序 Second"]')!;
    const list = handle.closest('[data-field-id]')!.parentElement!;
    list.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 64 }) as DOMRect;
    for (const item of list.querySelectorAll<HTMLElement>('[data-field-id]')) {
      item.getBoundingClientRect = () => ({ top: [...list.children].indexOf(item) * 32, height: 32 }) as DOMRect;
    }
    await act(async () => pointer(handle, 'pointerdown', 48));
    await act(async () => pointer(window, 'pointermove', 4));
    await act(async () => pointer(window, 'pointerup', 4));
    expect([...list.querySelectorAll('input')].map((input) => input.value)).toEqual(['Second', 'First']);
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => {
      if (close === 'outside') pointer(document.body, 'pointerdown', 150);
      else container.querySelector<HTMLButtonElement>('button')!.click();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith([second, first]);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="管理数据集"]')!.click());
    if (close === 'outside') {
      await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="编辑属性 Status"]')!.click());
    }
    const reopened = document.querySelector<HTMLInputElement>('input[aria-label="选项 1"]');
    expect(reopened?.value).toBe('Second');
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
