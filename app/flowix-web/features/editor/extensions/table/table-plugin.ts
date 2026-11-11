import { createOverlayScrollbarDom, type OverlayScrollbarDomController } from '@shared/ui/overlay-scrollbar-dom';
import { Extension } from '@tiptap/core';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableRow } from '@tiptap/extension-table-row';
import { TableView } from '@tiptap/extension-table';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

import { createTableEdgeInsertPlugin, type TableEdgeInsertLabels } from '@features/editor/extensions/table/table-edge-insert-plugin';
import { createTableColumnDecorationsPlugin } from '@features/editor/extensions/table/table-column-decorations';
import { createTableResizeIndicatorPlugin } from './table-resize-indicator';
import { createTableTextSelectionPlugin } from './table-text-selection';
import { createTableReorderPlugin, type TableReorderLabels } from './table-reorder';
import { createTableEditingCellPlugin } from './table-editing-cell';
import { createTableSelectionFramePlugin } from './table-selection-frame';
import { createTableCompositionPlugin } from './table-composition';
import { createEditorTable } from '@features/editor/extensions/table/flowix-table';
import { normalizeTableStyleId, TablePresentation } from '@features/editor/extensions/table/table-presentation';

import { createTableBreakoutPlugin } from './table-breakout';
import { createTableFixedWidthsPlugin, TABLE_CELL_MIN_WIDTH } from './table-fixed-widths';

const TABLE_RESIZE_HANDLE_WIDTH = 8;

/** TableView builds its own DOM instead of using the table's renderHTML attrs. */
class FlowixTableView extends TableView {
  private scrollbar: OverlayScrollbarDomController;
  constructor(node: ProseMirrorNode, cellMinWidth: number) {
    super(node, cellMinWidth);
    this.scrollbar = createOverlayScrollbarDom(this.dom.ownerDocument, {
      horizontal: true,
      observeContent: true,
      frameClassName: 'overlay-scrollbar-frame--custom-mac markdown-table-scrollbar',
      scrollerClassName: 'tableWrapper',
    });
    const rail = this.dom.ownerDocument.createElement('div');
    rail.className = 'markdown-table-rail';
    rail.append(this.table);
    this.scrollbar.scroller.append(rail);
    this.dom = this.scrollbar.frame;
    this.updateStyle(node);
  }

  update(node: ProseMirrorNode): boolean {
    if (!super.update(node)) return false;
    this.updateStyle(node);
    this.scrollbar.update({ reveal: false, schedule: false });
    return true;
  }

  destroy(): void {
    this.scrollbar.destroy();
  }

  stopEvent(event: Event): boolean {
    return event.target instanceof Element && !!event.target.closest('.overlay-scrollbar-thumb, .overlay-scrollbar-track, .table-edge-insert-button, .table-edge-insert-hover-zone, .table-reorder-handle');
  }

  private updateStyle(node: ProseMirrorNode): void {
    const styleId = normalizeTableStyleId(node.attrs.styleId);
    const current = this.table.getAttribute('data-flowix-table-style');
    if (styleId === 'default') {
      if (current !== null) this.table.removeAttribute('data-flowix-table-style');
      return;
    }
    // Same-value setAttribute still invalidates style for the table subtree.
    if (current !== styleId) this.table.setAttribute('data-flowix-table-style', styleId);
  }
}

export interface TablePluginOptions {
  /** Copy for DOM controls the plugins create outside React (edge insert buttons). */
  labels?: TableEdgeInsertLabels & TableReorderLabels;
}

/** Each editor owns its table renderer and schema binding. */
export function createTablePlugin({ labels }: TablePluginOptions = {}) {
  const table = createEditorTable().configure({
    resizable: true,
    handleWidth: TABLE_RESIZE_HANDLE_WIDTH,
    cellMinWidth: TABLE_CELL_MIN_WIDTH,
    View: FlowixTableView,
  });

  return Extension.create({
    name: 'tablePlugin',

    addExtensions() {
      return [table, TableRow, TableHeader, TableCell, TablePresentation];
    },

    addProseMirrorPlugins() {
      return [
        createTableFixedWidthsPlugin(),
        createTableBreakoutPlugin(),
        createTableCompositionPlugin(),
        createTableEdgeInsertPlugin(this.editor, labels),
        createTableReorderPlugin(labels),
        createTableResizeIndicatorPlugin(),
        createTableColumnDecorationsPlugin(),
        createTableEditingCellPlugin(),
        createTableSelectionFramePlugin(),
        createTableTextSelectionPlugin(),
      ];
    },
  });
}
