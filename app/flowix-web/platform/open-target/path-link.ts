import { canonicalPath, notebookForPath } from '@/lib/path';

/** Persist a notebook-relative address in a Flowix deep link. */
export function buildNoteOpenLink(book: string, relativeFile: string, heading?: string): string {
  const file = relativeFile.replace(/\\/g, '/');
  if (!book || !file || file.startsWith('/') || file.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid notebook link target');
  }
  const params = new URLSearchParams({ b: book, f: file });
  // Explicit heading also disambiguates filenames containing '#'.
  if (heading !== undefined || file.includes('#')) params.set('heading', heading ?? '');
  return `flowix://open?${params.toString()}`;
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
