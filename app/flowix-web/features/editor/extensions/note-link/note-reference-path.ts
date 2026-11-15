import { resolveWikiDocumentHref } from '@/lib/wiki-reference';
import { sanitizeLinkHref } from '@/lib/safe-link';
import type { JSONContent } from '@tiptap/core';
import { documentResourceRoots, formatDocumentPathReference } from '@/lib/document-resource-context';
import { decodeDocumentHref, resolveDocumentRelativeHref, resolvePhysicalDocumentPath, wikiDocumentHref } from '@/lib/document-relative-path';
import { joinNotebookMemoPath, notebookForPath, samePath } from '@/lib/path';
import { escapeHtml, stripMdSuffix } from './markdown';
import type { NoteReferenceAttrs } from './note-reference-markdown';

export interface NoteReferenceContext {
  documentPath: string;
  notebookId?: string;
  notebooks: readonly { id: string; name: string; path: string }[];
  roots?: readonly { id: string; path: string }[];
  repositories?: readonly { notebookId: string; path: string }[];
}

export type NoteReferenceTarget =
  | { kind: 'path'; path: string; heading: string | null }
  | { kind: 'legacy-name'; name: string }
  | { kind: 'unresolved'; reason: 'invalid-path' | 'notebook-unavailable' | 'missing-target' | 'expired-link' };

/** Explicit wiki paths use the same document-directory base as pasted links. */
export function wikiReferencePath(attrs: NoteReferenceAttrs, documentPath?: string): string | null {
  const target = attrs.linkTarget;
  if (attrs.linkStyle !== 'wiki' || !target) return null;
  return resolveWikiDocumentHref(target, documentPath)?.path ?? null;
}

function isExplicitPath(target: string): boolean {
  return /^(?:\.{1,2}[\\/]|[\\/]|[a-z]:[\\/]|file:)/i.test(target);
}

/** Adapt historical locators at the boundary; callers only consume a resolved target. */
export function resolveNoteReference(attrs: NoteReferenceAttrs, context: NoteReferenceContext): NoteReferenceTarget {
  if (/^flowix:\/\/memo\//i.test(attrs.linkTarget ?? '')) return { kind: 'unresolved', reason: 'expired-link' };
  const resolved = (path: string | null): NoteReferenceTarget => path
    ? { kind: 'path', path, heading: attrs.heading }
    : { kind: 'unresolved', reason: 'invalid-path' };
  if (attrs.linkStyle === 'wiki' && attrs.linkTarget && (isExplicitPath(attrs.linkTarget) || /[\\/]|\.[^/\\]+$/i.test(attrs.linkTarget))) {
    return resolved(wikiReferencePath(attrs, context.documentPath));
  }
  const matches = context.notebooks.filter(book => {
    if (attrs.notebookId) return book.id === attrs.notebookId;
    if (attrs.notebookName) return book.name === attrs.notebookName;
    return book.id === context.notebookId;
  });
  if (matches.length === 1 && attrs.relativePath) {
    const path = joinNotebookMemoPath(matches[0].path, attrs.relativePath);
    return resolved(path ? resolvePhysicalDocumentPath(path)?.path ?? null : null);
  }
  if (attrs.originalPath) return resolved(resolvePhysicalDocumentPath(attrs.originalPath)?.path ?? null);
  if (attrs.linkStyle === 'markdown' && attrs.linkTarget) {
    return resolved(resolveDocumentRelativeHref(attrs.linkTarget, context.documentPath)?.path ?? null);
  }
  if (attrs.linkTarget && /^flowix:\/\/open\?/i.test(attrs.linkTarget)) {
    try {
      const path = new URL(attrs.linkTarget).searchParams.get('path');
      if (path) return resolved(resolvePhysicalDocumentPath(path)?.path ?? null);
    } catch { /* Keep an unresolved historical reference intact. */ }
  }
  if (attrs.linkStyle === 'wiki' && attrs.linkTarget && !/^[a-z][a-z0-9+.-]*:/i.test(attrs.linkTarget)) {
    return { kind: 'legacy-name', name: decodeDocumentHref(attrs.linkTarget) };
  }
  return { kind: 'unresolved', reason: attrs.relativePath ? 'notebook-unavailable' : 'missing-target' };
}

type NamedNoteReference = { relativePath: string; filename: string; title: string; notebookPath: string };

/** Legacy name lookup is injected so the resolver remains independent of application stores. */
export async function resolveNoteReferenceTarget(
  attrs: NoteReferenceAttrs,
  context: NoteReferenceContext,
  lookup: (query: string, notebookId?: string) => Promise<readonly NamedNoteReference[]>,
): Promise<{ path: string; heading: string | null } | null> {
  const target = resolveNoteReference(attrs, context);
  if (target.kind === 'path') return target;
  if (target.kind !== 'legacy-name') return null;
  const name = target.name.replace(/\\/g, '/');
  const query = name.split('/').pop()?.replace(/\.md$/i, '') ?? name;
  const notes = await lookup(query, context.notebookId ?? notebookForPath(context.documentPath, context.notebooks)?.id);
  const relative = resolveDocumentRelativeHref(`${attrs.linkTarget}.md`, context.documentPath);
  const matches = notes.filter(item => relative && joinNotebookMemoPath(item.notebookPath, item.relativePath)
    && samePath(joinNotebookMemoPath(item.notebookPath, item.relativePath)!, relative.path));
  return matches.length === 1 ? { path: relative!.path, heading: attrs.heading } : null;
}

function noteReferenceDestination(attrs: NoteReferenceAttrs, context: NoteReferenceContext): string | null {
  const target = resolveNoteReference(attrs, context);
  if (target.kind !== 'path') return null;
  const href = formatDocumentPathReference({ path: target.path, anchor: target.heading }, context.documentPath,
    context.roots ?? documentResourceRoots(context.notebooks, context.repositories));
  return wikiDocumentHref(href);
}

/** Wiki is reserved for Markdown notes inside the source notebook. */
function canUseWiki(path: string, context: NoteReferenceContext): boolean {
  const owner = notebookForPath(context.documentPath, context.notebooks);
  const targetOwner = notebookForPath(path, context.notebooks);
  return Boolean(owner && targetOwner?.id === owner.id && /\.(md|markdown)$/i.test(path));
}

export function noteReferenceWikiMarkdown(attrs: NoteReferenceAttrs, context: NoteReferenceContext): string | null {
  const target = resolveNoteReference(attrs, context);
  if (target.kind !== 'path' || !canUseWiki(target.path, context)) return null;
  const destination = noteReferenceDestination(attrs, context);
  return destination ? `[[${destination}]]` : null;
}

/** A normal link shares the editor's existing local/URL navigation behavior. */
export function noteReferenceMarkdownNode(attrs: NoteReferenceAttrs, context: NoteReferenceContext): JSONContent | null {
  const target = resolveNoteReference(attrs, context);
  if (target.kind === 'legacy-name') return null;
  if (target.kind === 'unresolved' && attrs.linkStyle !== 'wiki') return null;
  // Context-free parser extensions also render snapshots already normalized by the host.
  if (!context.documentPath && attrs.linkStyle === 'wiki'
    && !/^(?:[\\/]|[a-z]:[\\/]|[a-z][a-z0-9+.-]*:)/i.test(decodeDocumentHref(attrs.linkTarget ?? ''))
    && /\.(md|markdown)$/i.test(attrs.linkTarget ?? '')) return null;
  if (target.kind === 'path' && canUseWiki(target.path, context)
    && !(attrs.linkStyle === 'wiki' && /^(?:[\\/]|[a-z]:[\\/]|file:)/i.test(decodeDocumentHref(attrs.linkTarget ?? '')))) return null;
  const href = target.kind === 'path'
    ? formatDocumentPathReference({ path: target.path, anchor: target.heading }, context.documentPath,
      context.roots ?? documentResourceRoots(context.notebooks, context.repositories))
    : attrs.linkTarget ? `${attrs.linkTarget}${attrs.heading ? `#${encodeURIComponent(attrs.heading)}` : ''}` : null;
  if (!href) return null;
  if (!sanitizeLinkHref(href)) return { type: 'text', text: `[[${href}]]` };
  return { type: 'text', text: attrs.title || attrs.linkTarget || href,
    marks: [{ type: 'link', attrs: { href } }] };
}

/** Normalize a serialization snapshot without mutating the live editor. */
export function normalizeNoteReferenceDocument(node: JSONContent, context: NoteReferenceContext): JSONContent {
  if (!context.roots) context = { ...context, roots: documentResourceRoots(context.notebooks, context.repositories) };
  if (node.type === 'noteReference') {
    const attrs = node.attrs as NoteReferenceAttrs;
    const link = noteReferenceMarkdownNode(attrs, context);
    if (link) return link;
    const destination = noteReferenceDestination(attrs, context);
    if (!destination) return node;
    const hash = destination.indexOf('#');
    return { ...node, attrs: {
      ...node.attrs, notebookId: null, notebookName: '', relativePath: null, originalPath: null,
      linkStyle: 'wiki', linkTarget: hash < 0 ? destination : destination.slice(0, hash),
    } };
  }
  return node.content ? { ...node, content: node.content.map(child => normalizeNoteReferenceDocument(child, context)) } : node;
}

function escapeLinkText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

/** Legacy fallback is lossless when its notebook has not been loaded. */
export function renderNoteReferenceMarkdown(attrs: NoteReferenceAttrs, context: NoteReferenceContext): string {
  const link = noteReferenceMarkdownNode(attrs, context);
  if (link) {
    if (!link.marks?.length) return escapeLinkText(link.text!);
    const href = String(link.marks![0].attrs!.href).replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
    return `[${escapeLinkText(link.text!)}](${href})`;
  }
  if (attrs.linkStyle === 'wiki' && attrs.linkTarget) {
    return `[[${attrs.linkTarget}${attrs.heading ? `#${encodeURIComponent(attrs.heading)}` : ''}]]`;
  }
  const wiki = noteReferenceWikiMarkdown(attrs, context);
  if (wiki) return wiki;
  if (attrs.linkTarget) {
    const heading = attrs.linkStyle === 'markdown' && attrs.heading ? `#${encodeURIComponent(attrs.heading)}` : '';
    return `[${escapeLinkText(attrs.title || '')}](${attrs.linkTarget}${heading})`;
  }
  if (attrs.relativePath) {
    const label = `${attrs.notebookName ? `${attrs.notebookName}/` : ''}${attrs.title || ''}`;
    return `<note notebook="${escapeHtml(attrs.notebookId || '')}" relativePath="${escapeHtml(attrs.relativePath)}">${escapeHtml(label)}</note>`;
  }
  return escapeLinkText(stripMdSuffix(attrs.title || ''));
}
