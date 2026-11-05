import { beforeEach, expect, it } from 'vitest';
import { ensureFileDisplayIdentity } from '@/lib/file-display-registry';
import { resolveWorkColumnPresentation } from '@features/surface/presentation';
import { resolveSessionDocumentContext } from './session-document-context';
import { useWorkspaceSessionStore } from '../store/workspace-session-store';
import { useWorkColumnStore } from '../store/work-column-store';

beforeEach(() => useWorkspaceSessionStore.getState().reset());
it('renders A after swapping it back while the singleton runtime still belongs to C', () => {
  const store = useWorkspaceSessionStore.getState();
  const a = { kind: 'external' as const, path: '/book/a.md', scopePath: '/book', transitionId: 1 };
  const c = { ...a, path: '/book/c.md', transitionId: 2 };
  const identityA = ensureFileDisplayIdentity(a.path);
  const identityC = ensureFileDisplayIdentity(c.path);
  store.commitTarget('column-1', a);
  store.swapColumnContents();
  store.commitTarget('column-2', c);
  store.swapColumnContents();
  const loadedC = { fileIdentity: identityC, scopePath: '/book', transitionId: 2, openedAt: 0 };
  const navigation = useWorkColumnStore.getState().navigation;
  const document = resolveSessionDocumentContext(navigation.target, loadedC, [{ id: 'book', path: '/book' }])!;
  expect(document.fileIdentity).toEqual(identityA);
  expect(document.notebookId).toBe('book');
  expect(document.relativePath).toBe('a.md');
  expect(document).not.toBe(loadedC);
  const presentation = resolveWorkColumnPresentation({ navigation, emptyMessage: 'empty', document: {
    identity: { kind: 'external', fileIdentity: document.fileIdentity, scopePath: document.scopePath,
      indexable: document.indexable, transitionId: 1 },
    instanceKey: document.fileIdentity.displayId,
    documentProps: { isExternalDocument: true, externalScopePath: document.scopePath, transitionId: 1,
      documentSessionMode: 'isolated', workspaceHost: 'column-1' },
  } });
  expect(presentation.content).toMatchObject({ status: 'surface', surface: { kind: 'md', fileIdentity: identityA } });
  expect(presentation.header).toMatchObject({ document: { externalFilePath: a.path } });
  expect(loadedC.fileIdentity.path).toBe(c.path);
});

it('preserves a matching loaded context and never borrows a different scope or transition', () => {
  const fileIdentity = ensureFileDisplayIdentity('/book/a.md');
  const loaded = { fileIdentity, scopePath: '/book', transitionId: 5, openedAt: 10 };
  const target = { kind: 'external' as const, path: fileIdentity.path, scopePath: '/book', transitionId: 5 };
  expect(resolveSessionDocumentContext(target, loaded, [])).toBe(loaded);
  expect(resolveSessionDocumentContext({ ...target, transitionId: 6 }, loaded, [])).not.toBe(loaded);
  expect(resolveSessionDocumentContext({ ...target, scopePath: '/other' }, loaded, [])?.scopePath).toBe('/other');
  expect(resolveSessionDocumentContext({ kind: 'empty' }, loaded, [])).toBeNull();
});
