import { movedPath, type PathMove } from '@/lib/markdown-path-move';
import { canonicalPath, pathComparisonKey } from '@/lib/path';

interface PendingRewrite {
  through: number;
  inputHash: string;
  outputHash: string;
}
interface DocumentCheckpoint {
  applied: number;
  pending?: PendingRewrite;
}
export type NoteLinkMoveJob = PathMove & {
  id?: string;
  documents?: Record<string, DocumentCheckpoint>;
  /** Previous queue format; migrated once when resuming an interrupted scan. */
  batchSize?: number;
  sourcePlans?: Record<string, { inputHash: string; outputHash: string; done?: boolean }>;
};

async function contentHash(content: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
}

export function pathBeforeMoves(path: string, moves: readonly PathMove[]): string {
  return [...moves].reverse().reduce((value, move) => movedPath(value, move, true), canonicalPath(path));
}

/**
 * One checkpoint per original document, shared by source moves and target moves.
 * Queue prefixes remain intact until every document catches up, so an appended
 * move advances the same timeline instead of guessing a new source location.
 */
export function createNoteLinkRewriteProgress(jobs: NoteLinkMoveJob[], persist: () => void) {
  const documents = jobs[0].documents ??= {};
  const legacy = jobs[0].sourcePlans;
  if (legacy) {
    const through = jobs[0].batchSize ?? jobs.length;
    for (const [path, plan] of Object.entries(legacy)) {
      const key = pathComparisonKey(pathBeforeMoves(path, jobs.slice(0, through)));
      documents[key] ??= plan.done
        ? { applied: through }
        : { applied: 0, pending: { through, inputHash: plan.inputHash, outputHash: plan.outputHash } };
    }
    delete jobs[0].sourcePlans;
  }
  delete jobs[0].batchSize;

  return {
    stage(path: string): number {
      return documents[pathComparisonKey(pathBeforeMoves(path, jobs))]?.applied ?? 0;
    },
    acknowledge(path: string, through: number) {
      const key = pathComparisonKey(pathBeforeMoves(path, jobs));
      const checkpoint = documents[key] ??= { applied: 0 };
      checkpoint.applied = Math.max(checkpoint.applied, Math.min(through, jobs.length));
      if (checkpoint.pending && checkpoint.pending.through <= checkpoint.applied) delete checkpoint.pending;
    },
    async open(path: string, content: string, canonicalStage?: number) {
      const key = pathComparisonKey(pathBeforeMoves(path, jobs));
      const checkpoint = documents[key] ??= { applied: 0 };
      if (canonicalStage !== undefined && canonicalStage > checkpoint.applied && canonicalStage <= jobs.length) {
        checkpoint.applied = canonicalStage;
        if (checkpoint.pending && checkpoint.pending.through <= canonicalStage) delete checkpoint.pending;
        persist();
      }
      if (checkpoint.pending) {
        const hash = await contentHash(content);
        if (hash === checkpoint.pending.outputHash) checkpoint.applied = checkpoint.pending.through;
        else if (hash !== checkpoint.pending.inputHash) return null;
        delete checkpoint.pending;
        persist();
      }
      const applied = checkpoint.applied;
      return {
        applied,
        sourcePath: pathBeforeMoves(path, jobs.slice(applied)),
        async prepare(updated: string) {
          const [inputHash, outputHash] = await Promise.all([contentHash(content), contentHash(updated)]);
          checkpoint.pending = { through: jobs.length, inputHash, outputHash };
          // Persist intent before CAS. A lost write response can then be recovered.
          persist();
        },
        commit(persistNow = true) {
          checkpoint.applied = jobs.length;
          delete checkpoint.pending;
          if (persistNow) persist();
        },
        rollback() {
          delete checkpoint.pending;
          persist();
        },
      };
    },
  };
}

/** Merge durable save receipts into an in-flight scan before persisting its snapshot. */
export function mergeDocumentRewriteStages(jobs: NoteLinkMoveJob[], latest: NoteLinkMoveJob[]): void {
  if (!jobs.length || jobs[0].id !== latest[0]?.id) return;
  const documents = jobs[0].documents ??= {};
  for (const [key, saved] of Object.entries(latest[0].documents ?? {})) {
    const current = documents[key] ??= { ...saved };
    current.applied = Math.max(current.applied, saved.applied);
    if (current.pending && current.pending.through <= current.applied) delete current.pending;
  }
}
