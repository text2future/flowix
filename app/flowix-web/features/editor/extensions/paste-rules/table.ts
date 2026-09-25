import type { JSONContent } from '@tiptap/core';
import { sanitizeLinkHref } from '@/lib/safe-link';

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

function readCellContent(cell: HTMLTableCellElement): JSONContent[] {
  const paragraphs: JSONContent[] = [];
  let content: JSONContent[] = [];
  const flush = () => {
    while (content[0]?.type === 'text' && !content[0].text?.trim()) content.shift();
    while (content[content.length - 1]?.type === 'text' && !content[content.length - 1]?.text?.trim()) content.pop();
    if (content.length) paragraphs.push({ type: 'paragraph', content });
    content = [];
  };
  const visit = (node: Node, marks: NonNullable<JSONContent['marks']>) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? '').replace(/\u00a0/g, ' ');
      if (text) content.push({ type: 'text', text, ...(marks.length ? { marks } : {}) });
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (['P', 'DIV'].includes(node.tagName)) {
      flush();
      node.childNodes.forEach(child => visit(child, marks));
      flush();
      return;
    }
    if (node.tagName === 'BR') {
      content.push({ type: 'hardBreak' });
      return;
    }
    const tag = node.tagName.toLowerCase();
    const markType = ({ strong: 'bold', b: 'bold', em: 'italic', i: 'italic',
      code: 'code', s: 'strike', del: 'strike' } as Record<string, string>)[tag];
    const href = tag === 'a' ? sanitizeLinkHref(node.getAttribute('href')) : null;
    const nextMarks = markType ? [...marks, { type: markType }]
      : href ? [...marks, { type: 'link', attrs: { href } }] : marks;
    node.childNodes.forEach(child => visit(child, nextMarks));
  };
  cell.childNodes.forEach(node => visit(node, []));
  flush();
  return paragraphs.length ? paragraphs : [{ type: 'paragraph' }];
}

export function htmlTableToTableContent(html: string): JSONContent | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const table = doc.querySelector('table');
  if (!table) return null;

  const rows = Array.from(table.rows)
    .map(row => Array.from(row.cells).map(readCellContent))
    .filter(row => row.length > 0);

  if (rows.length === 0) return null;

  const firstRow = table.rows[0];
  const useHeaderRow = !!firstRow && Array.from(firstRow.cells).every(cell => cell.tagName.toLowerCase() === 'th');
  const width = Math.max(...rows.map(row => row.length));
  return {
    type: 'table',
    content: rows.map((row, rowIndex) => ({
      type: 'tableRow',
      content: Array.from({ length: width }, (_, cellIndex) => ({
        type: useHeaderRow && rowIndex === 0 ? 'tableHeader' : 'tableCell',
        content: row[cellIndex] ?? [{ type: 'paragraph' }],
      })),
    })),
  };
}
