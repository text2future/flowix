import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyLoadedDocumentContent, getDocumentBuffer, recordDocumentEdit, saveDocumentContent, protectDocumentDraft, prepareDocumentLeave, registerDocumentCapture, registerDocumentPersistence, flushAllDocumentSessions, reconcileUnsavedExternalDocumentChange } from './document-session-service';
import { waitForDocumentCommits } from './document-commit-queue';

const mocks = vi.hoisted(() => ({ write: vi.fn(), checkpoint: vi.fn() }));
vi.mock('../use-cases/local-document-operations', () => ({ localDocumentOperations: { write: mocks.write } }));
vi.mock('./recovery-draft-store', () => ({
  persistRecoveryDraft: mocks.checkpoint, clearRecoveryDraftThrough: vi.fn().mockResolvedValue(undefined),
  flushRecoveryOperations: vi.fn().mockResolvedValue(true),
}));

let sequence = 0;
function document() {
  const identity = { kind: 'md' as const, path: '/review.md', displayId: 'review-' + ++sequence };
  applyLoadedDocumentContent(identity, identity.path, 'A');
  return identity;
}
function save(identity: ReturnType<typeof document>) {
  return saveDocumentContent({ identity, path: identity.path, content: getDocumentBuffer(identity).content });
}
describe('persistence under slow and failed writes', () => {
  beforeEach(() => {
    mocks.write.mockReset().mockImplementation(async request => ({ status: 'saved', path: request.path, content: request.content }));
    mocks.checkpoint.mockReset().mockResolvedValue(true);
  });
  it('writes undo back to A after a delayed save of B, without another input event', async () => {
    const identity = document(); let complete!: (value: unknown) => void;
    mocks.write.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    recordDocumentEdit(identity, 'B'); const first = save(identity);
    recordDocumentEdit(identity, 'A');
    complete({ status: 'saved', path: identity.path, content: 'B' });
    expect(await first).toBe(true);
    expect(mocks.write.mock.calls.map(([request]) => request.content)).toEqual(['B', 'A']);
    expect(getDocumentBuffer(identity)).toMatchObject({ content: 'A', lastSavedContent: 'A', saveState: 'clean' });
  });
  it('keeps the old CAS base and blocks automatic writes after an external conflict', async () => {
    const identity = document();
    mocks.write.mockResolvedValueOnce({ status: 'conflict', diskContent: 'external' });
    recordDocumentEdit(identity, 'local'); expect(await save(identity)).toBe(false);
    recordDocumentEdit(identity, 'newer local'); expect(await save(identity)).toBe(false);
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(getDocumentBuffer(identity)).toMatchObject({ content: 'newer local', lastSavedContent: 'A', conflicted: true });
  });
  it('adopts an automatically merged save as the next editor baseline', async () => {
    const identity = document();
    mocks.write.mockResolvedValueOnce({ status: 'saved', path: identity.path, content: 'local and disk', merged: true });
    recordDocumentEdit(identity, 'local');
    expect(await save(identity)).toBe(true);
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(getDocumentBuffer(identity)).toMatchObject({
      content: 'local and disk', lastSavedContent: 'local and disk',
      pendingContent: null, conflicted: false, saveState: 'clean',
    });
  });
  it('keeps newer typing when an older snapshot is merged on disk', async () => {
    const identity = document(); let finish!: (value: unknown) => void;
    mocks.write.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    recordDocumentEdit(identity, 'local'); const pending = save(identity);
    recordDocumentEdit(identity, 'newer local');
    finish({ status: 'saved', path: identity.path, content: 'local and disk', merged: true });
    expect(await pending).toBe(false);
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(getDocumentBuffer(identity)).toMatchObject({
      content: 'newer local', lastSavedContent: 'local and disk',
      conflicted: true, saveState: 'conflict',
    });
  });
  it('keeps a save scheduled when recovery protection fails during an external change', async () => {
    vi.useFakeTimers();
    try {
      const identity = document();
      mocks.checkpoint.mockResolvedValueOnce(false);
      recordDocumentEdit(identity, 'local');
      await reconcileUnsavedExternalDocumentChange(identity, identity.path, null);
      expect(mocks.write).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(300);
      expect(await waitForDocumentCommits('md:' + identity.displayId)).toBe(true);
      expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ content: 'local' }));
      expect(getDocumentBuffer(identity).saveState).toBe('clean');
    } finally {
      vi.useRealTimers();
    }
  });
  it('releases the saving state when a conflict blocks a newer queued revision', async () => {
    const identity = document(); let finish!: (value: unknown) => void;
    mocks.write.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    recordDocumentEdit(identity, 'B'); const first = save(identity);
    recordDocumentEdit(identity, 'C'); const second = save(identity);
    finish({ status: 'conflict', diskContent: 'external' });
    expect(await first).toBe(false); expect(await second).toBe(false);
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(getDocumentBuffer(identity)).toMatchObject({ content: 'C', conflicted: true, savingRevision: null });
  });
  it('acknowledges only the revision captured by a delayed recovery checkpoint', async () => {
    const identity = document(); let complete!: (value: boolean) => void;
    mocks.checkpoint.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    recordDocumentEdit(identity, 'B'); const protecting = protectDocumentDraft(identity, identity.path, 'autosave');
    recordDocumentEdit(identity, 'C'); complete(true); await protecting;
    expect(getDocumentBuffer(identity).durableRevision).toBe(1);
    expect(getDocumentBuffer(identity).capturedRevision).toBe(2);
  });
  it('captures text typed during a close wait before acknowledging durability', async () => {
    const identity = document(); let local = 'B'; let finish!: (value: unknown) => void;
    const unregisterCapture = registerDocumentCapture(identity, () => { recordDocumentEdit(identity, local); return local; });
    const unregister = registerDocumentPersistence(identity, { capture: () => {}, path: () => identity.path, scopePath: null });
    mocks.write.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const closing = flushAllDocumentSessions();
    local = 'typed while closing';
    finish({ status: 'saved', path: identity.path, content: 'B' });
    expect(await closing).toBe(true);
    expect(mocks.checkpoint).toHaveBeenCalledWith(expect.objectContaining({ content: 'typed while closing' }));
    expect(getDocumentBuffer(identity).durableRevision).toBe(getDocumentBuffer(identity).capturedRevision);
    unregisterCapture(); unregister();
  });
  it('allows navigation while saving and recovery are delayed', async () => {
    const identity = document(); let complete!: (value: unknown) => void;
    mocks.write.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    recordDocumentEdit(identity, 'B');
    expect(await prepareDocumentLeave(identity, identity.path)).toBe(true);
    expect(getDocumentBuffer(identity).content).toBe('B');
    complete({ status: 'saved', path: identity.path, content: 'B' });
    expect(await waitForDocumentCommits('md:' + identity.displayId)).toBe(true);
  });
});
