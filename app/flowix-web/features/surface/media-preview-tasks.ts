import { files, mediaResources } from '@platform/tauri/client';
import { getNotebookVideoPreview } from './video-preview-cache';

const MAX_ACTIVE_PREVIEWS = 2;
const MAX_REMEMBERED_RESULTS = 256;

type PreviewKind = 'image' | 'video';
type JobState = 'queued' | 'running' | 'complete';

interface PreviewJob {
  key: string;
  filePath: string;
  notebookPath: string;
  kind: PreviewKind;
  modifiedMs: number;
  requestId: ReturnType<Crypto['randomUUID']>;
  state: JobState;
  consumers: Set<symbol>;
  resolve: (value: string | null) => void;
  promise: Promise<string | null>;
}

const queue: PreviewJob[] = [];
const jobs = new Map<string, PreviewJob>();
const completed = new Map<string, string | null>();
let active = 0;

function remember(key: string, value: string | null): void {
  if (!value) return;
  completed.delete(key);
  completed.set(key, value);
  if (completed.size > MAX_REMEMBERED_RESULTS) {
    completed.delete(completed.keys().next().value!);
  }
}

async function loadPreview(job: PreviewJob): Promise<string | null> {
  if (job.kind === 'video') {
    await mediaResources.get(job.filePath, job.notebookPath);
    return getNotebookVideoPreview(
      job.filePath,
      job.notebookPath,
      job.requestId,
    );
  }
  const cachedFile = await mediaResources.thumbnail(job.filePath, job.notebookPath, 'image', job.requestId);
  return cachedFile ? files.toAssetUrl(cachedFile) : null;
}

function pump(): void {
  while (active < MAX_ACTIVE_PREVIEWS && queue.length > 0) {
    const job = queue.shift();
    if (!job || job.consumers.size === 0) continue;
    job.state = 'running';
    active += 1;
    void loadPreview(job)
      .catch(() => null)
      .then((value) => {
        job.state = 'complete';
        remember(job.key, value);
        job.resolve(value);
      })
      .finally(() => {
        active -= 1;
        if (jobs.get(job.key) === job) jobs.delete(job.key);
        pump();
      });
  }
}

/** Queue and deduplicate thumbnail work. Queued jobs with no remaining cards are dropped. */
export function requestMediaPreview(
  filePath: string,
  notebookPath: string,
  kind: PreviewKind,
  modifiedMs: number,
): { promise: Promise<string | null>; cancel: () => void } {
  const key = `${kind}\u0000${filePath}\u0000${notebookPath}\u0000${modifiedMs}`;
  const token = Symbol(key);
  const cached = completed.get(key);
  if (cached !== undefined) {
    return { promise: Promise.resolve(cached), cancel: () => undefined };
  }

  let job = jobs.get(key);
  if (!job) {
    let resolve!: (value: string | null) => void;
    const promise = new Promise<string | null>((done) => { resolve = done; });
    job = { key, filePath, notebookPath, kind, modifiedMs, requestId: crypto.randomUUID(), state: 'queued', consumers: new Set(), resolve, promise };
    jobs.set(key, job);
    queue.push(job);
  }
  job.consumers.add(token);
  const selectedJob = job;
  const promise = new Promise<string | null>((resolve) => {
    void selectedJob.promise.then((value) => {
      if (selectedJob.consumers.has(token)) resolve(value);
      else resolve(null);
    });
  });
  pump();

  let cancelled = false;
  return {
    promise,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      selectedJob.consumers.delete(token);
      if (selectedJob.state === 'queued' && selectedJob.consumers.size === 0) {
        const index = queue.indexOf(selectedJob);
        if (index >= 0) queue.splice(index, 1);
        if (jobs.get(key) === selectedJob) jobs.delete(key);
        selectedJob.state = 'complete';
        selectedJob.resolve(null);
      } else if (selectedJob.state === 'running' && selectedJob.consumers.size === 0) {
        if (jobs.get(key) === selectedJob) jobs.delete(key);
        void mediaResources.cancelThumbnail(selectedJob.requestId).catch(() => undefined);
      }
    },
  };
}
