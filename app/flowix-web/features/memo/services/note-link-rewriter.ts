import {
  canonicalDirectoryPath, canonicalPath, isPathInDirectory, joinNotebookMemoPath,
  notebookForPath, pathComparisonKey,
} from '@/lib/path';
import { createNoteLinkRewriteProgress, mergeDocumentRewriteStages, pathBeforeMoves, type NoteLinkMoveJob } from './note-link-rewrite-progress';
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

/** Change Flowix note destinations and their filename-based display names.
 *
 * `sourceNotebook` is the notebook that owns the document being rewritten, and
 * it decides everything here:
 *
 * - Only references written inside that notebook are maintained. A move never
 *   rewrites cross-notebook references, because finding them would require
 *   reading every other notebook in the library.
 * - A bare `?f=` link means "inside my own notebook", so it belongs to that
 *   document's notebook by definition.
 * - New links are written in canonical form: `?f=` inside the notebook,
 *   `notebookId=&f=` when the note moved into another notebook. Neither
 *   carries a notebook name.
 */
export async function rewriteMovedNoteLinks(
  content: string,
  before: { book: string; file: string; notebookId: string; path: string },
  after: { file: string; notebookId?: string },
  folder = false,
  sourceNotebook: Notebook | null = null,
): Promise<string> {
  // Without a known owner, fall back to the moved note's own notebook: the
  // scan only visits notebooks that own a moved note.
  const owner = sourceNotebook ?? {
    id: before.notebookId,
    name: before.book,
    path: before.path.slice(0, before.path.length - before.file.length - 1),
  };
  const targetNotebookId = after.notebookId ?? before.notebookId;
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
    const linkNotebookId = params.get('notebookId');
    const linkBook = params.get('b') ?? params.get('book');
    const linkFile = params.get('f') ?? params.get('file') ?? params.get('relativePath');
    const physical = params.get('path');
    // Only references that resolve inside the notebook owning this document are
    // maintained: a bare `?f=` means "my notebook", and naming another notebook
    // (by ID or historical name) puts the reference out of scope.
    const sameNotebook = linkNotebookId
      ? linkNotebookId === owner.id
      : linkBook
        ? linkBook === owner.name
        : true;
    const resolved = sameNotebook && linkFile ? joinNotebookMemoPath(owner.path, linkFile) : null;
    const matchesNotebook = resolved !== null && (
      pathComparisonKey(resolved) === pathComparisonKey(before.path)
      || (folder && isPathInDirectory(resolved, before.path))
    );
    const matchesPhysicalPath = physical === before.path || (folder && physical?.startsWith(`${before.path}/`));
    if (!matchesNotebook && !matchesPhysicalPath) return link;
    const targetFile = movedFile(linkFile)
      ?? (matchesPhysicalPath && physical ? `${after.file}${physical.slice(before.path.length)}` : null);
    if (targetFile === null) return link;
    params.delete('b');
    params.delete('book');
    params.delete('f');
    params.delete('file');
    params.delete('notebookId');
    params.delete('relativePath');
    params.delete('path');
    if (targetNotebookId !== owner.id) params.set('notebookId', targetNotebookId);
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
    rewriteSource: (content: string, path: string, applied: number) => {
      const source = notebookForPath(path, useNoteStore.getState().notebooks) ?? null;
      return rewrite(content, pathBeforeMoves(path, jobs.slice(applied)), path, applied, source);
    },
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

/** Notebook that owns a path, with the notebook-relative file inside it. */
function notebookAddress(path: string, notebooks: readonly Notebook[]): { notebook: Notebook; file: string } | null {
  const notebook = notebookForPath(path, notebooks);
  if (!notebook) return null;
  const file = canonicalPath(path).slice(canonicalDirectoryPath(notebook.path).length + 1);
  return file && !file.startsWith('/') ? { notebook, file } : null;
}

function createBatchRewrite(jobs: MoveJob[], notebooks: readonly Notebook[]) {
  // Notebooks that any endpoint of a move lives in. A destination outside every
  // notebook still needs its source notebook scanned for relative references.
  const scope = new Set<string>();
  for (const { oldPath, newPath } of jobs) {
    for (const path of [oldPath, newPath]) {
      const notebook = notebookForPath(path, notebooks);
      if (notebook) scope.add(notebook.id);
    }
  }
  const moves = jobs.flatMap(({ oldPath, newPath, folder }, index) => {
    const before = notebookAddress(oldPath, notebooks);
    const after = notebookAddress(newPath, notebooks);
    if (!before || !after) return [];
    return [{
      index,
      before: {
        book: before.notebook.name,
        notebookId: before.notebook.id,
        file: before.file,
        path: canonicalPath(oldPath),
      },
      after: { file: after.file, notebookId: after.notebook.id },
      folder,
    }];
  });
  const rewrite = async (
    content: string,
    sourceBefore: string,
    sourceAfter: string,
    applied: number,
    sourceNotebook: Notebook | null = null,
  ) => {
    const { rewriteDocumentPathLinks } = await import('@/lib/markdown-path-references');
    let value = await rewriteDocumentPathLinks(content, sourceBefore, sourceAfter, jobs.slice(applied));
    for (const move of moves) {
      if (move.index < applied) continue;
      value = await rewriteMovedNoteLinks(value, move.before, move.after, move.folder, sourceNotebook);
    }
    return value;
  };
  return { moves, rewrite, scope };
}

interface ReferenceRewriteContext {
  jobs: MoveJob[];
  notebooks: readonly Notebook[];
  rewrite: (
    content: string,
    sourceBefore: string,
    sourceAfter: string,
    applied: number,
    sourceNotebook: Notebook | null,
  ) => Promise<string>;
  progress: ReturnType<typeof createNoteLinkRewriteProgress>;
  shouldYield: () => boolean;
  acceptBackgroundDocumentContent: (path: string, content: string) => boolean;
  hasLiveUnsavedDocumentAtPath: (path: string) => boolean;
  getWorkspaceDocumentLinkStage: (path: string, batchId: string, savedContent?: string) => number | undefined;
}

/**
 * Catch ONE document up with the queued moves.
 *
 * Every write keeps the queue's checkpoint (`applied`) and compare-and-swap
 * contract, so the same document can be retried by the background scan without
 * duplicating work. Returns false when the document still needs a later pass
 * (dirty buffer, concurrent move, write conflict).
 */
async function rewriteDocumentReferences(
  context: ReferenceRewriteContext,
  fullPath: string,
  scanningNotebook: Notebook,
): Promise<boolean> {
  const { jobs, rewrite, progress, shouldYield, acceptBackgroundDocumentContent,
    hasLiveUnsavedDocumentAtPath, getWorkspaceDocumentLinkStage } = context;
  // Nested notebooks overlap: a document below another notebook's root belongs
  // to the most specific one, and only that one may resolve its `?f=` links.
  const notebook = notebookForPath(fullPath, context.notebooks) ?? scanningNotebook;
  try {
    if (hasLiveUnsavedDocumentAtPath(fullPath)) return false;
    let content = await externalDocuments.read(fullPath, notebook.path);
    if (content === null) return false;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (shouldYield() || hasLiveUnsavedDocumentAtPath(fullPath)) return false;
      const canonicalStage = jobs[0].id ? getWorkspaceDocumentLinkStage(fullPath, jobs[0].id, content) : undefined;
      const document = await progress.open(fullPath, content, canonicalStage);
      if (!document) return false;
      const updated = await rewrite(content, document.sourcePath, fullPath, document.applied, notebook);
      if (shouldYield()) return false;
      if (updated === content) {
        document.commit(false);
        return acceptBackgroundDocumentContent(fullPath, content);
      }
      await document.prepare(updated);
      // Input or a later move may have arrived while hashing the write intent.
      if (shouldYield() || hasLiveUnsavedDocumentAtPath(fullPath)) {
        document.rollback();
        return false;
      }
      const result = await notes.writeDocument({ filePath: fullPath, content: updated, expectedContent: content });
      if (result) {
        document.commit();
        return acceptBackgroundDocumentContent(fullPath, result.content);
      }
      document.rollback();
      if (attempt === 1) return false;
      const latest = await externalDocuments.read(fullPath, notebook.path);
      if (latest === null) return false;
      content = latest;
    }
  } catch (error) {
    logger.warn('background reference update deferred', { path: fullPath, error });
  }
  return false;
}

/** Load the rewrite machinery once per batch (document sessions must be initialized). */
async function createReferenceRewriteContext(
  jobs: MoveJob[],
  persistProgress: () => void,
  shouldYield: () => boolean,
  notebooks: readonly Notebook[],
): Promise<{ context: ReferenceRewriteContext; scope: Set<string> }> {
  // The save pipeline imports this scheduler. Load document sessions only when
  // executing a job, after their module-level subscriptions are initialized.
  const { acceptBackgroundDocumentContent, hasLiveUnsavedDocumentAtPath, getWorkspaceDocumentLinkStage } = await import('@features/document/public/workspace-api');
  const { rewrite, scope } = createBatchRewrite(jobs, notebooks);
  return {
    scope,
    context: {
      jobs,
      notebooks,
      rewrite,
      progress: createNoteLinkRewriteProgress(jobs, persistProgress),
      shouldYield,
      acceptBackgroundDocumentContent,
      hasLiveUnsavedDocumentAtPath,
      getWorkspaceDocumentLinkStage,
    },
  };
}

async function readNotebooks(): Promise<Notebook[]> {
  const state = useNoteStore.getState();
  if (!state.notebooksInitialized) await state.loadNotebooks();
  return useNoteStore.getState().notebooks;
}

export async function rewriteNoteLinkMoves(
  jobs: MoveJob[],
  shouldYield: () => boolean = () => false,
  persistProgress: () => void = () => {},
): Promise<boolean> {
  if (!jobs.length) return true;
  const notebooks = await readNotebooks();
  const { context, scope } = await createReferenceRewriteContext(jobs, persistProgress, shouldYield, notebooks);

  let complete = true;

  // Only notebooks that own one end of a move can hold references it affects:
  // a `?f=` link means "inside my own notebook". Every other notebook is left
  // unread, so one rename no longer walks the whole library.
  const scanned = new Set<string>();
  // Nested roots overlap, so both the directory walk and the documents it
  // yields are shared across notebooks: every document is rewritten once, with
  // the notebook that actually owns it.
  const visited = new Set<string>();
  for (const notebook of notebooks) {
    if (!scope.has(notebook.id)) continue;
    if (shouldYield()) return false;
    const directories = [notebook.path];
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
        // Roots can nest, so a directory walk may reach documents that belong to
        // another notebook. Those are out of scope: only the notebooks that own
        // a moved file are read.
        const owner = notebookForPath(entry.fullPath, notebooks);
        if (!owner || !scope.has(owner.id)) continue;
        if (scanned.has(canonicalPath(entry.fullPath))) continue;
        documents.push(entry);
      }
      // Bound I/O concurrency, and avoid read_document's per-file index lookup.
      // A link rewrite only needs the exact Markdown bytes on disk.
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, documents.length) }, async () => {
        while (next < documents.length) {
          if (shouldYield()) { complete = false; return; }
          const entry = documents[next++];
          scanned.add(canonicalPath(entry.fullPath));
          if (!await rewriteDocumentReferences(context, entry.fullPath, notebook)) complete = false;
        }
      }));
      // No-op documents also advance; batch their progress after bounded I/O.
      persistProgress();
    }
  }
  return complete;
}

/**
 * A closed moved source must catch up before its first editable body is published.
 *
 * Only the opened document is rewritten here: publishing a body depends on that
 * document's own references, not on the rest of the library. Spreading the move
 * to every other note stays with the serialized background scan, which a large
 * library (thousands of Markdown files) turns into minutes of work.
 */
export async function prepareMovedDocumentForRead(path: string): Promise<void> {
  const queued = readJobs();
  const target = canonicalPath(path);
  if (!queued.length || pathBeforeMoves(target, queued) === target) return;
  const notebooks = await readNotebooks();
  const notebook = notebookAddress(target, notebooks)?.notebook;
  if (!notebook) return;
  const persist = () => persistQueuedProgress(queued);
  const { context } = await createReferenceRewriteContext(
    queued,
    persist,
    () => readJobs().length > queued.length,
    notebooks,
  );
  if (context.progress.stage(target) >= queued.length) return;
  if (!await rewriteDocumentReferences(context, target, notebook)) {
    // Never block the open: the background scan owns the rest and hands its
    // result to a live buffer through `acceptBackgroundDocumentContent`.
    logger.warn('moved document catch-up deferred', { path: target });
  }
  resumePendingNoteLinkUpdates();
}
