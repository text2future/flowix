import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { createMediaLibrary, parseMediaLibrary, serializeMediaLibrary, type MediaLibraryDocument } from '@features/media-library/model';
import { createWorkDocumentsCollection } from '@features/work-documents/model';
import { createTableDocument } from '@features/multidimensional-table/model';
import {
  collectionSourceDomain,
  createCollectionMetadata,
  serializeHybridCollectionDocument,
  type HybridCollectionDocument,
} from './model';
import {
  useCollectionDocumentSession,
  type CollectionDocumentCodec,
  type CollectionDocumentSession,
  type CollectionDocumentSessionOptions,
} from './use-collection-document-session';

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), toastError: vi.fn() }));

vi.mock('@platform/tauri/client', () => ({
  files: { read: mocks.read },
  externalDocuments: { read: mocks.read, write: mocks.write },
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.toastError, success: vi.fn() } }));

/** 图墙的格式能力：hybrid 里本域是 `media`。 */
const CODEC: CollectionDocumentCodec<MediaLibraryDocument> = {
  parse: parseMediaLibrary,
  serialize: serializeMediaLibrary,
  collectionId: (document) => document.collection.id,
  revision: (document) => document.collection.revision,
  sourceDomain: (content) => collectionSourceDomain(content, 'media_library'),
};

/** 同时带 notes / media / work_documents 三个域的 hybrid 来源（v3）。 */
function hybridSource(): string {
  const source = { scope: 'containing_folder' as const, depth: 'direct_children' as const };
  const table = createTableDocument('table', '项目', 'folder');
  table.dataset.source = source;
  const media = createMediaLibrary('项目');
  media.collection.placement = 'folder';
  media.dataset.source = { ...source, depth: 'descendants' as const };
  const work = createWorkDocumentsCollection('项目');
  work.collection.placement = 'folder';
  work.dataset.source = { ...source, depth: 'descendants' as const };
  const document: HybridCollectionDocument = {
    format: 'flowix.collection',
    schema_version: 3,
    collection: createCollectionMetadata('hybrid', '项目', 'folder'),
    payload: {
      schema_version: 3,
      file_tree: true,
      domains: { notes: table.dataset, media: media.dataset, work_documents: work.dataset },
      views: {
        default_by_domain: {
          notes: table.views.default_id,
          media: media.views.default_id,
          work_documents: work.views.default_id,
        },
        items: [
          ...table.views.items.map((view) => ({ ...view, domain: 'notes' as const })),
          ...media.views.items.map((view) => ({ ...view, domain: 'media' as const })),
          ...work.views.items.map((view) => ({ ...view, domain: 'work_documents' as const })),
        ],
      },
    },
  };
  return serializeHybridCollectionDocument(document);
}

function primaryView(source: string): string {
  return parseMediaLibrary(source).views.default_id;
}

const baseOptions = (overrides: Partial<CollectionDocumentSessionOptions<MediaLibraryDocument>> = {}) => ({
  filePath: '/book/library.lib.yaml',
  notebookPath: '/book',
  notebookId: 'book',
  codec: CODEC,
  loadErrorKey: 'errors.friendly.mediaLoad' as const,
  saveErrorKey: 'errors.friendly.tableViewSave' as const,
  missingScopeMessage: 'missing-scope',
  missingFileMessage: 'missing-file',
  ...overrides,
});

let root: Root | undefined;
let session: CollectionDocumentSession<MediaLibraryDocument> | null = null;

function Probe({ options }: { options: CollectionDocumentSessionOptions<MediaLibraryDocument> }) {
  session = useCollectionDocumentSession(options);
  return null;
}

async function mount(options: CollectionDocumentSessionOptions<MediaLibraryDocument>): Promise<void> {
  const node = document.createElement('div');
  root = createRoot(node);
  await act(async () => root?.render(<Probe options={options} />));
  await act(async () => { await Promise.resolve(); });
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  session = null;
  vi.clearAllMocks();
});

beforeEach(() => {
  mocks.write.mockImplementation(async ({ content }: { content: string }) => ({ status: 'saved', content }));
});

describe('useCollectionDocumentSession', () => {
  it('keeps a renamed collection visible while refreshing its new path, but loads a different identity', async () => {
    const source = serializeMediaLibrary(createMediaLibrary('Library'));
    const id = parseMediaLibrary(source).collection.id;
    mocks.read.mockResolvedValue(source);
    await mount(baseOptions({ expectedCollectionId: id }));
    let finish!: (content: string) => void;
    mocks.read.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => root?.render(<Probe options={baseOptions({ filePath: '/book/renamed.lib.yaml', expectedCollectionId: id })} />));
    expect(session?.loading).toBe(false);
    expect(session?.document?.collection.id).toBe(id);
    await act(async () => finish(source));
    await act(async () => root?.render(<Probe options={baseOptions({ filePath: '/book/other.lib.yaml', expectedCollectionId: 'other' })} />));
    expect(session?.loading).toBe(true);
  });

  it('只读会话不迁移旧格式，也拒绝直接写入和持锁任务', async () => {
    const migrate = vi.fn(serializeMediaLibrary);
    const document = createMediaLibrary('readonly');
    mocks.read.mockResolvedValue(JSON.stringify({ format: 'flowix.collection', schema_version: 1,
      collection: document.collection, payload: { schema_version: 1,
        view: { id: document.views.default_id, layout: 'waterfall' }, records: { data: [] } } }));
    await mount(baseOptions({ editable: false, codec: { ...CODEC, migrate } }));
    expect(session?.document).not.toBeNull();
    expect(migrate).not.toHaveBeenCalled();
    expect(await session!.persistMutation((current) => current)).toBe(false);
    const task = vi.fn(async () => true);
    expect(await session!.runSaveLocked(task)).toBe(false);
    expect(task).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('hybrid 来源写回按域合并，兄弟数据域原样保留', async () => {
    const source = hybridSource();
    mocks.read.mockResolvedValue(source);
    await mount(baseOptions());
    expect(session?.document?.collection.type).toBe('media_library');

    await act(async () => {
      await session?.persistMutation((current) => ({
        ...current,
        collection: { ...current.collection, revision: current.collection.revision + 1 },
        views: { ...current.views, default_id: primaryView(source) },
      }));
    });

    const written = YAML.parse(mocks.write.mock.calls[0][0].content) as {
      schema_version: number;
      payload: { domains: Record<string, unknown>; views: { items: { domain: string }[] } };
    };
    // 仍是 hybrid：其它两个域没有被 v2 序列化抹掉。
    expect(written.schema_version).toBe(3);
    expect(Object.keys(written.payload.domains).sort()).toEqual(['media', 'notes', 'work_documents']);
    expect(written.payload.views.items.some((view) => view.domain === 'notes')).toBe(true);
  });

  it('v1/v2 单类型来源写回走 codec 自己的序列化（不产出 hybrid）', async () => {
    mocks.read.mockResolvedValue(serializeMediaLibrary(createMediaLibrary('Library')));
    await mount(baseOptions());
    expect(session?.document?.collection.type).toBe('media_library');

    await act(async () => {
      await session?.persistMutation((current) => ({ ...current, collection: { ...current.collection, revision: 2 } }));
    });

    const written = YAML.parse(mocks.write.mock.calls[0][0].content) as { schema_version: number };
    expect(written.schema_version).toBe(2);
  });

  it('冲突且策略为 retry-once：拿磁盘版重放一次，用户不被告知', async () => {
    const source = serializeMediaLibrary(createMediaLibrary('Library'));
    mocks.read.mockResolvedValue(source);
    await mount(baseOptions());

    // 别人先写入了 revision 2，我们的基线仍是 1。
    const disk = serializeMediaLibrary({
      ...parseMediaLibrary(source),
      collection: { ...parseMediaLibrary(source).collection, revision: 2 },
    });
    mocks.write
      .mockResolvedValueOnce({ status: 'conflict', diskContent: disk })
      .mockImplementation(async ({ content }: { content: string }) => ({ status: 'saved', content }));

    let saved = false;
    await act(async () => {
      saved = await session!.persistMutation((current) => ({
        ...current,
        collection: { ...current.collection, revision: current.collection.revision + 1 },
      }));
    });

    expect(saved).toBe(true);
    expect(mocks.write).toHaveBeenCalledTimes(2);
    // 重放用的是磁盘版基线（revision 2 → 3），不是我们陈旧的 1 → 2。
    expect(parseMediaLibrary(mocks.write.mock.calls[1][0].content).collection.revision).toBe(3);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('冲突两次：载入磁盘最新版、报错并让 flush 失败', async () => {
    const source = serializeMediaLibrary(createMediaLibrary('Library'));
    mocks.read.mockResolvedValue(source);
    await mount(baseOptions());

    const disk = serializeMediaLibrary({
      ...parseMediaLibrary(source),
      collection: { ...parseMediaLibrary(source).collection, revision: 2 },
    });
    mocks.write.mockResolvedValue({ status: 'conflict', diskContent: disk });

    let saved = true;
    await act(async () => {
      saved = await session!.persistMutation((current) => ({
        ...current,
        collection: { ...current.collection, revision: current.collection.revision + 1 },
      }));
    });

    expect(saved).toBe(false);
    expect(mocks.write).toHaveBeenCalledTimes(2);
    expect(session?.document?.collection.revision).toBe(2);
    expect(mocks.toastError).toHaveBeenCalledWith('collection.save.conflictReloaded');
    await expect(session!.flush()).resolves.toBe(false);
  });

  it('没有 notebook 作用域时直接给提示，不读盘', async () => {
    mocks.read.mockResolvedValue(null);
    await mount(baseOptions({ notebookPath: null }));
    expect(session?.error).toBe('missing-scope');
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('集合身份与期望不符时拒绝打开路径里的替代文件', async () => {
    mocks.read.mockResolvedValue(serializeMediaLibrary(createMediaLibrary('Library')));
    await mount(baseOptions({ expectedCollectionId: 'someone-else' }));
    expect(session?.document).toBeNull();
    expect(session?.error).not.toBeNull();
  });
});
