/** Open Markdown by notebook ID and relative path or by a physical file path. */

import { notes as notesClient } from '@platform/tauri/client';
import { useNoteStore } from '@features/memo/store/note-store';
import { setCurrentWorkspaceNotebook } from '@features/memo/public/workspace-api';
import { canonicalDirectoryPath, canonicalPath, joinNotebookMemoPath } from '@/lib/path';
import { clearWorkspaceDocument, openExternalTarget } from '@features/workspace/use-cases/workspace-navigation';
import type { WorkspaceContentLocation } from '@features/workspace/use-cases/workspace-content-activation';
import { publishHeadingAnchorRequest } from '@features/document/use-cases/heading-anchor-publish';
import { translate } from '@/lib/i18n';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';

/** Extract the heading anchor from a flowix://open deep link.
 *
 * Two accepted forms: the standard `#fragment` (GitHub slug), and the
 * generator's `heading` query parameter (raw heading text; an empty value
 * only disambiguates filenames containing '#' and is not an anchor).
 */
function anchorFromDeepLinkUrl(rawUrl: string): string | null {
  if (!/^flowix:\/\/open\?/i.test(rawUrl.trim())) return null;
  try {
    const target = new URL(rawUrl.trim().replace(/&amp;/gi, '&'));
    const fragment = target.hash.replace(/^#/, '').trim();
    if (fragment) {
      try { return decodeURIComponent(fragment) || null; } catch { return fragment; }
    }
    return target.searchParams.get('heading')?.trim() || null;
  } catch {
    return null;
  }
}

function hasHiddenNotebookDirectory(path: string, notebookPath: string): boolean {
  const absolutePath = canonicalPath(path);
  const root = canonicalDirectoryPath(notebookPath);
  const prefix = root === '/' ? '/' : `${root}/`;
  if (!absolutePath.startsWith(prefix)) return false;
  const relativeParts = absolutePath.slice(prefix.length).split('/').filter(Boolean);
  if (relativeParts.includes('.flowix')) return false;
  return relativeParts.slice(0, -1).some((part) => part.startsWith('.') && part !== '.' && part !== '..');
}

function physicalPathFromTarget(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.toLowerCase().startsWith('flowix://open?')) {
    try {
      const path = new URL(trimmed).searchParams.get('path');
      if (path) return physicalPathFromTarget(path);
    } catch {
      return trimmed;
    }
  }
  if (!trimmed.toLowerCase().startsWith('file://')) return trimmed;
  try {
    const pathname = decodeURIComponent(new URL(trimmed).pathname);
    return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
  } catch {
    return trimmed;
  }
}

function hiddenNotebookForPhysicalTarget(rawPath: string): { path: string; notebookPath: string } | null {
  const path = physicalPathFromTarget(rawPath);
  const notebook = useNoteStore.getState().notebooks.find((item) => (
    hasHiddenNotebookDirectory(path, item.path)
  ));
  return notebook ? { path, notebookPath: notebook.path } : null;
}

/** Resolve a path link through the notebook path index and open the document. */
export async function openNoteByDeepLink(url: string, anchorOverride: string | null = null): Promise<void> {
  const anchor = anchorOverride ?? anchorFromDeepLinkUrl(url);
  if (/^flowix:\/\/open\?/i.test(url.trim())) {
    const target = new URL(url.trim().replace(/&amp;/gi, '&'));
    const book = target.searchParams.get('b') ?? target.searchParams.get('book');
    const file = target.searchParams.get('f') ?? target.searchParams.get('file');
    if (book && file) {
      let notebooks = useNoteStore.getState().notebooks;
      if (!notebooks.some((item) => item.name === book)) {
        await useNoteStore.getState().loadNotebooks();
        notebooks = useNoteStore.getState().notebooks;
      }
      const matches = notebooks.filter((item) => item.name === book);
      if (matches.length !== 1) throw new Error(`Notebook link is unavailable or ambiguous: ${book}`);
      await openNoteByNotebookPath(matches[0].id, file, anchor);
      return;
    }
    const notebookId = target.searchParams.get('notebookId');
    const relativePath = target.searchParams.get('relativePath');
    if (notebookId && relativePath) {
      await openNoteByNotebookPath(notebookId, relativePath, anchor);
      return;
    }
    if (!target.searchParams.get('path')) throw new Error(`Invalid note link: ${url}`);
  }
  if (/^flowix:\/\/memo\//i.test(url.trim())) throw new Error(`Expired note link: ${url}`);
  const notebookLink = /^flowix:\/\/notebook\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(url.trim());
  if (notebookLink) {
    if (!await openNotebookById(decodeURIComponent(notebookLink[1]))) {
      throw new Error(`Notebook is unavailable: ${notebookLink[1]}`);
    }
    return;
  }
  const physicalPath = physicalPathFromTarget(url);
  if (/\.(?:md|markdown)$/i.test(physicalPath)) {
    const location = await notesClient.resolveLocation(physicalPath).catch(() => null);
    if (location?.indexable && location.notebookId && location.relativePath) {
      await openNoteByNotebookPath(location.notebookId, location.relativePath, anchor);
      return;
    }
  }
  const hiddenTarget = hiddenNotebookForPhysicalTarget(url);
  if (hiddenTarget) {
    const opened = await openExternalTarget(hiddenTarget.path, {
      destination: 'main-third',
      scopePath: hiddenTarget.notebookPath,
    });
    if (anchor) publishHeadingAnchorRequest(hiddenTarget.path, opened, anchor);
    return;
  }

  if (/^flowix:\/\//i.test(url.trim()) && !/^flowix:\/\/open\?/i.test(url.trim())) {
    throw new Error(`Unable to resolve note target: ${url}`);
  }
  if (!/\.(?:md|markdown)$/i.test(physicalPath)) {
    throw new Error(`Unsupported note target: ${url}`);
  }
  const opened = await openExternalTarget(physicalPath, { scopePath: null, destination: 'main-third' });
  if (anchor) publishHeadingAnchorRequest(physicalPath, opened, anchor);
}

/** Open a note by notebook ID + relative path; returns where the content landed. */
export async function openNoteByNotebookPath(
  notebookId: string,
  relativePath: string,
  anchor: string | null = null,
): Promise<WorkspaceContentLocation | null> {
  const normalized = relativePath.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid notebook-relative note path');
  }
  let notebook = useNoteStore.getState().notebooks.find((item) => item.id === notebookId);
  if (!notebook) {
    await useNoteStore.getState().loadNotebooks();
    notebook = useNoteStore.getState().notebooks.find((item) => item.id === notebookId);
  }
  if (!notebook) throw new Error(`Notebook is unavailable: ${notebookId}`);
  const path = joinNotebookMemoPath(notebook.path, normalized);
  if (!path) throw new Error('Invalid notebook-relative note path');
  if (await notesClient.pathStatus(path) === 'missing') {
    throw new Error(translate(getCurrentAppLanguage(), 'memo.open.missing', {
      path: `${notebook.name}/${normalized}`,
    }));
  }
  const opened = await openExternalTarget(path, { scopePath: notebook.path, destination: 'main-third' });
  if (anchor) publishHeadingAnchorRequest(path, opened, anchor);
  return opened;
}

/** Open a Markdown file by absolute path or file URL, with an optional heading anchor. */
export async function openNoteByPhysicalPath(rawPath: string, anchor: string | null = null): Promise<void> {
  await openNoteByDeepLink(rawPath, anchor);
}

/** Open a notebook by its explicit notebook link. */
export async function openNotebookById(notebookId: string): Promise<boolean> {
  const store = useNoteStore.getState();
  let notebook = store.notebooks.find((item) => item.id === notebookId);
  if (!notebook) {
    await store.loadNotebooks();
    notebook = useNoteStore.getState().notebooks.find((item) => item.id === notebookId);
  }
  if (!notebook) return false;
  await clearWorkspaceDocument();
  await setCurrentWorkspaceNotebook(notebook);
  useNoteStore.getState().setSelectedNotebook(notebook);
  await useNoteStore.getState().loadNotes({ notebookId: notebook.id });
  return true;
}
