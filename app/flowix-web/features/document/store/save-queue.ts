/**
 * Per-path coalescing save queue.
 *
 * Why this exists
 * ---------------
 * The document has 5 independent mechanisms that can trigger a save:
 *   1. handleChange debounced timer (1s)
 *   2. sessionCloser (user navigates to another memo)
 *   3. finalizeMemoRename (memo renamed)
 *   4. document.visibilitychange (tab hidden)
 *   5. window.beforeunload (app closing)
 *
 * Before this refactor each of these called memosClient.writeDocument
 * directly. The IPC + CAS pattern is one-shot, so when two of these fired
 * close together (e.g. user types fast and switches memo), we would issue
 * two writes with the SAME expectedContent. The first would succeed and
 * bump the disk version, the second would CAS-fail and surface "文档已被
 * 外部修改" — even though the failure was self-induced.
 *
 * What this module does
 * ---------------------
 * - Serializes writes for a given path through a single chain.
 * - Coalesces: if a write is in flight and another comes in, the new
 *   content is queued as `pending`. The chain processes the in-flight
 *   one, then runs the pending one (with the latest expectedContent read
 *   from the caller at that moment via `readExpected`).
 * - Exposes `scheduleSave` for fire-and-forget callers, and `flushSave`
 *   for callers that need to wait for the chain to settle (closer,
 *   finalize).
 *
 * Buffer ownership
 * ----------------
 * The save queue does NOT own the DocumentBuffer. It calls back into the
 * React hook for two things: `readExpected` (just before IPC) and
 * `onSaved` (just after a successful IPC). This keeps buffer state in
 * React-land where it stays reactive, while the queue orchestrates IPC
 * ordering.
 */
import { externalDocuments, memos as memosClient } from '@platform/tauri/client';

export interface SaveContext {
  /** Stable queue key for this editing session (`memo:<id>` or `external:<path>`). */
  queueKey: string;
  /** The document path this save targets. */
  path: string;
  /**
   * `internal` (内部 memo 文档, 走 `key` 反查) 或 `external`
   * (外部 .md 文件, 走 `path` 寻址 + CAS)。后端 write_document 据此
   * 分流: 内部走派生改名 + memo index 同步, 外部只做 fs::write。
   */
  channel: 'internal' | 'external';
  /**
   * 内部 memo 用 ── memo id (6 位 shortid)。closure 期间稳定, 不受
   * rename / path 漂移影响, 后端用它反查 memo index 拿当前 entry.filename
   * 走新路径写。
   */
  key: string | null;
  /**
   * Read the current expectedContent (CAS expected value) just before the
   * IPC fires. Returning a fresh value here is what makes coalescing
   * safe: the chain re-reads the expected value before every IPC, so a
   * pending save always sends the latest expected version.
   */
  readExpected: () => string;
  /**
   * Called after a successful write. Caller is responsible for updating
   * `lastSavedContent` (and `pendingContent` if appropriate) here.
   * `writtenPath` 是磁盘上最终物理路径 ── rename 后可能跟 caller
   * 传的 path 不同, 前端需要据此切 buf / 更新 closure。
   */
  onSaved: (writtenPath: string, writtenContent: string) => void;
  /** Called on CAS refusal (write returned false). */
  onCasRefused: (writtenContent: string) => void;
  /** Called on transport / IPC error. */
  onError: (writtenContent: string, err: unknown) => void;
}

interface QueueEntry {
  /** Latest content waiting to be written (overwritten by later scheduleSave). */
  pending: string | null;
  /** Context for the latest pending content. */
  pendingCtx: SaveContext | null;
  /** The chain promise for the current or last in-flight chain. */
  inFlight: Promise<boolean> | null;
}

const queue = new Map<string, QueueEntry>();

/**
 * Schedule a save for the given path/content. Coalesces with any in-flight
 * or pending save. Returns a promise that resolves when the chain settles,
 * with the result of the LAST attempted write (true = on disk, false =
 * CAS-refused or errored — the latest content was NOT successfully written).
 *
 * Coalescing semantics: if you call scheduleSave with C1, then C2, then
 * C3 in quick succession while the chain is in-flight, the chain will
 * write C1 then C3 (C2 is dropped — the timer that scheduled it had
 * already been overwritten by C3's schedule).
 */
export function scheduleSave(ctx: SaveContext, content: string): Promise<boolean> {
  const queueKey = ctx.queueKey;
  let entry = queue.get(queueKey);
  if (!entry) {
    entry = { pending: null, pendingCtx: null, inFlight: null };
    queue.set(queueKey, entry);
  }

  if (entry.inFlight) {
    // Coalesce: just record the new content. The chain will pick it up.
    entry.pending = content;
    entry.pendingCtx = ctx;
    return entry.inFlight;
  }

  // No chain in flight — start one with this content.
  entry.pending = content;
  entry.pendingCtx = ctx;
  const promise = runChain(ctx);
  entry.inFlight = promise;
  return promise;
}

async function runChain(ctx: SaveContext): Promise<boolean> {
  const entry = queue.get(ctx.queueKey);
  if (!entry) return true;

  let currentContent = entry.pending ?? '';
  let currentCtx = entry.pendingCtx ?? ctx;
  entry.pending = null;
  entry.pendingCtx = null;
  let lastResult = true;

  while (true) {
    const result = await runOne(currentCtx, currentContent);
    lastResult = result;
    if (!result) {
      // CAS refused (or transport error). Stop the chain — caller will
      // toast/retry. The entry stays in the map with its current
      // pending, so a later scheduleSave can pick it up.
      break;
    }

    const e = queue.get(ctx.queueKey);
    if (!e || e.pending === null) {
      break;
    }
    if (e.pending === currentContent) {
      // Same content was queued twice (e.g. the timer fired twice
      // for the same content because the chain had not yet completed).
      // Drop the duplicate to avoid a wasted IPC.
      e.pending = null;
      e.pendingCtx = null;
      break;
    }
    currentContent = e.pending;
    currentCtx = e.pendingCtx ?? currentCtx;
    e.pending = null;
    e.pendingCtx = null;
  }

  // Cleanup. Runs synchronously after the loop breaks, so no other
  // scheduleSave can interleave with it.
  const e = queue.get(ctx.queueKey);
  if (e) {
    e.inFlight = null;
    if (e.pending === null) {
      queue.delete(ctx.queueKey);
    }
  }
  return lastResult;
}

async function runOne(ctx: SaveContext, content: string): Promise<boolean> {
  const expected = ctx.readExpected();
  try {
    if (ctx.channel === 'external') {
      const result = await externalDocuments.write({
          filePath: ctx.path,
          content,
          expectedContent: expected,
        });
      if (result.status === 'saved') {
        ctx.onSaved(result.path, result.content);
        return true;
      }
      if (result.status === 'conflict') {
        ctx.onCasRefused(content);
        return false;
      }
      const message = result.status === 'missing'
        ? `External document is unavailable: ${ctx.path}`
        : result.message;
      ctx.onError(content, new Error(message));
      return false;
    }
    const result = await memosClient.writeDocument({
      key: ctx.key!,
      content,
      expectedContent: expected,
    });
    if (result !== null) {
      ctx.onSaved(result.path, result.content);
      return true;
    }
    ctx.onCasRefused(content);
    return false;
  } catch (err) {
    console.error('[runOne] IPC threw', { path: ctx.path, err });
    ctx.onError(content, err);
    return false;
  }
}
