import { SAFE_LINK_PROTOCOLS } from '@/lib/safe-link';

export type AgentPlatform = 'windows' | 'macos' | 'linux';
export type RelativeLinkMode = 'file' | 'web' | 'reject';

export interface SourceLocation {
  line: number;
  /** One based UTF-16 code unit column. */
  column?: number;
}

export type AgentLinkTarget =
  | { kind: 'local-file'; path: string; flavor: 'windows-drive' | 'windows-unc' | 'posix'; location?: SourceLocation; anchor?: string }
  | { kind: 'flowix'; url: string }
  | { kind: 'web'; url: string }
  | { kind: 'external'; url: string; protocol: 'mailto:' | 'tel:' }
  | { kind: 'anchor'; anchor: string };

export type AgentLinkErrorCode =
  | 'INVALID_LINK'
  | 'UNSUPPORTED_SCHEME'
  | 'INVALID_ENCODING'
  | 'INVALID_PATH'
  | 'AMBIGUOUS_TARGET'
  | 'UNSUPPORTED_PLATFORM'
  | 'INVALID_LOCATION'
  | 'CONFLICTING_LOCATION';

export type AgentLinkParseResult =
  | { ok: true; target: AgentLinkTarget; warnings: string[] }
  | { ok: false; code: AgentLinkErrorCode; message: string };

export interface ParseContext {
  platform?: AgentPlatform;
  localOrigins?: readonly string[];
  baseDirectory?: string;
  relativeMode?: RelativeLinkMode;
  allowForwardSlashUnc?: boolean;
}

const DEFAULT_LOCAL_ORIGINS = ['http://tauri.localhost', 'tauri://localhost'] as const;

function fail(code: AgentLinkErrorCode, message: string): AgentLinkParseResult {
  return { ok: false, code, message };
}

function success(target: AgentLinkTarget): AgentLinkParseResult {
  return { ok: true, target, warnings: [] };
}

function decodePathOnce(path: string): string | null {
  if (/%(?:2f|5c)/i.test(path)) return null;
  try {
    const decoded = decodeURIComponent(path);
    return /[\u0000-\u001f\u007f]/.test(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

function parseLocationSuffix(path: string): { path: string; location?: SourceLocation; invalid: boolean } {
  const match = /:(\d+)(?::(\d+))?$/.exec(path);
  if (!match) {
    const malformed = /:-?\d+(?::[^/\\]*)?$/.exec(path);
    return { path, invalid: Boolean(malformed) };
  }
  const line = Number(match[1]);
  const column = match[2] === undefined ? undefined : Number(match[2]);
  if (!Number.isSafeInteger(line) || line < 1
    || (column !== undefined && (!Number.isSafeInteger(column) || column < 1))) {
    return { path: path.slice(0, match.index), invalid: true };
  }
  return {
    path: path.slice(0, match.index),
    location: { line, ...(column === undefined ? {} : { column }) },
    invalid: false,
  };
}

function normalizeSegments(path: string, flavor: 'windows-drive' | 'windows-unc' | 'posix'): string | null {
  let prefix = '';
  let remainder = path;
  let floor = 0;
  if (flavor === 'windows-drive') {
    const drive = /^\/?([a-z]):[\\/]/i.exec(path);
    if (!drive) return null;
    prefix = `${drive[1].toUpperCase()}:/`;
    remainder = path.slice(drive[0].length).replace(/\\/g, '/');
  } else if (flavor === 'windows-unc') {
    if (/^(?:\\\\[?.]\\|\/\/\?[\/])/.test(path)) return null;
    const unc = /^(?:\\\\|\/\/)([^\\/]+)[\\/]([^\\/]+)(?:[\\/](.*))?$/.exec(path);
    if (!unc) return null;
    prefix = `//${unc[1]}/${unc[2]}`;
    remainder = unc[3] ?? '';
    floor = 0;
  } else {
    if (!path.startsWith('/')) return null;
    prefix = '/';
    remainder = path.slice(1);
  }

  const parts: string[] = [];
  for (const part of remainder.split(flavor === 'posix' ? '/' : /[\\/]/)) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > floor) parts.pop();
      else return null;
      continue;
    }
    parts.push(part);
  }
  return flavor === 'windows-unc' ? `${prefix}${parts.length ? `/${parts.join('/')}` : ''}` : `${prefix}${parts.join('/')}`;
}

function pathFlavor(path: string): 'windows-drive' | 'windows-unc' | 'posix' | null {
  if (/^\/?[a-z]:[\\/]/i.test(path)) return 'windows-drive';
  if (path.startsWith('\\\\') || path.startsWith('//')) return 'windows-unc';
  if (path.startsWith('/')) return 'posix';
  return null;
}

function checkPlatform(flavor: 'windows-drive' | 'windows-unc' | 'posix', context: ParseContext): AgentLinkParseResult | null {
  if (context.platform && flavor !== 'posix' && context.platform !== 'windows') {
    return fail('UNSUPPORTED_PLATFORM', 'This Windows file link cannot be opened on the current platform.');
  }
  return null;
}

function parseLocalPath(rawPath: string, context: ParseContext): AgentLinkParseResult {
  const suffix = parseLocationSuffix(rawPath);
  if (suffix.invalid) return fail('INVALID_LOCATION', 'The file link has an invalid line or column reference.');
  const decoded = decodePathOnce(suffix.path);
  if (decoded === null) return fail('INVALID_ENCODING', 'The file link contains invalid or unsafe path encoding.');
  const flavor = pathFlavor(decoded);
  if (!flavor) return fail('INVALID_PATH', 'The file link does not contain a supported absolute path.');
  const platformError = checkPlatform(flavor, context);
  if (platformError) return platformError;
  const normalized = normalizeSegments(decoded, flavor);
  if (!normalized) return fail('INVALID_PATH', 'The file link contains an invalid root or traversal segment.');
  return success({ kind: 'local-file', path: normalized, flavor, ...(suffix.location ? { location: suffix.location } : {}) });
}

function rawUriPath(rawHref: string): string | null {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i.exec(rawHref);
  if (!match) return null;
  return match[1] ?? '/';
}

function isRegisteredOrigin(url: URL, origins: readonly string[], protocolOnly = false): boolean {
  for (const rawOrigin of origins) {
    try {
      const expected = new URL(rawOrigin);
      if (url.username || url.password || url.port !== expected.port) continue;
      if (protocolOnly) {
        if (url.protocol === expected.protocol && url.hostname.toLowerCase() === expected.hostname.toLowerCase()) return true;
      } else if (url.origin.toLowerCase() === expected.origin.toLowerCase()) return true;
    } catch {
      // Invalid configured origins are ignored.
    }
  }
  return false;
}

function applyFragment(result: AgentLinkParseResult, fragment: string): AgentLinkParseResult {
  if (!result.ok || result.target.kind !== 'local-file' || !fragment) return result;
  const lineMatch = /^#L(\d+)(?:C(\d+))?$/i.exec(fragment);
  if (/^#L/i.test(fragment) && !lineMatch) return fail('INVALID_LOCATION', 'The file link has an invalid line or column reference.');
  if (lineMatch) {
    const line = Number(lineMatch[1]);
    const column = lineMatch[2] === undefined ? undefined : Number(lineMatch[2]);
    if (!Number.isSafeInteger(line) || line < 1 || (column !== undefined && (!Number.isSafeInteger(column) || column < 1))) {
      return fail('INVALID_LOCATION', 'The file link has an invalid line or column reference.');
    }
    if (result.target.location && (result.target.location.line !== line || result.target.location.column !== column)) {
      return fail('CONFLICTING_LOCATION', 'The file link contains conflicting line and column references.');
    }
    return success({ ...result.target, location: { line, ...(column === undefined ? {} : { column }) } });
  }
  if (result.target.location) return fail('CONFLICTING_LOCATION', 'A line reference cannot be combined with a document anchor.');
  let anchor: string;
  try { anchor = decodeURIComponent(fragment.slice(1)); } catch { return fail('INVALID_ENCODING', 'The file link contains invalid fragment encoding.'); }
  return success({ ...result.target, anchor });
}

function parseUriFile(rawHref: string, context: ParseContext): AgentLinkParseResult {
  let url: URL;
  try { url = new URL(rawHref); } catch { return fail('INVALID_LINK', 'The file URL is malformed.'); }
  if (url.search) return fail('INVALID_LINK', 'File links cannot contain query parameters.');
  if (url.username || url.password) return fail('INVALID_LINK', 'File links cannot contain credentials.');
  const rawPath = rawUriPath(rawHref);
  if (rawPath === null || rawPath.includes('\\')) return fail('INVALID_PATH', 'The file URL contains an invalid path.');
  const path = url.hostname && url.hostname.toLowerCase() !== 'localhost'
    ? `//${url.hostname}${rawPath}`
    : rawPath;
  return applyFragment(parseLocalPath(path, context), url.hash);
}

function resolveRelativePath(rawPath: string, context: ParseContext): AgentLinkParseResult {
  if (context.relativeMode !== 'file' || !context.baseDirectory) {
    return fail('AMBIGUOUS_TARGET', 'This relative link is ambiguous and cannot be opened safely.');
  }
  const baseFlavor = pathFlavor(context.baseDirectory);
  if (!baseFlavor) return fail('INVALID_PATH', 'The file link has no valid base directory.');
  const suffix = parseLocationSuffix(rawPath);
  if (suffix.invalid) return fail('INVALID_LOCATION', 'The file link has an invalid line or column reference.');
  const decoded = decodePathOnce(suffix.path);
  if (decoded === null) return fail('INVALID_ENCODING', 'The file link contains invalid or unsafe path encoding.');
  const base = baseFlavor === 'posix'
    ? context.baseDirectory.replace(/\/$/, '')
    : context.baseDirectory.replace(/\\/g, '/').replace(/\/$/, '');
  const combined = `${base}/${decoded}`;
  const platformError = checkPlatform(baseFlavor, context);
  if (platformError) return platformError;
  const normalized = normalizeSegments(combined, baseFlavor);
  if (!normalized) return fail('INVALID_PATH', 'The relative file link escapes its filesystem root.');
  return success({ kind: 'local-file', path: normalized, flavor: baseFlavor, ...(suffix.location ? { location: suffix.location } : {}) });
}

/** Pure parser. It does not read files, inspect the filesystem, or open UI. */
export function parseAgentLink(rawHref: string | null | undefined, context: ParseContext = {}): AgentLinkParseResult {
  const href = rawHref?.trim() ?? '';
  if (!href || href.length > 8192 || /[\u0000-\u001f\u007f]/.test(href)) {
    return fail('INVALID_LINK', 'The link is empty, too long, or contains control characters.');
  }
  if (href.startsWith('#')) return success({ kind: 'anchor', anchor: href.slice(1) });
  if (/^\\\\[?.]\\/.test(href)) return fail('INVALID_PATH', 'Windows device and extended namespace paths are not supported.');
  if (/^\/?[a-z]:[\\/]/i.test(href) || href.startsWith('\\\\') || (href.startsWith('/') && !href.startsWith('//'))) {
    if (href.includes('?') || href.includes('#')) return fail('INVALID_LINK', 'Reserved path characters must be percent encoded.');
    return parseLocalPath(href, context);
  }

  const allowUnc = context.allowForwardSlashUnc === true && context.relativeMode === 'file';
  if (href.startsWith('//')) {
    if (allowUnc) return parseLocalPath(href, context);
    return success({ kind: 'web', url: `http:${href}` });
  }
  if (/^(?:\.\.?)[\\/]/.test(href)) return resolveRelativePath(href, context);

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1].toLowerCase();
  if (scheme && !SAFE_LINK_PROTOCOLS.has(scheme)) return fail('UNSUPPORTED_SCHEME', `Links using ${scheme}: are not supported.`);
  if (scheme === 'flowix') return success({ kind: 'flowix', url: href });
  if (scheme === 'mailto' || scheme === 'tel') return success({ kind: 'external', url: href, protocol: `${scheme}:` });
  if (scheme === 'file') return parseUriFile(href, context);
  if (scheme === 'tauri') {
    let url: URL;
    try { url = new URL(href); } catch { return fail('INVALID_LINK', 'The Tauri link is malformed.'); }
    const origins = context.localOrigins ?? DEFAULT_LOCAL_ORIGINS;
    if (!isRegisteredOrigin(url, origins, true)) return fail('INVALID_LINK', 'The Tauri link is not from a registered local application origin.');
    if (url.search) return fail('INVALID_LINK', 'Tauri file links cannot contain query parameters.');
    const rawPath = rawUriPath(href);
    if (!rawPath || rawPath.includes('\\')) return fail('INVALID_PATH', 'The Tauri file URL contains an invalid path.');
    if (!/^\/[a-z]:[\\/]/i.test(rawPath)
      && !/^\/(?:Users|home|root|tmp|var|private|Volumes|mnt|media|opt|etc|srv|workspace|workspaces)(?:\/|$)/i.test(rawPath)) {
      return fail('INVALID_PATH', 'The Tauri URL is not a recognized local file path.');
    }
    return applyFragment(parseLocalPath(rawPath, context), url.hash);
  }
  if (scheme === 'http' || scheme === 'https') {
    let url: URL;
    try { url = new URL(href); } catch { return fail('INVALID_LINK', 'The web link is malformed.'); }
    const origins = context.localOrigins ?? DEFAULT_LOCAL_ORIGINS;
    if (isRegisteredOrigin(url, origins)) {
      const rawPath = rawUriPath(href);
      if (rawPath && /^\/[a-z]:[\\/]/i.test(rawPath)) {
        if (url.search) return fail('INVALID_LINK', 'Local file links cannot contain query parameters.');
        return applyFragment(parseLocalPath(rawPath, context), url.hash);
      }
    }
    return success({ kind: 'web', url: href });
  }
  if (scheme) return fail('UNSUPPORTED_SCHEME', `Links using ${scheme}: are not supported.`);

  if (context.relativeMode === 'web' && /^[^\s/]+\.[^\s/]+(?:[/:?#].*)?$/.test(href)) {
    return success({ kind: 'web', url: `http://${href}` });
  }
  return fail('AMBIGUOUS_TARGET', 'This relative link is ambiguous and cannot be opened safely.');
}
