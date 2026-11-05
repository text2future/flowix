import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { CaretDownIcon, CheckIcon, TextAUnderlineIcon, RowsIcon, RowsPlusTopIcon, RowsPlusBottomIcon, ColumnsPlusLeftIcon, ColumnsPlusRightIcon, TrashSimpleIcon } from '@phosphor-icons/react';
import { Fragment, useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import type { I18nKey } from '@/lib/i18n/locales';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@shared/ui/dropdown-menu';
import { POPUP_SEPARATOR_CLASS } from '@shared/ui/popup-separator';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import type { TableBorderStyle, TableColumnRole, TableRowRole, TableStyleId } from './table-presentation';
import { getBorderExtendsHint, getTablePresentationSelection, setTableCellBorder, setTableColumnRole, setTableRowRole, setTableStyle } from './table-style-commands';
import { TABLE_TEMPLATE_OPTIONS } from './table-templates';
import { TableBorderIcon, TableBordersIcon, TableStyleIcon } from './table-style-icon';

interface TableMenuOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  separatorBefore?: boolean;
}

const TABLE_MENU_OPTION_CLASS = 'h-7 gap-3 rounded-lg px-2 py-0 text-left text-sm leading-5 text-[var(--foreground)] hover:bg-[var(--hover-bg)] focus-visible:bg-[var(--hover-bg)]';
const TABLE_MENU_ACTIVE_CLASS = ' is-active bg-[var(--hover-bg)] text-[var(--foreground)]';

type Translate = ReturnType<typeof useI18n>['t'];

/**
 * Value lists are pairs, not objects: the label key is typed as `I18nKey`, so a
 * renamed message fails the build instead of rendering the key.
 */
function optionEntries<T extends string>(
  t: Translate,
  entries: ReadonlyArray<readonly [T, I18nKey]>,
): TableMenuOption<T>[] {
  return entries.map(([value, labelKey]) => ({ value, label: t(labelKey) }));
}

/**
 * One dropdown shell for every table menu.
 *
 * The trigger shows `triggerText` when it has a stable label (a menu name) and
 * hides it when the button must collapse to an icon, but the accessible name is
 * always `label` plus the current value, so screen readers and tests can both
 * find it by value.
 */
function TableMenuShell({
  label, statusLabel, triggerText, icon, open, onOpenChange,
  widthClass = 'min-w-[190px]', scrollerClass = 'max-h-[min(360px,55vh)]', heading, children,
}: {
  label: string;
  statusLabel?: string;
  triggerText?: ReactNode;
  icon: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Override only when a menu needs a different frame than the default one. */
  widthClass?: string;
  scrollerClass?: string;
  heading?: ReactNode;
  children: ReactNode;
}) {
  const title = statusLabel ? `${label}: ${statusLabel}` : label;
  return (
    <DropdownMenu className="table-style-menu-trigger" open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button type="button" className={`toolbar-button flex h-7 items-center justify-center whitespace-nowrap${open ? ' active' : ''}`}
          aria-label={title} aria-haspopup="true" aria-expanded={open} title={title}
          onMouseDown={event => event.preventDefault()}>
          {icon}
          {triggerText === null || triggerText === undefined ? null : <span>{triggerText}</span>}
          <CaretDownIcon size={10} weight="bold" className="opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" sideOffset={5} align="start"
        className={`table-style-menu ${widthClass} rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]`}>
        {heading}
        <OverlayScrollbar className="table-style-menu-scroll-frame"
          scrollerClassName={`table-style-menu-scroller ${scrollerClass}`}>{children}</OverlayScrollbar>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TableOptionList<T extends string>({
  options, value, onSelect, withSeparators = false,
}: {
  options: TableMenuOption<T>[];
  value: string;
  onSelect: (value: T) => void;
  /** Template groups render a rule between menu groups; single-purpose menus do not. */
  withSeparators?: boolean;
}) {
  return (
    <>
      {options.map(option => (
        <Fragment key={option.value}>
          {withSeparators && option.separatorBefore && <div role="separator" className={POPUP_SEPARATOR_CLASS} />}
          <DropdownMenuItem
            className={`${TABLE_MENU_OPTION_CLASS}${value === option.value ? TABLE_MENU_ACTIVE_CLASS : ''}`}
            onClick={() => onSelect(option.value)}>
            {option.icon}
            <span className="flex-1">{option.label}</span>
            <CheckIcon size={14} weight="bold" aria-hidden="true" className={value === option.value ? '' : 'invisible'} />
          </DropdownMenuItem>
        </Fragment>
      ))}
    </>
  );
}

/**
 * One section frame for every menu: optional rule, heading, children.
 *
 * Both the value pickers and the command list need exactly this — the command
 * list has no current value, so it cannot go through `TableMenuSection`.
 */
function TableMenuGroup({ label, separatorBefore = false, footer, children }: {
  label: string;
  separatorBefore?: boolean;
  /** Rendered outside the stacked list so `space-y` cannot space it. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="table-style-menu-section">
      {separatorBefore && <div className={POPUP_SEPARATOR_CLASS} aria-hidden="true" />}
      <div className="table-style-menu-heading slash-menu-header">
        <span>{label}</span>
      </div>
      <div className="space-y-0.5">{children}</div>
      {footer}
    </section>
  );
}

function TableMenuSection<T extends string>({
  label, value, options, hint, separatorBefore, onSelect,
}: {
  label: string;
  value: string;
  options: TableMenuOption<T>[];
  hint?: ReactNode;
  separatorBefore?: boolean;
  onSelect: (value: T) => void;
}) {
  return (
    <TableMenuGroup label={label} footer={hint} separatorBefore={separatorBefore}>
      <TableOptionList options={options} value={value} onSelect={onSelect} />
    </TableMenuGroup>
  );
}

const HINT_CLASS = 'max-w-[230px] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--muted-foreground)]';

/**
 * Merged-edge notice. It mounts with the border menu, so the connected-span walk
 * (superlinear in the selected cell count) never runs while the user types.
 */
function BorderExtendsHint({ editor, edge }: { editor: Editor; edge: 'top' | 'bottom' }) {
  const { t } = useI18n();
  const extendsSelection = useEditorState({
    editor,
    selector: ({ editor: current }) => getBorderExtendsHint(current, edge),
  });
  return extendsSelection ? <p className={HINT_CLASS}>{t('editor.table.borderMergedHint')}</p> : null;
}

function TableHeaderToggle({ label, checked, disabled, disabledReason, onToggle }: {
  label: string;
  checked: boolean;
  disabled: boolean;
  disabledReason?: string;
  onToggle: () => void;
}) {
  return (
    <button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled}
      title={disabledReason} aria-description={disabledReason}
      className={`${TABLE_MENU_OPTION_CLASS} flex w-full items-center justify-between disabled:cursor-not-allowed disabled:opacity-50`}
      onMouseDown={event => event.preventDefault()} onClick={onToggle}>
      <span>{label}</span>
      <span aria-hidden="true" className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${checked ? 'bg-[var(--primary)]' : 'bg-[var(--muted)]'}`}>
        <span className={`absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-[var(--card)] shadow-sm transition-transform ${checked ? 'translate-x-3' : 'translate-x-0'}`} />
      </span>
    </button>
  );
}

export function TableStyleControls({ editor }: { editor: Editor }) {
  const { t, language } = useI18n();
  const [openMenu, setOpenMenu] = useState<'theme' | 'border' | 'font' | 'operations' | null>(null);
  const selected = useEditorState({
    editor,
    selector: ({ editor: current }) => getTablePresentationSelection(current),
  });
  if (!selected) return null;

  const styles: TableMenuOption<TableStyleId>[] = TABLE_TEMPLATE_OPTIONS.map(({ styleId, labelKey, menuGroup }, index) => ({
    value: styleId, label: t(labelKey),
    separatorBefore: index > 0 && menuGroup !== TABLE_TEMPLATE_OPTIONS[index - 1].menuGroup,
  }));
  const rows = optionEntries<TableRowRole>(t, [
    ['body', 'editor.table.rowBody'],
    ['group', 'editor.table.rowGroup'],
    ['subtotal', 'editor.table.rowSubtotal'],
    ['total', 'editor.table.rowTotal'],
  ]);
  const columns = optionEntries<TableColumnRole>(t, [
    ['default', 'editor.table.columnDefault'],
    ['label', 'editor.table.columnLabel'],
    ['note', 'editor.table.columnNote'],
    ['amount', 'editor.table.columnAmount'],
  ]);
  const borders = optionEntries<TableBorderStyle>(t, [
    ['single', 'editor.table.borderSingle'],
    ['double', 'editor.table.borderDouble'],
    ['none', 'editor.table.borderNone'],
    ['auto', 'editor.table.borderAuto'],
  ]);
  const borderLabel = (value: string) => borders.find(option => option.value === value)?.label ?? t('editor.table.mixed');
  const borderStatus = selected.borderTop === selected.borderBottom
    ? borderLabel(selected.borderTop)
    : t('editor.table.mixed');
  const fontStatus = selected.row === 'mixed' || selected.column === 'mixed' ? t('editor.table.mixed') : undefined;
  const currentStyleLabel = styles.find(option => option.value === selected.style)?.label ?? t('editor.table.mixed');
  const operationGroups: Array<{
    label: string;
    operations: Array<{ label: string; icon: ReactNode; can: () => boolean; run: () => void }>;
  }> = [
    { label: t('editor.table.rowOperations'), operations: [
      { label: t('editor.table.insertRowBefore'), icon: <RowsPlusTopIcon size={16} weight="regular" />,
        can: () => editor.can().addRowBefore(), run: () => editor.chain().focus().addRowBefore().run() },
      { label: t('editor.table.insertRowAfter'), icon: <RowsPlusBottomIcon size={16} weight="regular" />,
        can: () => editor.can().addRowAfter(), run: () => editor.chain().focus().addRowAfter().run() },
      { label: t('editor.table.deleteRow'), icon: <TrashSimpleIcon size={16} weight="regular" />,
        can: () => editor.can().deleteRow(), run: () => editor.chain().focus().deleteRow().run() },
    ] },
    { label: t('editor.table.columnOperations'), operations: [
      { label: t('editor.table.insertColumnBefore'), icon: <ColumnsPlusLeftIcon size={16} weight="regular" />,
        can: () => editor.can().addColumnBefore(), run: () => editor.chain().focus().addColumnBefore().run() },
      { label: t('editor.table.insertColumnAfter'), icon: <ColumnsPlusRightIcon size={16} weight="regular" />,
        can: () => editor.can().addColumnAfter(), run: () => editor.chain().focus().addColumnAfter().run() },
      { label: t('editor.table.deleteColumn'), icon: <TrashSimpleIcon size={16} weight="regular" />,
        can: () => editor.can().deleteColumn(), run: () => editor.chain().focus().deleteColumn().run() },
    ] },
  ];

  return (
    <div className="editor-toolbar table-style-controls" role="toolbar" aria-label={t('editor.table.theme')}>
      <TableMenuShell label={t('editor.table.theme')} statusLabel={currentStyleLabel}
        triggerText={selected.style === 'default' ? t('editor.table.theme') : currentStyleLabel}
        icon={<TableStyleIcon styleId={selected.style} compact />}
        open={openMenu === 'theme'} onOpenChange={open => setOpenMenu(open ? 'theme' : null)}
        widthClass="min-w-[172px]" scrollerClass="max-h-[min(320px,55vh)] space-y-0.5"
        heading={(
          <div className="table-style-menu-heading slash-menu-header">
            <span>{t('editor.table.theme')}</span>
          </div>
        )}>
        <TableOptionList options={styles.map(option => ({ ...option, icon: <TableStyleIcon styleId={option.value} /> }))}
          value={selected.style} withSeparators onSelect={value => setTableStyle(editor, value, language)} />
      </TableMenuShell>
      <span className="toolbar-divider table-toolbar-divider" aria-hidden="true" />
      <TableMenuShell label={t('editor.table.borders')} statusLabel={borderStatus}
        triggerText={t('editor.table.borders')} icon={<TableBordersIcon />}
        open={openMenu === 'border'} onOpenChange={open => setOpenMenu(open ? 'border' : null)}>
        <TableMenuSection label={t('editor.table.borderTop')} value={selected.borderTop}
          options={borders.map(option => ({ ...option, icon: <TableBorderIcon edge="top" style={option.value} /> }))}
          hint={<BorderExtendsHint editor={editor} edge="top" />}
          onSelect={value => setTableCellBorder(editor, 'top', value)} />
        <TableMenuSection label={t('editor.table.borderBottom')} value={selected.borderBottom}
          options={borders.map(option => ({ ...option, icon: <TableBorderIcon edge="bottom" style={option.value} /> }))}
          hint={<BorderExtendsHint editor={editor} edge="bottom" />}
          separatorBefore
          onSelect={value => setTableCellBorder(editor, 'bottom', value)} />
      </TableMenuShell>
      <TableMenuShell label={t('editor.table.font')} statusLabel={fontStatus} triggerText={null}
        icon={<TextAUnderlineIcon size={16} weight="bold" />}
        open={openMenu === 'font'} onOpenChange={open => setOpenMenu(open ? 'font' : null)}>
        <div className="space-y-0.5">
          <TableHeaderToggle label={t('editor.table.headerColumn')} checked={selected.columnHeader}
            disabled={!selected.canToggleHeaderColumn}
            onToggle={() => editor.chain().focus().toggleHeaderColumn().run()} />
          <TableHeaderToggle label={t('editor.table.headerRow')} checked={selected.rowHeader}
            disabled={!selected.canToggleHeaderRow}
            disabledReason={selected.headerRowLocked ? t('editor.table.headerRowRequired') : undefined}
            onToggle={() => editor.chain().focus().toggleHeaderRow().run()} />
        </div>
        <div className={POPUP_SEPARATOR_CLASS} aria-hidden="true" />
        <TableMenuSection label={t('editor.table.rowFont')} value={selected.row}
          options={rows} onSelect={value => setTableRowRole(editor, value)} />
        <TableMenuSection label={t('editor.table.columnFont')} value={selected.column}
          options={columns} separatorBefore onSelect={value => setTableColumnRole(editor, value)} />
      </TableMenuShell>
      <TableMenuShell label={t('editor.table.rowColumnOperations')} triggerText={null}
        icon={<RowsIcon size={18} weight="regular" />}
        open={openMenu === 'operations'} onOpenChange={open => setOpenMenu(open ? 'operations' : null)}>
        {operationGroups.map((group, index) => (
          <TableMenuGroup key={group.label} label={group.label} separatorBefore={index > 0}>
            {group.operations.map(operation => (
              <DropdownMenuItem key={operation.label} className={TABLE_MENU_OPTION_CLASS}
                disabled={!editor.isEditable || !operation.can()}
                onClick={() => operation.run()}>
                {operation.icon}
                <span>{operation.label}</span>
              </DropdownMenuItem>
            ))}
          </TableMenuGroup>
        ))}
      </TableMenuShell>
    </div>
  );
}
