import { getDocumentSession, findDocumentSession, listDocumentSessions, releaseDocumentSession } from './document-runtime-session';
import { createLogger } from '@/lib/logger';
import { pinFileDisplayId } from '@/lib/file-display-registry';

type Lane = 'body' | 'title';
interface Job { run: () => Promise<boolean>; queuedAt: number; finish: (success: boolean) => void }
export interface CommitQueue {
  pending: Map<Lane, Job>;
  done: Promise<boolean>;
  finish: (success: boolean) => void;
}
function sessionId(key: string) { return key.replace(/^md:/, ''); }
export interface CaptureClock { firstAt: number; timer: ReturnType<typeof setTimeout>; run: () => void }

/** One writer per live document, including rename, autosave and explicit flush.
 * Pending jobs are latest-value slots, never an unbounded keystroke queue.
 * A slow request retains ownership: a timeout must never start a second writer.
 */
const persistenceLog = createLogger('document:commit');

export function enqueueDocumentCommit(key: string, lane: Lane, run: Job['run']): Promise<boolean> {
  let finishJob!: Job['finish'];
  const completed = new Promise<boolean>(resolve => { finishJob = resolve; });
  const job: Job = { run, queuedAt: performance.now(), finish: finishJob };
  const current = findDocumentSession(sessionId(key))?.queue;
  if (current) {
    // Replaced pending intents were never executed; their callers can finish.
    current.pending.get(lane)?.finish(true);
    current.pending.set(lane, job);
    return completed;
  }
  let finish!: CommitQueue['finish'];
  const done = new Promise<boolean>(resolve => { finish = resolve; });
  const queue: CommitQueue = { pending: new Map([[lane, job]]), done, finish };
  getDocumentSession(sessionId(key)).queue = queue;
  void drain(key, queue);
  return completed;
}

async function drain(key: string, queue: CommitQueue): Promise<void> {
  const release = pinFileDisplayId(key.replace(/^md:/, ''));
  let success = true;
  try {
    while (queue.pending.size) {
      const [lane, job] = queue.pending.entries().next().value!;
      queue.pending.delete(lane);
      const started = performance.now();
      const operationId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${started}`;
      try {
        const result = await job.run();
        success = result && success;
        job.finish(result);
      } catch (error) {
        success = false;
        job.finish(false);
        persistenceLog.error('operation failed', { operationId, lane, errorType: error instanceof Error ? error.name : typeof error });
      } finally {
        const elapsedMs = performance.now() - started;
        if (elapsedMs > 100 || started - job.queuedAt > 100) {
          persistenceLog.info('slow operation', {
            operationId, lane, elapsedMs, queueMs: started - job.queuedAt,
          });
        }
      }
    }
  } finally {
    getDocumentSession(sessionId(key)).queue = undefined;
    queue.finish(success);
    release();
    releaseDocumentSession(sessionId(key));
  }
}

export function waitForDocumentCommits(key: string): Promise<boolean> {
  return findDocumentSession(sessionId(key))?.queue?.done ?? Promise.resolve(true);
}

export function hasDocumentCommit(key: string): boolean { return Boolean(findDocumentSession(sessionId(key))?.queue); }

// The clock belongs to the document, not a mounted React surface. Markdown
// editors schedule capture here; source editors schedule their already-captured
// content on the same clock. There is no second autosave debounce afterwards.
export const DOCUMENT_SAVE_DELAY_MS = 300;
export const DOCUMENT_SAVE_MAX_WAIT_MS = 2_000;

export function scheduleDocumentCapture(key: string, run: () => void): void {
  const previous = findDocumentSession(sessionId(key))?.clock;
  if (previous) clearTimeout(previous.timer);
  const firstAt = previous?.firstAt ?? Date.now();
  const delay = Math.max(0, Math.min(DOCUMENT_SAVE_DELAY_MS, DOCUMENT_SAVE_MAX_WAIT_MS - (Date.now() - firstAt)));
  const timer = setTimeout(() => {
    getDocumentSession(sessionId(key)).clock = undefined;
    run();
  }, delay);
  getDocumentSession(sessionId(key)).clock = { firstAt, timer, run };
}

export function cancelDocumentCapture(key: string): void {
  const session = findDocumentSession(sessionId(key));
  const clock = session?.clock;
  if (clock) clearTimeout(clock.timer);
  if (session) session.clock = undefined;
}

export function documentCommitDiagnostics() {
  const sessions = listDocumentSessions();
  return { active: sessions.filter(s => s.queue).length,
    pending: sessions.reduce((n, s) => n + (s.queue?.pending.size ?? 0), 0),
    clocks: sessions.filter(s => s.clock).length };
}
