import { externalFileViewKind } from '@features/editor/code-file';
import { canonicalPath } from '@/lib/path';

/**
 * 编辑器内相对路径链接的解析。
 *
 * 只做纯文本解析（无 IPC / 无 store 依赖），把 `../../公共/方案.md#章节` 这类
 * href 解析成相对当前文档目录的绝对路径 + 可选标题锚点；scheme、锚点、
 * 裸域名等非本地目标返回 null，调用方回退到既有网页语义。
 */

const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_DRIVE_RE = /^[a-z]:[\\/]/i;
const EXPLICIT_RELATIVE_RE = /^\.{1,2}\//;

/** A local file target with an optional heading fragment (no leading '#'). */
export interface ResolvedEditorLocalLink {
  path: string;
  anchor: string | null;
}

/**
 * Navigation context supplied by the document layer (it owns the dependency
 * on the workspace navigation surface). `openLocalPath` receives a target
 * resolved against `documentPath`.
 */
export interface EditorLinkContext {
  /** Absolute path of the document owning the editor. */
  documentPath?: string | null;
  /** Open a resolved local file target on the document surface. */
  openLocalPath?: (target: ResolvedEditorLocalLink) => void | Promise<void>;
}

/** Safe percent-decoding: malformed sequences return the input unchanged. */
export function decodeEditorHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

function normalizeDotSegments(path: string): string | null {
  const isAbsolute = path.startsWith('/');
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join('/');
  return isAbsolute ? `/${joined}` : (joined || '.');
}

function documentDirectory(documentPath: string): string | null {
  const canonical = canonicalPath(documentPath);
  const separatorIndex = canonical.lastIndexOf('/');
  if (separatorIndex <= 0) return null;
  return canonical.slice(0, separatorIndex);
}

function resolveAbsolute(href: string): ResolvedEditorLocalLink | null {
  const normalized = normalizeDotSegments(canonicalPath(href));
  if (!normalized) return null;
  return { path: normalized, anchor: null };
}

/**
 * Resolve an editor link href to a local file target.
 *
 * - Absolute posix/drive/UNC hrefs pass through (slash-normalized).
 * - Relative hrefs resolve against `documentPath`'s directory and must not
 *   escape the filesystem root.
 * - A trailing `#anchor` becomes `anchor` (GitHub slug heading fragment).
 * - Bare words without an extension keep the historic web semantics (autolink
 *   domains like `example.com` must not be mistaken for files).
 *
 * Returns null when the href is not a local file target.
 */
export function resolveEditorLocalHref(
  rawHref: string | null | undefined,
  documentPath: string | null | undefined,
): ResolvedEditorLocalLink | null {
  const href = rawHref?.trim() ?? '';
  if (!href) return null;
  if (href.startsWith('#') || href.startsWith('?') || href.startsWith('//')) return null;
  // Windows drive paths have a colon but are not URI schemes.
  if (WINDOWS_DRIVE_RE.test(href)) return resolveAbsolute(href);
  if (URI_SCHEME_RE.test(href)) return null;
  if (href.startsWith('/')) return resolveAbsolute(href);

  if (!documentPath) return null;

  // Split the anchor off the raw href before decoding: a literal '#' is the
  // fragment delimiter (CommonMark semantics, same as GitHub). A '#' inside
  // a filename cannot be distinguished at this layer, but a percent-encoded
  // %23 from any producer survives decoding intact.
  const hashIndex = href.indexOf('#', 1);
  const hasAnchor = hashIndex >= 0;
  const pathPart = decodeEditorHref(hasAnchor ? href.slice(0, hashIndex) : href);
  if (!pathPart) return null;

  const explicitRelative = EXPLICIT_RELATIVE_RE.test(pathPart);
  if (!explicitRelative && externalFileViewKind(pathPart) === 'unavailable') return null;

  const directory = documentDirectory(documentPath);
  if (!directory) return null;
  const resolved = normalizeDotSegments(`${directory}/${canonicalPath(pathPart)}`);
  if (!resolved) return null;
  return { path: resolved, anchor: hasAnchor ? decodeEditorHref(href.slice(hashIndex + 1)) : null };
}
