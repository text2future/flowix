import Papa, { type ParseError } from 'papaparse';

const MAX_ROWS = 100_000;
const MAX_COLUMNS = 200;
const MAX_CELLS = 500_000;
const MAX_CELL_BYTES = 256 * 1024;
const ALLOWED_DELIMITERS = [',', ';', '\t'] as const;
const utf8Encoder = new TextEncoder();

type ParseRequest = { id: number; text: string; delimiter?: string };
type ParsedCsv = { headers: string[]; rows: string[][]; delimiter: string };
type ParseReply =
  | { id: number; kind: 'parsed'; data: ParsedCsv }
  | { id: number; kind: 'choose-delimiter'; message: string }
  | { id: number; kind: 'error'; message: string };

function stripOneTrailingRecordTerminator(text: string): string {
  const ending = text.endsWith('\r\n') ? '\r\n' : text.endsWith('\n') ? '\n' : text.endsWith('\r') ? '\r' : '';
  if (!ending) return text;

  let quoted = false;
  for (let index = 0; index < text.length - ending.length; index += 1) {
    if (text[index] !== '"') continue;
    if (quoted && text[index + 1] === '"') {
      index += 1;
      continue;
    }
    quoted = !quoted;
  }
  return quoted ? text : text.slice(0, -ending.length);
}

function parse(text: string, delimiter?: string): ParsedCsv | 'choose-delimiter' {
  const source = stripOneTrailingRecordTerminator(text);
  const records: string[][] = [];
  const errors: ParseError[] = [];
  const resourceErrors: string[] = [];
  let detectedDelimiter = delimiter ?? '';
  let cellCount = 0;
  let parsedRows = 0;

  Papa.parse<string[]>(source, {
    header: false,
    dynamicTyping: false,
    skipEmptyLines: false,
    ...(delimiter ? { delimiter } : {}),
    step(result, parser) {
      const row = result.data;
      if (!detectedDelimiter) detectedDelimiter = result.meta.delimiter;
      errors.push(...result.errors);
      if (resourceErrors.length) {
        parser.abort();
        return;
      }
      parsedRows += 1;
      if (parsedRows > MAX_ROWS + 1) resourceErrors.push(`CSV 超过 ${MAX_ROWS.toLocaleString()} 条数据记录上限。`);
      if (row.length > MAX_COLUMNS) resourceErrors.push(`CSV 超过 ${MAX_COLUMNS} 列上限。`);
      cellCount += row.length;
      if (cellCount > MAX_CELLS) resourceErrors.push(`CSV 超过 ${MAX_CELLS.toLocaleString()} 个单元格上限。`);
      for (const value of row) {
        if (utf8Encoder.encode(value).byteLength > MAX_CELL_BYTES) {
          resourceErrors.push(`单元格内容超过 ${MAX_CELL_BYTES / 1024} KiB 上限。`);
          break;
        }
      }
      if (!resourceErrors.length) records.push(row);
      else parser.abort();
    },
  });

  if (resourceErrors.length) throw new Error(resourceErrors[0]);
  if (!delimiter && (!ALLOWED_DELIMITERS.includes(detectedDelimiter as typeof ALLOWED_DELIMITERS[number])
    || errors.some((error) => error.code === 'UndetectableDelimiter'))) {
    return 'choose-delimiter';
  }
  const parseError = errors.find((error) => error.code !== 'UndetectableDelimiter');
  if (parseError) throw new Error(`第 ${(parseError.row ?? 0) + 1} 条记录解析失败：${parseError.message}`);
  if (!records.length || (records.length === 1 && records[0].length === 1 && records[0][0] === '')) {
    throw new Error('CSV 文件为空，无法显示表格。');
  }

  const headers = records[0];
  if (!headers.length) throw new Error('CSV 文件没有表头。');
  if (headers.length > MAX_COLUMNS) throw new Error(`CSV 超过 ${MAX_COLUMNS} 列上限。`);
  for (let index = 1; index < records.length; index += 1) {
    if (records[index].length !== headers.length) {
      throw new Error(`第 ${index + 1} 条记录有 ${records[index].length} 列，表头有 ${headers.length} 列。`);
    }
  }
  return { headers, rows: records.slice(1), delimiter: detectedDelimiter || ',' };
}

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  const { id, text, delimiter } = event.data;
  let reply: ParseReply;
  try {
    const result = parse(text, delimiter);
    reply = result === 'choose-delimiter'
      ? { id, kind: 'choose-delimiter', message: '无法可靠判断分隔符，请选择 CSV 使用的分隔符。' }
      : { id, kind: 'parsed', data: result };
  } catch (error) {
    reply = { id, kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage(reply);
};
