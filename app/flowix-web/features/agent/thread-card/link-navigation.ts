import type { RuntimeConfig } from '@/types/agent';
import { openUrl } from '@platform/tauri/opener';
import { canonicalPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import { translate } from '@/lib/i18n';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { externalFileViewKind } from '@features/editor/code-file';
import { openNoteByDeepLink } from '@features/memo/use-cases/open-by-target';
import {
  openBrowserColumnFileBrowser,
  openBrowserColumnText,
  openBrowserColumnWebpage,
  type BrowserColumnOpenResult,
} from '@features/workspace/use-cases/browser-column-navigation';
import {
  cancelAgentLocationRequest,
  publishAgentLocationRequest,
} from '@features/document/use-cases/agent-location-navigation';
import { locationViewId } from '@features/document/use-cases/heading-anchor-publish';
import {
  parseAgentLink,
  type AgentLinkParseResult,
  type AgentLinkTarget,
  type ParseContext,
} from './agent-link-parser';

export {
  parseAgentLink,
  type AgentLinkErrorCode,
  type AgentLinkParseResult,
  type AgentLinkTarget,
  type ParseContext,
  type SourceLocation,
} from './agent-link-parser';

type ComparablePath = {
  value: string;
  flavor: 'posix' | 'windows' | 'relative';
};

let nextLocalNavigationId = 0;
const latestLocalNavigationByPath = new Map<string, number>();

/** Lexically normalize a user-visible path without requiring filesystem I/O. */
function comparablePath(value: string): ComparablePath {
  const slashed = value.replace(/\\/g, '/');
  const isUnc = slashed.startsWith('//');
  const drive = /^([a-z]):(?:\/|$)/i.exec(slashed)?.[1];
  const isPosix = !isUnc && slashed.startsWith('/');
  const flavor = isUnc || drive ? 'windows' : isPosix ? 'posix' : 'relative';
  const body = isUnc ? slashed.slice(2) : drive ? slashed.slice(2).replace(/^\/+/, '') : isPosix ? slashed.slice(1) : slashed;
  const parts: string[] = [];
  const floor = isUnc ? 2 : 0;
  for (const part of body.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > floor && parts[parts.length - 1] !== '..') parts.pop();
      else if (flavor === 'relative') parts.push(part);
      continue;
    }
    parts.push(part);
  }
  const prefix = isUnc ? '//' : drive ? `${drive.toUpperCase()}:/` : isPosix ? '/' : '';
  const normalized = `${prefix}${parts.join('/')}` || (isPosix ? '/' : drive ? `${drive.toUpperCase()}:/` : isUnc ? '//' : '.');
  return { value: normalized, flavor };
}

function pathContains(root: ComparablePath, target: ComparablePath): boolean {
  if (root.flavor !== target.flavor || root.flavor === 'relative') return false;
  const fold = (path: string) => root.flavor === 'windows' ? path.toLowerCase() : path;
  const rootValue = fold(root.value);
  const targetValue = fold(target.value);
  if (targetValue === rootValue) return true;
  return targetValue.startsWith(rootValue.endsWith('/') ? rootValue : `${rootValue}/`);
}

/** Return the narrowest captured workspace root containing a local file. */
export function agentFileScopePath(filePath: string, workspacePaths: readonly string[]): string | null {
  const target = comparablePath(filePath);
  return workspacePaths
    .filter((path) => typeof path === 'string' && path.trim())
    .map((path) => ({ original: path.trim(), comparable: comparablePath(path.trim()) }))
    .filter(({ comparable }) => pathContains(comparable, target))
    .sort((left, right) => right.comparable.value.length - left.comparable.value.length)[0]?.original ?? null;
}

export function agentFileScopePaths(runtimeConfig: RuntimeConfig | null | undefined): string[] {
  const snapshotPaths = runtimeConfig?.workspaceState?.desired.workspacePaths
    ?? runtimeConfig?.workspaceSnapshot?.workspacePaths ?? [];
  const legacyPaths = [runtimeConfig?.cwd, runtimeConfig?.files?.workspace,
    ...(runtimeConfig?.files?.folders ?? []), ...(runtimeConfig?.files?.notebooks ?? [])]
    .filter((path): path is string => typeof path === 'string');
  return [...snapshotPaths, ...legacyPaths];
}

export function agentFileScopePathForRuntime(filePath: string, runtimeConfig: RuntimeConfig | null | undefined): string | null {
  return agentFileScopePath(filePath, agentFileScopePaths(runtimeConfig));
}

function currentPlatform(): ParseContext['platform'] {
  if (typeof navigator === 'undefined') return undefined;
  const value = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (value.includes('win')) return 'windows';
  if (value.includes('mac')) return 'macos';
  if (value.includes('linux')) return 'linux';
  return undefined;
}

function explainParseError(result: Extract<AgentLinkParseResult, { ok: false }>): Error {
  const error = new Error(result.message);
  error.name = result.code;
  return error;
}

/** Shared click dispatcher for both Agent message surfaces. */
export async function openAgentLink(
  rawHref: string | null | undefined,
  runtimeConfig: RuntimeConfig | null | undefined,
): Promise<void> {
  // Agent Markdown historically treats bare domains as web links. Relative
  // file references remain rejected because no trusted base directory exists.
  const parsed = parseAgentLink(rawHref, { platform: currentPlatform(), relativeMode: 'web' });
  if (!parsed.ok) throw explainParseError(parsed);
  const target: AgentLinkTarget = parsed.target;
  switch (target.kind) {
    case 'anchor':
      return;
    case 'flowix':
      await openNoteByDeepLink(target.url);
      return;
    case 'web':
      await openBrowserColumnWebpage(target.url);
      return;
    case 'external':
      await openUrl(target.url);
      return;
    case 'local-file': {
      // Reserve the latest navigation synchronously. Opening a document can
      // take longer than a later click, so request order must not depend on
      // which navigation promise resolves first.
      const canonicalTargetPath = canonicalPath(target.path);
      const pathKey = /^[a-z]:\//i.test(canonicalTargetPath) || canonicalTargetPath.startsWith('//')
        ? canonicalTargetPath.toLowerCase()
        : canonicalTargetPath;
      const navigationId = ++nextLocalNavigationId;
      latestLocalNavigationByPath.set(pathKey, navigationId);
      cancelAgentLocationRequest(target.path);
      const scopePath = agentFileScopePathForRuntime(target.path, runtimeConfig);
      let opened: BrowserColumnOpenResult | null;
      try {
        opened = scopePath
          ? await openBrowserColumnFileBrowser(scopePath, target.path)
          : await openBrowserColumnText(target.path, null);
      } catch (error) {
        if (latestLocalNavigationByPath.get(pathKey) === navigationId) {
          latestLocalNavigationByPath.delete(pathKey);
        }
        throw error;
      }
      if (latestLocalNavigationByPath.get(pathKey) !== navigationId) return;
      latestLocalNavigationByPath.delete(pathKey);
      if (!opened || (!target.location && !target.anchor)) return;
      const viewKind = externalFileViewKind(target.path);
      if (viewKind !== 'markdown' && viewKind !== 'code') {
        toast.info(translate(getCurrentAppLanguage(), 'document.file.locationUnsupported'));
        return;
      }
      publishAgentLocationRequest({
        path: target.path,
        ...(target.location ? { location: target.location } : {}),
        ...(target.anchor ? { anchor: target.anchor } : {}),
        host: opened.host,
        viewId: locationViewId(opened),
      });
      return;
    }
  }
}

/** Shared delegated DOM click handling for both Agent message surfaces. */
export function handleAgentLinkClick(
  event: MouseEvent,
  runtimeConfig: RuntimeConfig | null | undefined,
  onError: (error: unknown, rawHref: string | null) => void,
): boolean {
  const target = event.target instanceof Element ? event.target : null;
  const anchor = target?.closest<HTMLAnchorElement>('a[href]');
  if (!anchor) return false;
  event.preventDefault();
  event.stopPropagation();
  const rawHref = anchor.getAttribute('href');
  void openAgentLink(rawHref, runtimeConfig).catch((error) => onError(error, rawHref));
  return true;
}

/** Compatibility helper for code that only needs a local file path. */
export function localFilePathFromAgentHref(rawHref: string | null | undefined): string | null {
  const parsed = parseAgentLink(rawHref);
  return parsed.ok && parsed.target.kind === 'local-file' ? parsed.target.path : null;
}

export function isMarkdownFilePath(path: string): boolean {
  return /\.(?:md|markdown)$/i.test(path);
}
