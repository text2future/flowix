'use client';

import { useEffect, useRef, useState } from 'react';
import Papa from 'papaparse';
import { TabulatorFull as Tabulator, type CellComponent, type ColumnDefinition } from 'tabulator-tables';
import { externalDocuments } from '@platform/tauri/client/memos';
import './csv-preview.css';

const MAX_CSV_BYTES = 20 * 1024 * 1024;
const MAX_CELL_BYTES = 256 * 1024;
const MAX_ROWS = 100_000;
const MAX_CELLS = 500_000;
const MIN_VISIBLE_ROWS = 100;
const DEFAULT_COLUMN_WIDTH = 160;
const READ_TIMEOUT_MS = 30_000;
const PARSE_TIMEOUT_MS = 30_000;
type CsvData = { headers: string[]; rows: string[][]; delimiter: string };
type CsvDraft = {
  data: CsvData;
  expectedContent: string;
  newline: string;
  finalNewline: boolean;
  bom: boolean;
  version: number;
};
type SaveState = { status: 'idle' | 'saving' | 'saved' | 'error'; message?: string; retryable?: boolean };
type CsvLoadState =
  | { status: 'loading' }
  | { status: 'choosing-delimiter'; text: string; delimiter: string }
  | { status: 'ready'; data: CsvData }
  | { status: 'error'; message: string };
type ParseReply =
  | { id: number; kind: 'parsed'; data: CsvData }
  | { id: number; kind: 'choose-delimiter'; message: string }
  | { id: number; kind: 'error'; message: string };

let nextRequestId = 0;
let nextDraftVersion = 0;
const pendingCsvDrafts = new Map<string, CsvDraft>();
const utf8Encoder = new TextEncoder();

function draftKey(filePath: string, scopePath: string | null): string {
  return `${scopePath ?? ''}\u0000${filePath}`;
}

function cloneCsvData(data: CsvData): CsvData {
  return { headers: [...data.headers], rows: data.rows.map((row) => [...row]), delimiter: data.delimiter };
}

function columnLabel(index: number): string {
  let value = index + 1;
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function csvColumnIndex(field: string): number | null {
  const match = /^c(\d+)$/.exec(field);
  return match ? Number(match[1]) : null;
}

function normalizeEditedRow(cell: CellComponent): void {
  (cell.getRow().normalizeHeight as (force: boolean) => void)(true);
}

const textareaEditor: NonNullable<ColumnDefinition['editor']> = (
  cell,
  onRendered,
  success,
  cancel,
) => {
  const input = document.createElement('textarea');
  let finished = false;
  let minimumHeight = 0;
  let measuredHeight = 0;
  input.rows = 1;
  input.value = String(cell.getValue() ?? '');
  Object.assign(input.style, {
    display: 'block',
    width: '100%',
    height: '100%',
    minHeight: '0',
    maxHeight: '240px',
    boxSizing: 'border-box',
    padding: '2px',
    resize: 'none',
    overflowY: 'auto',
    whiteSpace: 'pre-wrap',
  });
  const resizeWhenLineCountChanges = () => {
    input.style.height = 'auto';
    const nextHeight = Math.min(240, Math.max(minimumHeight, input.scrollHeight));
    input.style.height = `${nextHeight}px`;
    if (nextHeight !== measuredHeight) {
      measuredHeight = nextHeight;
      normalizeEditedRow(cell);
    }
  };
  onRendered(() => {
    minimumHeight = cell.getElement().clientHeight;
    measuredHeight = minimumHeight;
    resizeWhenLineCountChanges();
    input.focus({ preventScroll: true });
  });
  input.addEventListener('input', resizeWhenLineCountChanges);
  const commit = () => {
    if (finished) return;
    if (success(input.value)) {
      finished = true;
      requestAnimationFrame(() => { if (cell.getElement().isConnected) normalizeEditedRow(cell); });
    }
  };
  input.addEventListener('change', commit);
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      finished = true;
      cancel(input.value);
      requestAnimationFrame(() => { if (cell.getElement().isConnected) normalizeEditedRow(cell); });
    }
  });
  return input;
};

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(resolve, reject).finally(() => window.clearTimeout(timeout));
  });
}

function parseInWorker(text: string, delimiter: string | undefined, onWorker: (worker: Worker | null, finished?: Worker) => void): Promise<ParseReply> {
  const worker = new Worker(new URL('./csv-codec.worker.ts', import.meta.url), { type: 'module' });
  const id = ++nextRequestId;
  onWorker(worker);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      onWorker(null, worker);
      worker.terminate();
      reject(new Error('CSV 解析超时，请重新打开文件。'));
    }, PARSE_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timeout);
      onWorker(null, worker);
      worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<ParseReply>) => {
      if (event.data.id !== id) return;
      if (settled) return;
      settled = true;
      cleanup();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(event.message || 'CSV 解析 Worker 发生错误。'));
    };
    worker.onmessageerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('CSV 解析结果无法读取，请重新打开文件。'));
    };
    worker.postMessage({ id, text, delimiter });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CsvPreview({ filePath, scopePath }: { filePath: string; scopePath: string | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const documentRef = useRef<CsvData | null>(null);
  const requestRef = useRef(0);
  const savedTextRef = useRef('');
  const newlineRef = useRef('\n');
  const finalNewlineRef = useRef(false);
  const bomRef = useRef(false);
  const revisionRef = useRef(0);
  const savingRef = useRef<number | null>(null);
  const visibleRowCountRef = useRef(MIN_VISIBLE_ROWS);
  const [state, setState] = useState<CsvLoadState>({ status: 'loading' });
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });

  function retainDraft() {
    const doc = documentRef.current;
    if (!doc) return;
    pendingCsvDrafts.set(draftKey(filePath, scopePath), {
      data: cloneCsvData(doc),
      expectedContent: savedTextRef.current,
      newline: newlineRef.current,
      finalNewline: finalNewlineRef.current,
      bom: bomRef.current,
      version: ++nextDraftVersion,
    });
  }

  async function saveCurrentDocument() {
    const requestId = requestRef.current;
    const key = draftKey(filePath, scopePath);
    if (savingRef.current === requestId) return;
    savingRef.current = requestId;
    try {
      while (requestRef.current === requestId && documentRef.current && revisionRef.current > 0) {
        const revision = revisionRef.current;
        const doc = documentRef.current;
        const serialized = Papa.unparse([doc.headers, ...doc.rows], {
          delimiter: doc.delimiter,
          newline: newlineRef.current,
          header: false,
          skipEmptyLines: false,
        });
        const content = `${bomRef.current ? '\uFEFF' : ''}${serialized}${finalNewlineRef.current ? newlineRef.current : ''}`;
        if (utf8Encoder.encode(content).byteLength > MAX_CSV_BYTES) {
          setSaveState({ status: 'error', message: '编辑后的 CSV 超过 20 MiB 上限，无法自动保存。' });
          return;
        }
        const original = savedTextRef.current;
        const draftVersion = pendingCsvDrafts.get(key)?.version;
        setSaveState({ status: 'saving' });
        let outcome: Awaited<ReturnType<typeof externalDocuments.write>>;
        try {
          outcome = await externalDocuments.write({ filePath, scopePath, content, expectedContent: original });
        } catch (error) {
          if (requestRef.current !== requestId) return;
          setSaveState({ status: 'error', message: `自动保存失败：${errorMessage(error)}`, retryable: true });
          return;
        }
        if (outcome.status !== 'saved') {
          if (requestRef.current !== requestId) return;
          const message = outcome.status === 'conflict'
            ? '文件已在其他位置修改。当前编辑未覆盖磁盘文件，请重新打开后处理冲突。'
            : outcome.status === 'missing'
              ? '文件已不存在，无法自动保存。'
              : outcome.message;
          setSaveState({ status: 'error', message, retryable: outcome.status === 'error' });
          return;
        }
        const draft = pendingCsvDrafts.get(key);
        if (draft && draft.version === draftVersion) pendingCsvDrafts.delete(key);
        else if (draft) draft.expectedContent = outcome.content;
        if (requestRef.current !== requestId) return;
        savedTextRef.current = outcome.content;
        if (revisionRef.current === revision) {
          revisionRef.current = 0;
          setSaveState({ status: 'saved' });
        }
      }
    } finally {
      if (savingRef.current === requestId) savingRef.current = null;
    }
  }

  useEffect(() => {
    const requestId = ++requestRef.current;
    let cancelled = false;
    documentRef.current = null;
    revisionRef.current = 0;
    savingRef.current = null;
    setSaveState({ status: 'idle' });
    setState({ status: 'loading' });
    const draft = pendingCsvDrafts.get(draftKey(filePath, scopePath));
    if (draft) {
      documentRef.current = cloneCsvData(draft.data);
      savedTextRef.current = draft.expectedContent;
      newlineRef.current = draft.newline;
      finalNewlineRef.current = draft.finalNewline;
      bomRef.current = draft.bom;
      revisionRef.current = 1;
      visibleRowCountRef.current = Math.max(MIN_VISIBLE_ROWS, draft.data.rows.length + 1);
      setSaveState({ status: 'error', message: '此文件有未保存的编辑，内容已恢复。请重试保存；若磁盘文件已变化，保存会提示冲突。', retryable: true });
      setState({ status: 'ready', data: documentRef.current });
      return () => { cancelled = true; };
    }
    void withTimeout(
      externalDocuments.read(filePath, scopePath, MAX_CSV_BYTES),
      READ_TIMEOUT_MS,
      '读取 CSV 超时，请检查文件是否仍可访问。',
    ).then(async (text) => {
      if (cancelled || requestRef.current !== requestId) return;
      const reply = await parseInWorker(text, undefined, (worker, finished) => {
        if (worker) workerRef.current = worker;
        else if (workerRef.current === finished) workerRef.current = null;
      });
      if (cancelled || requestRef.current !== requestId) return;
      if (reply.kind === 'parsed') {
        documentRef.current = reply.data;
        savedTextRef.current = text;
        newlineRef.current = text.includes('\r\n') ? '\r\n' : text.includes('\r') ? '\r' : '\n';
        finalNewlineRef.current = /(?:\r\n|\r|\n)$/.test(text);
        bomRef.current = text.startsWith('\uFEFF');
        visibleRowCountRef.current = Math.max(MIN_VISIBLE_ROWS, reply.data.rows.length + 1);
        setState({ status: 'ready', data: reply.data });
      }
      else if (reply.kind === 'choose-delimiter') setState({ status: 'choosing-delimiter', text, delimiter: ',' });
      else setState({ status: 'error', message: reply.message });
    }).catch((error: unknown) => {
      if (cancelled || requestRef.current !== requestId) return;
      setState({ status: 'error', message: errorMessage(error) });
    });
    return () => {
      cancelled = true;
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [filePath, scopePath]);

  useEffect(() => {
    if (state.status !== 'ready' || !hostRef.current) return;
    const { headers, rows } = state.data;
    let addingRow = false;
    let addingColumn = false;
    let updatingCells = false;
    let pasteInProgress = false;
    const handleCellEdited = (cell: CellComponent) => {
      if (updatingCells) return;
      const doc = documentRef.current;
      const rowIndex = Number(cell.getRow().getData()._rowId);
      const columnIndex = csvColumnIndex(cell.getField());
      if (!doc || !Number.isInteger(rowIndex) || rowIndex < 0 || columnIndex === null) return;
      const value = String(cell.getValue() ?? '');
      if ((rowIndex === 0 ? doc.headers[columnIndex] : doc.rows[rowIndex - 1]?.[columnIndex] ?? '') === value) return;
      if (rowIndex === 0) doc.headers[columnIndex] = value;
      else {
        while (doc.rows.length < rowIndex) doc.rows.push(Array(doc.headers.length).fill(''));
        doc.rows[rowIndex - 1][columnIndex] = value;
      }
      revisionRef.current += 1;
      retainDraft();
      void saveCurrentDocument();
    };
    const createDataColumn = (index: number): ColumnDefinition => ({
      title: columnLabel(index),
      field: `c${index}`,
      headerSort: false,
      headerHozAlign: 'center',
      editor: textareaEditor,
      editable: (cell) => !cell.getRow().getData()._addRow,
      validator: (cell, value) => {
        const rowIndex = Number(cell.getRow().getData()._rowId);
        const doc = documentRef.current;
        const requiredRows = Math.max(doc?.rows.length ?? 0, rowIndex);
        return utf8Encoder.encode(String(value ?? '')).byteLength <= MAX_CELL_BYTES
          && requiredRows <= MAX_ROWS
          && (requiredRows + 1) * (doc?.headers.length ?? headers.length) <= MAX_CELLS;
      },
      cellEdited: handleCellEdited,
      formatter: 'textarea',
      variableHeight: true,
      resizable: true,
      width: DEFAULT_COLUMN_WIDTH,
      minWidth: 80,
    });
    const addColumn = async () => {
      const doc = documentRef.current;
      if (!doc || addingColumn) return;
      if (doc.headers.length >= 200 || doc.headers.length + 1 > MAX_CELLS
        || (doc.rows.length + 1) * (doc.headers.length + 1) > MAX_CELLS) {
        setSaveState({ status: 'error', message: '新增列会超过 CSV 的列数或单元格数量上限。' });
        return;
      }
      addingColumn = true;
      const holder = table.element.querySelector<HTMLElement>('.tabulator-tableholder');
      const scrollLeft = holder?.scrollLeft ?? 0;
      const scrollTop = holder?.scrollTop ?? 0;
      try {
        await table.addColumn(createDataColumn(doc.headers.length), true, '_csvAction');
        doc.headers.push('');
        doc.rows.forEach((row) => row.push(''));
        if (holder) {
          holder.scrollLeft = scrollLeft;
          holder.scrollTop = scrollTop;
        }
        revisionRef.current += 1;
        retainDraft();
        void saveCurrentDocument();
      } catch (error) {
        setSaveState({ status: 'error', message: `新增列失败：${errorMessage(error)}` });
      } finally {
        addingColumn = false;
      }
    };
    const columns: ColumnDefinition[] = headers.map((_title, index) => createDataColumn(index));
    const visibleRowCount = visibleRowCountRef.current;
    const displayRows = [headers, ...rows];
    while (displayRows.length < visibleRowCount) displayRows.push(Array(headers.length).fill(''));
    const data = displayRows.map((values, index) => {
      const row: Record<string, string | number | boolean> = { _rowId: index };
      values.forEach((value, index) => { row[`c${index}`] = value; });
      return row;
    });
    data.push({ _rowId: displayRows.length, _addRow: true });
    columns.push({
      title: '+',
      field: '_csvAction',
      width: 40,
      minWidth: 40,
      maxWidth: 40,
      headerSort: false,
      resizable: false,
      hozAlign: 'center',
      headerHozAlign: 'center',
      headerClick: () => { void addColumn(); },
      formatter: () => '',
    });
    const addVisibleRow = async () => {
      const currentCount = visibleRowCountRef.current;
      if (addingRow) return;
      if (currentCount >= MAX_ROWS + 1) {
        setSaveState({ status: 'error', message: 'CSV 最多支持 100,000 行。' });
        return;
      }
      addingRow = true;
      try {
        await table.getRow(currentCount).update({ _addRow: false });
        const nextCount = currentCount + 1;
        await table.addRow({ _rowId: nextCount, _addRow: true }, false);
        visibleRowCountRef.current = nextCount;
        await table.scrollToRow(nextCount, 'bottom', false);
      } catch (error) {
        setSaveState({ status: 'error', message: `新增行失败：${errorMessage(error)}` });
      } finally {
        addingRow = false;
      }
    };
    const parseClipboardRows = (clipboard: string): Array<Record<string, string>> | false => {
      if (typeof clipboard !== 'string') return false;
      const range = table.getRanges()[0];
      const selectedCells = range?.getStructuredCells();
      const selectedFields = selectedCells?.[0]?.map((cell) => csvColumnIndex(cell.getField()))
        .filter((columnIndex): columnIndex is number => columnIndex !== null);
      if (!selectedCells?.length || !selectedFields?.length) return false;

      const parsed = Papa.parse<string[]>(clipboard, { delimiter: '\t', skipEmptyLines: false });
      const sourceRows = parsed.errors.length
        ? clipboard.split(/\r\n|\r|\n/).map((row) => row.split('\t'))
        : parsed.data;
      const lastSourceRow = sourceRows[sourceRows.length - 1];
      if (/(?:\r\n|\r|\n)$/.test(clipboard) && lastSourceRow?.length === 1 && lastSourceRow[0] === '') {
        sourceRows.pop();
      }
      if (!sourceRows.length) return false;

      const firstColumn = selectedFields[0];
      const singleCell = selectedCells.length === 1 && selectedCells[0].length === 1;
      const width = singleCell
        ? sourceRows.reduce((widest, row) => Math.max(widest, row.length), 0)
        : selectedFields.length;
      return sourceRows.map((sourceRow) => {
        const row: Record<string, string> = {};
        for (let columnOffset = 0; columnOffset < width; columnOffset += 1) {
          const columnIndex = firstColumn + columnOffset;
          if (columnIndex >= (documentRef.current?.headers.length ?? 0)) break;
          row[`c${columnIndex}`] = sourceRow[columnOffset % sourceRow.length] ?? '';
        }
        return row;
      });
    };
    const applyPastedRows = async (pastedRows: Array<Record<string, unknown>>) => {
      const doc = documentRef.current;
      const range = table.getRanges()[0];
      if (!doc || !range || pastedRows.length === 0) return [];
      const startingRevision = revisionRef.current;

      const selectedCells = range.getStructuredCells();
      const firstCell = selectedCells[0]?.[0];
      if (!firstCell) return [];
      const startRow = Number(firstCell.getRow().getData()._rowId);
      const selectedRowCount = selectedCells.length;
      const singleCell = selectedRowCount === 1 && selectedCells[0].length === 1;
      const rowCount = singleCell ? pastedRows.length : selectedRowCount;
      const updates: Array<{ rowIndex: number; columnIndex: number; value: string }> = [];
      const nextDoc = cloneCsvData(doc);

      for (let rowOffset = 0; rowOffset < rowCount; rowOffset += 1) {
        const rowIndex = startRow + rowOffset;
        if (rowIndex > MAX_ROWS) {
          setSaveState({ status: 'error', message: '粘贴内容会超过 CSV 的 100,000 行上限。' });
          return [];
        }
        const pastedRow = pastedRows[rowOffset % pastedRows.length];
        for (const [field, rawValue] of Object.entries(pastedRow)) {
          const columnIndex = csvColumnIndex(field);
          if (columnIndex === null) continue;
          if (columnIndex < 0 || columnIndex >= doc.headers.length) continue;
          const value = String(rawValue ?? '');
          if (utf8Encoder.encode(value).byteLength > MAX_CELL_BYTES) {
            setSaveState({ status: 'error', message: '粘贴内容中有单元格超过 256 KiB，未应用粘贴。' });
            return [];
          }
          updates.push({ rowIndex, columnIndex, value });
          if (rowIndex === 0) nextDoc.headers[columnIndex] = value;
          else {
            while (nextDoc.rows.length < rowIndex) nextDoc.rows.push(Array(doc.headers.length).fill(''));
            nextDoc.rows[rowIndex - 1][columnIndex] = value;
          }
        }
      }

      if ((nextDoc.rows.length + 1) * nextDoc.headers.length > MAX_CELLS) {
        setSaveState({ status: 'error', message: '粘贴内容会超过 CSV 的 500,000 个单元格上限。' });
        return [];
      }
      if (!updates.length) return [];
      const serialized = Papa.unparse([nextDoc.headers, ...nextDoc.rows], {
        delimiter: nextDoc.delimiter,
        newline: newlineRef.current,
        header: false,
        skipEmptyLines: false,
      });
      const content = `${bomRef.current ? '\uFEFF' : ''}${serialized}${finalNewlineRef.current ? newlineRef.current : ''}`;
      if (utf8Encoder.encode(content).byteLength > MAX_CSV_BYTES) {
        setSaveState({ status: 'error', message: '粘贴内容会超过 CSV 的 20 MiB 上限，未应用粘贴。' });
        return [];
      }

      const highestRow = startRow + rowCount - 1;
      while (visibleRowCountRef.current <= highestRow) {
        const previousCount = visibleRowCountRef.current;
        await addVisibleRow();
        if (visibleRowCountRef.current === previousCount) return [];
      }
      if (documentRef.current !== doc || revisionRef.current !== startingRevision) {
        setSaveState({ status: 'error', message: '粘贴期间表格内容发生变化，请重新选择后重试。' });
        return [];
      }
      const changedRows = new Set<number>();
      updatingCells = true;
      try {
        for (const update of updates) {
          const row = table.getRow(update.rowIndex);
          const cell = row?.getCell(`c${update.columnIndex}`);
          if (!cell || String(cell.getValue() ?? '') === update.value) continue;
          cell.setValue(update.value, true);
          changedRows.add(update.rowIndex);
        }
      } finally {
        updatingCells = false;
      }
      if (changedRows.size) {
        documentRef.current = nextDoc;
        revisionRef.current += 1;
        retainDraft();
        void saveCurrentDocument();
      }
      return [...changedRows].map((rowIndex) => table.getRow(rowIndex));
    };
    const pasteIntoRange = (pastedRows: Array<Record<string, unknown>>) => {
      if (pasteInProgress) return [];
      pasteInProgress = true;
      void applyPastedRows(pastedRows).catch((error: unknown) => {
        setSaveState({ status: 'error', message: `粘贴失败：${errorMessage(error)}` });
      }).finally(() => { pasteInProgress = false; });
      return [];
    };
    const table = new Tabulator(hostRef.current, {
      height: '100%',
      data,
      columns,
      rowHeader: { formatter: 'rownum', width: 48, frozen: true, headerSort: false, resizable: false, hozAlign: 'center' },
      rowFormatter: (row) => {
        const headerCell = row.getElement().querySelector<HTMLElement>('.tabulator-row-header');
        if (!headerCell) return;
        if (!row.getData()._addRow) {
          if (headerCell.querySelector('.csv-preview__add-row-header')) {
            const number = document.createElement('span');
            number.textContent = String(Number(row.getData()._rowId) + 1);
            headerCell.replaceChildren(number);
          }
          return;
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'csv-preview__add-row-header';
        button.textContent = '+';
        button.setAttribute('aria-label', '新增一行');
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          void addVisibleRow();
        });
        headerCell.replaceChildren(button);
      },
      index: '_rowId',
      layout: 'fitData',
      movableColumns: false,
      selectableRows: false,
      columnDefaults: { headerSort: false },
      editTriggerEvent: 'dblclick',
      validationMode: 'blocking',
      selectableRange: 1,
      selectableRangeColumns: true,
      selectableRangeRows: true,
      selectableRangeClearCells: false,
      clipboard: 'paste',
      // Tabulator accepts false from a parser and custom actions at runtime; its types omit both cases.
      clipboardPasteParser: parseClipboardRows as (clipboard: string) => Array<Record<string, string>>,
      clipboardPasteAction: pasteIntoRange as unknown as 'range',
      history: false,
    });
    table.on('validationFailed', () => {
      setSaveState({ status: 'error', message: '单元格不能超过 256 KiB，且 CSV 最多支持 100,000 行、500,000 个单元格。' });
    });
    table.on('clipboardPasteError', () => {
      setSaveState({ status: 'error', message: '无法将剪贴板内容粘贴到当前选区。' });
    });
    const getSelectedCells = () => {
      const range = table.getRanges()[0];
      return range?.getStructuredCells().map((row) => row.filter((cell) => csvColumnIndex(cell.getField()) !== null)) ?? [];
    };
    const getSelectionText = (cells: CellComponent[][]) => {
      const values = cells.map((row) => row.map((cell) => String(cell.getValue() ?? '')));
      if (!values.length || !values[0].length) return null;
      return Papa.unparse(values, {
        delimiter: '\t',
        newline: '\r\n',
        header: false,
        skipEmptyLines: false,
      });
    };
    const clearSelectedCells = (selectedCells: CellComponent[][]) => {
      const doc = documentRef.current;
      if (!doc || pasteInProgress) return;
      const nextDoc = cloneCsvData(doc);
      const changedCells: CellComponent[] = [];
      for (const row of selectedCells) {
        for (const cell of row) {
          const rowIndex = Number(cell.getRow().getData()._rowId);
          const columnIndex = csvColumnIndex(cell.getField());
          if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex > nextDoc.rows.length
            || columnIndex === null || columnIndex < 0 || columnIndex >= nextDoc.headers.length
            || String(cell.getValue() ?? '') === '') continue;
          if (rowIndex === 0) nextDoc.headers[columnIndex] = '';
          else nextDoc.rows[rowIndex - 1][columnIndex] = '';
          changedCells.push(cell);
        }
      }
      if (!changedCells.length) return;
      updatingCells = true;
      try {
        changedCells.forEach((cell) => cell.setValue('', true));
      } finally {
        updatingCells = false;
      }
      documentRef.current = nextDoc;
      revisionRef.current += 1;
      retainDraft();
      void saveCurrentDocument();
    };
    const isTextInput = (target: EventTarget | null) => target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || (target instanceof HTMLElement && target.isContentEditable);
    const copySelection = (event: ClipboardEvent) => {
      if (!event.clipboardData || isTextInput(event.target)) return;
      const text = getSelectionText(getSelectedCells());
      if (text === null) return;
      event.preventDefault();
      event.clipboardData.setData('text/plain', text);
    };
    const cutSelection = (event: ClipboardEvent) => {
      if (!event.clipboardData || isTextInput(event.target)) return;
      const cells = getSelectedCells();
      const text = getSelectionText(cells);
      if (text === null || pasteInProgress) return;
      event.preventDefault();
      event.clipboardData.setData('text/plain', text);
      clearSelectedCells(cells);
    };
    const handleClipboardShortcut = (event: KeyboardEvent) => {
      if (isTextInput(event.target)) return;
      const key = event.key.toLowerCase();
      if (!event.metaKey && !event.ctrlKey && !event.altKey && (key === 'backspace' || key === 'delete')) {
        const cells = getSelectedCells();
        if (!cells.some((row) => row.length)) return;
        event.preventDefault();
        clearSelectedCells(cells);
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (key === 'c') {
        const text = getSelectionText(getSelectedCells());
        if (text === null) return;
        if (!navigator.clipboard?.writeText) return;
        event.preventDefault();
        void navigator.clipboard.writeText(text).catch((error: unknown) => {
          setSaveState({ status: 'error', message: `复制失败：${errorMessage(error)}` });
        });
      } else if (key === 'x') {
        const cells = getSelectedCells();
        const text = getSelectionText(cells);
        if (text === null || pasteInProgress || !navigator.clipboard?.writeText) return;
        const doc = documentRef.current;
        const revision = revisionRef.current;
        event.preventDefault();
        void navigator.clipboard.writeText(text).then(() => {
          if (documentRef.current === doc && revisionRef.current === revision) clearSelectedCells(cells);
        }).catch((error: unknown) => {
          setSaveState({ status: 'error', message: `剪切失败：${errorMessage(error)}` });
        });
      } else if (key === 'v') {
        if (!navigator.clipboard?.readText) return;
        event.preventDefault();
        void navigator.clipboard.readText().then((text) => {
          const pastedRows = parseClipboardRows(text);
          if (pastedRows) pasteIntoRange(pastedRows);
          else setSaveState({ status: 'error', message: '无法将剪贴板内容粘贴到当前选区。' });
        }).catch((error: unknown) => {
          setSaveState({ status: 'error', message: `读取剪贴板失败：${errorMessage(error)}` });
        });
      }
    };
    table.element.addEventListener('copy', copySelection);
    table.element.addEventListener('cut', cutSelection);
    table.element.addEventListener('keydown', handleClipboardShortcut);
    return () => {
      table.element.removeEventListener('copy', copySelection);
      table.element.removeEventListener('cut', cutSelection);
      table.element.removeEventListener('keydown', handleClipboardShortcut);
      void table.destroy();
    };
  }, [state]);

  async function parseWithDelimiter(delimiter: string, text: string) {
    const requestId = ++requestRef.current;
    setState({ status: 'loading' });
    try {
      const reply = await parseInWorker(text, delimiter, (worker, finished) => {
        if (worker) workerRef.current = worker;
        else if (workerRef.current === finished) workerRef.current = null;
      });
      if (requestRef.current !== requestId) return;
      if (reply.kind === 'parsed') {
        documentRef.current = reply.data;
        savedTextRef.current = text;
        newlineRef.current = text.includes('\r\n') ? '\r\n' : text.includes('\r') ? '\r' : '\n';
        finalNewlineRef.current = /(?:\r\n|\r|\n)$/.test(text);
        bomRef.current = text.startsWith('\uFEFF');
        revisionRef.current = 0;
        setSaveState({ status: 'idle' });
        setState({ status: 'ready', data: reply.data });
      }
      else if (reply.kind === 'error') setState({ status: 'error', message: reply.message });
      else setState({ status: 'error', message: reply.message });
    } catch (error) {
      if (requestRef.current === requestId) setState({ status: 'error', message: errorMessage(error) });
    } finally {
      workerRef.current = null;
    }
  }

  if (state.status === 'loading') return <div className="csv-preview__status">正在读取 CSV…</div>;
  if (state.status === 'error') {
    return <div className="csv-preview__status csv-preview__error" role="alert">无法显示 CSV：{state.message}</div>;
  }
  if (state.status === 'choosing-delimiter') {
    return (
      <div className="csv-preview__status csv-preview__delimiter" role="group" aria-label="选择 CSV 分隔符">
        <div>
          <strong>无法自动判断分隔符</strong>
          <p>请选择此文件使用的分隔符，再继续预览。</p>
        </div>
        <select aria-label="分隔符" value={state.delimiter} onChange={(event) => setState({ ...state, delimiter: event.target.value })}>
          <option value=",">逗号 (,)</option>
          <option value=";">分号 (;)</option>
          <option value="\t">Tab</option>
        </select>
        <button type="button" onClick={() => { void parseWithDelimiter(state.delimiter, state.text); }}>继续</button>
      </div>
    );
  }

  return (
    <section className="csv-preview" aria-label="CSV 表格预览">
      <header className="csv-preview__toolbar">
        <span>{(state.data.rows.length + 1).toLocaleString()} 行</span>
        <span>{state.data.headers.length.toLocaleString()} 列</span>
        <span>分隔符：{state.data.delimiter === '\t' ? 'Tab' : state.data.delimiter}</span>
        {saveState.status === 'saving' && <span className="csv-preview__modified">正在自动保存…</span>}
        {saveState.status === 'saved' && <span>已自动保存</span>}
        <span className="csv-preview__readonly">双击编辑 · ⌘/Ctrl+C 复制 · ⌘/Ctrl+X 剪切 · ⌘/Ctrl+V 粘贴 · Delete/Backspace 清空</span>
      </header>
      {saveState.status === 'error' && <div className="csv-preview__save-error" role="alert">{saveState.message}{saveState.retryable && <> <button type="button" onClick={() => { void saveCurrentDocument(); }}>重试保存</button></>}</div>}
      <div className="csv-preview__table" ref={hostRef} />
    </section>
  );
}
