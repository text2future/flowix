import GithubSlugger from 'github-slugger';
import type { WorkspaceContentLocation } from '@features/workspace/public/note-navigation-api';
import { publishAgentLocationRequest } from './agent-location-navigation';

/** Stable view id for a content location: the tab itself, or the shared main view.
 *
 * The public surface-open result is normalized to WorkspaceContentLocation
 * before it reaches this helper.
 */
export function locationViewId(opened: { host: string; surfaceId?: string; runtimeLocation?: { host: string; surfaceId?: string } }): string {
  opened = opened.runtimeLocation ?? opened;
  return opened.host === 'column-2' ? (opened.surfaceId ?? opened.host) : opened.host;
}

/**
 * Publish a cross-document heading anchor request on the shared location
 * channel, for consumption by the opened document's container.
 *
 * Single choke point for anchor publishing:
 * - the anchor is normalized to its GitHub slug once here — every consumer
 *   (rich text heading match, source view) compares against slugs;
 * - A cancelled open passes null and does not publish a request. An actual
 *   Work open always carries an explicit Work location.
 */
export function publishHeadingAnchorRequest(
  path: string,
  opened: WorkspaceContentLocation | null,
  anchor: string | null | undefined,
): void {
  const raw = anchor?.trim();
  if (!raw) return;
  const slug = new GithubSlugger().slug(raw);
  if (!slug) return;
  if (!opened) return;
  const location = opened.runtimeLocation ?? opened;
  publishAgentLocationRequest({
    path,
    anchor: slug,
    host: location.host,
    viewId: locationViewId(location),
  });
}
