import { expect, it, vi } from 'vitest';
import { scheduleSave } from './save-queue';
import { ensureFileDisplayIdentity, rebaseFileDisplayPath } from '@/lib/file-display-registry';
const mocks = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('../use-cases/local-document-operations', () => ({ localDocumentOperations: { write: mocks.write } }));

it('resolves a queued save against the current path after a rename', async () => {
  const identity = ensureFileDisplayIdentity('C:/queue/Old.md');
  let finish!: (result: { status: 'saved'; path: string; content: string }) => void;
  mocks.write.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockImplementationOnce(async request => ({ status: 'saved', path: request.path, content: request.content }));
  let expected = 'initial';
  const saved = vi.fn((_path: string, content: string) => { expected = content; });
  const context = { queueKey: 'md:' + identity.displayId, path: identity.path,
    scopePath: null, revision: 1, readExpected: () => expected,
    onSaved: saved, onCasRefused: vi.fn(), onError: vi.fn() };
  const first = scheduleSave(context, 'first');
  const second = scheduleSave({ ...context, revision: 2 }, 'second');
  rebaseFileDisplayPath(identity.path, 'C:/queue/New.md', identity.displayId);
  finish({ status: 'saved', path: 'C:\\queue\\Old.md', content: 'first' });
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(mocks.write.mock.calls[1][0]).toMatchObject({ path: 'C:/queue/New.md', expectedContent: 'first', content: 'second' });
  expect(saved).toHaveBeenCalledTimes(2);
  expect(saved.mock.calls[0][0]).toBe('C:/queue/New.md');
});

it('retries a refused in-flight save only after a confirmed path rebase', async () => {
  mocks.write.mockReset();
  const identity = ensureFileDisplayIdentity('/retry/Before.md');
  let refuse!: (result: { status: 'refused' }) => void;
  mocks.write.mockImplementationOnce(() => new Promise(resolve => { refuse = resolve; }))
    .mockImplementationOnce(async request => ({ status: 'saved', path: request.path, content: request.content }));
  const onSaved = vi.fn(); const onCasRefused = vi.fn();
  const pending = scheduleSave({ queueKey: 'md:' + identity.displayId, path: identity.path,
    scopePath: null, revision: 1,
    readExpected: () => 'old content', onSaved, onCasRefused, onError: vi.fn() }, 'unsaved edit');
  rebaseFileDisplayPath(identity.path, '/retry/After.md', identity.displayId);
  refuse({ status: 'refused' });
  expect(await pending).toBe(true);
  expect(mocks.write.mock.calls[1][0]).toMatchObject({ path: '/retry/After.md', expectedContent: 'old content' });
  expect(onCasRefused).not.toHaveBeenCalled();
  expect(onSaved).toHaveBeenCalledWith('/retry/After.md', 'unsaved edit', 1, 'unsaved edit', false);
});
