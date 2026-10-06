import { parseTableDocument } from './model';

self.addEventListener('message', (event: MessageEvent<{ id: number; source: string }>) => {
  const { id, source } = event.data;
  try {
    self.postMessage({ id, ok: true, value: parseTableDocument(source) });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
