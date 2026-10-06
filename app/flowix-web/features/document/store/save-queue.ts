import { enqueueDocumentCommit, waitForDocumentCommits } from './document-commit-queue';
import { canonicalPath } from '@/lib/path';
import { findFileDisplayPath } from '@/lib/file-display-registry';
/** Body persistence adapter for the shared per-document title/body coordinator.
 * The buffer owns revisions and CAS baselines; this module owns IPC receipts.
 */
import { localDocumentOperations } from '@features/document/use-cases/local-document-operations';

export interface SaveContext {
  /** Stable queue key for this runtime Markdown identity (`md:<displayId>`). */
  queueKey: string;
  /** The document path this save targets. */
  path: string;
  /** Authorized file-tree root for this file. */
  scopePath: string | null;
  /** Immutable buffer revision represented by this save request. */
  revision: number;
  /**
   * Read the current expectedContent (CAS expected value) just before the
   * IPC fires. Returning a fresh value here is what makes coalescing
   * safe: the chain re-reads the expected value before every IPC, so a
   * pending save always sends the latest expected version.
   */
  readExpected: () => string;
  latest?: () => { content: string; revision: number };
  isBlocked?: () => boolean;
  onStarted?: (revision: number) => void;
  /**
   * Called after a successful write. Caller is responsible for updating
   * `lastSavedContent` (and `pendingContent` if appropriate) here.
   * `writtenPath` 是磁盘上最终物理路径 ── rename 后可能跟 caller
   * 传的 path 不同, 前端需要据此切 buf / 更新 closure。
   */
  onSaved: (writtenPath: string, writtenContent: string, revision: number,
    submittedContent: string, merged: boolean) => void;
  /** Called on CAS refusal (write returned false). */
  onCasRefused: (writtenContent: string, revision: number) => void;
  /** Called on transport / IPC error. */
  onError: (writtenContent: string, revision: number, err: unknown) => void;
}

/** All body flushes share the title/body commit coordinator. */
export const waitForSaveQueue = waitForDocumentCommits;
export function scheduleSave(ctx: SaveContext, content: string): Promise<boolean> {
  return enqueueDocumentCommit(ctx.queueKey, 'body', async () => {
    if (ctx.isBlocked?.()) return false;
    const snapshot = ctx.latest?.() ?? { content, revision: ctx.revision };
    ctx.onStarted?.(snapshot.revision);
    const savedContent = await runOne({ ...ctx, revision: snapshot.revision }, snapshot.content);
    const latest = ctx.latest?.();
    if (savedContent !== null && latest && latest.content !== savedContent && !ctx.isBlocked?.()) {
      void scheduleSave(ctx, latest.content);
    }
    return savedContent !== null && !ctx.isBlocked?.();
  });
}

async function runOne(ctx: SaveContext, content: string): Promise<string | null> {
  const expected = ctx.readExpected();
  try {
    const displayId = ctx.queueKey.startsWith('md:') ? ctx.queueKey.slice(3) : null;
    const path = displayId ? findFileDisplayPath(displayId) ?? ctx.path : ctx.path;
    const write = (target: string) => localDocumentOperations.write({
      path: target, scopePath: ctx.scopePath, content, expectedContent: expected,
    });
    let attemptedPath = path;
    let result = await write(attemptedPath);
    const rebasedPath = displayId ? findFileDisplayPath(displayId) : null;
    if ((result.status === 'refused' || result.status === 'missing') && rebasedPath && rebasedPath !== attemptedPath) {
      // Only a confirmed runtime rebase may redirect an old in-flight request.
      attemptedPath = rebasedPath;
      result = await write(attemptedPath);
    }
    if (result.status === 'saved') {
      const latestPath = displayId ? findFileDisplayPath(displayId) : null;
      const writtenPath = canonicalPath(result.path) === canonicalPath(attemptedPath) && latestPath ? latestPath : result.path;
      ctx.onSaved(writtenPath, result.content, ctx.revision, content, result.merged === true);
      return result.content;
    }
    if (result.status === 'conflict' || result.status === 'refused') {
      ctx.onCasRefused(content, ctx.revision);
      return null;
    }
    const message = result.status === 'missing'
      ? `External document is unavailable: ${ctx.path}`
      : result.message;
    ctx.onError(content, ctx.revision, new Error(message));
    return null;
  } catch (err) {
    console.error('[runOne] IPC threw', { path: ctx.path, err });
    ctx.onError(content, ctx.revision, err);
    return null;
  }
}
