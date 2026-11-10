import { createLogger } from '@/lib/logger';
import { canonicalPath } from '@/lib/path';
import { perfMark } from '@/lib/perf-probe';
const logger = createLogger('lib/document-open-perf');
/** Observation-only timing trace for one document-open transaction. */

interface OpenDocumentTrace {
  startedAt: number;
  lastAt: number;
}

const traces = new Map<string, OpenDocumentTrace>();
/** path → journey trace key, consumed once the document store assigns a transitionId. */
const pendingJourneys = new Map<string, string>();
const TRACE_RETENTION_MS = 30_000;
let journeySequence = 0;

function traceKey(id: number | string): string {
  return typeof id === 'string' ? id : `t:${id}`;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function writeTrace(
  id: number | string,
  phase: string,
  trace: OpenDocumentTrace,
  meta?: Record<string, unknown>,
): void {
  const timestamp = now();
  const elapsedMs = round(timestamp - trace.startedAt);
  const deltaMs = round(timestamp - trace.lastAt);
  logger.info('[perf:open-doc-trace]', {
    transitionId: id,
    phase,
    elapsedMs,
    deltaMs,
    ...meta,
  });
  // The WebView console has no capture channel, so mirror every phase into the
  // always-on probe: `__flowixPerf.dump()` then carries a click-to-first-frame
  // timeline that can be pasted out of a packaged build.
  perfMark(`open-doc:${phase}`, deltaMs, { elapsedMs, transitionId: id });
  trace.lastAt = timestamp;
}

function retain(key: string, trace: OpenDocumentTrace, cleanup?: () => void): void {
  traces.set(key, trace);
  window.setTimeout(() => {
    if (traces.get(key) === trace) {
      traces.delete(key);
      cleanup?.();
    }
  }, TRACE_RETENTION_MS);
}

/**
 * Begin measuring from the user action (file-tree click, list row, search hit)
 * instead of from the document-store transition. Keyed by canonical path; the
 * earliest begin wins when several entry points fire for the same file.
 * The journey is consumed by attachDocumentOpenJourney when the store assigns
 * its transitionId, producing one continuous click → first-frame timeline.
 */
export function beginDocumentOpenJourney(
  path: string,
  meta?: Record<string, unknown>,
): void {
  const key = canonicalPath(path);
  if (pendingJourneys.has(key)) return;

  journeySequence += 1;
  const id = `journey:${journeySequence}`;
  const timestamp = now();
  const trace = { startedAt: timestamp, lastAt: timestamp };
  pendingJourneys.set(key, id);
  retain(id, trace, () => {
    if (pendingJourneys.get(key) === id) pendingJourneys.delete(key);
  });
  writeTrace(id, 'journey:begin', trace, { path, ...meta });
}

/** Add a mark to the pending journey for `path`; silently ignored when absent. */
export function markDocumentOpenJourney(
  path: string,
  phase: string,
  meta?: Record<string, unknown>,
): void {
  const id = pendingJourneys.get(canonicalPath(path));
  if (!id) return;
  const trace = traces.get(id);
  if (!trace) return;
  writeTrace(id, phase, trace, meta);
}

/**
 * Re-key the pending journey for `path` onto the store transition so the
 * click → first-frame trace continues under a single transitionId.
 * Returns true when a journey was found and attached.
 */
export function attachDocumentOpenJourney(
  transitionId: number,
  path: string | null,
): boolean {
  if (!path) return false;
  const key = canonicalPath(path);
  const journeyId = pendingJourneys.get(key);
  if (!journeyId) return false;
  pendingJourneys.delete(key);
  const trace = traces.get(journeyId);
  if (!trace) return false;
  traces.delete(journeyId);
  retain(traceKey(transitionId), trace);
  writeTrace(transitionId, 'journey:attach-to-transition', trace);
  return true;
}

export function startDocumentOpenTrace(
  transitionId: number | null | undefined,
  meta?: Record<string, unknown>,
): void {
  if (transitionId === null || transitionId === undefined) return;

  const key = traceKey(transitionId);
  // A journey attached in the same tick already owns this transition; keep its
  // earlier startedAt so elapsedMs spans the whole user action.
  if (traces.has(key)) return;

  const timestamp = now();
  const trace = { startedAt: timestamp, lastAt: timestamp };
  retain(key, trace);
  writeTrace(transitionId, 'navigation:start', trace, meta);
}

export function markDocumentOpenTrace(
  transitionId: number | null | undefined,
  phase: string,
  meta?: Record<string, unknown>,
): void {
  if (transitionId === null || transitionId === undefined) return;

  const trace = traces.get(traceKey(transitionId));
  if (!trace) {
    const timestamp = now();
    const fallback = { startedAt: timestamp, lastAt: timestamp };
    retain(traceKey(transitionId), fallback);
    writeTrace(transitionId, phase, fallback, { traceStartedLate: true, ...meta });
    return;
  }

  writeTrace(transitionId, phase, trace, meta);
}
