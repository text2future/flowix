import type { TabulatorFull as Tabulator } from 'tabulator-tables';

/** Tabulator assumes an active range for Shift and right-click interactions. */
export function ensureCsvPointerRange(table: Tabulator, event: MouseEvent) {
  if ((!event.shiftKey && event.button !== 2) || table.getRanges().length > 0) return;
  const target = event.target instanceof Element ? event.target : null;
  const cellElement = target?.closest<HTMLElement>('.tabulator-cell');
  const columnElement = target?.closest<HTMLElement>('.tabulator-col');
  if (!cellElement && !columnElement) return;
  const rowElement = cellElement?.closest<HTMLElement>('.tabulator-row');
  const row = rowElement ? table.getRow(rowElement) : table.getRows('active')[0];
  if (!row) return;
  const column = columnElement ? table.getColumn(columnElement) : null;
  const cell = row.getCells().find(candidate => cellElement
    ? candidate.getElement() === cellElement
    : candidate.getField() === column?.getField());
  if (!cell) return;
  // Set bounds synchronously: addRange's initial bounds are deferred by the library.
  table.addRange(cell, cell).setBounds(cell, cell);
}
