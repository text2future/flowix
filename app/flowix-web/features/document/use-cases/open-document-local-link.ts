import { openExternalTarget } from '@features/workspace/use-cases/workspace-navigation';
import { publishHeadingAnchorRequest } from '@features/document/use-cases/heading-anchor-publish';
import type { ResolvedEditorLocalLink } from '@features/editor/editor-link-resolution';

/**
 * Open a local file reached through an in-editor link (relative or absolute
 * path href) on the standard document surface.
 *
 * `scopePath` is the notebook/workspace root the linking document belongs to;
 * it keeps the opened target inside the same editable boundary. When the link
 * carries a heading fragment, a location request is published so the opened
 * document reveals the anchor after load — the same channel agent links use.
 * This module owns the editor → workspace dependency so the editor itself
 * stays free of navigation-layer imports.
 */
export async function openDocumentLocalLink(
  target: ResolvedEditorLocalLink,
  scopePath: string | null,
): Promise<void> {
  const opened = await openExternalTarget(target.path, { scopePath });
  publishHeadingAnchorRequest(target.path, opened, target.anchor);
}
