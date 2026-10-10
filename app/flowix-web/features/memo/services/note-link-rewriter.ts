import { canonicalPath } from '@/lib/path';
import { buildNoteOpenLinkFromPath } from '@platform/open-target/path-link';
import { externalDocuments, notes } from '@platform/tauri/client';
import { files } from '@platform/tauri/client/desktop';
import { useNoteStore } from '@features/memo/store/note-store';
import { displayTitleFromFilename } from '@/lib/utils';
import { createLogger } from '@/lib/logger';

const logger = createLogger('note-link-rewriter');

type Notebook = { id: string; name: string; path: string };
type MoveJob = { oldPath: string; newPath: string; folder: boolean };
const JOBS_KEY = 'flowix:pending-note-link-moves';

function readJobs(): MoveJob[] {
  try { return JSON.parse(localStorage.getItem(JOBS_KEY) ?? '[]') as MoveJob[]; }
  catch { return []; }
}

function writeJobs(jobs: MoveJob[]): void {
  localStorage.setItem(JOBS_KEY, JSON.stringify(jobs));
}

/** Change Flowix note destinations and their filename-based display names. */
export function rewriteMovedNoteLinks(
  content: string,
  before: { book: string; file: string; notebookId: string; path: string },
  after: { book: string; file: string },
  folder = false,
): string {
  const rewriteLine = (line: string): string => line.replace(/(\[((?:\\.|[^\]\\\n])*)\]\()(flowix:\/\/open\?[^\s)]+)(\))/gi, (whole, _prefix: string, _label: string, href: string, suffix: string, offset: number) => {
    // A URL shown as inline code is an example, not a note reference.
    const beforeLink = line.slice(0, offset);
    if ((beforeLink.match(/(?<!\\)`/g)?.length ?? 0) % 2 !== 0) return whole;
    let url: URL;
    try { url = new URL(href); } catch { return whole; }
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
    if (!matchesBookPath && !matchesLegacyBookPath && !matchesOldIdPath && !matchesPhysicalPath) return whole;
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
    return `[${label}](flowix://open?${params.toString()}${url.hash}${suffix}`;
  });
  let fence: { marker: string; length: number } | null = null;
  return content.split(/(\r?\n)/).map((part) => {
    if (part === '\n' || part === '\r\n') return part;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(part)?.[1];
    if (marker) {
      if (!fence) fence = { marker: marker[0], length: marker.length };
      else if (marker[0] === fence.marker && marker.length >= fence.length) fence = null;
      return part;
    }
    return fence ? part : rewriteLine(part);
  }).join('');
}

let pending: Promise<void> = Promise.resolve();
let running = false;
let retryCount = 0;
let rerunRequested = false;

export function updateNoteLinksAfterMove(oldPath: string, newPath: string, folder = false): void {
  if (canonicalPath(oldPath) === canonicalPath(newPath)) return;
  try { writeJobs([...readJobs(), { oldPath, newPath, folder }]); } catch { return; }
  resumePendingNoteLinkUpdates();
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
        const complete = await rewriteNoteLinkMoves(jobs, () => readJobs().length > jobs.length);
        if (complete) writeJobs(readJobs().slice(jobs.length));
        if (!complete) {
          if (++retryCount <= 3) window.setTimeout(resumePendingNoteLinkUpdates, 5000);
        } else {
          retryCount = 0;
          if (readJobs().length) window.setTimeout(resumePendingNoteLinkUpdates, 0);
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

export async function rewriteNoteLinkMoves(jobs: MoveJob[], shouldYield: () => boolean = () => false): Promise<boolean> {
  // The save pipeline imports this scheduler. Load document sessions only when
  // executing a job, after their module-level subscriptions are initialized.
  const { acceptBackgroundDocumentContent, hasLiveUnsavedDocumentAtPath } = await import('@features/document/public/workspace-api');
  const state = useNoteStore.getState();
  if (!state.notebooksInitialized) await state.loadNotebooks();
  const notebooks: Notebook[] = useNoteStore.getState().notebooks;
  const moves = jobs.flatMap(({ oldPath, newPath, folder }) => {
    const beforeLink = buildNoteOpenLinkFromPath(oldPath, notebooks);
    const afterLink = buildNoteOpenLinkFromPath(newPath, notebooks);
    if (!beforeLink || !afterLink) return [];
    const beforeUrl = new URL(beforeLink);
    const afterUrl = new URL(afterLink);
    const book = beforeUrl.searchParams.get('b')!;
    const notebook = notebooks.find((item) => item.name === book)!;
    return [{
      before: { book, file: beforeUrl.searchParams.get('f')!, notebookId: notebook.id, path: canonicalPath(oldPath) },
      after: { book: afterUrl.searchParams.get('b')!, file: afterUrl.searchParams.get('f')! },
      folder,
    }];
  });
  if (!moves.length) return true;
  const rewrite = (content: string) => moves.reduce(
    (value, move) => rewriteMovedNoteLinks(value, move.before, move.after, move.folder), content);

  let complete = moves.length === jobs.length;

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
            if (!content.toLowerCase().includes('flowix://open?')) continue;
            for (let attempt = 0; attempt < 2; attempt++) {
              const updated = rewrite(content);
              if (updated === content) {
                if (!acceptBackgroundDocumentContent(entry.fullPath, content)) complete = false;
                break;
              }
              // Input may have arrived while the disk read was pending.
              if (hasLiveUnsavedDocumentAtPath(entry.fullPath)) { complete = false; break; }
              const result = await notes.writeDocument({ filePath: entry.fullPath, content: updated, expectedContent: content });
              if (result) {
                if (!acceptBackgroundDocumentContent(entry.fullPath, result.content)) complete = false;
                break;
              }
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
    }
  }
  return complete;
}
