import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Resolver tests for the embedded-page data bridge.
 *
 * This is the only place where the workbench scenario can actually break: the
 * page renders whatever these resolvers return. Everything here is mocked at
 * the Tauri client boundary, so the tests describe the wire payload contract
 * (fields, joins, truncation, error codes) rather than native behaviour.
 */
const mocks = vi.hoisted(() => ({
  collectionList: vi.fn(),
  read: vi.fn(),
  listDocumentPage: vi.fn(),
  listWorkDocumentsPage: vi.fn(),
  noteList: vi.fn(),
  usedTagIds: vi.fn(),
  backgroundStatus: vi.fn(),
  allTags: vi.fn(),
  customViews: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('@/lib/logger', () => {
  const noop = () => {};
  return { createLogger: () => ({ debug: noop, info: noop, warn: mocks.logWarn, error: noop }) };
});

vi.mock('@platform/tauri/client', () => ({
  collections: { list: mocks.collectionList },
  externalDocuments: { read: mocks.read },
  files: { listDocumentPage: mocks.listDocumentPage, listWorkDocumentsPage: mocks.listWorkDocumentsPage },
  memos: { getUsedTagIds: mocks.usedTagIds },
  notebooks: { getBackgroundStatus: mocks.backgroundStatus },
  notes: { list: mocks.noteList },
  system: { getCustomViews: mocks.customViews },
  tags: { getAll: mocks.allTags },
}));

import {
  invalidateHtmlDataCache,
  resolveHtmlDataRequest,
  type HtmlDataContext,
  type HtmlDataStats,
  type HtmlDataViews,
  type HtmlViewData,
} from './html-data-bridge';
import { HtmlEmbedError } from '@/lib/html-embed-api';
import { serializeTableDocument } from '@features/multidimensional-table/public/create-api';
import { tableDocument, tableSource, hybridSource, mediaLibrarySource, workDocumentsSource } from './html-data-bridge.fixtures';

const ROOT = '/library/工作';
const ctx: HtmlDataContext = { notebookId: 'nb-1', scopePath: ROOT };

const collectionEntry = (overrides: Record<string, unknown> = {}) => ({
  indexSequence: 0,
  relativePath: '项目/.index.yaml',
  collectionId: 'col-1',
  collectionType: 'table' as const,
  name: '项目',
  schemaVersion: 1,
  payloadSchemaVersion: 1,
  revision: 1,
  properties: {},
  createdAt: null,
  updatedAt: null,
  modifiedMs: 0,
  inViews: true,
  identityConflict: false,
  ...overrides,
});

const noteEntry = (relativePath: string, overrides: Record<string, unknown> = {}) => ({
  relativePath,
  title: relativePath.replace(/\.md$/, ''),
  preview: '',
  thumbnail: null,
  tags: ['#idea'],
  todos: [],
  agents: [],
  createdAt: 1,
  updatedAt: 1_799_990_000_000,
  favorited: false,
  icon: null,
  colors: [],
  properties: { status: '进行中' },
  ...overrides,
});

/** The `flowix://open` link the link bridge resolves inside HTML previews. */
const openLink = (path: string) => `flowix://open?notebookId=nb-1&f=${encodeURIComponent(path)}`;

/**
 * A dataset collection **without** a valid envelope (`format` / `collection` /
 * `schema_version` are missing), which is deliberate: the strict per-type
 * parsers reject it, so every test using this fixture exercises the degradation
 * path that answers from `dataset.records.include`. Adding the missing envelope
 * fields would silently move those tests onto the real table reader and leave
 * the fallback untested. Use `tableSource()` from the fixtures module when a
 * test needs a real table.
 */
const datasetDocument = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  payload: {
    views: {
      default_id: 'v1',
      items: [
        { id: 'v1', name: '全部', layout: 'table' },
        { id: 'v2', name: '按状态', layout: 'board' },
      ],
    },
    dataset: {
      schema: { fields: [
        { id: 'f1', name: '状态', type: 'text', property_key: 'status' },
        // Schema v2/v3 carry no `name`; the label is the property key.
        { id: 'f2', type: 'Text', property_key: '负责人' },
        { id: 'f3', type: 'primary', property_key: 'note' },
      ] },
      records: {
        include: [
          { id: 'r1', note_path: '项目/a.md' },
          { id: 'r2', note_path: '项目/b.md' },
          { id: 'r3', note_path: '项目/missing.md' },
        ],
      },
    },
    ...overrides,
  },
});

beforeEach(() => {
  vi.resetAllMocks();
  invalidateHtmlDataCache();
  mocks.collectionList.mockResolvedValue([]);
});

describe('notebook-stats', () => {
  it('maps tag ids to names and derives bar widths from the largest count', async () => {
    mocks.usedTagIds.mockResolvedValue({
      totalMemoCount: 12, agentMemoCount: 3, todoMemoCount: 5,
      tagCounts: [
        { tagId: 't1', count: 6 },
        { tagId: 't2', count: 3 },
        { tagId: 't3', count: 0 },
      ],
    });
    mocks.backgroundStatus.mockResolvedValue([{ notebookId: 'nb-1', memoCount: 128 }]);
    mocks.allTags.mockResolvedValue({ tags: [{ id: 't1', name: '#进行中' }, { id: 't2', name: '#idea' }, { id: 't3', name: '#归档' }] });

    const payload = await resolveHtmlDataRequest('notebook-stats', ctx) as HtmlDataStats;

    expect(payload).toEqual({
      notebookId: 'nb-1',
      totalMemos: 12,
      databaseCount: 0,
      todoMemos: 5,
      memoCount: 128,
      topTags: [
        { name: '#进行中', count: 6, barWidth: '100%' },
        { name: '#idea', count: 3, barWidth: '50%' },
        { name: '#归档', count: 0, barWidth: '2%' },
      ],
    });
  });

  it('reports an unknown index as null instead of failing the page', async () => {
    mocks.usedTagIds.mockResolvedValue({ totalMemoCount: 0, agentMemoCount: 0, todoMemoCount: 0, tagCounts: [] });
    mocks.backgroundStatus.mockResolvedValue([]);
    mocks.allTags.mockRejectedValue(new Error('tag store offline'));

    const payload = await resolveHtmlDataRequest('notebook-stats', ctx) as HtmlDataStats;

    expect(payload.memoCount).toBeNull();
    expect(payload.topTags).toEqual([]);
  });
});

describe('notebook-views', () => {
  it('publishes view ids and the default view of each collection', async () => {
    mocks.collectionList.mockResolvedValue([collectionEntry()]);
    mocks.read.mockResolvedValue(datasetDocument());

    const payload = await resolveHtmlDataRequest('notebook-views', ctx) as HtmlDataViews;

    expect(payload.collections).toEqual([{
      name: '项目',
      type: 'table',
      relativePath: '项目/.index.yaml',
      // The card is clickable because the bridge hands back the deep link the
      // preview's link bridge already resolves.
      href: openLink('项目/.index.yaml'),
      inViews: true,
      identityConflict: false,
      viewsAvailable: true,
      defaultViewId: 'v1',
      views: [{ id: 'v1', name: '全部', layout: 'table' }, { id: 'v2', name: '按状态', layout: 'board' }],
      // Three records pinned inline; a page can pick its default card without
      // probing every collection with a one-row request.
      rowCount: 3,
    }]);
  });

  it('reports an unknown row count instead of zero for query-driven collections', async () => {
    mocks.collectionList.mockResolvedValue([collectionEntry({ relativePath: '工作文档.index.yaml', name: '工作文档' })]);
    // Filter-driven: `records.include` is empty, rows come from running the filter.
    mocks.read.mockResolvedValue(JSON.stringify({
      payload: {
        dataset: {
          schema: { fields: [] },
          records: { include: [] },
          filter: { path: '', match: 'all', conditions: [{ field: 'kind', op: 'eq', value: 'web' }] },
        },
        views: { default_id: 'v1', items: [{ id: 'v1', name: '工作文档', layout: 'gallery' }] },
      },
    }));

    const payload = await resolveHtmlDataRequest('notebook-views', ctx) as HtmlDataViews;

    expect(payload.collections[0].rowCount).toBeNull();
    expect(payload.collections[0].viewsAvailable).toBe(true);
  });

  it('degrades one broken collection file to an empty view list, not a failed request', async () => {
    mocks.collectionList.mockResolvedValue([collectionEntry(), collectionEntry({ relativePath: '坏/.index.yaml', name: '坏' })]);
    mocks.read.mockImplementation(async (path: string) => {
      if (path.includes('坏')) throw new Error('unreadable');
      return datasetDocument();
    });

    const payload = await resolveHtmlDataRequest('notebook-views', ctx) as HtmlDataViews;

    expect(payload.collections.map((entry) => entry.viewsAvailable)).toEqual([true, false]);
    expect(payload.collections[1].views).toEqual([]);
  });

  it.each([
    // A collection file is the only thing the deep link can reopen as a surface.
    ['a path that is not a collection file', '项目/资料'],
    // Collection files are user content: their paths must not point outside the
    // notebook, or a card would become a link into somewhere unauthorized.
    ['a path escaping the notebook', '../外部/.index.yaml'],
    ['an absolute path', '/etc/passwd/.index.yaml'],
  ])('publishes no href for %s', async (_label, relativePath) => {
    mocks.collectionList.mockResolvedValue([collectionEntry({ relativePath })]);
    mocks.read.mockResolvedValue(datasetDocument());

    const payload = await resolveHtmlDataRequest('notebook-views', ctx) as HtmlDataViews;

    expect(payload.collections[0].relativePath).toBe(relativePath);
    expect(payload.collections[0].href).toBe('');
  });
});

describe('view-data', () => {
  beforeEach(() => {
    mocks.read.mockResolvedValue(datasetDocument());
    mocks.collectionList.mockResolvedValue([collectionEntry()]);
    mocks.noteList.mockResolvedValue([
      noteEntry('项目/a.md'),
      noteEntry('项目/b.md', { title: 'B', tags: ['#x', '#y'], properties: { status: '评审中', budget: 1200 } }),
    ]);
  });

  it('joins records against the note index so rows carry titles, tags and properties', async () => {
    const payload = await resolveHtmlDataRequest('view-data', ctx, {
      relativePath: '项目/.index.yaml', viewId: 'v1', limit: 10,
    }) as HtmlViewData;

    // Name and type come from the collection index, not from the file.
    expect(payload.collection).toEqual({ name: '项目', type: 'table', relativePath: '项目/.index.yaml' });
    // `name` falls back to the property key: schema v2/v3 have no label field,
    // so a blank name would render an empty header row. `type` is lowercased
    // into the published vocabulary so a renderer can switch on it.
    expect(payload.fields).toEqual([
      { id: 'f1', name: '状态', type: 'text', propertyKey: 'status' },
      { id: 'f2', name: '负责人', type: 'text', propertyKey: '负责人' },
      { id: 'f3', name: 'note', type: 'primary', propertyKey: 'note' },
    ]);
    expect(payload.rows).toEqual([
      {
        id: 'r1', notePath: '项目/a.md', title: '项目/a', updatedAt: 1_799_990_000_000,
        tags: ['#idea'], properties: { status: '进行中' }, resolved: true, href: openLink('项目/a.md'),
      },
      {
        id: 'r2', notePath: '项目/b.md', title: 'B', updatedAt: 1_799_990_000_000,
        tags: ['#x', '#y'], properties: { status: '评审中', budget: 1200 }, resolved: true, href: openLink('项目/b.md'),
      },
      // A record whose note left the index still renders, titled by file name,
      // and says out loud that its metadata is missing.
      {
        id: 'r3', notePath: '项目/missing.md', title: 'missing', updatedAt: null,
        tags: [], properties: {}, resolved: false, href: openLink('项目/missing.md'),
      },
    ]);
    expect(payload.total).toBe(3);
    expect(payload.truncated).toBe(false);
  });

  it('truncates at the requested limit and says so', async () => {
    const payload = await resolveHtmlDataRequest('view-data', ctx, {
      relativePath: '项目/.index.yaml', limit: 2,
    }) as HtmlViewData;

    expect(payload.rows).toHaveLength(2);
    // The page can say "2 of 3" instead of just "truncated".
    expect(payload.total).toBe(3);
    expect(payload.truncated).toBe(true);
    expect(payload.viewId).toBeNull();
  });

  it('never hands back a link that escapes the notebook', async () => {
    mocks.read.mockResolvedValue(JSON.stringify({
      payload: {
        views: { items: [] },
        dataset: {
          schema: { fields: [] },
          records: { include: [{ id: 'r1', note_path: '../outside/a.md' }, { id: 'r2', note_path: '/abs/b.md' }] },
        },
      },
    }));

    const payload = await resolveHtmlDataRequest('view-data', ctx, { relativePath: '项目/.index.yaml' }) as HtmlViewData;

    expect(payload.rows.map((row) => row.href)).toEqual(['', '']);
    expect(payload.rows.every((row) => row.resolved === false)).toBe(true);
  });

  it('reads cached collection files once per content window', async () => {
    await resolveHtmlDataRequest('view-data', ctx, { relativePath: '项目/.index.yaml' });
    await resolveHtmlDataRequest('view-data', ctx, { relativePath: '项目/.index.yaml' });

    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.noteList).toHaveBeenCalledTimes(1);

    invalidateHtmlDataCache();
    await resolveHtmlDataRequest('view-data', ctx, { relativePath: '项目/.index.yaml' });
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it('shares one collection index read between the list kind and a single view', async () => {
    await resolveHtmlDataRequest('notebook-views', ctx);
    await resolveHtmlDataRequest('view-data', ctx, { relativePath: '项目/.index.yaml' });

    // A workbench always asks for both, and the index is the expensive half.
    expect(mocks.collectionList).toHaveBeenCalledTimes(1);
  });

  it('lists a folder collection through the authorized document page', async () => {
    mocks.read.mockResolvedValue(JSON.stringify({ payload: {} }));
    mocks.listDocumentPage.mockResolvedValue({
      folders: [],
      items: [{ fullPath: `${ROOT}/相册/x.png`, name: 'x.png', modifiedMs: 42 }],
      hasMore: true, nextCursor: 'next',
    });

    const payload = await resolveHtmlDataRequest('view-data', ctx, {
      relativePath: '相册/.index.yaml', limit: 1,
    }) as HtmlViewData;

    expect(mocks.listDocumentPage).toHaveBeenCalledWith({
      notebookId: 'nb-1', folderPath: `${ROOT}/相册`, cursor: null, limit: 1,
    });
    expect(payload.fields).toEqual([]);
    expect(payload.rows).toEqual([{
      id: '', notePath: '相册/x.png', title: 'x.png', updatedAt: 42, tags: [], properties: {},
      // File-tree rows have no frontmatter and no link: opening an image through
      // the note deep link would fail on click.
      resolved: false, href: '',
    }]);
    // A paged listing cannot state a total; claiming the page size would lie.
    expect(payload.total).toBeNull();
    expect(payload.truncated).toBe(true);
  });

  it('refuses anything outside the authorized scope with E_SCOPE', async () => {
    const failure = async (params: Record<string, unknown>, context: HtmlDataContext = ctx) => {
      const error = await resolveHtmlDataRequest('view-data', context, params).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(HtmlEmbedError);
      expect((error as HtmlEmbedError).code).toBe('E_SCOPE');
    };

    await failure({ relativePath: '../escape.yaml' });
    await failure({ relativePath: '项目/../../etc.yaml' });
    await failure({ relativePath: '' });
    await failure({ relativePath: '项目/.index.yaml' }, { notebookId: 'nb-1', scopePath: null });
    // A declared view id that the collection does not define is a scope miss too.
    await failure({ relativePath: '项目/.index.yaml', viewId: 'nope' });
  });

  it('separates a corrupt collection document from a scope problem', async () => {
    mocks.read.mockResolvedValue(JSON.stringify({ notPayload: true }));

    const error = await resolveHtmlDataRequest('view-data', ctx, { relativePath: '项目/.index.yaml' })
      .catch((reason: unknown) => reason);

    expect((error as HtmlEmbedError).code).toBe('E_INTERNAL');
  });
});

describe('view-data: real collection files', () => {
  /**
   * The rows a page shows have to be the rows the app shows. These fixtures are
   * produced by the product's own factories, so the bridge goes through the
   * same parsers and record rules instead of the "explicit records" fallback
   * the loose mocks above exercise.
   */
  const workDocument = (fullPath: string) => ({
    fullPath: `${ROOT}/${fullPath}`,
    name: fullPath.split('/').pop() ?? fullPath,
    resourceKind: 'other' as const,
    assetKind: 'spreadsheet' as const,
    sizeBytes: 10,
    modifiedMs: 99,
    createdMs: 1,
  });

  it('collects the rows a condition-driven table holds instead of answering zero', async () => {
    mocks.read.mockResolvedValue(tableSource({
      include: [],
      filter: { path: '项目', match: 'all', conditions: [{ field: 'file_name', op: 'contains', value: 'a' }] },
    }));
    mocks.collectionList.mockResolvedValue([collectionEntry()]);
    mocks.noteList.mockResolvedValue([
      noteEntry('项目/alpha.md'),
      noteEntry('项目/beta.md'),
      noteEntry('其它/alpha.md'),
    ]);

    const payload = await resolveHtmlDataRequest('view-data', ctx, {
      relativePath: '项目/.index.yaml', limit: 10,
    }) as HtmlViewData;

    // The path condition keeps the collection inside its own folder.
    expect(payload.rows.map((row) => row.notePath)).toEqual(['项目/alpha.md', '项目/beta.md']);
    expect(payload.total).toBe(2);
    // Collected rows still get a stable id, so a page can use it as a key.
    expect(payload.rows.map((row) => row.id)).toEqual(['note:项目/alpha.md', 'note:项目/beta.md']);
    expect(payload.rows.every((row) => row.href === openLink(row.notePath))).toBe(true);
  });

  it('applies the view filter the table surface shows', async () => {
    mocks.read.mockResolvedValue(tableSource({
      include: ['项目/a.md', '项目/b.md', '项目/c.md'],
      view: { filter: { all: [{ field: 'file_name', op: 'contains', value: 'b' }], any: [] } },
    }));
    mocks.collectionList.mockResolvedValue([collectionEntry()]);
    mocks.noteList.mockResolvedValue(['a', 'b', 'c'].map((name) => noteEntry(`项目/${name}.md`)));

    const payload = await resolveHtmlDataRequest('view-data', ctx, { relativePath: '项目/.index.yaml' }) as HtmlViewData;

    expect(payload.rows.map((row) => row.notePath)).toEqual(['项目/b.md']);
    // Total counts what the view holds, not what the file stores.
    expect(payload.total).toBe(1);
  });

  it('applies the view sort, so row order matches the table surface', async () => {
    const document = tableDocument({ include: ['项目/a.md', '项目/b.md', '项目/c.md'] });
    document.views.items[0].sort = [{ field: document.dataset.schema.primary_field_id, direction: 'desc' }];
    mocks.read.mockResolvedValue(serializeTableDocument(document));
    mocks.collectionList.mockResolvedValue([collectionEntry()]);
    mocks.noteList.mockResolvedValue(['a', 'b', 'c'].map((name) => noteEntry(`项目/${name}.md`)));

    const payload = await resolveHtmlDataRequest('view-data', ctx, { relativePath: '项目/.index.yaml' }) as HtmlViewData;

    expect(payload.rows.map((row) => row.notePath)).toEqual(['项目/c.md', '项目/b.md', '项目/a.md']);
  });

  it('lists work documents through the paged catalog query', async () => {
    mocks.read.mockResolvedValue(workDocumentsSource({
      filter: { path: '', match: 'all', conditions: [{ field: 'kind', op: 'in', value: ['spreadsheet'] }] },
    }));
    mocks.collectionList.mockResolvedValue([
      collectionEntry({ relativePath: '资料/.index.yaml', collectionType: 'work_documents', name: '资料' }),
    ]);
    mocks.listWorkDocumentsPage.mockResolvedValue({
      folders: [], items: [workDocument('资料/报表.xlsx')], nextCursor: 'c1', hasMore: true,
    });

    const payload = await resolveHtmlDataRequest('view-data', ctx, {
      relativePath: '资料/.index.yaml', limit: 5,
    }) as HtmlViewData;

    // The saved condition is pushed down to the query: the page sees the same
    // subset the list surface shows, not every document in the notebook.
    expect(mocks.listWorkDocumentsPage).toHaveBeenCalledWith('nb-1', null, 5, {
      fileNameContains: undefined,
      resourceKinds: ['spreadsheet'],
      // The collection sits at the notebook root, which the list surface sends
      // as "all folders".
      path: '',
    });
    expect(payload.rows).toEqual([{
      id: '', notePath: '资料/报表.xlsx', title: '报表.xlsx', updatedAt: 99,
      tags: [], properties: {}, resolved: false, href: '',
    }]);
    // A paged query cannot state a total.
    expect(payload.total).toBeNull();
    expect(payload.truncated).toBe(true);
  });

  it('reads the data domain a hybrid view names', async () => {
    const { text, viewIds } = hybridSource({ notes: { include: ['项目/a.md'] } });
    mocks.read.mockResolvedValue(text);
    mocks.collectionList.mockResolvedValue([collectionEntry({ collectionType: 'hybrid' })]);
    mocks.noteList.mockResolvedValue([noteEntry('项目/a.md')]);
    mocks.listWorkDocumentsPage.mockResolvedValue({
      folders: [], items: [workDocument('资料/报表.xlsx')], nextCursor: null, hasMore: false,
    });

    const notesView = await resolveHtmlDataRequest('view-data', ctx, {
      relativePath: '项目/.index.yaml', viewId: viewIds.notes,
    }) as HtmlViewData;
    expect(notesView.rows.map((row) => row.notePath)).toEqual(['项目/a.md']);
    expect(mocks.listWorkDocumentsPage).not.toHaveBeenCalled();

    // Same file, other domain: the view decides which reader answers.
    const workView = await resolveHtmlDataRequest('view-data', ctx, {
      relativePath: '项目/.index.yaml', viewId: viewIds.work_documents,
    }) as HtmlViewData;
    expect(workView.rows.map((row) => row.notePath)).toEqual(['资料/报表.xlsx']);
    expect(workView.viewId).toBe(viewIds.work_documents);
  });

  it('lists a media library through its file records', async () => {
    mocks.read.mockResolvedValue(mediaLibrarySource(['相册/a.png']));
    mocks.collectionList.mockResolvedValue([
      collectionEntry({ relativePath: '相册/.index.yaml', collectionType: 'media_library', name: '相册' }),
    ]);
    mocks.noteList.mockResolvedValue([]);

    const payload = await resolveHtmlDataRequest('view-data', ctx, { relativePath: '相册/.index.yaml' }) as HtmlViewData;

    // Media records name files through `relative_path`; reading only
    // `note_path` would hand back an empty row.
    expect(payload.rows).toEqual([{
      id: expect.stringMatching(/^rec_/),
      notePath: '相册/a.png',
      title: 'a.png',
      updatedAt: null,
      tags: [],
      properties: {},
      resolved: false,
      href: '',
    }]);
    expect(payload.total).toBe(1);
  });

  it('keeps a folder-placed table to the records it links', async () => {
    mocks.read.mockResolvedValue(tableSource({ include: ['项目/a.md'], placement: 'folder' }));
    mocks.collectionList.mockResolvedValue([collectionEntry()]);
    mocks.noteList.mockResolvedValue([noteEntry('项目/a.md'), noteEntry('项目/b.md')]);

    const payload = await resolveHtmlDataRequest('view-data', ctx, { relativePath: '项目/.index.yaml' }) as HtmlViewData;

    // A folder-placed table does not collect its directory (the location filter
    // is legacy-standalone only) — rows are exactly what it links. Same rule as
    // the table surface, which is why it is pinned here.
    expect(payload.rows.map((row) => row.notePath)).toEqual(['项目/a.md']);
    expect(payload.total).toBe(1);
    // The file is still a table, so the columns survive the placement change.
    expect(payload.fields).toHaveLength(1);
  });

  it('degrades to declared records, columns included, when a parser refuses the file', async () => {
    // A dataset collection the table parser rejects (no envelope): the page
    // must still get its rows and headers rather than an empty card.
    mocks.read.mockResolvedValue(datasetDocument());
    mocks.collectionList.mockResolvedValue([collectionEntry()]);
    mocks.noteList.mockResolvedValue([noteEntry('项目/a.md')]);

    const payload = await resolveHtmlDataRequest('view-data', ctx, {
      relativePath: '项目/.index.yaml', limit: 10,
    }) as HtmlViewData;

    expect(payload.rows.map((row) => row.notePath)).toEqual(['项目/a.md', '项目/b.md', '项目/missing.md']);
    expect(payload.fields.map((field) => field.type)).toEqual(['text', 'text', 'primary']);
    // Silence is the failure mode this guards against: a refused file is a data
    // problem, so it leaves a line in the log instead of changing the answer
    // invisibly.
    expect(mocks.logWarn).toHaveBeenCalledWith(
      'table parse refused, answering declared records',
      expect.objectContaining({ collection: '项目', type: 'table' }),
    );
  });
});

describe('other kinds', () => {
  it('passes the captured product theme through and fails loudly without one', async () => {
    const theme = { id: 'dark', tokens: { background: '#000', foreground: '#fff', secondaryForeground: '', mutedForeground: '', border: '', brand: '', card: '' } };
    await expect(resolveHtmlDataRequest('product-theme', { ...ctx, productTheme: theme })).resolves.toEqual(theme);

    const error = await resolveHtmlDataRequest('product-theme', ctx).catch((reason: unknown) => reason);
    expect((error as HtmlEmbedError).code).toBe('E_INTERNAL');
  });

  // A page opened outside every notebook can still paint itself; only notebook
  // reads are refused. Otherwise one stray .html goes completely blank.
  it('serves host-level kinds without a notebook and refuses notebook reads', async () => {
    const theme = { id: 'light', tokens: { background: '#fff', foreground: '#000', secondaryForeground: '', mutedForeground: '', border: '', brand: '', card: '' } };
    await expect(resolveHtmlDataRequest('product-theme', { notebookId: null, scopePath: null, productTheme: theme }))
      .resolves.toEqual(theme);

    for (const kind of ['notebook-stats', 'notebook-views', 'notebook-custom-views'] as const) {
      const error = await resolveHtmlDataRequest(kind, { notebookId: null, scopePath: null })
        .catch((reason: unknown) => reason);
      expect((error as HtmlEmbedError).code).toBe('E_SCOPE');
    }
  });

  it('returns custom view filters as a plain array', async () => {
    mocks.customViews.mockResolvedValue({ filters: [{ id: 'w1', name: '本周' }] });
    await expect(resolveHtmlDataRequest('notebook-custom-views', ctx))
      .resolves.toEqual({ filters: [{ id: 'w1', name: '本周' }] });

    mocks.customViews.mockResolvedValue({ filters: null });
    await expect(resolveHtmlDataRequest('notebook-custom-views', ctx)).resolves.toEqual({ filters: [] });
  });
});


describe('embedded API pagination', () => {
  it('continues collection listings and returns all views', async () => {
    mocks.collectionList.mockResolvedValue(Array.from({ length: 51 }, (_, i) => collectionEntry({ relativePath: `c${i}/.index.yaml` })));
    mocks.read.mockResolvedValue(datasetDocument({ views: { items: Array.from({ length: 25 }, (_, i) => ({ id: `v${i}`, name: `View ${i}` })) } }));
    const first = await resolveHtmlDataRequest('notebook-views', ctx) as HtmlDataViews;
    expect(first.collections).toHaveLength(50);
    expect(first.collections[0].views).toHaveLength(25);
    expect(first.truncated).toBe(true);
    const second = await resolveHtmlDataRequest('notebook-views', ctx, { cursor: first.nextCursor }) as HtmlDataViews;
    expect(second.collections).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it('continues explicit records and rejects cursors used with different parameters', async () => {
    mocks.collectionList.mockResolvedValue([collectionEntry()]);
    mocks.read.mockResolvedValue(datasetDocument());
    mocks.noteList.mockResolvedValue([]);
    const params = { relativePath: '项目/.index.yaml', limit: 2 };
    const first = await resolveHtmlDataRequest('view-data', ctx, params) as HtmlViewData;
    expect(first.rows.map(row => row.id)).toEqual(['r1', 'r2']);
    expect(first.nextCursor).toBeTruthy();
    const second = await resolveHtmlDataRequest('view-data', ctx, { ...params, cursor: first.nextCursor }) as HtmlViewData;
    expect(second.rows.map(row => row.id)).toEqual(['r3']);
    expect(second.nextCursor).toBeNull();
    await expect(resolveHtmlDataRequest('view-data', ctx, { ...params, limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: 'E_INVALID' });
  });
});


describe('folder view pagination', () => {
  it('preserves overflowing folders and files before advancing the native cursor', async () => {
    mocks.collectionList.mockResolvedValue([collectionEntry()]);
    mocks.read.mockResolvedValue(JSON.stringify({ payload: {} }));
    const item = (name: string) => ({ fullPath: `${ROOT}/项目/${name}`, name, modifiedMs: 1 });
    mocks.listDocumentPage.mockImplementation(async ({ cursor }: { cursor: string | null }) => cursor === null
      ? { folders: [item('a'), item('b'), item('c')], items: [item('d'), item('e')], hasMore: true, nextCursor: 'native' }
      : { folders: [], items: [item('f')], hasMore: false, nextCursor: null });
    const params = { relativePath: '项目/.index.yaml', limit: 2 };
    let cursor: string | null = null;
    const names: string[] = [];
    do {
      const result = await resolveHtmlDataRequest('view-data', ctx, { ...params, cursor }) as HtmlViewData;
      names.push(...result.rows.map(row => row.title));
      cursor = result.nextCursor;
    } while (cursor);
    expect(names).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});
