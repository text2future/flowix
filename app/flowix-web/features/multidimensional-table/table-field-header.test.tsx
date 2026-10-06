import * as React from 'react';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TableAutoCollectCondition, TableField, TableFieldOption, TableFieldType } from './model';

vi.mock('@shared/ui/popover', async () => {
  const ReactModule = await import('react');
  const Context = ReactModule.createContext<{ open: boolean; onOpenChange: (open: boolean) => void } | null>(null);
  return {
    Popover: ({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: React.ReactNode }) => (
      <Context.Provider value={{ open, onOpenChange }}>{children}</Context.Provider>
    ),
    PopoverTrigger: ({ children }: { children: React.ReactElement<{ onClick?: (event: React.MouseEvent) => void }> }) => {
      const state = ReactModule.useContext(Context);
      return ReactModule.cloneElement(children, {
        onClick: (event) => {
          children.props.onClick?.(event);
          state?.onOpenChange(!state.open);
        },
      });
    },
    PopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('@shared/ui/select', () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (value: string) => void; children: React.ReactNode }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>{children}</select>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => <option value={value}>{children}</option>,
  SelectValue: () => null,
}));

import { TableFieldHeader } from './table-field-header';

const field: TableField = { id: `fld_${'a'.repeat(32)}`, type: 'Text', property_key: 'title' };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function HeaderHarness({
  field: currentField = field,
  label = 'Title',
  typeChoices = [],
  conditionOnly = false,
  showAutoCollect = conditionOnly,
  onSaveEdits,
  onChangeType,
  onSaveAutoCollect,
}: {
  field?: TableField;
  label?: string;
  typeChoices?: TableFieldType[];
  conditionOnly?: boolean;
  showAutoCollect?: boolean;
  onSaveEdits: (field: TableField, name: string, options: TableFieldOption[]) => Promise<boolean>;
  onChangeType?: (field: TableField, type: TableFieldType, options: TableFieldOption[]) => Promise<boolean>;
  onSaveAutoCollect: (field: TableField, condition: TableAutoCollectCondition) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  return <table><thead><tr><th><TableFieldHeader
    field={currentField}
    label={label}
    conditionOnly={conditionOnly}
    showAutoCollect={showAutoCollect}
    saving={false}
    open={open}
    typeChoices={typeChoices}
    customPresets={[]}
    systemPresets={[]}
    t={(key) => key}
    typeLabel={(type) => type}
    typeIconKind={() => 'text'}
    onOpenChange={setOpen}
    onSaveEdits={onSaveEdits}
    onChangeType={onChangeType ?? vi.fn(async () => true)}
    onApplyPreset={vi.fn(async () => true)}
    onDelete={vi.fn(async () => true)}
    onManagePresets={vi.fn()}
    autoCollectFields={[{ id: currentField.id, label }]}
    onSaveAutoCollect={onSaveAutoCollect}
  /></th></tr></thead></table>;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container = null;
});

describe('TableFieldHeader', () => {
  it('saves its name draft when the header menu closes', async () => {
    const onSaveEdits = vi.fn(async (_field: TableField, _name: string, _options: TableFieldOption[]) => true);
    const onSaveAutoCollect = vi.fn(async () => true);
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root?.render(<HeaderHarness onSaveEdits={onSaveEdits} onSaveAutoCollect={onSaveAutoCollect} />));

    const trigger = [...container.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === '编辑属性 Title');
    expect(trigger).toBeTruthy();
    await act(async () => trigger?.click());

    const nameInput = container.querySelector<HTMLInputElement>('input[aria-label="名称"]');
    expect(nameInput).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(nameInput, 'Renamed');
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => trigger?.click());

    expect(onSaveEdits).toHaveBeenCalledWith(field, 'Renamed', []);
  });

  it('keeps the current options when a type change is rejected', async () => {
    const option = { id: `opt_${'b'.repeat(32)}`, label: 'Open' };
    const selectField: TableField = { ...field, type: 'Select', options: [option] };
    const onSaveEdits = vi.fn(async () => true);
    const onChangeType = vi.fn(async () => false);
    const onSaveAutoCollect = vi.fn(async () => true);
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root?.render(<HeaderHarness
      field={selectField}
      typeChoices={['Number']}
      onSaveEdits={onSaveEdits}
      onChangeType={onChangeType}
      onSaveAutoCollect={onSaveAutoCollect}
    />));

    const trigger = [...container.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === '编辑属性 Title');
    await act(async () => trigger?.click());
    const typeMenuTrigger = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('类型'));
    await act(async () => typeMenuTrigger?.click());
    const numberChoice = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Number'));
    await act(async () => numberChoice?.click());
    await act(async () => trigger?.click());

    expect(onChangeType).toHaveBeenCalledWith(selectField, 'Number', []);
    expect(onSaveEdits).toHaveBeenCalledWith(selectField, 'Title', [option]);
  });

  it('saves the automatic-link condition when the primary header closes', async () => {
    const primaryField: TableField = { ...field, type: 'primary', property_key: 'note' };
    const onSaveEdits = vi.fn(async () => true);
    const onSaveAutoCollect = vi.fn(async () => true);
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root?.render(<HeaderHarness
      field={primaryField}
      label="名称"
      conditionOnly
      onSaveEdits={onSaveEdits}
      onSaveAutoCollect={onSaveAutoCollect}
    />));

    const trigger = [...container.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === '管理笔记条件匹配');
    await act(async () => trigger?.click());
    expect(container.querySelector<HTMLInputElement>('input[aria-label="属性条件 1 字段"]')).not.toBeNull();
    const conditionValue = container.querySelector<HTMLInputElement>('input[aria-label="属性条件 1 匹配值"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(conditionValue, 'release');
      conditionValue?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const saveButton = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('应用'));
    await act(async () => saveButton?.click());

    expect(onSaveAutoCollect).toHaveBeenCalledWith(primaryField, expect.objectContaining({
      property_conditions: [expect.objectContaining({ value: 'release' })],
    }));
    expect(onSaveEdits).not.toHaveBeenCalled();
  });

  it('saves the automatic-link condition from the first column field menu', async () => {
    const primaryField: TableField = { ...field, type: 'primary', property_key: 'note' };
    const onSaveEdits = vi.fn(async () => true);
    const onSaveAutoCollect = vi.fn(async () => true);
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root?.render(<HeaderHarness
      field={primaryField}
      label="名称"
      showAutoCollect
      onSaveEdits={onSaveEdits}
      onSaveAutoCollect={onSaveAutoCollect}
    />));

    const trigger = [...container.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === '编辑属性 名称');
    await act(async () => trigger?.click());
    const datasetButton = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('数据集'));
    await act(async () => datasetButton?.click());
    const conditionValue = container.querySelector<HTMLInputElement>('input[aria-label="属性条件 1 匹配值"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(conditionValue, 'release');
      conditionValue?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const saveButton = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('应用'));
    await act(async () => saveButton?.click());

    expect(onSaveAutoCollect).toHaveBeenCalledWith(primaryField, expect.objectContaining({
      property_conditions: [expect.objectContaining({ value: 'release' })],
    }));
  });
});
