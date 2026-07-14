import type { JSONContent } from '@tiptap/core';

function splitTsvLine(line: string): string[] {
  return line.split('\t');
}

export function looksLikeTsvTable(text: string): boolean {
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(line => line.length > 0);

  if (lines.length < 2) return false;

  const rows = lines.map(splitTsvLine);
  const firstWidth = rows[0]?.length ?? 0;
  return firstWidth >= 2 && rows.every(row => row.length === firstWidth);
}

function createParagraph(text: string): JSONContent {
  const normalizedText = text.replace(/\r\n/g, '\n').trim();
  return normalizedText
    ? { type: 'paragraph', content: [{ type: 'text', text: normalizedText }] }
    : { type: 'paragraph' };
}

function rowsToTableContent(rows: string[][], useHeaderRow = false): JSONContent {
  const width = Math.max(...rows.map(row => row.length));
  const normalizedRows = rows.map(row => {
    const cells = [...row];
    while (cells.length < width) cells.push('');
    return cells;
  });

  return {
    type: 'table',
    content: normalizedRows.map((row, rowIndex) => ({
      type: 'tableRow',
      content: row.map(cell => ({
        type: useHeaderRow && rowIndex === 0 ? 'tableHeader' : 'tableCell',
        content: [createParagraph(cell)],
      })),
    })),
  };
}

export function tsvToTableContent(text: string): JSONContent | null {
  const rows = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(line => line.length > 0)
    .map(splitTsvLine);

  if (rows.length === 0) return null;
  return rowsToTableContent(rows);
}

function readCellText(cell: HTMLTableCellElement): string {
  return (cell.textContent ?? '').replace(/\u00a0/g, ' ').trim();
}

export function htmlTableToTableContent(html: string): JSONContent | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const table = doc.querySelector('table');
  if (!table) return null;

  const rows = Array.from(table.rows)
    .map(row => Array.from(row.cells).map(readCellText))
    .filter(row => row.length > 0);

  if (rows.length === 0) return null;

  const firstRow = table.rows[0];
  const useHeaderRow = !!firstRow && Array.from(firstRow.cells).every(cell => cell.tagName.toLowerCase() === 'th');
  return rowsToTableContent(rows, useHeaderRow);
}
