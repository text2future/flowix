import GithubSlugger from 'github-slugger';
import type { WorkspaceContentLocation } from '@features/workspace/use-cases/workspace-content-activation';
import { publishAgentLocationRequest } from './agent-location-navigation';

/** Stable view id for a content location: the tab itself, or the shared main view.
 *
 * Accepts any opened-location shape (WorkspaceContentLocation,
 * BrowserColumnOpenResult) — only `host` and an optional `tabId` are read.
 */
export function locationViewId(opened: { host: string; tabId?: string }): string {
  return opened.host === 'browser-column' ? (opened.tabId ?? opened.host) : opened.host;
}

/**
 * Publish a cross-document heading anchor request on the shared location
 * channel, for consumption by the opened document's container.
 *
 * Single choke point for anchor publishing:
 * - the anchor is normalized to its GitHub slug once here — every consumer
 *   (rich text heading match, source view) compares against slugs;
 * - `openExternalTarget` does not report a location for the markdown
 *   main-document branch (returns null), so a null `opened` safely falls
 *   back to main-third — all anchor-carrying opens land there unless an
 *   existing browser-column view was activated (which returns its location).
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
  const location = opened ?? { host: 'main-third', state: 'active' };
  publishAgentLocationRequest({
    path,
    anchor: slug,
    host: location.host,
    viewId: locationViewId(location),
  });
}
