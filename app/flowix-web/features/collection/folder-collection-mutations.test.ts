import { beforeEach, expect, it, vi } from 'vitest';
import { externalDocuments } from '@platform/tauri/client';
import { createFolderHybridCollectionContent, removeCollectionView, renameCollectionView } from './folder-collection';
import { parseHybridCollection, serializeHybridCollectionDocument } from './model';

const io = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('@platform/tauri/client', () => ({
  files: { read: io.read },
  externalDocuments: { write: io.write },
}));

const PATH = '/book/项目/.index.yaml';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(externalDocuments.write).mockImplementation(async ({ filePath, content }) => ({ status: 'saved', path: filePath, content }));
});

it('replays a view rename on the freshest content when another entry wrote first', async () => {
  const source = createFolderHybridCollectionContent('项目', '项目', ['notes']);
  const viewId = parseHybridCollection(source).payload.views.items[0].id;
  // 另一个入口抢先改了同一个文件：磁盘内容已经不是我们读到的那份。
  const freshDocument = parseHybridCollection(source);
  freshDocument.payload.views.items[0].name = '别人的名字';
  const fresh = serializeHybridCollectionDocument(freshDocument);
  const stale = parseHybridCollection(fresh);
  stale.payload.views.items[0].name = '旧名字';
  const staleSource = serializeHybridCollectionDocument(stale);

  io.read.mockResolvedValueOnce(staleSource).mockResolvedValue(fresh);
  io.write.mockResolvedValueOnce({ status: 'conflict', diskContent: fresh })
    .mockImplementationOnce(async ({ content }) => ({ status: 'saved', content }));

  const summary = await renameCollectionView(PATH, '/book', viewId, '新名字');

  expect(summary.views.find((view) => view.id === viewId)?.name).toBe('新名字');
  expect(io.write).toHaveBeenCalledTimes(2);
  // 第二笔写必须基于重读到的内容做 CAS，否则会覆盖掉别人的改动。
  expect(vi.mocked(externalDocuments.write).mock.calls[1][0]).toMatchObject({ expectedContent: fresh });
});

it('does not write when the view being removed is already gone', async () => {
  io.read.mockResolvedValue(createFolderHybridCollectionContent('项目', '项目', ['notes']));

  const summary = await removeCollectionView(PATH, '/book', 'view_missing');

  expect(io.write).not.toHaveBeenCalled();
  expect(summary.views).toHaveLength(1);
});
