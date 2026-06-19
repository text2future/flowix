import { Extension } from '@tiptap/core';
import { Table } from '@tiptap/extension-table';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableRow } from '@tiptap/extension-table-row';

import { createTableEdgeInsertPlugin } from './table-edge-insert-plugin';

const TABLE_RESIZE_HANDLE_WIDTH = 8;
const TABLE_CELL_MIN_WIDTH = 80;

export const TablePlugin = Extension.create({
  name: 'tablePlugin',

  addExtensions() {
    return [
      Table.configure({
        resizable: true,
        handleWidth: TABLE_RESIZE_HANDLE_WIDTH,
        cellMinWidth: TABLE_CELL_MIN_WIDTH,
      }),
      TableRow,
      TableHeader,
      TableCell,
    ];
  },

  addProseMirrorPlugins() {
    return [createTableEdgeInsertPlugin(this.editor)];
  },
});
