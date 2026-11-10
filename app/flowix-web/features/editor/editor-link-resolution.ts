import { externalFileViewKind, isRelativePathHref } from '@features/editor/code-file';
import { normalizePlainLinkHref } from '@features/editor/extensions/markdown-link-markdown';
import {
  decodeDocumentHref,
  resolveDocumentRelativeHref,
  type ResolvedDocumentPath,
} from '@/lib/document-relative-path';

export { decodeDocumentHref as decodeEditorHref } from '@/lib/document-relative-path';
export { isRelativePathHref } from '@features/editor/code-file';
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

/**
 * 链接编辑框里的初始文案。
 *
 * 路径形态的地址按作者原文解码: 编辑一个 `skills/a.md` 时不能把它显示成
 * `http://skills/a.md` —— 那会凭空造出一个主机名, 保存时直接改坏文档。
 */
export function editorLinkInputValue(rawHref: string | null | undefined): string {
  const raw = rawHref ?? '';
  if (isRelativePathHref(raw)) return decodeDocumentHref(raw);
  const normalized = normalizePlainLinkHref(raw);
  // 本机绝对路径 / file: 地址同样可能出现百分号转义, 进输入框前解码一次。
  return normalized.startsWith('/') || /^file:/i.test(normalized)
    ? decodeDocumentHref(normalized)
    : normalized;
}
