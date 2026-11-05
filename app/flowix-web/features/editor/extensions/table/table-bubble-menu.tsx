'use client';

import { Editor } from '@tiptap/core';
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { hasFormattableTextSelection } from '@features/editor/components/selection-bubble-menu-state';
import { Tooltip } from '@shared/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { TableStyleControls } from './table-style-controls';
import { getTableMenuHorizontalLayout } from './table-menu-position';

interface TableBubbleMenuProps {
  editor: Editor;
}

const TABLE_MENU_OFFSET = 4;
const AGENT_TRASH_ICON_PATH =
  'M216,48H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM192,208H64V64H192ZM80,24a8,8,0,0,1,8-8h80a8,8,0,0,1,0,16H88A8,8,0,0,1,80,24Z';

interface TableMenuPosition {
  left: number;
  top: number;
  maxWidth: number;
}

function getCurrentTableElement(editor: Editor): HTMLElement | null {
  // selectionUpdate 可能在 editor 销毁后还 flush 进来 (transaction 队列里
  // 还有未处理项, view DOM 已被 detach) — 守住避免 "view not available"。
  if (editor.isDestroyed) return null;
  const { state } = editor;
  const { $from } = state.selection;

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name !== 'table') continue;

    const domNode = editor.view.nodeDOM($from.before(depth));
    return domNode instanceof HTMLElement ? domNode : null;
  }

  return null;
}

function getMenuPosition(editor: Editor, overlayRoot: HTMLElement, menuWidth?: number): TableMenuPosition | null {
  if (!editor.isEditable || !editor.isActive('table')) return null;
  if (hasFormattableTextSelection(editor)) return null;

  const tableElement = getCurrentTableElement(editor);
  if (!tableElement) return null;

  const tableRect = tableElement.getBoundingClientRect();
  const rootRect = overlayRoot.getBoundingClientRect();
  const horizontal = getTableMenuHorizontalLayout(
    tableRect.left + tableRect.width / 2, rootRect, window.innerWidth, menuWidth,
  );
  if (!horizontal) return null;

  return {
    ...horizontal,
    top: tableRect.top - rootRect.top - TABLE_MENU_OFFSET,
  };
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
  const { t } = useI18n();
  const [overlayRoot, setOverlayRoot] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState<TableMenuPosition | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuVisible = position !== null;

  // Refine the initial estimate after the panel mounts or its content changes.
  useLayoutEffect(() => {
    if (!overlayRoot || !panelRef.current) return;
    const panel = panelRef.current;
    const update = () => {
      const next = getMenuPosition(editor, overlayRoot, panel.offsetWidth);
      setPosition(previous => previous?.left === next?.left && previous?.top === next?.top
        && previous?.maxWidth === next?.maxWidth ? previous : next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [editor, overlayRoot, menuVisible]);

  useEffect(() => {
    // editor 可能在 effect 排队时已被销毁 (切语言/切文档的卸载路径),
    // 此时 view.dom 已 detach — 直接 closest 会触发 view-not-available 警告。
    if (editor.isDestroyed) return;
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
        setPosition(getMenuPosition(editor, overlayRoot, panelRef.current?.offsetWidth));
      });
    };

    updatePosition();
    editor.on('selectionUpdate', updatePosition);
    editor.on('transaction', updatePosition);
    editor.on('focus', updatePosition);
    editor.on('blur', updatePosition);
    window.addEventListener('resize', updatePosition);
    document.addEventListener('scroll', updatePosition, true);
    const resizeObserver = new ResizeObserver(updatePosition);
    resizeObserver.observe(overlayRoot);

    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      editor.off('selectionUpdate', updatePosition);
      editor.off('transaction', updatePosition);
      editor.off('focus', updatePosition);
      editor.off('blur', updatePosition);
      window.removeEventListener('resize', updatePosition);
      document.removeEventListener('scroll', updatePosition, true);
      resizeObserver.disconnect();
    };
  }, [editor, overlayRoot]);

  if (!overlayRoot || !position) return null;

  return createPortal(
    <div
      className="table-bubble-menu-anchor"
      style={{
        left: `${position.left}px`,
        top: `${position.top}px`,
        '--table-menu-max-width': `${position.maxWidth}px`,
      } as CSSProperties}
    >
      <div className="selection-bubble-menu table-bubble-menu-panel" ref={panelRef}>
      <TableStyleControls editor={editor} />
      <span className="table-toolbar-divider" aria-hidden="true" />
      <div className="table-bubble-menu" role="toolbar" aria-label={t('editor.table.operations')}>
        <Tooltip content={t('editor.table.deleteTable')}>
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              editor.chain().focus().deleteTable().run();
            }}
            type="button"
            className="destructive"
          >
            <AgentTrashIcon size={16} />
          </button>
        </Tooltip>
      </div>
      </div>
    </div>,
    overlayRoot,
  );
}
