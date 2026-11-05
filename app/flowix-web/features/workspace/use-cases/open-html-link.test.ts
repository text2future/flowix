import { beforeEach, expect, it, vi } from 'vitest';
import { openHtmlLink } from './open-html-link';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), open: vi.fn(), note: vi.fn(), external: vi.fn(), heading: vi.fn() }));
vi.mock('@platform/tauri/client', () => ({ files: { resolveLocation: mocks.resolve } }));
vi.mock('@platform/tauri/opener', () => ({ openUrl: mocks.external }));
vi.mock('@features/memo/public/note-navigation-api', () => ({ openNoteByDeepLink: mocks.note }));
vi.mock('@features/document/public/heading-navigation-api', () => ({ publishHeadingAnchorRequest: mocks.heading }));
vi.mock('../public/open-surface-api', () => ({ openWorkspaceSurface: mocks.open }));
vi.mock('@features/memo/public/workspace-api', () => ({
  getWorkspaceMemoState: () => ({ notebooks: [{ id: 'book', path: '/book' }, { id: 'target', path: '/other' }] }),
}));
vi.mock('@features/agent/public/workspace-api', () => ({ getWorkspaceAgentResourceFolders: (id: string | null) => id === 'book' ? ['/repo'] : [] }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockImplementation(async (path: string) => ({ path, notebookId: null, notebookPath: null }));
  mocks.open.mockResolvedValue({ status: 'opened', location: { host: 'column-2', surfaceId: 'browser:1' } });
});

it.each(['README.md', 'report.pdf', 'data.json', 'next.html', 'archive.zip'])('opens %s through existing Browser file surfaces', async (filename) => {
  await openHtmlLink({ href: `file:///repo/${filename}`, baseHref: null }, '/book/index.html', '/book');
  expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({
    index: 1, source: 'html-link',
    target: expect.objectContaining({ kind: 'external', path: `/repo/${filename}`, scopePath: '/repo' }),
  }));
  expect(mocks.external).not.toHaveBeenCalled();
});

it('uses target ownership and publishes headings only after a successful open', async () => {
  mocks.resolve.mockResolvedValue({ path: '/other/a.md', notebookId: 'target', notebookPath: '/other' });
  await openHtmlLink({ href: '/other/a.md#intro', baseHref: null }, '/book/index.html', '/book');
  expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({
    target: expect.objectContaining({ scopePath: '/other' }), options: { notebookId: 'target' },
  }));
  expect(mocks.heading).toHaveBeenCalledWith('/other/a.md', { host: 'column-2', surfaceId: 'browser:1' }, 'intro');
  mocks.heading.mockClear();
  mocks.open.mockResolvedValue({ status: 'cancelled' });
  await openHtmlLink({ href: '/other/a.md#intro', baseHref: null }, '/book/index.html', '/book');
  expect(mocks.heading).not.toHaveBeenCalled();
});

it('retains notebook context for chained resource HTML links without extending their scope', async () => {
  await openHtmlLink({ href: 'next.md', baseHref: null }, '/repo/index.html', '/repo', 'book');
  expect(mocks.open).toHaveBeenLastCalledWith(expect.objectContaining({
    target: expect.objectContaining({ path: '/repo/next.md', scopePath: '/repo' }), options: { notebookId: 'book' },
  }));
  await openHtmlLink({ href: '/outside/report.pdf', baseHref: null }, '/repo/index.html', '/repo', 'book');
  expect(mocks.open).toHaveBeenLastCalledWith(expect.objectContaining({
    target: expect.objectContaining({ path: '/outside/report.pdf', scopePath: null }),
  }));
});

it('routes websites and note deep links to Browser and communication links to the system', async () => {
  await openHtmlLink({ href: 'https://example.com/report.pdf', baseHref: null }, '/book/index.html', '/book');
  expect(mocks.open).toHaveBeenCalledWith({ index: 1, source: 'html-link', target: { kind: 'web', url: 'https://example.com/report.pdf' } });
  await openHtmlLink({ href: 'flowix://open?notebookId=book&relativePath=a.md', baseHref: null }, '/book/index.html', '/book');
  expect(mocks.note).toHaveBeenCalledWith(expect.any(String), null, { destination: 1, source: 'html-link' });
  await openHtmlLink({ href: 'mailto:a@example.com', baseHref: null }, '/book/index.html', '/book');
  expect(mocks.external).toHaveBeenCalledWith('mailto:a@example.com');
});
