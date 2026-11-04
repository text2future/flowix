import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { CaretDownIcon, CheckIcon, ColumnsIcon, RowsIcon } from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@shared/ui/dropdown-menu';
import type { TableBorderStyle, TableColumnRole, TableRowRole, TableStyleId } from './table-presentation';
import { getTablePresentationSelection, setTableCellBorder, setTableColumnRole, setTableRowRole, setTableStyle } from './table-style-commands';
import { TABLE_TEMPLATE_OPTIONS } from './table-templates';
import { TableStyleIcon } from './table-style-icon';

function TableBorderIcon({ edge, style = 'single' }: { edge: 'top' | 'bottom'; style?: TableBorderStyle }) {
  const y = edge === 'top' ? 4 : 16;
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
      <rect x="3" y="4" width="14" height="12" strokeDasharray="2 2" opacity="0.3" />
      {style === 'double' ? <path d={`M3 ${y - 1.5}h14M3 ${y + 1.5}h14`} />
        : style === 'none' ? <path d="m6 7 8 6m0-6-8 6" opacity="0.7" />
        : <path d={`M3 ${y}h14`} strokeWidth="1.5" strokeDasharray={style === 'auto' ? '3 2' : undefined} />}
    </svg>
  );
}

interface TableMenuOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

function TableFormatMenu<T extends string>({
  label, value, mixedLabel, options, icon, showCurrent, hint, open, onOpenChange, onSelect,
}: {
  label: string;
  value: string;
  mixedLabel: string;
  options: TableMenuOption<T>[];
  icon: ReactNode;
  showCurrent?: boolean;
  hint?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (value: T) => void;
}) {
  const currentLabel = options.find(option => option.value === value)?.label ?? mixedLabel;
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button type="button" className={`toolbar-button flex h-7 items-center justify-center whitespace-nowrap${open ? ' active' : ''}`} aria-label={`${label}: ${currentLabel}`}
          aria-haspopup="true" aria-expanded={open} title={`${label}: ${currentLabel}`}
          onMouseDown={event => event.preventDefault()}>
          {icon}
          <span>{showCurrent ? currentLabel : label}</span>
          <CaretDownIcon size={12} weight="bold" className="opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" sideOffset={5} align="start"
        className="table-style-menu min-w-[172px] rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <div className="table-style-menu-heading flex items-center justify-between gap-3 px-2 py-1.5 text-[11px] text-[var(--muted-foreground)]">
          <span>{label}</span>
          {value === 'mixed' && <span>{mixedLabel}</span>}
        </div>
        <div className="max-h-[min(320px,55vh)] overflow-y-auto space-y-0.5">{options.map(option => (
          <DropdownMenuItem key={option.value}
            className={`h-7 gap-2.5 rounded-lg px-2 py-0 text-left text-xs hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)] focus-visible:bg-[var(--brand)] focus-visible:text-[var(--primary-foreground)]${value === option.value ? ' is-active bg-[var(--brand)] text-[var(--primary-foreground)]' : ''}`}
            onClick={() => onSelect(option.value)}>
            {option.icon}
            <span className="flex-1">{option.label}</span>
            <CheckIcon size={14} weight="bold" aria-hidden="true" className={value === option.value ? '' : 'invisible'} />
          </DropdownMenuItem>
        ))}</div>
        {hint && <p className="max-w-[230px] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--muted-foreground)]">{hint}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TableStyleControls({ editor }: { editor: Editor }) {
  const { t } = useI18n();
  const [openMenu, setOpenMenu] = useState<'style' | 'row' | 'column' | 'top' | 'bottom' | null>(null);
  const selected = useEditorState({
    editor,
    selector: ({ editor: current }) => getTablePresentationSelection(current),
  });
  if (!selected) return null;

  const styles: TableMenuOption<TableStyleId>[] = TABLE_TEMPLATE_OPTIONS.map(({ styleId, labelKey }) => ({
    value: styleId, label: t(labelKey),
  }));
  const rows: TableMenuOption<TableRowRole>[] = [
    { value: 'body', label: t('editor.table.rowBody') },
    { value: 'group', label: t('editor.table.rowGroup') },
    { value: 'subtotal', label: t('editor.table.rowSubtotal') },
    { value: 'total', label: t('editor.table.rowTotal') },
  ];
  const columns: TableMenuOption<TableColumnRole>[] = [
    { value: 'default', label: t('editor.table.columnDefault') },
    { value: 'label', label: t('editor.table.columnLabel') },
    { value: 'note', label: t('editor.table.columnNote') },
    { value: 'amount', label: t('editor.table.columnAmount') },
  ];
  const borders: TableMenuOption<TableBorderStyle>[] = [
    { value: 'single', label: t('editor.table.borderSingle') },
    { value: 'double', label: t('editor.table.borderDouble') },
    { value: 'none', label: t('editor.table.borderNone') },
    { value: 'auto', label: t('editor.table.borderAuto') },
  ];

  return (
    <>
    <div className="editor-toolbar table-style-controls" role="toolbar" aria-label={t('editor.table.style')}>
      <TableFormatMenu label={t('editor.table.style')} value={selected.style} mixedLabel={t('editor.table.mixed')}
        options={styles.map(option => ({ ...option, icon: <TableStyleIcon styleId={option.value} /> }))}
        icon={<TableStyleIcon styleId={selected.style} compact />} showCurrent
        open={openMenu === 'style'} onOpenChange={open => setOpenMenu(open ? 'style' : null)}
        onSelect={value => setTableStyle(editor, value)} />
      <span className="toolbar-divider" aria-hidden="true" />
      <TableFormatMenu label={t('editor.table.rowRole')} value={selected.row} mixedLabel={t('editor.table.mixed')}
        options={rows} icon={<RowsIcon size={16} weight="bold" />}
        open={openMenu === 'row'} onOpenChange={open => setOpenMenu(open ? 'row' : null)}
        onSelect={value => setTableRowRole(editor, value)} />
      <TableFormatMenu label={t('editor.table.columnRole')} value={selected.column} mixedLabel={t('editor.table.mixed')}
        options={columns} icon={<ColumnsIcon size={16} weight="bold" />}
        open={openMenu === 'column'} onOpenChange={open => setOpenMenu(open ? 'column' : null)}
        onSelect={value => setTableColumnRole(editor, value)} />
    </div>
    <div className="editor-toolbar table-style-controls table-border-controls" role="toolbar" aria-label={t('editor.table.borders')}>
      {(['top', 'bottom'] as const).map(edge => (
        <TableFormatMenu key={edge} label={t(edge === 'top' ? 'editor.table.borderTop' : 'editor.table.borderBottom')}
          value={edge === 'top' ? selected.borderTop : selected.borderBottom} mixedLabel={t('editor.table.mixed')}
          options={borders.map(option => ({ ...option, icon: <TableBorderIcon edge={edge} style={option.value} /> }))}
          icon={<TableBorderIcon edge={edge} />}
          hint={(edge === 'top' ? selected.borderTopExtends : selected.borderBottomExtends) ? t('editor.table.borderMergedHint') : undefined}
          open={openMenu === edge} onOpenChange={open => setOpenMenu(open ? edge : null)}
          onSelect={value => setTableCellBorder(editor, edge, value)} />
      ))}
    </div>
    </>
  );
}
