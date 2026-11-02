/**
 * Lightweight runtime performance probe for the document save path.
 *
 * Design constraints:
 * - Always on, but O(1) per sample: two `performance.now()` calls plus a
 *   numeric bucket update. No allocation on the hot path unless a sample is
 *   actually retained.
 * - Never throws: perf instrumentation must not break editing.
 * - Aggregates instead of logging every event, so a few minutes of typing
 *   still produce a readable summary.
 *
 * Access from a WebView devtools console (Windows: right-click > Inspect):
 *   __flowixPerf.dump()   // JSON string, paste back for analysis
 *   __flowixPerf.summary() // console.table
 *   __flowixPerf.reset()
 */

export type PerfDetail = Record<string, string | number | boolean | undefined>;

type Bucket = {
  count: number;
  totalMs: number;
  maxMs: number;
  samples: number[];
  lastDetail?: PerfDetail;
};

type SlowEvent = {
  at: number;
  name: string;
  ms: number;
  detail?: PerfDetail;
};

/** Samples above this stay in the bounded list, everything else aggregates only. */
const SLOW_EVENT_MS = 8;
const MAX_SLOW_EVENTS = 120;
/** Keep the percentile window small so long sessions do not grow memory. */
const MAX_SAMPLES_PER_BUCKET = 400;

const buckets = new Map<string, Bucket>();
const slowEvents: SlowEvent[] = [];
let enabled = true;
let startedAt = Date.now();

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
  return sorted[index];
}

export function perfEnabled(): boolean {
  return enabled;
}

export function setPerfEnabled(next: boolean): void {
  enabled = next;
}

export function perfReset(): void {
  buckets.clear();
  slowEvents.length = 0;
  startedAt = Date.now();
}

/**
 * Record one duration sample. Cheap enough to call on every save/notify.
 * Safe to call when disabled (returns immediately).
 */
export function perfMark(name: string, ms: number, detail?: PerfDetail): void {
  if (!enabled) return;
  try {
    if (!Number.isFinite(ms) || ms < 0) return;
    let bucket = buckets.get(name);
    if (!bucket) {
      bucket = { count: 0, totalMs: 0, maxMs: 0, samples: [] };
      buckets.set(name, bucket);
    }
    bucket.count += 1;
    bucket.totalMs += ms;
    if (ms > bucket.maxMs) bucket.maxMs = ms;
    if (detail) bucket.lastDetail = detail;
    if (bucket.samples.length < MAX_SAMPLES_PER_BUCKET) bucket.samples.push(ms);
    if (ms >= SLOW_EVENT_MS) {
      slowEvents.push({ at: Date.now(), name, ms: Math.round(ms * 100) / 100, detail });
      if (slowEvents.length > MAX_SLOW_EVENTS) slowEvents.shift();
    }
  } catch {
    // Instrumentation must never interfere with editing.
  }
}

/** Increment a counter (listener deliveries, renders) without a duration. */
export function perfCount(name: string, delta = 1, detail?: PerfDetail): void {
  if (!enabled) return;
  try {
    let bucket = buckets.get(name);
    if (!bucket) {
      bucket = { count: 0, totalMs: 0, maxMs: 0, samples: [] };
      buckets.set(name, bucket);
    }
    bucket.count += delta;
    if (detail) bucket.lastDetail = detail;
  } catch {
    // ignore
  }
}

type BucketSummary = {
  name: string;
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  lastDetail?: PerfDetail;
};

export function perfSummary(): BucketSummary[] {
  const rows: BucketSummary[] = [];
  for (const [name, bucket] of buckets) {
    const sorted = [...bucket.samples].sort((a, b) => a - b);
    rows.push({
      name,
      count: bucket.count,
      avgMs: Math.round((bucket.totalMs / Math.max(1, bucket.count)) * 100) / 100,
      p50Ms: Math.round(percentile(sorted, 0.5) * 100) / 100,
      p95Ms: Math.round(percentile(sorted, 0.95) * 100) / 100,
      maxMs: Math.round(bucket.maxMs * 100) / 100,
      lastDetail: bucket.lastDetail,
    });
  }
  return rows.sort((a, b) => b.p95Ms - a.p95Ms);
}

export function perfDump(): string {
  return JSON.stringify({
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
    buckets: perfSummary(),
    slowEvents,
  }, null, 2);
}

type PerfGlobal = {
  dump: () => string;
  summary: () => BucketSummary[];
  reset: () => void;
  disable: () => void;
  enable: () => void;
};

if (typeof window !== 'undefined') {
  const host = window as typeof window & { __flowixPerf?: PerfGlobal };
  host.__flowixPerf ??= {
    dump: perfDump,
    summary: perfSummary,
    reset: perfReset,
    disable: () => setPerfEnabled(false),
    enable: () => setPerfEnabled(true),
  };
}

/** Long tasks are the clearest signal of "the UI froze while typing". */
export function installLongTaskObserver(): () => void {
  if (typeof PerformanceObserver === 'undefined') return () => {};
  let observer: PerformanceObserver;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        perfMark('long-task', entry.duration, { entryType: entry.entryType });
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    return () => {};
  }
  return () => observer.disconnect();
}
