import { parseTableDocument, type MultidimensionalTableDocument } from './model';

const WORKER_THRESHOLD = 128 * 1024;
let worker: Worker | null = null;
let nextRequestId = 0;
const pending = new Map<number, { resolve: (value: MultidimensionalTableDocument) => void; reject: (error: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./table-parser.worker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (event: MessageEvent<{ id: number; ok: boolean; value?: MultidimensionalTableDocument; error?: string }>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if (event.data.ok && event.data.value) request.resolve(event.data.value);
    else request.reject(new Error(event.data.error ?? '无法解析多维表格'));
  });
  worker.addEventListener('error', (event) => {
    const error = new Error(event.message || '多维表格解析线程异常');
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    worker?.terminate();
    worker = null;
  });
  return worker;
}

/** Keep large YAML parsing and validation off the UI thread. */
export function parseTableDocumentAsync(source: string): Promise<MultidimensionalTableDocument> {
  const sourceBytes = new TextEncoder().encode(source).byteLength;
  if (sourceBytes < WORKER_THRESHOLD || typeof Worker === 'undefined') {
    return Promise.resolve().then(() => parseTableDocument(source));
  }
  return new Promise((resolve, reject) => {
    const id = ++nextRequestId;
    pending.set(id, { resolve, reject });
    try {
      getWorker().postMessage({ id, source });
    } catch (error) {
      pending.delete(id);
      try { resolve(parseTableDocument(source)); } catch (parseError) { reject(parseError instanceof Error ? parseError : error); }
    }
  });
}
