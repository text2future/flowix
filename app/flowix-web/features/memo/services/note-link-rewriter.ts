import { canonicalPath } from '@/lib/path';
import { createNoteLinkRewriteProgress, mergeDocumentRewriteStages, pathBeforeMoves, type NoteLinkMoveJob } from './note-link-rewrite-progress';
import { buildNoteOpenLinkFromPath } from '@platform/open-target/path-link';
import { externalDocuments, notes } from '@platform/tauri/client';
import { files } from '@platform/tauri/client/desktop';
import { useNoteStore } from '@features/memo/store/note-store';
import { displayTitleFromFilename } from '@/lib/utils';
import { createLogger } from '@/lib/logger';

const logger = createLogger('note-link-rewriter');

type Notebook = { id: string; name: string; path: string };
type MoveJob = NoteLinkMoveJob;

const JOBS_KEY = 'flowix:pending-note-link-moves';

function readJobs(): MoveJob[] {
  try { return JSON.parse(localStorage.getItem(JOBS_KEY) ?? '[]') as MoveJob[]; }
  catch { return []; }
}

function writeJobs(jobs: MoveJob[]): void {
  localStorage.setItem(JOBS_KEY, JSON.stringify(jobs));
}

function persistQueuedProgress(jobs: MoveJob[]): void {
  const latest = readJobs();
  mergeDocumentRewriteStages(jobs, latest);
  writeJobs([...jobs, ...latest.slice(jobs.length)]);
}

/** A save receipt survives closing the source tab before the background scan resumes. */
export function acceptWorkspaceDocumentLinkSave(notice: { path: string; linkStage?: { batchId: string; through: number } }): void {
  const jobs = readJobs();
  if (notice.linkStage && jobs[0]?.id === notice.linkStage.batchId) {
    createNoteLinkRewriteProgress(jobs, () => {}).acknowledge(notice.path, notice.linkStage.through);
    writeJobs(jobs);
  }
  resumePendingNoteLinkUpdates();
}

/** Change Flowix note destinations and their filename-based display names. */
export async function rewriteMovedNoteLinks(
  content: string,
  before: { book: string; file: string; notebookId: string; path: string },
  after: { book: string; file: string },
  folder = false,
): Promise<string> {
  const { mapMarkdownLinks } = await import('@/lib/markdown-path-references');
  return mapMarkdownLinks(content, link => {
    const href = link.href;
    if (!/^flowix:\/\/open\?/i.test(href)) return link;
    let url: URL;
    try { url = new URL(href); } catch { return link; }
    const params = url.searchParams;
    const movedFile = (file: string | null): string | null => {
      if (file === before.file) return after.file;
      if (folder && file?.startsWith(`${before.file}/`)) return `${after.file}${file.slice(before.file.length)}`;
      return null;
    };
    const matchesBookPath = params.get('b') === before.book && movedFile(params.get('f')) !== null;
    const matchesLegacyBookPath = params.get('book') === before.book && movedFile(params.get('file')) !== null;
    const matchesOldIdPath = params.get('notebookId') === before.notebookId
      && movedFile(params.get('relativePath')) !== null;
    const physical = params.get('path');
    const matchesPhysicalPath = physical === before.path || (folder && physical?.startsWith(`${before.path}/`));
    if (!matchesBookPath && !matchesLegacyBookPath && !matchesOldIdPath && !matchesPhysicalPath) return link;
    const targetFile = movedFile(params.get('f') ?? params.get('file') ?? params.get('relativePath'))
      ?? (matchesPhysicalPath && physical ? `${after.file}${physical.slice(before.path.length)}` : after.file);
    params.delete('book');
    params.delete('file');
    params.delete('notebookId');
    params.delete('relativePath');
    params.delete('path');
    params.set('b', after.book);
    params.set('f', targetFile);
    const label = displayTitleFromFilename(targetFile).replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
    // url.hash is the heading anchor fragment (e.g. `#目标与范围`); searchParams
    // never carries it, so it must be re-appended or moves would drop it.
    return { ...link, label, href: `flowix://open?${params.toString()}${url.hash}` };
  });
}

let pending: Promise<void> = Promise.resolve();
let running = false;
let retryCount = 0;
let rerunRequested = false;

export function updateNoteLinksAfterMove(oldPath: string, newPath: string, folder = false) {
  oldPath = canonicalPath(oldPath);
  newPath = canonicalPath(newPath);
  if (oldPath === newPath) return;
  const jobs = readJobs();
  try {
    const last = jobs[jobs.length - 1];
    // Only coalesce adjacent identical confirmations. A->B, B->A, A->B
    // are distinct operations and must retain their order.
    if (!last || canonicalPath(last.oldPath) !== oldPath
      || canonicalPath(last.newPath) !== newPath || last.folder !== folder) {
      jobs.push({ oldPath, newPath, folder });
    }
    jobs[0].id ??= crypto.randomUUID();
    writeJobs(jobs);
  } catch { return; }
  resumePendingNoteLinkUpdates();
  const { rewrite } = createBatchRewrite(jobs, useNoteStore.getState().notebooks);
  return { id: jobs[0].id, through: jobs.length,
    rewriteSource: (content: string, path: string, applied: number) =>
      rewrite(content, pathBeforeMoves(path, jobs.slice(applied)), path, applied),
  };
}

/** Called on startup too, so an interrupted scan can finish after a restart. */
export function resumePendingNoteLinkUpdates(): void {
  if (!readJobs().length) return;
  if (running) { rerunRequested = true; return; }
  running = true;
  window.setTimeout(() => {
    pending = pending.then(async () => {
      try {
        // Apply consecutive renames in order during ONE scan, not a full scan
        // for every keystroke/old queued rename (B -> B2 -> B3).
        const jobs = readJobs();
        const complete = await rewriteNoteLinkMoves(jobs, () => readJobs().length > jobs.length, () => persistQueuedProgress(jobs));
        const appended = readJobs().length > jobs.length;
        // Retain the prefix and its document checkpoints when new moves arrive.
        if (complete && !appended) writeJobs([]);
        if (complete || appended) {
          retryCount = 0;
          if (readJobs().length) window.setTimeout(resumePendingNoteLinkUpdates, 0);
        } else if (++retryCount <= 3) {
          window.setTimeout(resumePendingNoteLinkUpdates, 5000);
        }
      } finally {
        running = false;
        if (rerunRequested) { rerunRequested = false; window.setTimeout(resumePendingNoteLinkUpdates, 0); }
      }
    }).catch((error) => { running = false; logger.warn('background reference scan deferred', { error }); });
  }, 0);
}

export async function rewriteLinksInNotebooks(oldPath: string, newPath: string, folder = false): Promise<boolean> {
  return rewriteNoteLinkMoves([{ oldPath, newPath, folder }]);
}

function createBatchRewrite(jobs: MoveJob[], notebooks: readonly Notebook[]) {
  const moves = jobs.flatMap(({ oldPath, newPath, folder }, index) => {
    const beforeLink = buildNoteOpenLinkFromPath(oldPath, notebooks);
    const afterLink = buildNoteOpenLinkFromPath(newPath, notebooks);
    if (!beforeLink || !afterLink) return [];
    const beforeUrl = new URL(beforeLink);
    const afterUrl = new URL(afterLink);
    const book = beforeUrl.searchParams.get('b')!;
    const notebook = notebooks.find((item) => item.name === book)!;
    return [{
      index,
      before: { book, file: beforeUrl.searchParams.get('f')!, notebookId: notebook.id, path: canonicalPath(oldPath) },
      after: { book: afterUrl.searchParams.get('b')!, file: afterUrl.searchParams.get('f')! },
      folder,
    }];
  });
  const rewrite = async (content: string, sourceBefore: string, sourceAfter: string, applied: number) => {
    const { rewriteDocumentPathLinks } = await import('@/lib/markdown-path-references');
    let value = await rewriteDocumentPathLinks(content, sourceBefore, sourceAfter, jobs.slice(applied));
    for (const move of moves) {
      if (move.index >= applied) value = await rewriteMovedNoteLinks(value, move.before, move.after, move.folder);
    }
    return value;
  };
  return { moves, rewrite };
}

export async function rewriteNoteLinkMoves(
  jobs: MoveJob[],
  shouldYield: () => boolean = () => false,
  persistProgress: () => void = () => {},
): Promise<boolean> {
  if (!jobs.length) return true;
  const progress = createNoteLinkRewriteProgress(jobs, persistProgress);
  // The save pipeline imports this scheduler. Load document sessions only when
  // executing a job, after their module-level subscriptions are initialized.
  const { acceptBackgroundDocumentContent, hasLiveUnsavedDocumentAtPath, getWorkspaceDocumentLinkStage } = await import('@features/document/public/workspace-api');
  const state = useNoteStore.getState();
  if (!state.notebooksInitialized) await state.loadNotebooks();
  const notebooks: Notebook[] = useNoteStore.getState().notebooks;
  const { moves, rewrite } = createBatchRewrite(jobs, notebooks);

  let complete = true;

  // Update references in the affected notebook before scanning unrelated books.
  const preferredBooks = [...moves].reverse().map((move) => move.before.notebookId);
  const priority = (book: Notebook) => {
    const index = preferredBooks.indexOf(book.id);
    return index < 0 ? preferredBooks.length : index;
  };
  const orderedNotebooks = [...notebooks].sort((a, b) =>
    priority(a) - priority(b));
  for (const notebook of orderedNotebooks) {
    if (shouldYield()) return false;
    const directories = [notebook.path];
    const visited = new Set<string>();
    while (directories.length > 0) {
      if (shouldYield()) return false;
      const directory = directories.shift()!;
      const normalizedDirectory = canonicalPath(directory);
      if (visited.has(normalizedDirectory)) continue;
      visited.add(normalizedDirectory);
      let entries: Awaited<ReturnType<typeof files.getDirChildren>>;
      try { entries = await files.getDirChildren(directory); } catch { complete = false; continue; }
      const documents: typeof entries = [];
      for (const entry of entries) {
        if (entry.type === 'folder') {
          directories.push(entry.fullPath);
          continue;
        }
        if (!/\.(?:md|markdown)$/i.test(entry.name)) continue;
        documents.push(entry);
      }
      // Bound I/O concurrency, and avoid read_document's per-file index lookup.
      // A link rewrite only needs the exact Markdown bytes on disk.
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, documents.length) }, async () => {
        while (next < documents.length) {
          if (shouldYield()) { complete = false; return; }
          const entry = documents[next++];
          try {
            if (hasLiveUnsavedDocumentAtPath(entry.fullPath)) { complete = false; continue; }
            let content = await externalDocuments.read(entry.fullPath, notebook.path);
            if (content === null) { complete = false; continue; }
            for (let attempt = 0; attempt < 2; attempt++) {
              if (shouldYield() || hasLiveUnsavedDocumentAtPath(entry.fullPath)) { complete = false; break; }
              const canonicalStage = jobs[0].id ? getWorkspaceDocumentLinkStage(entry.fullPath, jobs[0].id, content) : undefined;
              const document = await progress.open(entry.fullPath, content, canonicalStage);
              if (!document) { complete = false; break; }
              const updated = await rewrite(content, document.sourcePath, entry.fullPath, document.applied);
              if (shouldYield()) { complete = false; break; }
              if (updated === content) {
                document.commit(false);
                if (!acceptBackgroundDocumentContent(entry.fullPath, content)) complete = false;
                break;
              }
              await document.prepare(updated);
              // Input or a later move may have arrived while hashing the write intent.
              if (shouldYield() || hasLiveUnsavedDocumentAtPath(entry.fullPath)) {
                document.rollback();
                complete = false; break;
              }
              const result = await notes.writeDocument({ filePath: entry.fullPath, content: updated, expectedContent: content });
              if (result) {
                document.commit();
                if (!acceptBackgroundDocumentContent(entry.fullPath, result.content)) complete = false;
                break;
              }
              document.rollback();
              if (attempt === 1) { complete = false; break; }
              const latest = await externalDocuments.read(entry.fullPath, notebook.path);
              if (latest === null) { complete = false; break; }
              content = latest;
            }
          } catch (error) {
            complete = false;
            logger.warn('background reference update deferred', { path: entry.fullPath, error });
          }
        }
      }));
      // No-op documents also advance; batch their progress after bounded I/O.
      persistProgress();
    }
  }
  return complete;
}

/** A closed moved source must catch up before its first editable body is published. */
export async function prepareMovedDocumentForRead(path: string): Promise<void> {
  const queued = readJobs();
  if (!queued.length || pathBeforeMoves(path, queued) === canonicalPath(path)) return;
  const { getWorkspaceDocumentLinkStage } = await import('@features/document/public/workspace-api');
  if (queued[0].id && (getWorkspaceDocumentLinkStage(path, queued[0].id) ?? 0) >= queued.length) return;
  const ready = pending.then(async () => {
    const jobs = readJobs();
    if (!jobs.length || pathBeforeMoves(path, jobs) === canonicalPath(path)) return;
    const persist = () => persistQueuedProgress(jobs);
    const complete = await rewriteNoteLinkMoves(jobs, () => readJobs().length > jobs.length, persist);
    const caughtUp = createNoteLinkRewriteProgress(jobs, persist).stage(path) >= jobs.length;
    if (complete && readJobs().length === jobs.length) writeJobs([]);
    if (!caughtUp) throw new Error('Document references are still being reconciled; retry opening this document');
  });
  // Both loading and background scans share the same serialized persistence owner.
  pending = ready.catch(() => {});
  await ready;
}
