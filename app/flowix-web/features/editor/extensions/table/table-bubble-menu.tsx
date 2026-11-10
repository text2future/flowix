'use client';

import { Editor } from '@tiptap/core';
import { useCallback, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { hasFormattableTextSelection } from '@features/editor/components/selection-bubble-menu-state';
import { computeOverlayFrame } from '@features/editor/overlay/compute-overlay-frame';
import { useEditorOverlayAnchor } from '@features/editor/overlay/use-editor-overlay-anchor';
import { Tooltip } from '@shared/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { TableStyleControls } from './table-style-controls';
import { TableDeleteIcon } from './table-style-icon';

interface TableBubbleMenuProps {
  editor: Editor;
}

/** 气泡工具条与表格上沿的间距。 */
const TABLE_MENU_GAP = 4;
/** 首帧测量前的估算尺寸; 真值由 layout effect 里的实测校正。 */
const TABLE_MENU_FALLBACK_SIZE = { width: 320, height: 34 };

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

/**
 * 表格气泡工具条。
 *
 * 与选区气泡共用同一套锚点机制 (useEditorOverlayAnchor + computeOverlayFrame):
 * 锚点是当前表格的包围盒, 用 fixed + 视口坐标落在表格上沿, 跟随内层滚动重算。
 * 表格滚出面板时工具条贴面板顶停住而不是消失; 面板装不下就溢出到面板外
 * (宽度固定, 不压缩内容)。
 *
 * `flip: false` 是有意的: 表格上沿的气泡翻到下方会盖住首行。
 */
export function TableBubbleMenu({ editor }: TableBubbleMenuProps) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);

  const compute = useCallback((root: HTMLElement) => {
    if (editor.isDestroyed) return null;
    if (!editor.isEditable || !editor.isActive('table')) return null;
    // 有文本选区时交给选区气泡, 两个工具条不叠在一起。
    if (hasFormattableTextSelection(editor)) return null;

    const tableElement = getCurrentTableElement(editor);
    if (!tableElement) return null;

    const panel = panelRef.current;
    return computeOverlayFrame({
      anchor: tableElement.getBoundingClientRect(),
      root: root.getBoundingClientRect(),
      menu: {
        width: panel?.offsetWidth || TABLE_MENU_FALLBACK_SIZE.width,
        height: panel?.offsetHeight || TABLE_MENU_FALLBACK_SIZE.height,
      },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      gap: TABLE_MENU_GAP,
      flip: false,
    });
  }, [editor]);

  const { root, frame, requestUpdate } = useEditorOverlayAnchor(editor, compute);

  // 菜单尺寸由内容决定 (样式开关 + 行/列操作), 首帧用估算值, 这里在绘制前校正,
  // 之后靠 ResizeObserver 跟进。
  const visible = frame !== null;
  useLayoutEffect(() => {
    if (!visible) return;
    requestUpdate(true);
    const panel = panelRef.current;
    if (!panel) return;
    const observer = new ResizeObserver(() => requestUpdate(true));
    observer.observe(panel);
    return () => observer.disconnect();
  }, [visible, requestUpdate]);

  if (!root || !frame) return null;

  return createPortal(
    <div
      ref={panelRef}
      className="selection-bubble-menu table-bubble-menu-panel"
      style={{
        position: 'fixed',
        left: `${frame.left}px`,
        top: `${frame.top}px`,
      }}
    >
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
          >
            <TableDeleteIcon />
          </button>
        </Tooltip>
      </div>
    </div>,
    document.body,
  );
}
