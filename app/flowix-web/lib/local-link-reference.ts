import { canonicalPath, notebookForPath } from './path';
import { documentResourceRoots, formatDocumentPathReference } from './document-resource-context';
import { resolveDocumentRelativeHref, resolvePhysicalDocumentPath, type ResolvedDocumentPath } from './document-relative-path';

export interface LinkNotebook { id: string; name: string; path: string }
export interface LinkRepository { notebookId: string; path: string }
export interface LocalLinkContext {
  documentPath: string;
  notebookId?: string;
  notebooks: readonly LinkNotebook[];
  repositories?: readonly LinkRepository[];
}

function hasControls(value: string): boolean {
  return Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

/** Convert a single copied address; no store reads, file I/O, or editor dependencies. */
export function localLinkReference(raw: string, context: LocalLinkContext): (ResolvedDocumentPath & { href: string; label: string }) | null {
  const text = raw.trim();
  if (!text || hasControls(text)) return null;
  const allowedRoots = documentResourceRoots(context.notebooks, context.repositories);
  const currentOwner = notebookForPath(context.documentPath, allowedRoots);
  const notebook = context.notebookId
    ? context.notebooks.find(book => book.id === context.notebookId)
    : context.notebooks.find(book => book.id === currentOwner?.id);
  if (!notebook) {
    let target: ResolvedDocumentPath | null = null;
    if (/^(?:[\\/]|[a-z]:[\\/])/i.test(text)) target = resolvePhysicalDocumentPath(text);
    else if (/^file:/i.test(text)) target = resolveDocumentRelativeHref(text, context.documentPath);
    if (!target || (!target.path.startsWith('/') && !/^[a-z]:\//i.test(target.path) && !target.path.startsWith('//'))) return null;
    const href = formatDocumentPathReference(target, undefined, allowedRoots);
    const name = canonicalPath(target.path).split('/').pop()!;
    return { ...target, href, label: name.replace(/\.md$/i, '') };
  }
  if (currentOwner?.id !== notebook.id) return null;
  let path: string;
  let anchor: string | null = null;
  let search: string | undefined;
  if (/^flowix:/i.test(text)) {
    try {
      const url = new URL(text);
      if (url.hostname !== 'open' || (url.pathname && url.pathname !== '/')) return null;
      const params = url.searchParams;
      const file = params.get('f') ?? params.get('file') ?? params.get('relativePath') ?? '';
      // The notebook is named by ID (cross-notebook) or by name (historical), and
      // a same-notebook address names none at all.
      const named = params.get('b') ?? params.get('book');
      const id = params.get('notebookId');
      const notebooks = id
        ? context.notebooks.filter(book => book.id === id)
        : named
          ? context.notebooks.filter(book => book.name === named)
          : [notebook];
      if (notebooks.length !== 1 || notebooks[0].id !== notebook.id || !file
        || file.startsWith('/') || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..')
        || hasControls(file)) return null;
      path = `${canonicalPath(notebook.path).replace(/\/+$/, '')}/${file}`;
      anchor = params.get('heading') ?? (url.hash ? decodeURIComponent(url.hash.slice(1)) : null);
    } catch { return null; }
  } else {
    // Plain filesystem paths keep literal #, ? and percent characters in filenames.
    if (/^(?:[\\/]|[a-z]:[\\/])/i.test(text)) {
      const target = resolvePhysicalDocumentPath(text);
      if (!target) return null;
      path = target.path;
    } else if (/^file:/i.test(text)) {
      const target = resolveDocumentRelativeHref(text, context.documentPath);
      if (!target) return null;
      path = target.path;
      anchor = target.anchor;
      search = target.search;
    } else return null;
  }
  if (notebookForPath(path, allowedRoots)?.id !== notebook.id) return null;
  const target = { path, anchor, ...(search ? { search } : {}) };
  const href = formatDocumentPathReference(target, context.documentPath, allowedRoots);
  const name = canonicalPath(path).split('/').pop()!;
  return { ...target, href, label: name.replace(/\.md$/i, '') };
}
