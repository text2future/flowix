import { Extension } from '@tiptap/core';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableRow } from '@tiptap/extension-table-row';
import { TableView } from '@tiptap/extension-table';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

import { createTableEdgeInsertPlugin, type TableEdgeInsertLabels } from '@features/editor/extensions/table/table-edge-insert-plugin';
import { createTableColumnDecorationsPlugin } from '@features/editor/extensions/table/table-column-decorations';
import { createTableEditingCellPlugin } from './table-editing-cell';
import { createTableCompositionPlugin } from './table-composition';
import { createEditorTable } from '@features/editor/extensions/table/flowix-table';
import { normalizeTableStyleId, TablePresentation } from '@features/editor/extensions/table/table-presentation';

const TABLE_RESIZE_HANDLE_WIDTH = 8;
const TABLE_CELL_MIN_WIDTH = 80;

/** TableView builds its own DOM instead of using the table's renderHTML attrs. */
class FlowixTableView extends TableView {
  constructor(node: ProseMirrorNode, cellMinWidth: number) {
    super(node, cellMinWidth);
    this.updateStyle(node);
  }

  update(node: ProseMirrorNode): boolean {
    if (!super.update(node)) return false;
    this.updateStyle(node);
    return true;
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
  labels?: TableEdgeInsertLabels;
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
        createTableCompositionPlugin(),
        createTableEdgeInsertPlugin(this.editor, labels),
        createTableColumnDecorationsPlugin(),
        createTableEditingCellPlugin(),
      ];
    },
  });
}
