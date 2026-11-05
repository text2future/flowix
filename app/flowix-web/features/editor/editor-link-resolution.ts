import { externalFileViewKind } from '@features/editor/code-file';
import {
  decodeDocumentHref,
  resolveDocumentRelativeHref,
  type ResolvedDocumentPath,
} from '@/lib/document-relative-path';

export { decodeDocumentHref as decodeEditorHref } from '@/lib/document-relative-path';
export type ResolvedEditorLocalLink = ResolvedDocumentPath;

export interface EditorLinkContext {
  documentPath?: string | null;
  openLocalPath?: (target: ResolvedEditorLocalLink) => void | Promise<void>;
}

/** Link-specific recognition; filesystem resolution is shared with embedded resources. */
export function resolveEditorLocalHref(
  rawHref: string | null | undefined,
  documentPath: string | null | undefined,
): ResolvedEditorLocalLink | null {
  const href = rawHref?.trim() ?? '';
  if (!href) return null;
  const windowsDrive = /^[a-z]:[\\/]/i.test(href);
  if (!windowsDrive && !/^file:/i.test(href) && /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  const target = resolveDocumentRelativeHref(href, documentPath);
  if (!target) return null;
  if (windowsDrive || href.startsWith('/') || /^file:/i.test(href)) return target;

  const pathPart = decodeDocumentHref(href.split(/[?#]/, 1)[0]);
  const explicitRelative = /^\.{1,2}\//.test(pathPart);
  const looksLikeBareDomain = /^[^/]+\.[a-z]{2,}(?:\/|$)/i.test(pathPart);
  if (!explicitRelative && externalFileViewKind(target.path) === 'unavailable'
    && !(target.isDirectory && !looksLikeBareDomain)) return null;
  return target;
}
