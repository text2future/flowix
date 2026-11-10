import { canonicalPath, notebookForPath } from '@/lib/path';

/**
 * Assemble a note deep link.
 *
 * The file is always notebook-relative; the notebook itself is addressed by
 * exactly one of: nothing (the referring document's own notebook), a notebook
 * ID (cross-notebook), or a notebook name (historical links only).
 *
 * `heading` doubles as the disambiguator for filenames containing '#', so it is
 * written even when empty in that case.
 */
function openLink(params: URLSearchParams, file: string, heading?: string): string {
  if (heading !== undefined || file.includes('#')) params.set('heading', heading ?? '');
  return `flowix://open?${params.toString()}`;
}

function notebookRelativeFile(relativeFile: string): string {
  const file = relativeFile.replace(/\\/g, '/');
  if (!file || file.startsWith('/') || file.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid notebook link target');
  }
  return file;
}

/** Same-notebook reference: no name, no ID, so renames and moves leave it intact. */
export function buildNotebookRelativeOpenLink(relativeFile: string, heading?: string): string {
  const file = notebookRelativeFile(relativeFile);
  return openLink(new URLSearchParams({ f: file }), file, heading);
}

/** Cross-notebook reference: the ID is the only target that survives both renames. */
export function buildNoteOpenLinkById(notebookId: string, relativeFile: string, heading?: string): string {
  const file = notebookRelativeFile(relativeFile);
  if (!notebookId) throw new Error('Invalid notebook link target');
  return openLink(new URLSearchParams({ notebookId, f: file }), file, heading);
}

/** Persist a notebook-relative address in a Flowix deep link (historical name form). */
export function buildNoteOpenLink(book: string, relativeFile: string, heading?: string): string {
  const file = notebookRelativeFile(relativeFile);
  if (!book) throw new Error('Invalid notebook link target');
  return openLink(new URLSearchParams({ b: book, f: file }), file, heading);
}

export function buildNoteOpenLinkFromPath(
  path: string,
  notebooks: ReadonlyArray<{ name: string; path: string }>,
  heading?: string,
): string | null {
  const target = canonicalPath(path);
  const notebook = notebookForPath(target, notebooks);
  const match = notebook ? { notebook, root: canonicalPath(notebook.path).replace(/\/+$/, '') } : null;
  if (!match || target.length <= match.root.length || notebooks.filter((book) => book.name === match.notebook.name).length !== 1) return null;
  return buildNoteOpenLink(match.notebook.name, target.slice(match.root.length + 1), heading);
}
