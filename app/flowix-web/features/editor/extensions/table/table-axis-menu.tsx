import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { CaretRightIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/lib/i18n';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@shared/ui/dropdown-menu';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { POPUP_SEPARATOR_CLASS } from '@shared/ui/popup-separator';
import { FlowixBackgroundPalette } from '../../components/flowix-background-palette';
import { setTableBackground } from './table-background-commands';
import { getTablePresentationSelection } from './table-style-commands';
import { TableBorderMenuSections, TableColumnAlignmentOptions } from './table-style-controls';
import { TableAlignmentIcon, TableBackgroundIcon, TableBordersIcon, TableDeleteColumnIcon, TableDeleteRowIcon, TableInsertColumnIcon, TableInsertRowIcon } from './table-style-icon';
import type { Axis } from './table-reorder-commands';

interface MenuAnchor { axis: Axis; anchor: DOMRect }
const MENU_GAP = 2;
const VIEWPORT_MARGIN = 4;
const SUBMENU_CLOSE_DELAY = 150;
const itemClass = 'flex h-7 w-full items-center gap-3 rounded-lg px-2 text-left text-sm text-[var(--foreground)] hover:bg-[var(--hover-bg)] focus-visible:bg-[var(--hover-bg)] disabled:opacity-50';

export function TableAxisMenu({ editor }: { editor: Editor }) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [submenu, setSubmenu] = useState<'format' | 'background' | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelSubmenuClose = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const scheduleSubmenuClose = () => {
    cancelSubmenuClose();
    closeTimer.current = setTimeout(() => { setSubmenu(null); closeTimer.current = null; }, SUBMENU_CLOSE_DELAY);
  };
  useEffect(() => () => cancelSubmenuClose(), [cancelSubmenuClose]);
  const selected = useEditorState({ editor, selector: ({ editor: current }) => getTablePresentationSelection(current) });

  useEffect(() => {
    const dom = editor.view.dom;
    const open = (event: Event) => {
      const detail = (event as CustomEvent<MenuAnchor>).detail;
      cancelSubmenuClose();
      setSubmenu(null);
      setMenu(detail);
    };
    dom.addEventListener('flowix:table-axis-menu', open);
    return () => dom.removeEventListener('flowix:table-axis-menu', open);
  }, [editor, cancelSubmenuClose]);

  useLayoutEffect(() => {
    if (!menu || !panelRef.current) return;
    const panel = panelRef.current;
    const { anchor } = menu;
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const left = anchor.right + MENU_GAP + width <= window.innerWidth - VIEWPORT_MARGIN
      ? anchor.right + MENU_GAP : anchor.left - width - MENU_GAP;
    setPosition({
      left: Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - width - VIEWPORT_MARGIN)),
      top: Math.max(VIEWPORT_MARGIN, Math.min(anchor.top, window.innerHeight - height - VIEWPORT_MARGIN)),
    });
    panel.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = () => { cancelSubmenuClose(); setMenu(null); setSubmenu(null); };
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && (panelRef.current?.contains(target) || target.closest('[data-flowix-menu-child]'))) return;
      close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      close();
      if (!editor.isDestroyed) editor.view.focus();
    };
    const selection = editor.state.selection;
    const selectionChanged = () => { if (!selection.eq(editor.state.selection)) close(); };
    editor.on('selectionUpdate', selectionChanged);
    const scroll = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('[data-flowix-menu-child]')) return;
      close();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', close);
    return () => {
      editor.off('selectionUpdate', selectionChanged);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', close);
    };
  }, [editor, menu, cancelSubmenuClose]);

  if (!menu || !selected || !editor.isEditable) return null;
  const row = menu.axis === 'row';
  const run = (action: () => void) => { cancelSubmenuClose(); action(); setMenu(null); setSubmenu(null); };
  const before = row ? t('editor.table.insertRowBefore') : t('editor.table.insertColumnBefore');
  const after = row ? t('editor.table.insertRowAfter') : t('editor.table.insertColumnAfter');
  return createPortal(
    <div ref={panelRef} role="menu" aria-label={t(row ? 'editor.table.rowOperations' : 'editor.table.columnOperations')}
      data-flowix-surface="popover" className="table-axis-menu fixed z-[150] flex min-w-[190px] flex-col gap-0.5 rounded-xl border border-[var(--border-popup)] bg-[var(--card)] p-1 shadow-lg"
      style={{ left: position.left, top: position.top }}
      onMouseOver={event => {
        if (!event.currentTarget.contains(event.target as Node)) return;
        const item = (event.target as Element).closest('[role="menuitem"]');
        if (item && !item.hasAttribute('data-axis-submenu')) {
          cancelSubmenuClose();
          setSubmenu(null);
        }
      }}
      onKeyDown={event => {
        if ((event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || !event.currentTarget.contains(event.target as Node)) return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (!buttons.length) return;
        event.preventDefault();
        buttons[(current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
      }}>
      <button type="button" role="menuitem" className={itemClass} onMouseDown={event => event.preventDefault()}
        disabled={row ? !editor.can().addRowBefore() : !editor.can().addColumnBefore()}
        onClick={() => run(() => { if (row) editor.chain().focus().addRowBefore().run(); else editor.chain().focus().addColumnBefore().run(); })}>
        {row ? <TableInsertRowIcon placement="above" /> : <TableInsertColumnIcon placement="left" />}{before}
      </button>
      <button type="button" role="menuitem" className={itemClass} onMouseDown={event => event.preventDefault()}
        disabled={row ? !editor.can().addRowAfter() : !editor.can().addColumnAfter()}
        onClick={() => run(() => { if (row) editor.chain().focus().addRowAfter().run(); else editor.chain().focus().addColumnAfter().run(); })}>
        {row ? <TableInsertRowIcon placement="below" /> : <TableInsertColumnIcon placement="right" />}{after}
      </button>
      <div role="separator" className={POPUP_SEPARATOR_CLASS} />
      <DropdownMenu open={submenu === 'format'} onOpenChange={open => setSubmenu(open ? 'format' : null)}>
        <DropdownMenuTrigger asChild><button type="button" role="menuitem" data-axis-submenu aria-haspopup="menu" aria-expanded={submenu === 'format'} className={itemClass}
          onMouseEnter={() => { cancelSubmenuClose(); setSubmenu('format'); }} onMouseLeave={scheduleSubmenuClose}
          onClickCapture={event => { if (event.detail > 0 && submenu === 'format') event.stopPropagation(); }}
          onMouseDown={event => event.preventDefault()}>
          {row ? <TableBordersIcon /> : <TableAlignmentIcon />}<span className="flex-1">{t(row ? 'editor.table.borderStyle' : 'editor.table.alignment')}</span><CaretRightIcon size={14} />
        </button></DropdownMenuTrigger>
        <DropdownMenuContent side="right" sideOffset={0} keepParentMenuOpen onMouseEnter={cancelSubmenuClose} onMouseLeave={scheduleSubmenuClose} className="table-style-menu min-w-[190px] rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
          <OverlayScrollbar className="table-style-menu-scroll-frame" scrollerClassName="table-style-menu-scroller max-h-[min(360px,55vh)] space-y-0.5">
            {row ? <TableBorderMenuSections editor={editor} selected={selected} /> : <TableColumnAlignmentOptions editor={editor} value={selected.column} />}
          </OverlayScrollbar>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu open={submenu === 'background'} onOpenChange={open => setSubmenu(open ? 'background' : null)}>
        <DropdownMenuTrigger asChild><button type="button" role="menuitem" data-axis-submenu aria-haspopup="menu" aria-expanded={submenu === 'background'} className={itemClass}
          onMouseEnter={() => { cancelSubmenuClose(); setSubmenu('background'); }} onMouseLeave={scheduleSubmenuClose}
          onClickCapture={event => { if (event.detail > 0 && submenu === 'background') event.stopPropagation(); }}
          onMouseDown={event => event.preventDefault()}>
          <TableBackgroundIcon /><span className="flex-1">{t(row ? 'editor.table.rowBackground' : 'editor.table.columnBackground')}</span><CaretRightIcon size={14} />
        </button></DropdownMenuTrigger>
        <DropdownMenuContent side="right" sideOffset={0} keepParentMenuOpen onMouseEnter={cancelSubmenuClose} onMouseLeave={scheduleSubmenuClose} className="table-style-menu table-style-menu--palette">
          <div className="editor-highlight-palette"><FlowixBackgroundPalette value={row ? selected.rowBackground : selected.columnBackground}
            onChange={color => run(() => { setTableBackground(editor, menu.axis, color); })} /></div>
        </DropdownMenuContent>
      </DropdownMenu>
      <div role="separator" className={POPUP_SEPARATOR_CLASS} />
      <button type="button" role="menuitem" className={itemClass} onMouseDown={event => event.preventDefault()}
        disabled={row ? !editor.can().deleteRow() : !editor.can().deleteColumn()}
        onClick={() => run(() => { if (row) editor.chain().focus().deleteRow().run(); else editor.chain().focus().deleteColumn().run(); })}>
        {row ? <TableDeleteRowIcon /> : <TableDeleteColumnIcon />}<span>{t(row ? 'editor.table.deleteRow' : 'editor.table.deleteColumn')}</span>
      </button>
    </div>, document.body,
  );
}
