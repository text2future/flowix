'use client';

import { Editor } from '@tiptap/core';
import { type ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Tooltip } from '../../../../components/ui/tooltip';

interface TableBubbleMenuProps {
  editor: Editor;
}

const TABLE_MENU_OFFSET = 4;
const AGENT_TRASH_ICON_PATH =
  'M216,48H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM192,208H64V64H192ZM80,24a8,8,0,0,1,8-8h80a8,8,0,0,1,0,16H88A8,8,0,0,1,80,24Z';

interface TableMenuPosition {
  left: number;
  top: number;
}

function getCurrentTableElement(editor: Editor): HTMLElement | null {
  const { state } = editor;
  const { $from } = state.selection;

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name !== 'table') continue;

    const domNode = editor.view.nodeDOM($from.before(depth));
    return domNode instanceof HTMLElement ? domNode : null;
  }

  return null;
}

function getMenuPosition(editor: Editor, overlayRoot: HTMLElement): TableMenuPosition | null {
  if (!editor.isEditable || !editor.isActive('table')) return null;

  const tableElement = getCurrentTableElement(editor);
  if (!tableElement) return null;

  const tableRect = tableElement.getBoundingClientRect();
  const rootRect = overlayRoot.getBoundingClientRect();

  return {
    left: tableRect.left - rootRect.left + tableRect.width / 2,
    top: tableRect.top - rootRect.top - TABLE_MENU_OFFSET,
  };
}

function TableToolIcon({
  size = 18,
  children,
}: {
  size?: number;
  children: ReactNode;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="16"
    >
      {children}
    </svg>
  );
}

function ColumnsPlusLeftIcon({ size = 18 }: { size?: number }) {
  return (
    <TableToolIcon size={size}>
      <rect x="148" y="44" width="40" height="168" rx="8" />
      <line x1="56" y1="128" x2="120" y2="128" />
      <line x1="88" y1="96" x2="88" y2="160" />
    </TableToolIcon>
  );
}

function ColumnsPlusRightIcon({ size = 18 }: { size?: number }) {
  return (
    <TableToolIcon size={size}>
      <rect x="68" y="44" width="40" height="168" rx="8" />
      <line x1="136" y1="128" x2="200" y2="128" />
      <line x1="168" y1="96" x2="168" y2="160" />
    </TableToolIcon>
  );
}

function RowsPlusTopIcon({ size = 18 }: { size?: number }) {
  return (
    <TableToolIcon size={size}>
      <rect x="44" y="148" width="168" height="40" rx="8" />
      <line x1="128" y1="56" x2="128" y2="120" />
      <line x1="96" y1="88" x2="160" y2="88" />
    </TableToolIcon>
  );
}

function RowsPlusBottomIcon({ size = 18 }: { size?: number }) {
  return (
    <TableToolIcon size={size}>
      <rect x="44" y="68" width="168" height="40" rx="8" />
      <line x1="128" y1="136" x2="128" y2="200" />
      <line x1="96" y1="168" x2="160" y2="168" />
    </TableToolIcon>
  );
}

function RowsDeleteIcon({ size = 18 }: { size?: number }) {
  return (
    <TableToolIcon size={size}>
      <rect x="44" y="148" width="168" height="40" rx="8" />
      <line x1="104" y1="64" x2="152" y2="112" />
      <line x1="152" y1="64" x2="104" y2="112" />
    </TableToolIcon>
  );
}

function ColumnsDeleteIcon({ size = 18 }: { size?: number }) {
  return (
    <TableToolIcon size={size}>
      <rect x="148" y="44" width="40" height="168" rx="8" />
      <line x1="64" y1="104" x2="112" y2="152" />
      <line x1="112" y1="104" x2="64" y2="152" />
    </TableToolIcon>
  );
}

function AgentTrashIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={AGENT_TRASH_ICON_PATH} />
    </svg>
  );
}

export function TableBubbleMenu({ editor }: TableBubbleMenuProps) {
  const [overlayRoot, setOverlayRoot] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState<TableMenuPosition | null>(null);

  useEffect(() => {
    const root = editor.view.dom.closest('.markdown-editor');
    setOverlayRoot(root instanceof HTMLElement ? root : null);
  }, [editor]);

  useEffect(() => {
    if (!overlayRoot) return;

    let frameId: number | null = null;

    const updatePosition = () => {
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        setPosition(getMenuPosition(editor, overlayRoot));
      });
    };

    updatePosition();
    editor.on('selectionUpdate', updatePosition);
    editor.on('transaction', updatePosition);
    editor.on('focus', updatePosition);
    editor.on('blur', updatePosition);
    window.addEventListener('resize', updatePosition);
    document.addEventListener('scroll', updatePosition, true);

    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      editor.off('selectionUpdate', updatePosition);
      editor.off('transaction', updatePosition);
      editor.off('focus', updatePosition);
      editor.off('blur', updatePosition);
      window.removeEventListener('resize', updatePosition);
      document.removeEventListener('scroll', updatePosition, true);
    };
  }, [editor, overlayRoot]);

  if (!overlayRoot || !position) return null;

  return createPortal(
    <div
      className="table-bubble-menu-anchor"
      style={{
        left: `${position.left}px`,
        top: `${position.top}px`,
      }}
    >
      <div className="table-bubble-menu">
        <Tooltip content="上方插入行">
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              editor.chain().focus().addRowBefore().run();
            }}
            type="button"
          >
            <RowsPlusTopIcon size={18} />
          </button>
        </Tooltip>
        <Tooltip content="下方插入行">
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              editor.chain().focus().addRowAfter().run();
            }}
            type="button"
          >
            <RowsPlusBottomIcon size={18} />
          </button>
        </Tooltip>
        <Tooltip content="删除行">
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              editor.chain().focus().deleteRow().run();
            }}
            type="button"
          >
            <RowsDeleteIcon size={18} />
          </button>
        </Tooltip>
        <div className="menu-divider" />
        <Tooltip content="左侧插入列">
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              editor.chain().focus().addColumnBefore().run();
            }}
            type="button"
          >
            <ColumnsPlusLeftIcon size={18} />
          </button>
        </Tooltip>
        <Tooltip content="右侧插入列">
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              editor.chain().focus().addColumnAfter().run();
            }}
            type="button"
          >
            <ColumnsPlusRightIcon size={18} />
          </button>
        </Tooltip>
        <Tooltip content="删除列">
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              editor.chain().focus().deleteColumn().run();
            }}
            type="button"
          >
            <ColumnsDeleteIcon size={18} />
          </button>
        </Tooltip>
        <div className="menu-divider" />
        <Tooltip content="删除表格">
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              editor.chain().focus().deleteTable().run();
            }}
            type="button"
            className="delete-table-btn"
          >
            <AgentTrashIcon size={18} />
          </button>
        </Tooltip>
      </div>
    </div>,
    overlayRoot,
  );
}
