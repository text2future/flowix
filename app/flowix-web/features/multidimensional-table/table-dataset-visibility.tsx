import { EyeIcon, EyeSlashIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import type { TableView } from './model';
import { visibleFieldIds } from './table-view-config';

/**
 * 「这张表所有表格视图里该字段是否展示」的三态：全部展示 / 部分展示 / 都没展示。
 * 数据集菜单的眼睛图标就是靠它决定实心、半态还是划线。
 */
export function datasetFieldVisibility(tableViews: TableView[], fieldId: string): 'all' | 'some' | 'none' {
  if (tableViews.length === 0) return 'none';
  const shown = tableViews.filter((view) => visibleFieldIds(view).includes(fieldId)).length;
  if (shown === tableViews.length) return 'all';
  return shown === 0 ? 'none' : 'some';
}

/** 数据集菜单里字段行右侧的显隐开关：点击＝在所有表格视图里一起显示/隐藏。 */
export function DatasetFieldVisibilityButton({
  fieldId,
  label,
  state,
  disabled,
  onToggle,
  className = '',
}: {
  fieldId: string;
  label: string;
  state: 'all' | 'some' | 'none';
  disabled: boolean;
  onToggle: (fieldId: string) => void;
  className?: string;
}): ReactNode {
  const checked = state === 'all';
  const mixed = state === 'some';
  const action = checked ? '隐藏' : '展示';
  const ariaLabel = mixed ? `部分表格视图中展示，点击后全部展示${label}` : `${action}${label}`;
  return <button
    type="button"
    aria-label={ariaLabel}
    title={ariaLabel}
    aria-pressed={checked ? true : mixed ? 'mixed' : false}
    disabled={disabled}
    onClick={() => onToggle(fieldId)}
    className={`${className} inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40`}
  >{checked || mixed
    ? <EyeIcon size={16} weight="bold" className="text-[var(--brand)]" aria-hidden="true" />
    : <EyeSlashIcon size={16} weight="bold" className="text-[var(--muted-foreground)]" aria-hidden="true" />}</button>;
}
