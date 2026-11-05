import { canonicalPath } from './path';

export interface ResolvedDocumentPath {
  path: string;
  anchor: string | null;
  /** Query string is not part of the filesystem path; resources may use it as a version. */
  search?: string;
  /** Syntax hint from a trailing separator; this does not inspect the filesystem. */
  isDirectory?: boolean;
}

const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_DRIVE_RE = /^[a-z]:[\\/]/i;

/** Safe percent-decoding: malformed sequences return the input unchanged. */
export function decodeDocumentHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

function normalizeDotSegments(path: string): string | null {
  const isAbsolute = path.startsWith('/');
  const isUnc = path.startsWith('//');
  const segments: string[] = [];
  const rootDepth = isUnc ? 2 : /^[a-z]:\//i.test(path) ? 1 : 0;
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length <= rootDepth) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join('/');
  return isUnc ? `//${joined}` : isAbsolute ? `/${joined}` : (joined || '.');
}

function documentDirectory(documentPath: string): string | null {
  const canonical = canonicalPath(documentPath);
  const separatorIndex = canonical.lastIndexOf('/');
  if (separatorIndex < 0) return null;
  return canonical.slice(0, separatorIndex) || '/';
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

/** Shared filesystem URL semantics for links and embedded resources, without link heuristics. */
export function resolveDocumentRelativeHref(
  rawHref: string | null | undefined,
  documentPath: string | null | undefined,
): ResolvedDocumentPath | null {
  let href = rawHref?.trim() ?? '';
  if (!href || hasControlCharacters(href)) return null;
  const fileUrl = /^file:/i.test(href);
  if (fileUrl) {
    try {
      const url = new URL(href);
      const host = url.hostname && url.hostname !== 'localhost' ? `//${url.hostname}` : '';
      href = host + url.pathname.replace(/^\/([a-z]:\/)/i, '$1') + url.search + url.hash;
    } catch { return null; }
  } else if (!WINDOWS_DRIVE_RE.test(href) && URI_SCHEME_RE.test(href)) return null;
  if (href.startsWith('#') || href.startsWith('?') || (!fileUrl && href.startsWith('//'))) return null;
  const hashIndex = href.indexOf('#');
  // Split URL delimiters before decoding so %3F and %23 remain filename characters.
  const withoutFragment = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const queryIndex = withoutFragment.indexOf('?');
  const search = queryIndex >= 0 ? withoutFragment.slice(queryIndex) : '';
  const pathPart = decodeDocumentHref(queryIndex >= 0 ? withoutFragment.slice(0, queryIndex) : withoutFragment);
  if (!pathPart || hasControlCharacters(pathPart)) return null;
  const absolute = pathPart.startsWith('/') || WINDOWS_DRIVE_RE.test(pathPart);
  const directory = absolute ? null : documentPath ? documentDirectory(documentPath) : null;
  if (!absolute && !directory) return null;
  const resolved = normalizeDotSegments(absolute ? canonicalPath(pathPart) : `${directory === '/' ? '' : directory}/${canonicalPath(pathPart)}`);
  if (!resolved) return null;
  return {
    path: resolved,
    ...(search ? { search } : {}),
    anchor: hashIndex >= 0 ? decodeDocumentHref(href.slice(hashIndex + 1)) : null,
    ...(/[\\/]$/.test(pathPart) ? { isDirectory: true } : {}),
  };
}


/** Encode each URL component, including Markdown destination delimiters. */
export function encodeDocumentComponent(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Generate a portable reference from the linking document's directory. */
export function documentRelativeHref(target: ResolvedDocumentPath, documentPath: string): string | null {
  const directory = documentDirectory(documentPath);
  if (!directory) return null;
  const source = canonicalPath(directory).replace(/\/+$/, '').split('/');
  const destination = canonicalPath(target.path).split('/');
  const windows = /^[a-z]:\//i.test(target.path) || target.path.startsWith('//');
  const equal = (a: string, b: string) => windows ? a.toLowerCase() === b.toLowerCase() : a === b;
  // A relative reference cannot cross drive letters or UNC shares.
  if (windows && (target.path.startsWith('//')
    ? !equal(source.slice(0, 4).join('/'), destination.slice(0, 4).join('/'))
    : !equal(source[0], destination[0]))) return null;
  let common = 0;
  while (common < source.length && common < destination.length && equal(source[common], destination[common])) common++;
  const relative = [...source.slice(common).map(() => '..'), ...destination.slice(common).map(encodeDocumentComponent)].join('/');
  if (!relative) return null;
  const href = relative.startsWith('../') ? relative : `./${relative}`;
  return href + (target.isDirectory ? '/' : '') + (target.search ?? '')
    + (target.anchor ? `#${encodeDocumentComponent(target.anchor)}` : '');
}

/** Read a physical path without treating literal #, ? or % as URL syntax. */
export function resolvePhysicalDocumentPath(path: string): ResolvedDocumentPath | null {
  if (hasControlCharacters(path)) return null;
  const canonical = canonicalPath(path);
  if (!canonical.startsWith('/') && !WINDOWS_DRIVE_RE.test(canonical)) return null;
  const normalized = normalizeDotSegments(canonical);
  return normalized ? { path: normalized, anchor: null, ...(/[\\/]$/.test(path) ? { isDirectory: true } : {}) } : null;
}

/** Absolute URL fallback for moves between drives or network shares. */
export function documentFileHref(target: ResolvedDocumentPath): string {
  const path = canonicalPath(target.path);
  const encoded = path.split('/').map(encodeDocumentComponent).join('/').replace(/^([a-z])%3A/i, '$1:');
  const base = path.startsWith('//') ? `file:${encoded}` : path.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`;
  return base + (target.search ?? '') + (target.anchor ? `#${encodeDocumentComponent(target.anchor)}` : '');
}
