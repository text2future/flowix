import { beforeEach, expect, it, vi } from 'vitest';
import { externalDocuments, files } from '@platform/tauri/client';
import { createFolderHybridCollectionContent, reorderCollectionViews } from './folder-collection';
import { parseHybridCollection } from './model';

const io = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('@platform/tauri/client', () => ({
  files: { read: io.read },
  externalDocuments: { write: io.write },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(externalDocuments.write).mockImplementation(async ({ filePath, content }) => ({ status: 'saved', path: filePath, content }));
});

it('persists a reordered shared view list without changing domain defaults or datasets', async () => {
  const source = createFolderHybridCollectionContent('项目', '项目', ['notes', 'media']);
  const original = parseHybridCollection(source);
  const noteView = original.payload.views.items.find((view) => view.domain === 'notes')!;
  const mediaView = original.payload.views.items.find((view) => view.domain === 'media')!;
  vi.mocked(files.read).mockResolvedValue(source);

  const summary = await reorderCollectionViews('/book/项目/.index.yaml', '/book', [mediaView.id, noteView.id]);

  expect(summary.views.map((view) => view.id)).toEqual([mediaView.id, noteView.id]);
  const write = vi.mocked(externalDocuments.write).mock.calls[0][0];
  expect(write).toMatchObject({ filePath: '/book/项目/.index.yaml', scopePath: '/book', expectedContent: source });
  const reordered = parseHybridCollection(write.content);
  expect(reordered.payload.views.default_by_domain).toEqual(original.payload.views.default_by_domain);
  expect(reordered.payload.domains).toEqual(original.payload.domains);
});
