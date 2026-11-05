import { beforeEach, expect, it, vi } from 'vitest';
import { subscribeCollectionContent, type CollectionContentChange } from './content-events';
import { CollectionDocumentWriteError, createCollectionDocument, mutateCollectionDocument } from './document-gateway';

const io = vi.hoisted(() => ({ read: vi.fn(), create: vi.fn(), write: vi.fn() }));
vi.mock('@platform/tauri/client', () => ({ files: { read: io.read, create: io.create }, externalDocuments: { write: io.write } }));

const INDEX = '/book/project/.index.yaml';

function record() {
  const seen: CollectionContentChange[] = [];
  const stop = subscribeCollectionContent((change) => seen.push(change));
  return { seen, stop };
}

beforeEach(() => {
  vi.resetAllMocks();
  io.write.mockImplementation(async ({ content }: { content: string }) => ({ status: 'saved', content }));
});

it('broadcasts the saved content so every mounted copy can follow without a reload', async () => {
  io.read.mockResolvedValue('old');
  const { seen, stop } = record();
  try {
    const { content } = await mutateCollectionDocument({
      indexPath: INDEX, notebookPath: '/book',
      mutate: () => ({ content: 'new', result: null }),
    });
    expect(content).toBe('new');
    expect(seen).toEqual([{ indexPath: INDEX, notebookPath: '/book', content: 'new' }]);
  } finally { stop(); }
});

it('a conflicting write throws and broadcasts nothing', async () => {
  io.read.mockResolvedValue('old');
  io.write.mockResolvedValue({ status: 'conflict' });
  const { seen, stop } = record();
  try {
    await expect(mutateCollectionDocument({
      indexPath: INDEX, notebookPath: '/book',
      mutate: () => ({ content: 'new', result: null }),
    })).rejects.toThrow('集合文件已变化');
    expect(seen).toHaveLength(0);
  } finally { stop(); }
});

it('replays the mutation once against newer disk content before giving up', async () => {
  io.read.mockResolvedValue('v1');
  io.write
    .mockResolvedValueOnce({ status: 'conflict', diskContent: 'v2' })
    .mockImplementationOnce(async ({ content }: { content: string }) => ({ status: 'saved', content }));

  const writes: string[] = [];
  const { content, result } = await mutateCollectionDocument({
    indexPath: INDEX, notebookPath: '/book',
    mutate: (source) => { writes.push(source); return { content: `${source}+view`, result: source }; },
  });

  expect(writes).toEqual(['v1', 'v2']);
  expect(content).toBe('v2+view');
  expect(result).toBe('v2');
});

it('writes nothing when the mutation is a no-op, but still returns the result', async () => {
  io.read.mockResolvedValue('v1');
  const { seen, stop } = record();
  try {
    const { content, result } = await mutateCollectionDocument({
      indexPath: INDEX, notebookPath: '/book',
      mutate: (source) => ({ content: source, result: 'unchanged' as const }),
    });
    expect(content).toBe('v1');
    expect(result).toBe('unchanged');
    expect(io.write).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  } finally { stop(); }
});

it('reports a missing collection file as a typed write error', async () => {
  io.read.mockResolvedValue(null);
  await expect(mutateCollectionDocument({ indexPath: INDEX, notebookPath: '/book', mutate: (source) => ({ content: source, result: null }) }))
    .rejects.toBeInstanceOf(CollectionDocumentWriteError);
});

it('a created collection file is broadcast too', async () => {
  const { seen, stop } = record();
  try {
    const content = await createCollectionDocument({ indexPath: INDEX, notebookPath: '/book', content: 'fresh' });
    expect(content).toBe('fresh');
    expect(io.create).toHaveBeenCalledWith(INDEX, 'fresh', '/book');
    expect(seen.map((change) => change.content)).toEqual(['fresh']);
  } finally { stop(); }
});

it('a failing consumer neither breaks the write nor other consumers', async () => {
  io.read.mockResolvedValue('old');
  const seen: string[] = [];
  const stopBad = subscribeCollectionContent(() => { throw new Error('consumer boom'); });
  const stopGood = subscribeCollectionContent((change) => seen.push(change.content));
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const { content } = await mutateCollectionDocument({
      indexPath: INDEX, notebookPath: '/book',
      mutate: () => ({ content: 'new', result: null }),
    });
    expect(content).toBe('new');
    expect(seen).toEqual(['new']);
    expect(spy).toHaveBeenCalled();
  } finally { stopBad(); stopGood(); spy.mockRestore(); }
});
