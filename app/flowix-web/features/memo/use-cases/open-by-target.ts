/** Open Markdown by notebook ID and relative path or by a physical file path. */

import { openWorkspaceSurface as openInColumn } from '@features/workspace/public/session-opening-api';
import type { OpenWorkspaceSurfaceRequest } from '@features/workspace/public/open-surface-api';
import { notes as notesClient } from '@platform/tauri/client';
import { useNoteStore } from '@features/memo/store/note-store';
import { setCurrentWorkspaceNotebook } from '@features/memo/public/workspace-api';
import { canonicalDirectoryPath, canonicalPath, joinNotebookMemoPath } from '@/lib/path';
import {
  clearWorkspaceDocument,
  openWorkspaceSurface as openAtIndex,
} from '@features/workspace/public/note-navigation-api';
import type { WorkspaceContentLocation } from '@features/workspace/public/note-navigation-api';
import type { WorkspaceNavigationSource, WorkspaceSurfaceOpenResult } from '@features/workspace/public/open-surface-api';
import { publishHeadingAnchorRequest } from '@features/document/public/heading-navigation-api';
import { translate } from '@/lib/i18n';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';

/**
 * Where a note should be surfaced. `browser-column` mirrors the Agent message
 * link target: notes open in the right column instead of replacing whatever
 * the work column already shows.
 */
export interface OpenNoteDestinationOptions {
  source?: WorkspaceNavigationSource;
  destination?: 0 | 1;
  columnId?: import('@features/workspace/public/surface-api').WorkspaceColumnId;
  /**
   * Notebook that owns the document the link was written in.
   *
   * Same-notebook links (`flowix://open?f=…`) carry no notebook of their own,
   * so a caller that has the referring document must supply this.
   */
  ownerNotebookId?: string;
}

/** Cancelled opens have no view location to publish anchors against. */
function locationFromOpenResult(
  opened: WorkspaceSurfaceOpenResult,
): WorkspaceContentLocation | null {
  return opened.status === 'cancelled' ? null : opened.location;
}

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
export async function openNoteByDeepLink(
  url: string,
  anchorOverride: string | null = null,
  options?: OpenNoteDestinationOptions,
): Promise<void> {
  const anchor = anchorOverride ?? anchorFromDeepLinkUrl(url);
  if (/^flowix:\/\/open\?/i.test(url.trim())) {
    const target = new URL(url.trim().replace(/&amp;/gi, '&'));
    const book = target.searchParams.get('b') ?? target.searchParams.get('book');
    const file = target.searchParams.get('f')
      ?? target.searchParams.get('file')
      ?? target.searchParams.get('relativePath');
    if (book && file) {
      let notebooks = useNoteStore.getState().notebooks;
      if (!notebooks.some((item) => item.name === book)) {
        await useNoteStore.getState().loadNotebooks();
        notebooks = useNoteStore.getState().notebooks;
      }
      const matches = notebooks.filter((item) => item.name === book);
      if (matches.length !== 1) throw new Error(`Notebook link is unavailable or ambiguous: ${book}`);
      await openNoteByNotebookPath(matches[0].id, file, anchor, options);
      return;
    }
    // Cross-notebook links name their notebook by ID; same-notebook links name
    // none and resolve inside the notebook that owns the referring document.
    const notebookId = target.searchParams.get('notebookId') ?? options?.ownerNotebookId;
    if (file) {
      if (!notebookId) {
        throw new Error(`Notebook-relative note link is missing its notebook: ${url}`);
      }
      await openNoteByNotebookPath(notebookId, file, anchor, options);
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
      await openNoteByNotebookPath(location.notebookId, location.relativePath, anchor, options);
      return;
    }
  }
  const hiddenTarget = hiddenNotebookForPhysicalTarget(url);
  if (hiddenTarget) {
    const opened = await openNoteDestination(
      hiddenTarget.path,
      hiddenTarget.notebookPath,
      options,
    );
    if (anchor) publishHeadingAnchorRequest(hiddenTarget.path, opened, anchor);
    return;
  }

  if (/^flowix:\/\//i.test(url.trim()) && !/^flowix:\/\/open\?/i.test(url.trim())) {
    throw new Error(`Unable to resolve note target: ${url}`);
  }
  if (!/\.(?:md|markdown)$/i.test(physicalPath)) {
    throw new Error(`Unsupported note target: ${url}`);
  }
  const opened = await openNoteDestination(physicalPath, null, options);
  if (anchor) publishHeadingAnchorRequest(physicalPath, opened, anchor);
}

/** Route a resolved physical note into the requested workspace host. */
async function openNoteDestination(
  path: string,
  scopePath: string | null,
  options?: OpenNoteDestinationOptions,
): Promise<WorkspaceContentLocation | null> {
  if (options?.destination === 1) {
    const opened = await openNoteTarget(options, {
      index: 1,
      ...(options?.source ? { source: options.source } : {}),
      target: { kind: 'external', path, scopePath, transitionId: null },
      options: { notebookId: useNoteStore.getState().notebooks.find((notebook) => canonicalPath(notebook.path) === canonicalPath(scopePath ?? ''))?.id },
    });
    return locationFromOpenResult(opened);
  }
  const opened = await openNoteTarget(options, {
    index: 0,
    ...(options?.source ? { source: options.source } : {}),
    target: { kind: 'external', path, scopePath, transitionId: null },
  });
  return locationFromOpenResult(opened);
}

/** Open a note by notebook ID + relative path; returns where the content landed. */
export async function openNoteByNotebookPath(
  notebookId: string,
  relativePath: string,
  anchor: string | null = null,
  options?: OpenNoteDestinationOptions,
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
  if (options?.destination === 1) {
    const opened = locationFromOpenResult(
      await openNoteTarget(options, {
        index: 1,
        ...(options?.source ? { source: options.source } : {}),
        target: { kind: 'external', path, scopePath: notebook.path, transitionId: null },
        options: { notebookId },
      }),
    );
    if (anchor) publishHeadingAnchorRequest(path, opened, anchor);
    return opened;
  }
  const opened = await openNoteTarget(options, {
    index: 0,
    ...(options?.source ? { source: options.source } : {}),
    target: { kind: 'external', path, scopePath: notebook.path, transitionId: null },
  });
  const location = locationFromOpenResult(opened);
  if (anchor) publishHeadingAnchorRequest(path, location, anchor);
  return location;
}

/** Open a Markdown file by absolute path or file URL, with an optional heading anchor. */
export async function openNoteByPhysicalPath(
  rawPath: string,
  anchor: string | null = null,
  options?: OpenNoteDestinationOptions,
): Promise<void> {
  await openNoteByDeepLink(rawPath, anchor, options);
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

function openNoteTarget(options: OpenNoteDestinationOptions | undefined, request: OpenWorkspaceSurfaceRequest) {
  if (!options?.columnId) return openAtIndex(request);
  const { index: _index, ...rest } = request;
  return openInColumn({ ...rest, columnId: options.columnId });
}
