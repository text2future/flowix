import { describe, expect, it, vi } from 'vitest';
import { createNoteLinkRewriteProgress, mergeDocumentRewriteStages, type NoteLinkMoveJob } from './note-link-rewrite-progress';

const move = { oldPath: '/book/A/n.md', newPath: '/book/B/n.md' };
const next = { oldPath: '/book/B/n.md', newPath: '/book/C/n.md' };

describe('document rewrite stages', () => {
  it('resumes a prepared write at its output stage when more moves arrive', async () => {
    const jobs: NoteLinkMoveJob[] = [{ ...move }];
    const persist = vi.fn();
    const document = await createNoteLinkRewriteProgress(jobs, persist).open(move.newPath, 'before');
    await document!.prepare('after');
    expect(persist).toHaveBeenCalledOnce();
    const recovered: NoteLinkMoveJob[] = JSON.parse(JSON.stringify(jobs));
    recovered.push(next);
    const resumed = await createNoteLinkRewriteProgress(recovered, persist).open(next.newPath, 'after');
    expect(resumed).toMatchObject({ applied: 1, sourcePath: move.newPath });
  });

  it('retries an uncommitted write from the prior stage and rolls back a rejected CAS', async () => {
    const jobs: NoteLinkMoveJob[] = [{ ...move }];
    const persist = vi.fn();
    const document = await createNoteLinkRewriteProgress(jobs, persist).open(move.newPath, 'before');
    await document!.prepare('after');
    const resumed = await createNoteLinkRewriteProgress(jobs, persist).open(move.newPath, 'before');
    expect(resumed).toMatchObject({ applied: 0, sourcePath: move.oldPath });
    await resumed!.prepare('after');
    resumed!.rollback();
    expect(jobs[0].documents?.['/book/A/n.md']).toEqual({ applied: 0 });
  });

  it('does not guess a write outcome when both content hashes differ', async () => {
    const jobs: NoteLinkMoveJob[] = [{ ...move }];
    const document = await createNoteLinkRewriteProgress(jobs, () => {}).open(move.newPath, 'before');
    await document!.prepare('after');
    const saved = JSON.stringify(jobs);
    expect(await createNoteLinkRewriteProgress(jobs, () => {}).open(move.newPath, 'external edit')).toBeNull();
    expect(JSON.stringify(jobs)).toBe(saved);
  });

  it('migrates completed legacy source plans and retains their stage', async () => {
    const jobs: NoteLinkMoveJob[] = [{ ...move, batchSize: 1, sourcePlans: {
      '/book/B/n.md': { inputHash: 'old', outputHash: 'new', done: true },
    } }, next];
    const resumed = await createNoteLinkRewriteProgress(jobs, () => {}).open(next.newPath, 'edited after completion');
    expect(resumed).toMatchObject({ applied: 1, sourcePath: move.newPath });
    expect(jobs[0].batchSize).toBeUndefined();
    expect(jobs[0].sourcePlans).toBeUndefined();
  });

  it('migrates prepared legacy writes using the same recovery mechanism', async () => {
    const original: NoteLinkMoveJob[] = [{ ...move }];
    const document = await createNoteLinkRewriteProgress(original, () => {}).open(move.newPath, 'before');
    await document!.prepare('after');
    const pending = original[0].documents!['/book/A/n.md'].pending!;
    const legacy: NoteLinkMoveJob[] = [{ ...move, batchSize: 1, sourcePlans: {
      '/book/B/n.md': { inputHash: pending.inputHash, outputHash: pending.outputHash },
    } }];
    expect(await createNoteLinkRewriteProgress(legacy, () => {}).open(move.newPath, 'after')).toMatchObject({ applied: 1 });
  });
  it('retains a canonical save receipt when an older scan snapshot is persisted', async () => {
    const scan: NoteLinkMoveJob[] = [{ ...move, id: 'batch' }];
    const document = await createNoteLinkRewriteProgress(scan, () => {}).open(move.newPath, 'before');
    await document!.prepare('after');
    const receipt: NoteLinkMoveJob[] = JSON.parse(JSON.stringify(scan));
    createNoteLinkRewriteProgress(receipt, () => {}).acknowledge(move.newPath, 1);
    mergeDocumentRewriteStages(scan, receipt);
    expect(scan[0].documents!['/book/A/n.md']).toEqual({ applied: 1 });
  });

});
